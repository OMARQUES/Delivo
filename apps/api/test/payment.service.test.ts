import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { registerUser } from '../src/services/auth.service'
import { createAddress } from '../src/services/address.service'
import { createOrder, getCustomerOrder } from '../src/services/order.service'
import { orders } from '../src/db/schema'
import type { PaymentProvider } from '../src/lib/payment-provider'
import {
  createPixPaymentForOrder,
  confirmPaymentApproved,
  expireStaleAwaitingPayment,
  getOrderPayment,
  refundOrderPaymentIfAny,
} from '../src/services/payment.service'

const storeInput: StoreCreateInput = {
  name: 'Pizzaria',
  slug: 'pizzaria',
  category: 'PIZZARIA',
  phone: '4433334444',
  city: 'C',
  addressText: 'Rua A, 1',
  lat: -23.55,
  lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}
const ana = { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER' as const, acceptedTerms: true as const }

let customerId: string
let addressId: string
let productId: string

function fakeProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    createPixPayment: vi.fn(async (i) => ({
      providerPaymentId: 'mp-1',
      status: 'PENDING' as const,
      qrCode: 'copia',
      qrCodeBase64: 'b64',
      ticketUrl: null,
      expiresAt: i.expiresAt,
    })),
    createCardPayment: vi.fn(async () => ({ providerPaymentId: 'mp-c', status: 'APPROVED' as const, statusDetail: 'accredited' })),
    getPayment: vi.fn(async (id) => ({ providerPaymentId: id, status: 'APPROVED' as const })),
    refundPayment: vi.fn(async () => {}),
    cancelPayment: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  await updateStore(testDb, store.id, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED',
    deliveryFixedFeeCents: 500,
    minOrderCents: 1000,
  })
  const customer = await registerUser(testDb, ana, 'test-secret')
  customerId = customer.user.id
  const addr = await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })
  addressId = addr.id
  const cat = await createCategory(testDb, store.id, { name: 'Pizzas' })
  productId = (await createProduct(testDb, store.id, {
    categoryId: cat.id,
    name: 'Pizza',
    basePriceCents: 6000,
    isAvailable: true,
  })).id
})
afterAll(closeTestDb)

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY' as const,
    addressId,
    paymentMethod: 'CASH' as const,
    changeForCents: 10000,
    items: [{ productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  }
}

async function makeAwaitingPaymentOrder() {
  const cash = await createOrder(testDb, customerId, checkout())
  await testDb.execute(sql`update orders set status='AWAITING_PAYMENT', payment_method='PIX_ONLINE' where id=${cash.id}`)
  const [row] = await testDb.select().from(orders).where(eq(orders.id, cash.id))
  return row!
}

describe('createPixPaymentForOrder', () => {
  it('creates payment row with QR data and 15min expiry', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    const p = await createPixPaymentForOrder(testDb, provider, order, 'cliente@x.com', null)
    expect(p).toMatchObject({ providerPaymentId: 'mp-1', status: 'PENDING', method: 'PIX', qrCode: 'copia' })
    expect(p.amountCents).toBe(order.totalCents)
    const mins = (p.expiresAt!.getTime() - Date.now()) / 60000
    expect(mins).toBeGreaterThan(13)
    expect(mins).toBeLessThan(16)
  })
})

describe('confirmPaymentApproved', () => {
  it('flips order AWAITING_PAYMENT->PENDING, marks payment APPROVED, adds SYSTEM event; idempotent', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, order, 'c@x.com', null)
    const r1 = await confirmPaymentApproved(testDb, 'mp-1')
    expect(r1).toBe(true)
    const after = await getCustomerOrder(testDb, customerId, order.id)
    expect(after!.status).toBe('PENDING')
    expect(after!.events.some((e) => e.actorRole === 'SYSTEM' && (e.note ?? '').includes('agamento'))).toBe(true)
    expect((await getOrderPayment(testDb, order.id))!.status).toBe('APPROVED')
    const r2 = await confirmPaymentApproved(testDb, 'mp-1')
    expect(r2).toBe(false)
  })

  it('unknown providerPaymentId -> false (no throw)', async () => {
    expect(await confirmPaymentApproved(testDb, 'ghost')).toBe(false)
  })

  it('LATE payment on already-CANCELLED order -> automatic refund', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, order, 'c@x.com', null)
    await testDb.execute(sql`update orders set status='CANCELLED', cancel_reason='Pagamento não realizado a tempo' where id = ${order.id}`)
    const r = await confirmPaymentApproved(testDb, 'mp-1', provider)
    expect(r).toBe(false)
    expect(provider.refundPayment).toHaveBeenCalledWith('mp-1')
    expect((await getOrderPayment(testDb, order.id))!.status).toBe('REFUNDED')
  })
})

describe('refundOrderPaymentIfAny', () => {
  it('refunds APPROVED payment, marks REFUNDED, adds event; no-op without payment', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, order, 'c@x.com', null)
    await confirmPaymentApproved(testDb, 'mp-1')
    const refunded = await refundOrderPaymentIfAny(testDb, provider, order.id)
    expect(refunded).toBe(true)
    expect(provider.refundPayment).toHaveBeenCalledWith('mp-1')
    expect((await getOrderPayment(testDb, order.id))!.status).toBe('REFUNDED')

    const cash = await createOrder(testDb, customerId, checkout())
    expect(await refundOrderPaymentIfAny(testDb, provider, cash.id)).toBe(false)
  })

  it('PENDING (não pago) -> cancela no gateway em vez de estornar', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, order, 'c@x.com', null)
    const r = await refundOrderPaymentIfAny(testDb, provider, order.id)
    expect(r).toBe(false)
    expect(provider.cancelPayment).toHaveBeenCalledWith('mp-1')
    expect((await getOrderPayment(testDb, order.id))!.status).toBe('CANCELLED')
  })
})

describe('expireStaleAwaitingPayment', () => {
  it('cancels AWAITING_PAYMENT orders older than 15min + their payments; leaves fresh ones', async () => {
    const stale = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, stale, 'c@x.com', null)
    await testDb.execute(sql`update orders set created_at = now() - interval '20 minutes' where id = ${stale.id}`)
    const fresh = await makeAwaitingPaymentOrder()
    const n = await expireStaleAwaitingPayment(testDb, provider, 15)
    expect(n).toBe(1)
    expect((await getCustomerOrder(testDb, customerId, stale.id))!.status).toBe('CANCELLED')
    expect((await getOrderPayment(testDb, stale.id))!.status).toBe('EXPIRED')
    expect((await getCustomerOrder(testDb, customerId, fresh.id))!.status).toBe('AWAITING_PAYMENT')
  })
})

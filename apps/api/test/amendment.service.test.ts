import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder, getCustomerOrder } from '../src/services/order.service'
import { storeUpdateOrderStatus } from '../src/services/order-status.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'
import { payments } from '../src/db/schema'
import type { PaymentProvider } from '../src/lib/payment-provider'
import {
  AmendmentError,
  approveAmendment,
  getPendingAmendment,
  proposeAmendment,
  rejectAmendment,
  withdrawAmendment,
} from '../src/services/amendment.service'

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

let storeId: string
let ownerUserId: string
let customerId: string
let addressId: string
let pizzaId: string
let cocaId: string

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
    refundPartial: vi.fn(async () => {}),
    cancelPayment: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  storeId = store.id
  ownerUserId = store.ownerUserId
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED',
    deliveryFixedFeeCents: 500,
    minOrderCents: 1000,
  })
  const customer = await createVerifiedTestAccount(testDb, ana, 'test-secret')
  customerId = customer.user.id
  addressId = (await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })).id
  const cat = await createCategory(testDb, storeId, { name: 'Itens' })
  pizzaId = (await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })).id
  cocaId = (await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Coca', basePriceCents: 1000, isAvailable: true })).id
})
afterAll(closeTestDb)

function checkout() {
  return {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY' as const,
    addressId,
    paymentMethod: 'CASH' as const,
    changeForCents: 10000,
    items: [
      { productId: pizzaId, quantity: 2, selections: [] },
      { productId: cocaId, quantity: 1, selections: [] },
    ],
    idempotencyKey: crypto.randomUUID(),
  }
}

async function makeOrder() {
  const { order } = await createOrder(testDb, customerId, checkout())
  const detail = await getCustomerOrder(testDb, customerId, order.id)
  const pizzaItemId = detail!.items.find((i) => i.nameSnapshot === 'Pizza')!.id
  const cocaItemId = detail!.items.find((i) => i.nameSnapshot === 'Coca')!.id
  return { orderId: order.id, pizzaItemId, cocaItemId }
}

async function makeAcceptedOrder() {
  const o = await makeOrder()
  await storeUpdateOrderStatus(testDb, storeId, o.orderId, 'ACCEPTED', ownerUserId)
  return o
}

async function makeAcceptedPaidOrder() {
  const o = await makeAcceptedOrder()
  await testDb.update(payments).set({ status: 'CANCELLED' })
  await testDb.execute(sql`update orders set payment_method='PIX_ONLINE' where id=${o.orderId}`)
  await testDb.insert(payments).values({
    orderId: o.orderId,
    providerPaymentId: 'mp-9',
    method: 'PIX',
    amountCents: 7500,
    status: 'APPROVED',
  })
  return o
}

describe('proposeAmendment', () => {
  it('freezes new totals and refund diff; stores item diff snapshots', async () => {
    const { orderId, pizzaItemId } = await makeAcceptedOrder()
    const a = await proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      note: 'acabou massa',
      items: [{ orderItemId: pizzaItemId, newQuantity: 1 }],
    })
    expect(a).toMatchObject({ status: 'PROPOSED', newSubtotalCents: 4000, newTotalCents: 4500, refundCents: 3000 })
    const pending = await getPendingAmendment(testDb, orderId)
    expect(pending!.items[0]).toMatchObject({ oldQuantity: 2, newQuantity: 1, nameSnapshot: 'Pizza' })
  })

  it('rejects: wrong status, increase, zero-all, duplicate pending, foreign store/item', async () => {
    const { orderId, pizzaItemId, cocaItemId } = await makeAcceptedOrder()
    await expect(proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 3 }],
    })).rejects.toMatchObject({ status: 400 })
    await expect(proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 0 }, { orderItemId: cocaItemId, newQuantity: 0 }],
    })).rejects.toMatchObject({ status: 400 })
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    await expect(proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 1 }],
    })).rejects.toMatchObject({ status: 409 })
    const fresh = await makeOrder()
    await expect(proposeAmendment(testDb, storeId, ownerUserId, fresh.orderId, {
      items: [{ orderItemId: fresh.pizzaItemId, newQuantity: 1 }],
    })).rejects.toMatchObject({ status: 409 })
    await expect(proposeAmendment(testDb, crypto.randomUUID(), ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 1 }],
    })).rejects.toMatchObject({ status: 404 })
  })
})

describe('approveAmendment', () => {
  it('applies quantities atomically (0 removes), updates order totals, keeps status; partial refund when paid', async () => {
    const { orderId, pizzaItemId, cocaItemId } = await makeAcceptedPaidOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 1 }, { orderItemId: cocaItemId, newQuantity: 0 }],
    })
    const provider = fakeProvider()
    const r = await approveAmendment(testDb, provider, customerId, orderId)
    expect(r.status).toBe('APPROVED')
    const detail = await getCustomerOrder(testDb, customerId, orderId)
    expect(detail!.status).toBe('ACCEPTED')
    expect(detail!.items).toHaveLength(1)
    expect(detail!.items[0]).toMatchObject({ quantity: 1, totalCents: 3000 })
    expect(detail!.subtotalCents).toBe(3000)
    expect(detail!.totalCents).toBe(3500)
    expect(provider.refundPartial).toHaveBeenCalledWith('mp-9', 4000)
    expect(detail!.events.some((e) => (e.note ?? '').includes('ajustado'))).toBe(true)
  })

  it('cash order: no gateway call, totals still applied', async () => {
    const { orderId, cocaItemId } = await makeAcceptedOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    const provider = fakeProvider()
    await approveAmendment(testDb, provider, customerId, orderId)
    expect(provider.refundPartial).not.toHaveBeenCalled()
    expect((await getCustomerOrder(testDb, customerId, orderId))!.subtotalCents).toBe(6000)
  })

  it('guards: wrong customer 404, no pending 409, double approve 409', async () => {
    const { orderId, cocaItemId } = await makeAcceptedOrder()
    await expect(approveAmendment(testDb, fakeProvider(), customerId, orderId)).rejects.toMatchObject({ status: 409 })
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    await expect(approveAmendment(testDb, fakeProvider(), crypto.randomUUID(), orderId)).rejects.toMatchObject({ status: 404 })
    await approveAmendment(testDb, fakeProvider(), customerId, orderId)
    await expect(approveAmendment(testDb, fakeProvider(), customerId, orderId)).rejects.toMatchObject({ status: 409 })
  })
})

describe('rejectAmendment', () => {
  it('cancels order with full refund when paid', async () => {
    const { orderId, cocaItemId } = await makeAcceptedPaidOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    const provider = fakeProvider()
    await rejectAmendment(testDb, provider, customerId, orderId)
    const detail = await getCustomerOrder(testDb, customerId, orderId)
    expect(detail!.status).toBe('CANCELLED')
    expect(provider.refundPayment).toHaveBeenCalledWith('mp-9')
  })
})

describe('withdraw + status gate', () => {
  it('only one wins when customer approve and store withdraw race', async () => {
    const { orderId, cocaItemId } = await makeAcceptedOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })

    const results = await Promise.allSettled([
      approveAmendment(testDb, fakeProvider(), customerId, orderId),
      withdrawAmendment(testDb, storeId, orderId),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(await getPendingAmendment(testDb, orderId)).toBeNull()
  })

  it('withdraw expires proposal; store status change blocked while pending except CANCELLED', async () => {
    const { orderId, cocaItemId } = await makeAcceptedOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    await expect(storeUpdateOrderStatus(testDb, storeId, orderId, 'PREPARING', ownerUserId))
      .rejects.toMatchObject({ status: 409 })
    await withdrawAmendment(testDb, storeId, orderId)
    expect(await getPendingAmendment(testDb, orderId)).toBeNull()
    await storeUpdateOrderStatus(testDb, storeId, orderId, 'PREPARING', ownerUserId)

    const o2 = await makeAcceptedOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, o2.orderId, { items: [{ orderItemId: o2.cocaItemId, newQuantity: 0 }] })
    await storeUpdateOrderStatus(testDb, storeId, o2.orderId, 'CANCELLED', ownerUserId, 'sem estoque')
    expect(await getPendingAmendment(testDb, o2.orderId)).toBeNull()
  })
})

void AmendmentError

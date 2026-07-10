import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { orders, users } from '../src/db/schema'
import type { CardPaymentResult } from '../src/lib/payment-provider'
import * as mp from '../src/lib/mercadopago'
import { createAddress } from '../src/services/address.service'
import { registerUser } from '../src/services/auth.service'
import { createCategory, createProduct, replaceProductOptions } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { requestDriver, storeUpdateOrderStatus } from '../src/services/order-status.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

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
let customerId: string
let customerToken: string
let addressId: string
let productId: string
let driverUserId: string
let groupIds: { varId: string; varG: string; adId: string; adBorda: string }

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  storeId = store.id
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'DISTANCE',
    deliveryMinFeeCents: 400,
    deliveryPerKmCents: 200,
    deliveryMaxKm: 8,
    minOrderCents: 5000,
  })
  const customer = await registerUser(testDb, ana, env.JWT_SECRET)
  customerId = customer.user.id
  customerToken = customer.accessToken!
  const driver = await registerUser(testDb, { ...ana, name: 'Duda Motoboy', phone: '44911111111', role: 'DRIVER' }, env.JWT_SECRET)
  driverUserId = driver.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverUserId))
  const addr = await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })
  addressId = addr.id
  const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
  const prod = await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })
  productId = prod.id
  await replaceProductOptions(testDb, storeId, productId, [
    {
      name: 'Tamanho',
      type: 'VARIATION',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { name: 'P', priceCents: 3000, isAvailable: true },
        { name: 'G', priceCents: 5000, isAvailable: true },
      ],
    },
    {
      name: 'Extras',
      type: 'ADDON',
      minSelect: 0,
      maxSelect: 2,
      options: [{ name: 'Borda', priceCents: 800, isAvailable: true }],
    },
  ])
  const { getStoreCatalog } = await import('../src/services/catalog.service')
  const catalog = await getStoreCatalog(testDb, storeId)
  const groups = catalog[0]!.products[0]!.groups
  const v = groups.find((g) => g.type === 'VARIATION')!
  const a = groups.find((g) => g.type === 'ADDON')!
  groupIds = { varId: v.id, varG: v.options[1]!.id, adId: a.id, adBorda: a.options[0]!.id }
})
afterAll(closeTestDb)

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY' as const,
    addressId,
    paymentMethod: 'CASH' as const,
    changeForCents: 10000,
    items: [{
      productId,
      quantity: 2,
      selections: [
        { groupId: groupIds.varId, optionIds: [groupIds.varG] },
        { groupId: groupIds.adId, optionIds: [groupIds.adBorda] },
      ],
    }],
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  }
}

function req(path: string, init: RequestInit = {}, t = customerToken) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(init.headers as Record<string, string>) },
  }, env)
}

describe('POST /orders/quote + POST /orders', () => {
  it('quote returns totals; create returns 201 order; replay same key returns same id', async () => {
    const body = checkout()
    const q = await req('/orders/quote', { method: 'POST', body: JSON.stringify(body) })
    expect(q.status).toBe(200)
    expect(((await q.json()) as { totalCents: number }).totalCents).toBe(12000)
    const c1 = await req('/orders', { method: 'POST', body: JSON.stringify(body) })
    expect(c1.status).toBe(201)
    const o1 = (await c1.json()) as { order: { id: string } }
    const c2 = await req('/orders', { method: 'POST', body: JSON.stringify(body) })
    expect(c2.status).toBe(201)
    expect(((await c2.json()) as { order: { id: string } }).order.id).toBe(o1.order.id)
  })

  it('PIX_ONLINE: order born AWAITING_PAYMENT, response has QR; replay returns same QR', async () => {
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      createPixPayment: async (i) => ({
        providerPaymentId: 'mp-pix-1',
        status: 'PENDING',
        qrCode: 'copia',
        qrCodeBase64: 'b64',
        ticketUrl: null,
        expiresAt: i.expiresAt,
      }),
      createCardPayment: async () => { throw new Error('not used') },
      getPayment: async () => ({ providerPaymentId: 'x', status: 'PENDING' }),
      refundPayment: async () => {},
      cancelPayment: async () => {},
    })
    const body = checkout({ paymentMethod: 'PIX_ONLINE' })
    const res = await req('/orders', { method: 'POST', body: JSON.stringify(body) }, customerToken)
    expect(res.status).toBe(201)
    const r = (await res.json()) as { order: { status: string }; payment: { qrCode: string } }
    expect(r.order.status).toBe('AWAITING_PAYMENT')
    expect(r.payment.qrCode).toBe('copia')
    const replay = await req('/orders', { method: 'POST', body: JSON.stringify(body) }, customerToken)
    expect(((await replay.json()) as { payment: { qrCode: string } }).payment.qrCode).toBe('copia')
    vi.restoreAllMocks()
  })

  it('CARD_ONLINE approved -> order PENDING direct; rejected -> 402 + order CANCELLED', async () => {
    const approve = vi.fn(async (): Promise<CardPaymentResult> => ({
      providerPaymentId: 'mp-c1',
      status: 'APPROVED',
      statusDetail: 'accredited',
    }))
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      createPixPayment: async () => { throw new Error('not used') },
      createCardPayment: approve,
      getPayment: async () => ({ providerPaymentId: 'x', status: 'APPROVED' }),
      refundPayment: async () => {},
      cancelPayment: async () => {},
    })
    const ok = await req('/orders', {
      method: 'POST',
      body: JSON.stringify(checkout({
        paymentMethod: 'CARD_ONLINE',
        cardToken: 'tok_12345678',
        cardPaymentMethodId: 'master',
        installments: 1,
      })),
    }, customerToken)
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as { order: { status: string } }).order.status).toBe('PENDING')

    approve.mockResolvedValueOnce({ providerPaymentId: 'mp-c2', status: 'REJECTED', statusDetail: 'cc_rejected' })
    const bad = await req('/orders', {
      method: 'POST',
      body: JSON.stringify(checkout({
        paymentMethod: 'CARD_ONLINE',
        cardToken: 'tok_87654321',
        cardPaymentMethodId: 'visa',
        installments: 1,
      })),
    }, customerToken)
    expect(bad.status).toBe(402)
    vi.restoreAllMocks()
  })

  it('online payment without provider configured -> 503', async () => {
    const res = await req('/orders', { method: 'POST', body: JSON.stringify(checkout({ paymentMethod: 'PIX_ONLINE' })) }, customerToken)
    expect(res.status).toBe(503)
  })

  it('409 with problems; 401 anon', async () => {
    await updateStore(testDb, storeId, { isPaused: true })
    const r = await req('/orders', { method: 'POST', body: JSON.stringify(checkout()) })
    expect(r.status).toBe(409)
    expect((await app.request('/orders', { method: 'POST' }, env)).status).toBe(401)
  })
})

describe('GET /orders + /orders/:id', () => {
  it('lists own orders; detail includes items/events; 404 others order', async () => {
    const { order: created } = await createOrder(testDb, customerId, checkout())
    const list = await req('/orders')
    expect(((await list.json()) as unknown[]).length).toBe(1)
    const detail = await req(`/orders/${created.id}`)
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { items: unknown[]; events: unknown[] }
    expect(body.items.length).toBe(1)
    const other = await registerUser(testDb, { ...ana, phone: '44911112222' }, 'test-secret')
    expect((await req(`/orders/${created.id}`, {}, other.accessToken!)).status).toBe(404)
  })

  it('customer tracking shows driver first name once assigned', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    await storeUpdateOrderStatus(testDb, storeId, o.id, 'ACCEPTED', customerId)
    await requestDriver(testDb, storeId, o.id)
    const { acceptDelivery } = await import('../src/services/dispatch.service')
    await acceptDelivery(testDb, driverUserId, o.id)
    const detail = await req(`/orders/${o.id}`)
    expect(((await detail.json()) as { driverName: string | null }).driverName).toBe('Duda')
  })
})

describe('cancel flows', () => {
  it('PENDING: direct cancel 200; after ACCEPTED: cancel 409 but cancel-request 200', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    expect((await req(`/orders/${o.id}/cancel`, { method: 'POST' })).status).toBe(200)
    const { order: o2 } = await createOrder(testDb, customerId, checkout())
    await testDb.update(orders).set({ status: 'ACCEPTED' }).where(eq(orders.id, o2.id))
    expect((await req(`/orders/${o2.id}/cancel`, { method: 'POST' })).status).toBe(409)
    const cr = await req(`/orders/${o2.id}/cancel-request`, {
      method: 'POST',
      body: JSON.stringify({ note: 'mudei de ideia' }),
    })
    expect(cr.status).toBe(200)
  })
})

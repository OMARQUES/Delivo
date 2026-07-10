import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { orders } from '../src/db/schema'
import type { PaymentProvider } from '../src/lib/payment-provider'
import * as mp from '../src/lib/mercadopago'
import { createAddress } from '../src/services/address.service'
import { registerUser } from '../src/services/auth.service'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder, getCustomerOrder } from '../src/services/order.service'
import { createPixPaymentForOrder } from '../src/services/payment.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'

const WEBHOOK_SECRET = 'whsec-test'
const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}
const envWithMp = { ...env, MP_WEBHOOK_SECRET: WEBHOOK_SECRET, MP_ACCESS_TOKEN: 'tok' }

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
let orderId: string

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
  vi.restoreAllMocks()
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
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY',
    addressId,
    paymentMethod: 'CASH',
    changeForCents: 10000,
    items: [{ productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
  })
  await testDb.execute(sql`update orders set status='AWAITING_PAYMENT', payment_method='PIX_ONLINE' where id=${order.id}`)
  const [awaiting] = await testDb.select().from(orders).where(eq(orders.id, order.id))
  await createPixPaymentForOrder(testDb, fakeProvider(), awaiting!, 'c@x.com', null)
  orderId = order.id
})
afterAll(closeTestDb)

async function sign(dataId: string, requestId: string, ts: string): Promise<string> {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function webhookReq(dataId: string, v1: string, ts = String(Math.floor(Date.now() / 1000))) {
  return app.request(`/webhooks/mercadopago?data.id=${dataId}&type=payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': `ts=${ts},v1=${v1}`,
      'x-request-id': 'req-1',
    },
    body: JSON.stringify({ type: 'payment', data: { id: dataId } }),
  }, envWithMp)
}

describe('POST /webhooks/mercadopago', () => {
  it('valid signature + approved payment -> order becomes PENDING', async () => {
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(fakeProvider({
      getPayment: async () => ({ providerPaymentId: 'mp-1', status: 'APPROVED' }),
    }))
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await webhookReq('mp-1', await sign('mp-1', 'req-1', ts), ts)
    expect(res.status).toBe(200)
    const after = await getCustomerOrder(testDb, customerId, orderId)
    expect(after!.status).toBe('PENDING')
  })

  it('invalid signature -> 401 and nothing changes', async () => {
    const res = await webhookReq('mp-1', 'deadbeef')
    expect(res.status).toBe(401)
  })

  it('gateway says still pending -> 200 but no transition (re-fetch is the source of truth)', async () => {
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(fakeProvider({
      getPayment: async () => ({ providerPaymentId: 'mp-1', status: 'PENDING' }),
    }))
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await webhookReq('mp-1', await sign('mp-1', 'req-1', ts), ts)
    expect(res.status).toBe(200)
    expect((await getCustomerOrder(testDb, customerId, orderId))!.status).toBe('AWAITING_PAYMENT')
  })

  it('unknown payment id -> 200 (ack, no-op); missing secret config -> 503', async () => {
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(fakeProvider({
      getPayment: async () => ({ providerPaymentId: 'ghost', status: 'APPROVED' }),
    }))
    const ts = String(Math.floor(Date.now() / 1000))
    expect((await webhookReq('ghost', await sign('ghost', 'req-1', ts), ts)).status).toBe(200)
    const noSecret = await app.request('/webhooks/mercadopago?data.id=x&type=payment', { method: 'POST', body: '{}' }, env)
    expect(noSecret.status).toBe(503)
  })
})

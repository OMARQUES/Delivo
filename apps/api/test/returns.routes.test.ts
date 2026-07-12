import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import { ledgerEntries, orderEvents, orders, users } from '../src/db/schema'
import { registerUser } from '../src/services/auth.service'
import { createStoreWithOwner } from '../src/services/store.service'
import { PostgresRateLimiter } from '../src/security/rate-limit'
import { POLICIES, type RateLimitPolicy } from '../src/security/rate-limit-policies'

const bucketPut = vi.fn(async () => undefined)
const bucketDelete = vi.fn(async () => undefined)
const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'test-secret',
  RATE_LIMIT_HMAC_SECRET: 'rate-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: { put: bucketPut, delete: bucketDelete } as unknown as R2Bucket,
}
const input: StoreCreateInput = {
  name: 'Loja', slug: 'loja-return-route', category: 'MERCADO', phone: '4433334444', city: 'C',
  addressText: 'Rua A', lat: -23.5, lng: -51.9,
  owner: { name: 'Lojista', email: 'route@return.test', password: 'senha123' },
}
let storeId: string
let storeToken: string
let otherStoreToken: string
let adminToken: string
let customerToken: string
let customerId: string
let driverId: string
let driverToken: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  bucketPut.mockClear(); bucketDelete.mockClear()
  const store = await createStoreWithOwner(testDb, input)
  const other = await createStoreWithOwner(testDb, {
    ...input, name: 'Outra', slug: 'outra-return-route', phone: '4433335555',
    owner: { name: 'Outra', email: 'other@return.test', password: 'senha123' },
  })
  storeId = store.id
  storeToken = await createTestSession({ sub: store.ownerUserId, role: 'STORE', name: 'Lojista' }, env.JWT_SECRET)
  otherStoreToken = await createTestSession({ sub: other.ownerUserId, role: 'STORE', name: 'Outra' }, env.JWT_SECRET)
  adminToken = await createTestSession({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Admin' }, env.JWT_SECRET)
  const customer = await registerUser(testDb, {
    name: 'Cliente', phone: '44999999999', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true,
  }, env.JWT_SECRET)
  const driver = await registerUser(testDb, {
    name: 'Driver', phone: '44911111111', password: 'senha123', role: 'DRIVER', acceptedTerms: true,
  }, env.JWT_SECRET)
  customerId = customer.user.id; driverId = driver.user.id
  driverToken = await createTestSession({ sub: driver.user.id, role: 'DRIVER', name: 'Driver' }, env.JWT_SECRET)
  await testDb.update(users).set({ status: 'ACTIVE' })
  customerToken = customer.accessToken!
})
afterAll(closeTestDb)

async function failedOrder() {
  const [order] = await testDb.insert(orders).values({
    storeId, customerId, status: 'DELIVERY_FAILED', fulfillment: 'DELIVERY', paymentMethod: 'CASH',
    subtotalCents: 1_000, deliveryFeeCents: 500, totalCents: 1_500,
    driverId, returnPendingAt: new Date(Date.now() - 90 * 60_000), returnDriverPayCents: 500,
    idempotencyKey: crypto.randomUUID(),
  }).returning()
  return order!
}

function req(path: string, init: RequestInit, token: string) {
  return app.request(path, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  }, env)
}

async function exhaust(policy: RateLimitPolicy, subject: string) {
  const limiter = new PostgresRateLimiter(testDb, env.RATE_LIMIT_HMAC_SECRET)
  for (let i = 0; i < policy.limit; i++) await limiter.consume(policy, subject)
}

function throwingBody() {
  return new ReadableStream({
    pull() {
      throw new Error('body was read')
    },
  }) as unknown as BodyInit
}

function streamingInit(init: RequestInit & { duplex: 'half' }) {
  return init as RequestInit
}

describe('rotas de devolução', () => {
  it('aplica RBAC/tenant e permite confirmação por loja ou suporte', async () => {
    const first = await failedOrder()
    expect((await req('/admin/returns', {}, customerToken)).status).toBe(403)
    const list = await req('/admin/returns', {}, adminToken)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject([{ id: first.id, returnPendingAgeMinutes: 90 }])
    expect((await req(`/store/me/orders/${first.id}/confirm-return`, { method: 'POST' }, otherStoreToken)).status).toBe(404)
    expect((await req(`/store/me/orders/${first.id}/confirm-return`, { method: 'POST' }, storeToken)).status).toBe(200)
    expect((await req(`/store/me/orders/${first.id}/confirm-return`, { method: 'POST' }, storeToken)).status).toBe(409)

    const second = await failedOrder()
    expect((await req(`/admin/orders/${second.id}/confirm-return`, { method: 'POST' }, adminToken)).status).toBe(200)
    expect(await testDb.select().from(ledgerEntries)).toHaveLength(2)
  })

  it('permite só ao driver do pedido declarar a devolução uma vez', async () => {
    const order = await failedOrder()
    expect((await req(`/driver/orders/${order.id}/returned`, { method: 'POST' }, customerToken)).status).toBe(403)

    const other = await registerUser(testDb, {
      name: 'Outro driver', phone: '44922222222', password: 'senha123', role: 'DRIVER', acceptedTerms: true,
    }, env.JWT_SECRET)
    await testDb.update(users).set({ status: 'ACTIVE' })
    const otherToken = await createTestSession({ sub: other.user.id, role: 'DRIVER', name: 'Outro driver' }, env.JWT_SECRET)
    expect((await req(`/driver/orders/${order.id}/returned`, { method: 'POST' }, otherToken)).status).toBe(404)

    expect((await req(`/driver/orders/${order.id}/returned`, { method: 'POST' }, driverToken)).status).toBe(200)
    expect((await req(`/driver/orders/${order.id}/returned`, { method: 'POST' }, driverToken)).status).toBe(409)
    const [saved] = await testDb.select().from(orders)
    expect(saved!.driverReturnedAt).toBeInstanceOf(Date)
    expect(await testDb.select().from(orderEvents)).toEqual([
      expect.objectContaining({ orderId: order.id, actorRole: 'DRIVER', note: 'entregador declarou devolução na loja' }),
    ])
  })

  it('aceita no máximo 2 imagens válidas e somente na devolução do próprio driver', async () => {
    const order = await failedOrder()
    const upload = (type = 'image/jpeg', body: BodyInit = new Uint8Array([1, 2, 3]), headers = {}) =>
      req(`/driver/orders/${order.id}/return-photo`, { method: 'PUT', body, headers: { 'Content-Type': type, ...headers } }, driverToken)

    expect((await upload('image/svg+xml')).status).toBe(400)
    expect((await upload('image/jpeg', new Uint8Array())).status).toBe(400)
    expect((await upload('image/jpeg', new Uint8Array([1]), { 'Content-Length': String(5 * 1024 * 1024 + 1) })).status).toBe(400)
    expect((await upload()).status).toBe(200)
    expect((await upload('image/png')).status).toBe(200)
    expect((await upload('image/webp')).status).toBe(400)
    expect(bucketPut).toHaveBeenCalledTimes(2)

    const [saved] = await testDb.select().from(orders)
    expect(saved!.returnPhotoKeys).toHaveLength(2)
    expect(saved!.returnPhotoKeys.every((key) => key.startsWith('returns/'))).toBe(true)

    const adminList = await req('/admin/returns', {}, adminToken)
    expect(await adminList.json()).toEqual([
      expect.objectContaining({ id: order.id, returnPhotoKeys: saved!.returnPhotoKeys }),
    ])
    const storeList = await req('/store/me/orders?scope=returns', {}, storeToken)
    expect(await storeList.json()).toEqual([
      expect.objectContaining({ id: order.id, returnPhotoKeys: saved!.returnPhotoKeys }),
    ])
    const driverList = await req('/driver/deliveries?scope=returns', {}, driverToken)
    expect(await driverList.json()).toEqual([
      expect.objectContaining({ id: order.id, returnPhotoCount: saved!.returnPhotoKeys.length }),
    ])

    const other = await failedOrder()
    await testDb.update(orders).set({ driverId: crypto.randomUUID() }).where(eq(orders.id, other.id))
    expect((await req(`/driver/orders/${other.id}/return-photo`, {
      method: 'PUT', body: new Uint8Array([1]), headers: { 'Content-Type': 'image/jpeg' },
    }, driverToken)).status).toBe(404)
  })

  it('rate-limits return photo before reading body or writing R2', async () => {
    const order = await failedOrder()
    await exhaust(POLICIES.returnUploadDriverHour, driverId)
    const res = await req(`/driver/orders/${order.id}/return-photo`, streamingInit({
      method: 'PUT',
      body: throwingBody(),
      headers: { 'Content-Type': 'image/jpeg' },
      duplex: 'half',
    }), driverToken)
    expect(res.status).toBe(429)
    expect(bucketPut).not.toHaveBeenCalled()
  })

  it('mantém dois slots sob uploads concorrentes e remove objetos que perderem a corrida', async () => {
    const order = await failedOrder()
    const responses = await Promise.all(Array.from({ length: 3 }, () => req(
      `/driver/orders/${order.id}/return-photo`,
      { method: 'PUT', body: new Uint8Array([1]), headers: { 'Content-Type': 'image/jpeg' } },
      driverToken,
    )))
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2)
    expect(responses.filter((response) => response.status === 400)).toHaveLength(1)
    expect(bucketPut.mock.calls.length - bucketDelete.mock.calls.length).toBe(2)
    const [saved] = await testDb.select().from(orders)
    expect(saved!.returnPhotoKeys).toHaveLength(2)
  })
})

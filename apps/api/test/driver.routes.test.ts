import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderStatus } from '@delivery/shared/constants'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { eq, inArray } from 'drizzle-orm'
import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import { ledgerEntries, users } from '../src/db/schema'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
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
let productId: string
let addressId: string
let driverId: string
let driver2Id: string
let driverToken: string
let driver2Token: string
let customerToken: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  storeId = store.id
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED',
    deliveryFixedFeeCents: 500,
  })
  const customer = await createVerifiedTestAccount(testDb, ana, env.JWT_SECRET)
  customerId = customer.user.id
  customerToken = customer.accessToken!
  addressId = (await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })).id
  const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
  productId = (await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })).id
  const d1 = await createVerifiedTestAccount(testDb, { ...ana, name: 'Duda', phone: '44911111111', role: 'DRIVER' }, env.JWT_SECRET)
  const d2 = await createVerifiedTestAccount(testDb, { ...ana, name: 'Edu', phone: '44922222222', role: 'DRIVER' }, env.JWT_SECRET)
  driverId = d1.user.id
  driver2Id = d2.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(inArray(users.id, [driverId, driver2Id]))
  driverToken = await createTestSession({ sub: driverId, role: 'DRIVER', name: 'Duda' }, env.JWT_SECRET)
  driver2Token = await createTestSession({ sub: driver2Id, role: 'DRIVER', name: 'Edu' }, env.JWT_SECRET)
})
afterAll(closeTestDb)

async function makeRequestedOrder() {
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY',
    addressId,
    paymentMethod: 'CASH',
    items: [{ productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
  })
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'ACCEPTED', customerId)
  await requestDriver(testDb, storeId, order.id)
  return order
}

function req(path: string, init: RequestInit = {}, token = driverToken) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  }, env)
}

async function ledgerSummary(orderId: string) {
  const rows = await testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId))
  return rows
    .map((e) => ({ party: e.party, type: e.type, amountCents: e.amountCents }))
    .sort((a, b) => `${a.party}:${a.type}`.localeCompare(`${b.party}:${b.type}`))
}

describe('driver flow via HTTP', () => {
  it('saves and clears driver pix key', async () => {
    const save = await req('/driver/me/pix-key', {
      method: 'PATCH',
      body: JSON.stringify({ pixKey: 'driver@pix.com' }),
    }, driverToken)
    expect(save.status).toBe(200)
    expect(((await save.json()) as { pixKey: string }).pixKey).toBe('driver@pix.com')

    const clear = await req('/driver/me/pix-key', {
      method: 'PATCH',
      body: JSON.stringify({ pixKey: null }),
    }, driverToken)
    expect(clear.status).toBe(200)
    expect(((await clear.json()) as { pixKey: string | null }).pixKey).toBeNull()
  })

  it('availability toggle + available list + accept + collect + deliver', async () => {
    const order = await makeRequestedOrder()
    const av = await req('/driver/me/availability', { method: 'PATCH', body: JSON.stringify({ isAvailable: true }) }, driverToken)
    expect(av.status).toBe(200)
    const list = await req('/driver/available', {}, driverToken)
    expect(list.status).toBe(200)
    const body = (await list.json()) as Record<string, unknown>[]
    expect(body).toHaveLength(1)
    expect(body[0]).not.toHaveProperty('customerName')
    const acc = await req(`/driver/orders/${order.id}/accept`, { method: 'POST' }, driverToken)
    expect(acc.status).toBe(200)
    expect(((await acc.json()) as { customerName: string }).customerName).toBe('Ana')
    expect((await req(`/driver/orders/${order.id}/accept`, { method: 'POST' }, driver2Token)).status).toBe(409)
    expect((await req(`/driver/orders/${order.id}/collect`, { method: 'POST' }, driverToken)).status).toBe(409)
    for (const to of ['PREPARING', 'READY']) {
      await storeUpdateOrderStatus(testDb, storeId, order.id, to as OrderStatus, customerId)
    }
    expect((await req(`/driver/orders/${order.id}/collect`, { method: 'POST' }, driverToken)).status).toBe(200)
    expect((await req(`/driver/orders/${order.id}/deliver`, { method: 'POST' }, driverToken)).status).toBe(200)
    expect(await ledgerSummary(order.id)).toEqual([
      { party: 'DRIVER', type: 'DRIVER_DELIVERY_CREDIT', amountCents: 500 },
      { party: 'STORE', type: 'STORE_DRIVER_FEE_DEBIT', amountCents: -500 },
    ])
    const done = await req('/driver/deliveries?scope=done', {}, driverToken)
    expect(((await done.json()) as unknown[]).length).toBe(1)
  })

  it('fail with reason; release returns to pool; 403 CUSTOMER role; 401 anon', async () => {
    const order = await makeRequestedOrder()
    await req(`/driver/orders/${order.id}/accept`, { method: 'POST' }, driverToken)
    const rel = await req(`/driver/orders/${order.id}/release`, { method: 'POST' }, driverToken)
    expect(rel.status).toBe(200)
    await req(`/driver/orders/${order.id}/accept`, { method: 'POST' }, driverToken)
    for (const to of ['PREPARING', 'READY']) {
      await storeUpdateOrderStatus(testDb, storeId, order.id, to as OrderStatus, customerId)
    }
    await req(`/driver/orders/${order.id}/collect`, { method: 'POST' }, driverToken)
    const fail = await req(`/driver/orders/${order.id}/fail`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'WRONG_ADDRESS', note: 'numero nao existe' }),
    }, driverToken)
    expect(fail.status).toBe(200)
    expect((await fail.json()) as { id: string; status: string }).toMatchObject({ id: order.id, status: 'DELIVERY_FAILED' })
    expect(await ledgerSummary(order.id)).toEqual([])
    expect((await req('/driver/available', {}, customerToken)).status).toBe(403)
    expect((await app.request('/driver/available', {}, env)).status).toBe(401)
    expect((await req('/driver/me/fcm-token', { method: 'POST', body: JSON.stringify({ token: 'tok-1234567890' }) }, driverToken)).status).toBe(200)
  })

  it('unavailable driver sees an empty pool', async () => {
    await makeRequestedOrder()
    const off = await req('/driver/available', {}, driverToken)
    expect(off.status).toBe(200)
    expect((await off.json()) as unknown[]).toHaveLength(0)
    await req('/driver/me/availability', { method: 'PATCH', body: JSON.stringify({ isAvailable: true }) }, driverToken)
    const on = await req('/driver/available', {}, driverToken)
    expect(((await on.json()) as unknown[]).length).toBe(1)
  })
})

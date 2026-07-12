import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import { orders, users } from '../src/db/schema'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { storeUpdateOrderStatus } from '../src/services/order-status.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}
const storeInput: StoreCreateInput = {
  name: 'Pizzaria',
  slug: 'pizzaria-batch-routes',
  category: 'PIZZARIA',
  phone: '4433334444',
  city: 'C',
  addressText: 'Rua A, 1',
  lat: -23.55,
  lng: -51.9,
  owner: { name: 'João', email: 'batch-routes-store@email.com', password: 'senha123' },
}
const customerInput = {
  name: 'Ana',
  phone: '44999998888',
  password: 'senha123',
  role: 'CUSTOMER' as const,
  acceptedTerms: true as const,
}

let storeId: string
let ownerToken: string
let otherOwnerToken: string
let customerId: string
let customerToken: string
let addressId: string
let productId: string
let driverToken: string
let driver2Token: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  const other = await createStoreWithOwner(testDb, {
    ...storeInput,
    name: 'Sushi',
    slug: 'sushi-batch-routes',
    phone: '4433335555',
    owner: { name: 'Maria', email: 'batch-routes-other@email.com', password: 'senha123' },
  })
  storeId = store.id
  ownerToken = await createTestSession({ sub: store.ownerUserId, role: 'STORE', name: 'João' }, env.JWT_SECRET)
  otherOwnerToken = await createTestSession({ sub: other.ownerUserId, role: 'STORE', name: 'Maria' }, env.JWT_SECRET)
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED',
    deliveryFixedFeeCents: 500,
  })
  const customer = await createVerifiedTestAccount(testDb, customerInput, env.JWT_SECRET)
  customerId = customer.user.id
  customerToken = customer.accessToken!
  addressId = (await createAddress(testDb, customerId, {
    addressText: 'Rua B, 22', lat: -23.56, lng: -51.9,
  })).id
  const category = await createCategory(testDb, storeId, { name: 'Pizzas' })
  productId = (await createProduct(testDb, storeId, {
    categoryId: category.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true,
  })).id
  const driver = await createVerifiedTestAccount(testDb, { ...customerInput, name: 'Duda', phone: '44911111111', role: 'DRIVER' }, env.JWT_SECRET)
  const driver2 = await createVerifiedTestAccount(testDb, { ...customerInput, name: 'Edu', phone: '44922222222', role: 'DRIVER' }, env.JWT_SECRET)
  await testDb.update(users).set({ status: 'ACTIVE' }).where(inArray(users.id, [driver.user.id, driver2.user.id]))
  driverToken = await createTestSession({ sub: driver.user.id, role: 'DRIVER', name: 'Duda' }, env.JWT_SECRET)
  driver2Token = await createTestSession({ sub: driver2.user.id, role: 'DRIVER', name: 'Edu' }, env.JWT_SECRET)
})
afterAll(closeTestDb)

function req(path: string, init: RequestInit = {}, token = ownerToken) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  }, env)
}

async function eligibleOrder() {
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: 'pizzaria-batch-routes',
    fulfillment: 'DELIVERY',
    addressId,
    paymentMethod: 'CASH',
    items: [{ productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
  })
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'ACCEPTED', customerId)
  return order.id
}

async function createPackage() {
  const orderIds = await Promise.all([eligibleOrder(), eligibleOrder()])
  const response = await req('/store/me/batches', { method: 'POST', body: JSON.stringify({ orderIds }) })
  expect(response.status).toBe(201)
  return { orderIds, batch: await response.json() as { id: string; status: string } }
}

describe('batch routes', () => {
  it('store creates and broadcasts; available driver sees and accepts it', async () => {
    const { batch, orderIds } = await createPackage()
    expect(batch.status).toBe('OPEN')
    expect((await req(`/store/me/batches/${batch.id}/broadcast`, { method: 'POST' })).status).toBe(200)

    expect((await req('/driver/batches', {}, driverToken)).status).toBe(200)
    expect((await (await req('/driver/batches', {}, driverToken)).json()) as unknown[]).toHaveLength(0)
    await req('/driver/me/availability', { method: 'PATCH', body: JSON.stringify({ isAvailable: true }) }, driverToken)
    const available = await req('/driver/batches', {}, driverToken)
    expect(available.status).toBe(200)
    expect(await available.json()).toMatchObject([{ batchId: batch.id, count: 2, feeTotalCents: 1000 }])
    expect((await req(`/driver/batches/${batch.id}/accept`, { method: 'POST' }, driverToken)).status).toBe(200)
    expect((await req(`/driver/batches/${batch.id}/accept`, { method: 'POST' }, driver2Token)).status).toBe(409)
    expect((await testDb.select().from(orders).where(inArray(orders.id, orderIds))).every((o) => o.driverId)).toBe(true)
  })

  it('requires all READY before collection and then exposes normal active deliveries', async () => {
    const { batch, orderIds } = await createPackage()
    await req(`/store/me/batches/${batch.id}/broadcast`, { method: 'POST' })
    await req('/driver/me/availability', { method: 'PATCH', body: JSON.stringify({ isAvailable: true }) }, driverToken)
    await req(`/driver/batches/${batch.id}/accept`, { method: 'POST' }, driverToken)
    expect((await req(`/driver/batches/${batch.id}/collect`, { method: 'POST' }, driverToken)).status).toBe(409)
    for (const id of orderIds) {
      await storeUpdateOrderStatus(testDb, storeId, id, 'PREPARING', customerId)
      await storeUpdateOrderStatus(testDb, storeId, id, 'READY', customerId)
    }
    expect((await req(`/driver/batches/${batch.id}/collect`, { method: 'POST' }, driverToken)).status).toBe(200)
    const active = await req('/driver/deliveries?scope=active', {}, driverToken)
    expect(await active.json()).toMatchObject([
      { status: 'OUT_FOR_DELIVERY', batchId: batch.id },
      { status: 'OUT_FOR_DELIVERY', batchId: batch.id },
    ])
  })

  it('enforces tenant and roles', async () => {
    const { batch } = await createPackage()
    expect((await req(`/store/me/batches/${batch.id}`, { method: 'DELETE' }, otherOwnerToken)).status).toBe(404)
    expect((await req('/store/me/batches', {}, customerToken)).status).toBe(403)
    expect((await req('/driver/batches', {}, customerToken)).status).toBe(403)
    expect((await req(`/driver/batches/${batch.id}/accept`, { method: 'POST' }, driverToken)).status).toBe(409)
    expect(await testDb.select({ id: orders.id }).from(orders).where(eq(orders.batchId, batch.id))).toHaveLength(2)
  })
})

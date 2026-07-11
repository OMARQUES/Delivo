import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { ledgerEntries, orders, users } from '../src/db/schema'
import { signAccessToken } from '../src/lib/tokens'
import { registerUser } from '../src/services/auth.service'
import { createStoreWithOwner } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret', ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive, BUCKET: {} as R2Bucket,
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

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, input)
  const other = await createStoreWithOwner(testDb, {
    ...input, name: 'Outra', slug: 'outra-return-route', phone: '4433335555',
    owner: { name: 'Outra', email: 'other@return.test', password: 'senha123' },
  })
  storeId = store.id
  storeToken = await signAccessToken({ sub: store.ownerUserId, role: 'STORE', name: 'Lojista' }, env.JWT_SECRET)
  otherStoreToken = await signAccessToken({ sub: other.ownerUserId, role: 'STORE', name: 'Outra' }, env.JWT_SECRET)
  adminToken = await signAccessToken({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Admin' }, env.JWT_SECRET)
  const customer = await registerUser(testDb, {
    name: 'Cliente', phone: '44999999999', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true,
  }, env.JWT_SECRET)
  const driver = await registerUser(testDb, {
    name: 'Driver', phone: '44911111111', password: 'senha123', role: 'DRIVER', acceptedTerms: true,
  }, env.JWT_SECRET)
  customerId = customer.user.id; driverId = driver.user.id
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
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  }, env)
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
})

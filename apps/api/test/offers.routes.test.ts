import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import { users } from '../src/db/schema'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createStoreWithOwner } from '../src/services/store.service'

const env = { JWT_SECRET: 'test-secret', ALLOWED_ORIGINS: 'http://localhost:5173', HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive, BUCKET: {} as R2Bucket }
let storeToken: string; let otherStoreToken: string; let driverToken: string; let customerToken: string
beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const base = { category: 'MERCADO' as const, phone: '4433334444', city: 'C', addressText: 'Rua A', lat: -23.5, lng: -51.9 }
  const store = await createStoreWithOwner(testDb, { ...base, name: 'Loja', slug: 'rota-oferta', owner: { name: 'L', email: 'loja@rota-oferta.test', password: 'senha123' } })
  const other = await createStoreWithOwner(testDb, { ...base, name: 'Outra', slug: 'outra-rota-oferta', phone: '4433335555', owner: { name: 'O', email: 'outra@rota-oferta.test', password: 'senha123' } })
  storeToken = await createTestSession({ sub: store.ownerUserId, role: 'STORE', name: 'L' }, env.JWT_SECRET)
  otherStoreToken = await createTestSession({ sub: other.ownerUserId, role: 'STORE', name: 'O' }, env.JWT_SECRET)
  const driver = await createVerifiedTestAccount(testDb, { name: 'D', phone: '44911111111', password: 'senha123', role: 'DRIVER', acceptedTerms: true }, env.JWT_SECRET)
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driver.user.id))
  driverToken = await createTestSession({ sub: driver.user.id, role: 'DRIVER', name: 'D' }, env.JWT_SECRET)
  customerToken = await createTestSession({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
})
afterAll(closeTestDb)
function req(path: string, init: RequestInit, token: string) {
  return app.request(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }, env)
}
describe('ofertas via HTTP', () => {
  it('cobre publicação, tenant, RBAC, listagem e aceite', async () => {
    const created = await req('/store/me/offers', { method: 'POST', body: JSON.stringify({ dailyRateCents: 8_000, perDeliveryCents: 700,
      slots: 1, recurrence: { kind: 'WEEKLY', days: [1] }, start: '11:00', end: '15:00', note: 'Bag',
    }) }, storeToken)
    expect(created.status).toBe(201)
    const offer = await created.json() as { id: string }
    expect((await req(`/store/me/offers/${offer.id}/close`, { method: 'POST' }, otherStoreToken)).status).toBe(404)
    expect((await req('/store/me/offers', { method: 'GET' }, customerToken)).status).toBe(403)
    const listed = await req('/driver/offers', { method: 'GET' }, driverToken)
    expect(await listed.json()).toMatchObject([{ id: offer.id, storeName: 'Loja' }])
    const accepted = await req(`/driver/offers/${offer.id}/accept`, { method: 'POST' }, driverToken)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ link: { status: 'CONFIRMED', dailyRateCents: 8_000 } })
    expect((await req('/driver/offers', { method: 'GET' }, customerToken)).status).toBe(403)
  })
})

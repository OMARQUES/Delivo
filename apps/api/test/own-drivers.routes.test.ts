import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { inArray } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { users } from '../src/db/schema'
import { signAccessToken } from '../src/lib/tokens'
import { registerUser } from '../src/services/auth.service'
import { confirmLink, inviteDriver } from '../src/services/store-driver.service'
import { startShift } from '../src/services/shift.service'
import { createStoreWithOwner } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret', ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive, BUCKET: {} as R2Bucket,
}
const baseStore: StoreCreateInput = {
  name: 'Loja', slug: 'loja-termos', category: 'MERCADO', phone: '4433334444', city: 'C',
  addressText: 'Rua A', lat: -23.55, lng: -51.9,
  owner: { name: 'Lojista', email: 'loja@termos.test', password: 'senha123' },
}
let storeId: string
let storeToken: string
let otherStoreToken: string
let driverId: string
let driverToken: string
let otherDriverToken: string
let customerToken: string
let linkId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, baseStore)
  storeId = store.id
  storeToken = await signAccessToken({ sub: store.ownerUserId, role: 'STORE', name: 'Lojista' }, env.JWT_SECRET)
  const otherStore = await createStoreWithOwner(testDb, {
    ...baseStore, name: 'Outra', slug: 'outra-termos', phone: '4433335555',
    owner: { name: 'Outra', email: 'outra@termos.test', password: 'senha123' },
  })
  otherStoreToken = await signAccessToken({ sub: otherStore.ownerUserId, role: 'STORE', name: 'Outra' }, env.JWT_SECRET)
  const input = { name: 'D', phone: '44911111111', password: 'senha123', role: 'DRIVER' as const, acceptedTerms: true as const }
  const driver = await registerUser(testDb, input, env.JWT_SECRET)
  const other = await registerUser(testDb, { ...input, phone: '44922222222' }, env.JWT_SECRET)
  driverId = driver.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(inArray(users.id, [driver.user.id, other.user.id]))
  driverToken = await signAccessToken({ sub: driver.user.id, role: 'DRIVER', name: 'D' }, env.JWT_SECRET)
  otherDriverToken = await signAccessToken({ sub: other.user.id, role: 'DRIVER', name: 'O' }, env.JWT_SECRET)
  customerToken = await signAccessToken({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
  const link = await inviteDriver(testDb, storeId, input.phone, { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: [] })
  linkId = link.id
  await confirmLink(testDb, driverId, linkId)
})
afterAll(closeTestDb)

function req(path: string, init: RequestInit, token: string) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  }, env)
}

describe('termos e reajuste via HTTP', () => {
  it('propõe sem ativar, só o entregador vinculado confirma e RBAC bloqueia cliente', async () => {
    const proposed = await req(`/store/me/drivers/${linkId}`, {
      method: 'PATCH', body: JSON.stringify({ dailyRateCents: 7_000, perDeliveryCents: 800 }),
    }, storeToken)
    expect(proposed.status).toBe(200)
    expect(await proposed.json()).toMatchObject({ dailyRateCents: 5_000, pendingDailyRateCents: 7_000 })
    expect((await req(`/driver/links/${linkId}/terms/confirm`, { method: 'POST' }, otherDriverToken)).status).toBe(404)
    const confirmed = await req(`/driver/links/${linkId}/terms/confirm`, { method: 'POST' }, driverToken)
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toMatchObject({ dailyRateCents: 7_000, perDeliveryCents: 800, pendingProposedAt: null })
    expect((await req(`/store/me/drivers/${linkId}`, {
      method: 'PATCH', body: JSON.stringify({ dailyRateCents: 1 }),
    }, customerToken)).status).toBe(403)
  })

  it('reajusta somente turno ativo da própria loja', async () => {
    const shift = await startShift(testDb, driverId, storeId, { lat: -23.55, lng: -51.9 })
    expect((await req(`/store/me/shifts/${shift.id}`, {
      method: 'PATCH', body: JSON.stringify({ dailyRateCents: 9_000, perDeliveryCents: 900 }),
    }, otherStoreToken)).status).toBe(404)
    const adjusted = await req(`/store/me/shifts/${shift.id}`, {
      method: 'PATCH', body: JSON.stringify({ dailyRateCents: 9_000, perDeliveryCents: 900 }),
    }, storeToken)
    expect(adjusted.status).toBe(200)
    expect(await adjusted.json()).toMatchObject({ dailyRateCents: 9_000, perDeliveryCents: 900 })
  })
})

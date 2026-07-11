import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import { loginUser, registerUser } from '../src/services/auth.service'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

let adminToken: string
let driverUserId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  adminToken = await createTestSession({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Root' }, env.JWT_SECRET)
  const d = await registerUser(testDb, {
    name: 'Duda',
    phone: '44911111111',
    password: 'senha123',
    role: 'DRIVER',
    acceptedTerms: true,
  }, env.JWT_SECRET)
  driverUserId = d.user.id
})
afterAll(closeTestDb)

function req(path: string, init: RequestInit = {}, token = adminToken) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  }, env)
}

describe('/admin/drivers', () => {
  it('lists drivers with status; approve activates login', async () => {
    const list = await req('/admin/drivers')
    expect(list.status).toBe(200)
    const body = (await list.json()) as { id: string; status: string }[]
    expect(body[0]).toMatchObject({ id: driverUserId, status: 'PENDING' })

    await expect(loginUser(testDb, { identifier: '44911111111', password: 'senha123' }, env.JWT_SECRET))
      .rejects.toThrow('aguardando aprovação')

    const patch = await req(`/admin/drivers/${driverUserId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ACTIVE' }),
    })
    expect(patch.status).toBe(200)
    const login = await loginUser(testDb, { identifier: '44911111111', password: 'senha123' }, env.JWT_SECRET)
    expect(login.accessToken).toBeTruthy()
  })

  it('block works; cannot target non-driver users; 403 non-admin', async () => {
    await req(`/admin/drivers/${driverUserId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }) })
    const block = await req(`/admin/drivers/${driverUserId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'BLOCKED' }) })
    expect(((await block.json()) as { status: string }).status).toBe('BLOCKED')

    const customer = await registerUser(testDb, {
      name: 'Ana',
      phone: '44999998888',
      password: 'senha123',
      role: 'CUSTOMER',
      acceptedTerms: true,
    }, env.JWT_SECRET)
    expect((await req(`/admin/drivers/${customer.user.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'BLOCKED' }) })).status).toBe(404)

    const custToken = customer.accessToken!
    expect((await req('/admin/drivers', {}, custToken)).status).toBe(403)
  })
})

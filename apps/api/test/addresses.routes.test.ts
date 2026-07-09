import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { registerUser } from '../src/services/auth.service'

const env = {
  JWT_SECRET: 'test-secret', ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive, BUCKET: {} as R2Bucket,
}

let token: string
const ana = { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER' as const, acceptedTerms: true as const }
const addr = { addressText: 'Rua A, 123 - Centro', reference: 'Portão azul', lat: -23.5, lng: -51.9 }

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const r = await registerUser(testDb, ana, env.JWT_SECRET)
  token = r.accessToken!
})
afterAll(closeTestDb)

function req(path: string, init: RequestInit = {}, t = token) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(init.headers as Record<string, string>) },
  }, env)
}

describe('/me/addresses', () => {
  it('POST creates, GET lists own only, DELETE removes', async () => {
    const post = await req('/me/addresses', { method: 'POST', body: JSON.stringify(addr) })
    expect(post.status).toBe(201)
    const { id } = (await post.json()) as { id: string }
    const list = await req('/me/addresses')
    expect(((await list.json()) as unknown[]).length).toBe(1)
    expect((await req(`/me/addresses/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect(((await (await req('/me/addresses')).json()) as unknown[]).length).toBe(0)
  })

  it('401 anon; cannot delete another user address (404)', async () => {
    expect((await app.request('/me/addresses', {}, env)).status).toBe(401)
    const other = await registerUser(testDb, { ...ana, phone: '44911112222' }, env.JWT_SECRET)
    const post = await req('/me/addresses', { method: 'POST', body: JSON.stringify(addr) })
    const { id } = (await post.json()) as { id: string }
    expect((await req(`/me/addresses/${id}`, { method: 'DELETE' }, other.accessToken!)).status).toBe(404)
  })
})

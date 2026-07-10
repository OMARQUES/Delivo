import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { signAccessToken } from '../src/lib/tokens'
import { createStoreWithOwner } from '../src/services/store.service'

const put = vi.fn(async () => ({}))
const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: { put } as unknown as R2Bucket,
}

const input = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA' as const, phone: '4433334444',
  city: 'Cidade Exemplo', addressText: 'Rua Central, 100', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  put.mockClear()
})
afterAll(closeTestDb)

async function makeStore() {
  const store = await createStoreWithOwner(testDb, input)
  const token = await signAccessToken({ sub: store.ownerUserId, role: 'STORE', name: 'João' }, env.JWT_SECRET)
  return { store, token }
}

describe('GET/PATCH /store/me', () => {
  it('owner reads and updates own store', async () => {
    const { token } = await makeStore()
    const get = await app.request('/store/me', { headers: { Authorization: `Bearer ${token}` } }, env)
    expect(get.status).toBe(200)
    expect(((await get.json()) as { slug: string }).slug).toBe('pizzaria-do-joao')

    const patch = await app.request('/store/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPaused: true, minOrderCents: 2000 }),
    }, env)
    expect(patch.status).toBe(200)
    const body = (await patch.json()) as { isPaused: boolean; minOrderCents: number }
    expect(body.isPaused).toBe(true)
    expect(body.minOrderCents).toBe(2000)
  })

  it('updates pix key for weekly payouts', async () => {
    const { token } = await makeStore()
    const patch = await app.request('/store/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pixKey: 'chave@pix.com' }),
    }, env)
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as { pixKey: string }).pixKey).toBe('chave@pix.com')

    const get = await app.request('/store/me', { headers: { Authorization: `Bearer ${token}` } }, env)
    expect(((await get.json()) as { pixKey: string }).pixKey).toBe('chave@pix.com')
  })

  it('401 anon, 403 CUSTOMER, 404 STORE sem loja', async () => {
    expect((await app.request('/store/me', {}, env)).status).toBe(401)
    const cust = await signAccessToken({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
    expect((await app.request('/store/me', { headers: { Authorization: `Bearer ${cust}` } }, env)).status).toBe(403)
    const orphanStore = await signAccessToken({ sub: crypto.randomUUID(), role: 'STORE', name: 'S' }, env.JWT_SECRET)
    expect((await app.request('/store/me', { headers: { Authorization: `Bearer ${orphanStore}` } }, env)).status).toBe(404)
  })
})

describe('PUT /store/me/logo', () => {
  it('stores image in bucket and saves logoKey', async () => {
    const { token } = await makeStore()
    const res = await app.request('/store/me/logo', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
      body: new Uint8Array([137, 80, 78, 71]),
    }, env)
    expect(res.status).toBe(200)
    const { logoKey } = (await res.json()) as { logoKey: string }
    expect(logoKey).toMatch(/^logos\//)
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('rejects non-image content types', async () => {
    const { token } = await makeStore()
    const res = await app.request('/store/me/logo', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html' },
      body: 'nope',
    }, env)
    expect(res.status).toBe(400)
  })
})

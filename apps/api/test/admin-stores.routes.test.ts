import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { signAccessToken } from '../src/lib/tokens'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const storeInput = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA',
  phone: '(44) 3333-4444', city: 'Cidade Exemplo', addressText: 'Rua Central, 100',
  lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

async function adminToken() {
  return signAccessToken({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Root' }, env.JWT_SECRET)
}
async function customerToken() {
  return signAccessToken({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
}

type StoreBody = { id: string; slug: string; isActive: boolean }

function req(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) }
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(path, { ...init, headers }, env)
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('POST /admin/stores', () => {
  it('admin creates store, 201', async () => {
    const res = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    expect(res.status).toBe(201)
    const body = (await res.json()) as StoreBody
    expect(body.slug).toBe('pizzaria-do-joao')
    expect(body).not.toHaveProperty('owner')
  })

  it('401 sem token, 403 role errado, 400 slug reservado, 409 duplicado', async () => {
    expect((await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) })).status).toBe(401)
    expect((await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await customerToken())).status).toBe(403)
    const reserved = await req('/admin/stores', { method: 'POST', body: JSON.stringify({ ...storeInput, slug: 'admin' }) }, await adminToken())
    expect(reserved.status).toBe(400)
    await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const dup = await req('/admin/stores', { method: 'POST', body: JSON.stringify({ ...storeInput, owner: { ...storeInput.owner, email: 'z@y.com' } }) }, await adminToken())
    expect(dup.status).toBe(409)
  })
})

describe('GET /admin/stores + PATCH active', () => {
  it('lists all (including inactive) and toggles active', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { id } = (await create.json()) as StoreBody
    const patch = await req(`/admin/stores/${id}/active`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) }, await adminToken())
    expect(patch.status).toBe(200)
    const list = await req('/admin/stores', {}, await adminToken())
    const body = (await list.json()) as StoreBody[]
    expect(body).toHaveLength(1)
    expect(body[0]?.isActive).toBe(false)
  })
})

describe('POST /admin/stores/:id/catalog/import', () => {
  it('imports csv, returns counts + line errors', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { id } = (await create.json()) as { id: string }
    const csv = 'Pizzas;Mussarela;;30,00\nPizzas;SemPreco;;\nBebidas;Coca;;10,00'
    const res = await req(`/admin/stores/${id}/catalog/import`, {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv,
    }, await adminToken())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { createdCategories: number; createdProducts: number; errors: { line: number }[] }
    expect(body.createdCategories).toBe(2)
    expect(body.createdProducts).toBe(2)
    expect(body.errors).toHaveLength(1)
  })

  it('403 non-admin, 404 unknown store', async () => {
    expect((await req(`/admin/stores/${crypto.randomUUID()}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await customerToken())).status).toBe(403)
    expect((await req(`/admin/stores/${crypto.randomUUID()}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await adminToken())).status).toBe(404)
  })
})

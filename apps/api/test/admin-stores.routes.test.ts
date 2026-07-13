import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'

const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'test-secret',
  AUTH_CODE_SECRET: 'admin-store-activation-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const storeInput = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA',
  phone: '(44) 3333-4444', city: 'Cidade Exemplo', addressText: 'Rua Central, 100',
  lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com' },
}

async function adminToken() {
  return createTestSession({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Root' }, env.JWT_SECRET)
}
async function customerToken() {
  return createTestSession({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
}

type StoreBody = { id: string; slug: string; securityStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | 'PENDING_ACTIVATION' }

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
    expect(body.securityStatus).toBe('PENDING_ACTIVATION')
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

describe('GET /admin/stores + PATCH security status', () => {
  it('lists all and permits closing a pending store', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { id } = (await create.json()) as StoreBody
    const patch = await req(`/admin/stores/${id}/security-status`, { method: 'PATCH', body: JSON.stringify({ securityStatus: 'CLOSED' }) }, await adminToken())
    expect(patch.status).toBe(200)
    const list = await req('/admin/stores', {}, await adminToken())
    const body = (await list.json()) as StoreBody[]
    expect(body).toHaveLength(1)
    expect(body[0]?.securityStatus).toBe('CLOSED')
  })
})

describe('PATCH /admin/stores/:id/commission', () => {
  it('admin define comissão (bps); reflete na listagem', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { id } = (await create.json()) as StoreBody
    const patch = await req(`/admin/stores/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: 1200 }) }, await adminToken())
    expect(patch.status).toBe(200)
    const list = await req('/admin/stores', {}, await adminToken())
    const body = (await list.json()) as { id: string; commissionBps: number }[]
    expect(body.find((s) => s.id === id)?.commissionBps).toBe(1200)
  })

  it('403 não-admin, 404 loja inexistente, 400 fora de 0..10000', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { id } = (await create.json()) as StoreBody
    expect((await req(`/admin/stores/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: 1000 }) }, await customerToken())).status).toBe(403)
    expect((await req(`/admin/stores/${crypto.randomUUID()}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: 1000 }) }, await adminToken())).status).toBe(404)
    expect((await req(`/admin/stores/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: 10001 }) }, await adminToken())).status).toBe(400)
    expect((await req(`/admin/stores/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: -1 }) }, await adminToken())).status).toBe(400)
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

  it('400 non-uuid id', async () => {
    const res = await req('/admin/stores/abc/catalog/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await adminToken())
    expect(res.status).toBe(400)
  })

  it('400 csv over line cap', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { id } = (await create.json()) as { id: string }
    const csv = Array.from({ length: 2001 }, (_, i) => `Cat;Prod${i};;1,00`).join('\n')
    const res = await req(`/admin/stores/${id}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv }, await adminToken())
    expect(res.status).toBe(400)
  })

  it('403 non-admin, 404 unknown store', async () => {
    expect((await req(`/admin/stores/${crypto.randomUUID()}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await customerToken())).status).toBe(403)
    expect((await req(`/admin/stores/${crypto.randomUUID()}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await adminToken())).status).toBe(404)
  })
})

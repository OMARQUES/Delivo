import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createStoreWithOwner } from '../src/services/store.service'
import { createCategory, createProduct } from '../src/services/catalog.service'

const env = {
  JWT_SECRET: 'test-secret', ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const storeInput: StoreCreateInput = {
  name: 'Pizzaria', slug: 'pizzaria', category: 'PIZZARIA', phone: '4433334444',
  city: 'C', addressText: 'Rua A, 1', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

async function seedMenu() {
  const store = await createStoreWithOwner(testDb, storeInput)
  const cat = await createCategory(testDb, store.id, { name: 'Pizzas' })
  await createProduct(testDb, store.id, { categoryId: cat.id, name: 'Pizza Calabresa', basePriceCents: 3500, isAvailable: true })
  return store
}

describe('GET /stores/:slug/menu', () => {
  it('returns nested menu publicly; 404 unknown', async () => {
    await seedMenu()
    const res = await app.request('/stores/pizzaria/menu', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { categories: { name: string; products: { name: string; groups: unknown[] }[] }[] }
    expect(body.categories[0]!.products[0]!.name).toBe('Pizza Calabresa')
    expect((await app.request('/stores/nope/menu', {}, env)).status).toBe(404)
  })
})

describe('GET /search', () => {
  it('finds products grouped by store; empty q rejected', async () => {
    await seedMenu()
    const res = await app.request('/search?q=calabresa', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { store: { slug: string }; products: { name: string }[] }[]
    expect(body[0]!.store.slug).toBe('pizzaria')
    expect((await app.request('/search?q=a', {}, env)).status).toBe(200) // <2 chars → []
    expect(((await (await app.request('/search?q=a', {}, env)).json()) as unknown[]).length).toBe(0)
  })
})

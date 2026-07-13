import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { createActiveStoreTestFixture, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { setStoreSecurityStatus } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const base = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA' as const, phone: '4433334444',
  city: 'Cidade Exemplo', addressText: 'Rua Central, 100', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('GET /stores', () => {
  it('lists active stores publicly (no auth), hides owner fields', async () => {
    await createActiveStoreTestFixture(base)
    const inactive = await createActiveStoreTestFixture({
      ...base, slug: 'fechada', name: 'Fechada', owner: { ...base.owner, email: 'f@y.com' },
    })
    await setStoreSecurityStatus(testDb, inactive.id, 'SUSPENDED')
    const res = await app.request('/stores', {}, env)
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]?.slug).toBe('pizzaria-do-joao')
    expect(list[0]).toHaveProperty('isOpen')
    expect(list[0]).not.toHaveProperty('ownerUserId')
  })
})

describe('GET /stores/:slug', () => {
  it('returns store by slug case-insensitive; 404 unknown/inactive', async () => {
    await createActiveStoreTestFixture(base)
    const res = await app.request('/stores/PIZZARIA-DO-JOAO', {}, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('Pizzaria do João')
    expect((await app.request('/stores/nao-existe', {}, env)).status).toBe(404)
  })
})

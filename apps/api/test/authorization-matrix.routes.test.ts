import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { createActiveStoreTestFixture, migrateTestDb, truncateAll, testDb, closeTestDb, createTestSession } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  APP_ENV: 'local',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: { get: async () => null } as unknown as R2Bucket,
}

const ID = '00000000-0000-4000-8000-000000000000'
const STORE_SLUG = 'loja-matriz'

type Actor = 'ANON' | 'CUSTOMER' | 'DRIVER' | 'STORE_A' | 'STORE_B' | 'ADMIN'
type Allowed = 'CUSTOMER' | 'DRIVER' | 'STORE' | 'ADMIN' | 'ANY'
type Entry = { m: string; p: string; role: Allowed }

const ACTORS: Actor[] = ['ANON', 'CUSTOMER', 'DRIVER', 'STORE_A', 'STORE_B', 'ADMIN']
const AUTHENTICATED: Actor[] = ACTORS.filter((actor) => actor !== 'ANON')
let tokens: Record<Actor, string | null>

const anyAuthenticated = ['GET /auth/me', 'POST /auth/logout', 'POST /auth/logout-all']

const customer = [
  'PATCH /auth/me/contact',
  'GET /me/addresses',
  'POST /me/addresses',
  'DELETE /me/addresses/{id}',
  'POST /orders/quote',
  'POST /orders',
  'GET /orders',
  'GET /orders/{id}',
  'POST /orders/{id}/amendments/current/approve',
  'POST /orders/{id}/amendments/current/reject',
  'POST /orders/{id}/cancel',
  'POST /orders/{id}/cancel-request',
]

const driver = [
  'GET /driver/offers',
  'POST /driver/offers/{id}/accept',
  'POST /driver/offers/{id}/dismiss',
  'GET /driver/links',
  'POST /driver/links/{id}/confirm',
  'POST /driver/links/{id}/terms/confirm',
  'POST /driver/links/{id}/terms/reject',
  'GET /driver/shifts/active',
  'POST /driver/shifts',
  'GET /driver/shift-authorizations',
  'POST /driver/shift-authorizations/{id}/accept',
  'POST /driver/shift-authorizations/{id}/reject',
  'POST /driver/shifts/{id}/terms/{proposalId}/accept',
  'POST /driver/shifts/{id}/terms/{proposalId}/reject',
  'POST /driver/shifts/{id}/end',
  'POST /driver/shifts/{id}/reactivate',
  'GET /driver/shifts/recent',
  'GET /driver/shift-deliveries',
  'GET /driver/shift-batches',
  'POST /driver/orders/{id}/accept-shift',
  'POST /driver/orders/{id}/refuse-direct',
  'POST /driver/orders/{id}/arrived',
  'GET /driver/me',
  'GET /driver/batches',
  'POST /driver/batches/{id}/accept',
  'POST /driver/batches/{id}/release',
  'POST /driver/batches/{id}/refuse',
  'POST /driver/batches/{id}/collect',
  'PATCH /driver/me/availability',
  'POST /driver/me/fcm-token',
  'PATCH /driver/me/pix-key',
  'GET /driver/available',
  'GET /driver/deliveries?scope=active',
  'POST /driver/orders/{id}/accept',
  'POST /driver/orders/{id}/release',
  'POST /driver/orders/{id}/collect',
  'POST /driver/orders/{id}/deliver',
  'POST /driver/orders/{id}/returned',
  'PUT /driver/orders/{id}/return-photo',
  'POST /driver/orders/{id}/fail',
  'GET /driver/me/finance',
  'GET /driver/earnings/orders/{id}',
]

const store = [
  'GET /store/me',
  'PATCH /store/me',
  'PUT /store/me/logo',
  'GET /store/me/catalog',
  'POST /store/me/categories',
  'PATCH /store/me/categories/{id}',
  'DELETE /store/me/categories/{id}',
  'POST /store/me/products',
  'PATCH /store/me/products/{id}',
  'DELETE /store/me/products/{id}',
  'PUT /store/me/products/{id}/options',
  'PATCH /store/me/options/{id}',
  'PUT /store/me/products/{id}/photo',
  'POST /store/me/offers',
  'GET /store/me/offers',
  'POST /store/me/offers/{id}/close',
  'GET /store/me/drivers',
  'POST /store/me/drivers',
  'PATCH /store/me/drivers/{id}',
  'DELETE /store/me/drivers/{id}',
  'GET /store/me/shifts',
  'POST /store/me/shifts/{id}/terms',
  'POST /store/me/shifts/{id}/terms/{proposalId}/cancel',
  'POST /store/me/shift-authorizations',
  'POST /store/me/shift-authorizations/{id}/cancel',
  'POST /store/me/shifts/{id}/release',
  'POST /store/me/shifts/{id}/daily/approve',
  'POST /store/me/shifts/{id}/daily/reject',
  'POST /store/me/shifts/{id}/reactivation',
  'POST /store/me/orders/{id}/confirm-return',
  'POST /store/me/orders/{id}/release-driver',
  'GET /store/me/batches',
  'POST /store/me/orders/{id}/request-own',
  'POST /store/me/orders/{id}/request-specific',
  'POST /store/me/orders/{id}/request-withdraw',
  'POST /store/me/batches',
  'POST /store/me/batches/{id}/broadcast',
  'DELETE /store/me/batches/{id}',
  'GET /store/me/orders',
  'GET /store/me/orders/{id}',
  'POST /store/me/orders/{id}/amendments',
  'DELETE /store/me/orders/{id}/amendments/current',
  'PATCH /store/me/orders/{id}/status',
  'POST /store/me/orders/{id}/request-driver',
  'POST /store/me/orders/{id}/cancel-request/approve',
  'POST /store/me/orders/{id}/cancel-request/deny',
  'GET /store/me/finance',
]

const admin = [
  'GET /admin/drivers',
  'PATCH /admin/drivers/{id}/status',
  'GET /admin/returns',
  'POST /admin/orders/{id}/confirm-return',
  'POST /admin/stores',
  'POST /admin/stores/{id}/activation/resend',
  'GET /admin/stores',
  'PATCH /admin/stores/{id}/security-status',
  'PATCH /admin/stores/{id}/commission',
  'POST /admin/stores/{id}/catalog/import',
  'POST /admin/finance/close',
  'GET /admin/finance',
  'PATCH /admin/finance/store-invoices/{id}/paid',
  'PATCH /admin/finance/store-payouts/{id}/paid',
  'PATCH /admin/finance/driver-payouts/{id}/paid',
]

function parse(entries: string[], role: Allowed): Entry[] {
  return entries.map((line) => {
    const idx = line.indexOf(' ')
    return { m: line.slice(0, idx), p: line.slice(idx + 1), role }
  })
}

const MANIFEST: Entry[] = [
  ...parse(anyAuthenticated, 'ANY'),
  ...parse(customer, 'CUSTOMER'),
  ...parse(driver, 'DRIVER'),
  ...parse(store, 'STORE'),
  ...parse(admin, 'ADMIN'),
]

function fill(path: string) {
  return path.replace(/\{[^}]+\}/g, ID)
}

function call(method: string, path: string, actor: Actor) {
  const token = tokens[actor]
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const init: RequestInit = { method, headers }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['Content-Type'] = 'application/json'
    init.body = '{}'
  }
  return app.request(fill(path), init, env)
}

function actorAllowed(role: Allowed, actor: Actor) {
  if (role === 'ANY') return actor !== 'ANON'
  if (role === 'STORE') return actor === 'STORE_A' || actor === 'STORE_B'
  return role === actor
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const storeA = await createActiveStoreTestFixture({
    name: 'Loja Matriz', slug: STORE_SLUG, category: 'PIZZARIA', phone: '4433334444',
    city: 'Cidade Exemplo', addressText: 'Rua Central, 100', lat: -23.5, lng: -51.9,
    owner: { name: 'Dono', email: 'dono-matriz@email.com', password: 'senha123' },
  })
  const storeB = await createActiveStoreTestFixture({
    name: 'Loja B', slug: 'loja-matriz-b', category: 'OUTROS', phone: '4455556666',
    city: 'Cidade Exemplo', addressText: 'Rua B, 200', lat: -23.51, lng: -51.91,
    owner: { name: 'Dona B', email: 'dona-b@email.com', password: 'senha123' },
  })
  tokens = {
    ANON: null,
    CUSTOMER: await createTestSession({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'Cliente' }, env.JWT_SECRET),
    DRIVER: await createTestSession({ sub: crypto.randomUUID(), role: 'DRIVER', name: 'Entregador' }, env.JWT_SECRET),
    STORE_A: await createTestSession({ sub: storeA.ownerUserId, role: 'STORE', name: 'Dono' }, env.JWT_SECRET),
    STORE_B: await createTestSession({ sub: storeB.ownerUserId, role: 'STORE', name: 'Dona B' }, env.JWT_SECRET),
    ADMIN: await createTestSession({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Admin' }, env.JWT_SECRET),
  }
})
afterAll(closeTestDb)

describe('authorization matrix — every protected route', () => {
  for (const { m, p, role } of MANIFEST) {
    it(`${m} ${p} (allowed: ${role})`, async () => {
      // ANON is always rejected with 401.
      expect((await call(m, p, 'ANON')).status).toBe(401)

      for (const actor of AUTHENTICATED) {
        const status = (await call(m, p, actor)).status
        const isAllowed = actorAllowed(role, actor)
        if (isAllowed) {
          // Passed authorization: business validation may still 400/404/409, never 401/403.
          expect(status, `${m} ${p} as ${actor} must pass authz`).not.toBe(401)
          expect(status, `${m} ${p} as ${actor} must pass authz`).not.toBe(403)
        } else {
          expect(status, `${m} ${p} as ${actor} must be forbidden`).toBe(403)
        }
      }
    })
  }
})

describe('public auth allowlist — authentication never changes reachability', () => {
  const publicAuthPosts = [
    '/auth/register',
    '/auth/verification/confirm',
    '/auth/verification/resend',
    '/auth/recovery/start',
    '/auth/recovery/verify',
    '/auth/recovery/reset',
    '/auth/password-setup',
    '/auth/login',
    '/auth/refresh',
  ]

  for (const path of publicAuthPosts) {
    it(`POST ${path} is public for every principal`, async () => {
      for (const actor of ACTORS) {
        const status = (await call('POST', path, actor)).status
        expect(status, `${path} as ${actor} must remain public`).not.toBe(401)
        expect(status, `${path} as ${actor} must remain public`).not.toBe(403)
      }
    })
  }
})

describe('public allowlist — no authentication required', () => {
  const publicGets = [
    '/health',
    '/stores',
    `/stores/${STORE_SLUG}`,
    `/stores/${STORE_SLUG}/menu`,
    '/search?q=pizza',
    `/media/logos/${ID}.png`,
    `/media/products/${ID}.webp`,
  ]
  for (const path of publicGets) {
    it(`GET ${path} is reachable without a token`, async () => {
      const status = (await app.request(path, {}, env)).status
      expect(status).not.toBe(401)
      expect(status).not.toBe(403)
    })
  }

  it('private return evidence is never public', async () => {
    const status = (await app.request(`/media/returns/${ID}.jpg`, {}, env)).status
    expect(status).toBe(404)
  })
})

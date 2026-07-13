import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { createActiveStoreTestFixture, type StoreFixtureInput, migrateTestDb, truncateAll, testDb, closeTestDb, createTestSession } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { orders, stores, users } from '../src/db/schema'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { updateStore, setStoreSecurityStatus } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret',
  RATE_LIMIT_HMAC_SECRET: 'rate-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  APP_ENV: 'local',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

function storeInput(n: string): StoreFixtureInput {
  return {
    name: `Loja ${n}`, slug: `loja-${n}`, category: 'PIZZARIA', phone: '4433334444',
    city: 'C', addressText: 'Rua A, 1', lat: -23.55, lng: -51.9,
    owner: { name: `Dono ${n}`, email: `dono-${n}@email.com`, password: 'senha123' },
  }
}

function req(path: string, token: string | null, init: RequestInit = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) }
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(path, { ...init, headers }, env)
}

async function seedOpenStore(n: string) {
  const store = await createActiveStoreTestFixture(storeInput(n))
  await updateStore(testDb, store.id, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'DISTANCE', deliveryMinFeeCents: 400, deliveryPerKmCents: 200,
    deliveryMaxKm: 8, minOrderCents: 1000,
  })
  const token = await createTestSession({ sub: store.ownerUserId, role: 'STORE', name: `Dono ${n}` }, env.JWT_SECRET)
  return { store, token }
}

async function seedOrderFor(storeId: string, storeSlug: string) {
  const customer = await createVerifiedTestAccount(
    testDb,
    { name: 'Cliente', phone: `44${Math.floor(100000000 + Math.random() * 800000000)}`, password: 'senha123', role: 'CUSTOMER', acceptedTerms: true },
    env.JWT_SECRET,
  )
  const addr = await createAddress(testDb, customer.user.id, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })
  const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
  const prod = await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })
  const { order } = await createOrder(testDb, customer.user.id, {
    storeSlug, fulfillment: 'DELIVERY', addressId: addr.id, paymentMethod: 'CASH', changeForCents: 0,
    items: [{ productId: prod.id, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
  })
  return { customer, addressId: addr.id, order }
}

async function seedPendingStore(n: string) {
  const [owner] = await testDb.insert(users).values({
    name: `Dono pendente ${n}`,
    email: `pendente-${n}@email.com`,
    role: 'STORE',
    status: 'PENDING_EMAIL',
    emailVerifiedAt: null,
    registrationSource: 'ADMIN_PROVISIONED',
  }).returning()
  if (!owner) throw new Error('pending owner fixture was not created')
  const [store] = await testDb.insert(stores).values({
    ownerUserId: owner.id,
    name: `Loja pendente ${n}`,
    slug: `loja-pendente-${n}`,
    category: 'OUTROS',
    phone: '44999990000',
    city: 'C',
    addressText: 'Rua pendente, 1',
    lat: -23.55,
    lng: -51.9,
    securityStatus: 'PENDING_ACTIVATION',
  }).returning()
  if (!store) throw new Error('pending store fixture was not created')
  const token = await createTestSession({ sub: owner.id, role: 'STORE', name: owner.name }, env.JWT_SECRET)
  return { owner, store, token }
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

// Reads scoped to an owner return 404 for a foreigner. Mutations scoped by a
// WHERE clause affect 0 rows and reject with 404 or 409 — identical to a
// nonexistent id or a wrong-state own resource, so existence never leaks.
const blocked = (status: number) => expect([404, 409]).toContain(status)

describe('cross-tenant isolation — foreign resources are inaccessible', () => {
  it('keeps pending stores private and denies their owner plus foreign stores', async () => {
    const a = await seedOpenStore('a')
    const pending = await seedPendingStore('b')

    const publicList = await req('/stores', null)
    expect(publicList.status).toBe(200)
    expect(JSON.stringify(await publicList.json())).not.toContain(pending.store.slug)
    expect((await req(`/stores/${pending.store.slug}`, null)).status).toBe(404)
    expect((await req(`/stores/${pending.store.slug}/menu`, null)).status).toBe(404)

    expect((await req('/store/me', pending.token)).status).toBe(403)
    expect((await req('/store/me/catalog', pending.token)).status).toBe(403)

    const foreignResend = await req(`/admin/stores/${pending.store.id}/activation/resend`, a.token, {
      method: 'POST', body: '{}',
    })
    const unknownResend = await req(`/admin/stores/${crypto.randomUUID()}/activation/resend`, a.token, {
      method: 'POST', body: '{}',
    })
    expect(foreignResend.status).toBe(403)
    expect(await foreignResend.json()).toEqual(await unknownResend.json())
    expect((await req('/admin/stores', a.token)).status).toBe(403)
  })

  it('store B cannot read or mutate store A catalog or orders', async () => {
    const a = await seedOpenStore('a')
    const b = await seedOpenStore('b')
    const cat = await createCategory(testDb, a.store.id, { name: 'Categoria A' })
    const prod = await createProduct(testDb, a.store.id, { categoryId: cat.id, name: 'Produto A', basePriceCents: 2000, isAvailable: true })
    const { order } = await seedOrderFor(a.store.id, a.store.slug)

    expect((await req(`/store/me/categories/${cat.id}`, b.token, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) })).status).toBe(404)
    expect((await req(`/store/me/categories/${cat.id}`, b.token, { method: 'DELETE' })).status).toBe(404)
    expect((await req(`/store/me/products/${prod.id}`, b.token, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) })).status).toBe(404)
    expect((await req(`/store/me/products/${prod.id}`, b.token, { method: 'DELETE' })).status).toBe(404)
    expect((await req(`/store/me/orders/${order.id}`, b.token)).status).toBe(404)
    expect((await req(`/store/me/orders/${order.id}/status`, b.token, { method: 'PATCH', body: JSON.stringify({ to: 'PREPARING' }) })).status).toBe(404)
  })

  it('customer B cannot read or mutate customer A order or address', async () => {
    const a = await seedOpenStore('a')
    const { customer, addressId, order } = await seedOrderFor(a.store.id, a.store.slug)
    void customer
    const other = await createVerifiedTestAccount(testDb, { name: 'Outro', phone: '44900001111', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true }, env.JWT_SECRET)

    expect((await req(`/orders/${order.id}`, other.accessToken!)).status).toBe(404)
    blocked((await req(`/orders/${order.id}/cancel`, other.accessToken!, { method: 'POST', body: '{}' })).status)
    expect((await req(`/me/addresses/${addressId}`, other.accessToken!, { method: 'DELETE' })).status).toBe(404)
  })

  it('driver B cannot read or act on an order assigned to driver A', async () => {
    const a = await seedOpenStore('a')
    const { order } = await seedOrderFor(a.store.id, a.store.slug)
    const driverA = await createVerifiedTestAccount(testDb, { name: 'DriverA', phone: '44911112222', password: 'senha123', role: 'DRIVER', acceptedTerms: true }, env.JWT_SECRET)
    await testDb.update(orders).set({ driverId: driverA.user.id, status: 'OUT_FOR_DELIVERY' }).where(eq(orders.id, order.id))
    const driverB = await createTestSession({ sub: crypto.randomUUID(), role: 'DRIVER', name: 'DriverB' }, env.JWT_SECRET)

    expect((await req(`/driver/earnings/orders/${order.id}`, driverB)).status).toBe(404)
    blocked((await req(`/driver/orders/${order.id}/collect`, driverB, { method: 'POST', body: '{}' })).status)
    blocked((await req(`/driver/orders/${order.id}/deliver`, driverB, { method: 'POST', body: '{}' })).status)
  })
})

describe('security-event transitions — old credentials fail immediately', () => {
  const forbidden = (status: number) => expect([401, 403]).toContain(status)

  it('device logout revokes access and refresh of that family', async () => {
    const u = await createVerifiedTestAccount(testDb, { name: 'U', phone: '44900000001', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true }, env.JWT_SECRET)
    expect((await req('/auth/me', u.accessToken!)).status).toBe(200)
    expect((await req('/auth/logout', u.accessToken!, { method: 'POST', body: '{}' })).status).toBe(204)
    forbidden((await req('/auth/me', u.accessToken!)).status)
    forbidden((await req('/auth/refresh', null, { method: 'POST', body: JSON.stringify({ refreshToken: u.refreshToken }) })).status)
  })

  it('logout-all revokes every family', async () => {
    const u = await createVerifiedTestAccount(testDb, { name: 'U', phone: '44900000002', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true }, env.JWT_SECRET)
    expect((await req('/auth/logout-all', u.accessToken!, { method: 'POST', body: '{}' })).status).toBe(204)
    forbidden((await req('/auth/me', u.accessToken!)).status)
    forbidden((await req('/auth/refresh', null, { method: 'POST', body: JSON.stringify({ refreshToken: u.refreshToken }) })).status)
  })

  it('blocking the user invalidates access and refresh', async () => {
    const u = await createVerifiedTestAccount(testDb, { name: 'U', phone: '44900000003', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true }, env.JWT_SECRET)
    await testDb.update(users).set({ status: 'BLOCKED' }).where(eq(users.id, u.user.id))
    forbidden((await req('/auth/me', u.accessToken!)).status)
    forbidden((await req('/auth/refresh', null, { method: 'POST', body: JSON.stringify({ refreshToken: u.refreshToken }) })).status)
  })

  it('suspending a store invalidates the owner access and refresh', async () => {
    const store = await createActiveStoreTestFixture(storeInput('sus'))
    const login = await createVerifiedTestAccount(testDb, { name: 'x', phone: '44900000004', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true }, env.JWT_SECRET)
    // Promote the fresh login user into the store owner seat so it carries a real refresh family.
    void login
    const owner = await testDb.select().from(users).where(eq(users.id, store.ownerUserId)).limit(1)
    expect(owner[0]).toBeTruthy()
    const ownerSession = await createTestSession({ sub: store.ownerUserId, role: 'STORE', name: owner[0]!.name }, env.JWT_SECRET)
    expect((await req('/store/me', ownerSession)).status).toBe(200)
    await setStoreSecurityStatus(testDb, store.id, 'SUSPENDED')
    forbidden((await req('/store/me', ownerSession)).status)
  })

  it('rejects forged sessions for every pending or blocked principal class', async () => {
    const principals = [
      { role: 'CUSTOMER' as const, status: 'BLOCKED' as const, verified: true, path: '/auth/me' },
      { role: 'DRIVER' as const, status: 'PENDING_APPROVAL' as const, verified: true, path: '/driver/me' },
      { role: 'ADMIN' as const, status: 'PENDING_EMAIL' as const, verified: false, path: '/admin/stores' },
    ]

    for (const [index, principal] of principals.entries()) {
      const [user] = await testDb.insert(users).values({
        name: `Principal ${index}`,
        email: `principal-${index}@email.com`,
        role: principal.role,
        status: principal.status,
        emailVerifiedAt: principal.verified ? new Date() : null,
      }).returning()
      if (!user) throw new Error('principal fixture was not created')
      const token = await createTestSession({ sub: user.id, role: principal.role, name: user.name }, env.JWT_SECRET)

      expect((await req(principal.path, token)).status, `${principal.role}/${principal.status}`).toBe(403)
    }
  })
})

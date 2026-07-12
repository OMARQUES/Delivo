import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import { loginUser } from '../src/services/auth.service'
import { drivers, users } from '../src/db/schema'
import { setAvailability, setFcmToken } from '../src/services/dispatch.service'
import { eq } from 'drizzle-orm'

const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'test-secret',
  RATE_LIMIT_HMAC_SECRET: 'rate-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
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
  const d = await createVerifiedTestAccount(testDb, {
    name: 'Duda',
    email: 'driver@example.test',
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
    expect(body[0]).toMatchObject({ id: driverUserId, status: 'PENDING_APPROVAL' })

    await expect(loginUser(testDb, { email: 'driver@example.test', password: 'senha123' }, env.JWT_SECRET))
      .rejects.toThrow('aguardando aprovação')

    const patch = await req(`/admin/drivers/${driverUserId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ACTIVE' }),
    })
    expect(patch.status).toBe(200)
    const login = await loginUser(testDb, { email: 'driver@example.test', password: 'senha123' }, env.JWT_SECRET)
    expect(login.accessToken).toBeTruthy()
  })

  it('block works; cannot target non-driver users; 403 non-admin', async () => {
    await req(`/admin/drivers/${driverUserId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }) })
    const block = await req(`/admin/drivers/${driverUserId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'BLOCKED' }) })
    expect(((await block.json()) as { status: string }).status).toBe('BLOCKED')

    const customer = await createVerifiedTestAccount(testDb, {
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

  it('refuses activation without verified email and contact phone', async () => {
    const missingVerification = crypto.randomUUID()
    const missingPhone = crypto.randomUUID()
    await testDb.insert(users).values([
      {
        id: missingVerification,
        name: 'Unverified Driver',
        email: 'unverified-driver@example.test',
        phone: '44933334444',
        role: 'DRIVER',
        status: 'PENDING_APPROVAL',
        emailVerifiedAt: null,
      },
      {
        id: missingPhone,
        name: 'No Phone Driver',
        email: 'no-phone-driver@example.test',
        phone: null,
        role: 'DRIVER',
        status: 'PENDING_APPROVAL',
        emailVerifiedAt: new Date(),
      },
    ])

    for (const id of [missingVerification, missingPhone]) {
      const response = await req(`/admin/drivers/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ACTIVE' }),
      })
      expect(response.status).toBe(409)
    }
  })

  it('block followed by reactivation never resurrects old sessions', async () => {
    await req(`/admin/drivers/${driverUserId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }),
    })
    const session = await loginUser(
      testDb,
      { email: 'driver@example.test', password: 'senha123' },
      env.JWT_SECRET,
    )
    expect((await req('/auth/me', {}, session.accessToken)).status).toBe(200)

    await req(`/admin/drivers/${driverUserId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'BLOCKED' }),
    })
    expect((await req('/auth/me', {}, session.accessToken)).status).toBe(403)

    await req(`/admin/drivers/${driverUserId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }),
    })
    expect((await req('/auth/me', {}, session.accessToken)).status).toBe(401)
    const refresh = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    }, env)
    expect(refresh.status).toBe(401)
  })

  it('blocking a driver removes it from dispatch and clears push destination', async () => {
    await req(`/admin/drivers/${driverUserId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }),
    })
    await setAvailability(testDb, driverUserId, true)
    await setFcmToken(testDb, driverUserId, 'secret-device-token')

    await req(`/admin/drivers/${driverUserId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'BLOCKED' }),
    })

    const [profile] = await testDb.select().from(drivers).where(eq(drivers.userId, driverUserId))
    expect(profile).toMatchObject({ isAvailable: false, fcmToken: null })
  })

  it('a concurrent block wins over availability and push updates', async () => {
    await req(`/admin/drivers/${driverUserId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }),
    })
    await setAvailability(testDb, driverUserId, false)

    let releaseBlock!: () => void
    let reportLocked!: () => void
    const blockMayCommit = new Promise<void>((resolve) => { releaseBlock = resolve })
    const blockHasLock = new Promise<void>((resolve) => { reportLocked = resolve })
    const blocking = testDb.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
      await tx.update(users).set({ status: 'BLOCKED' }).where(eq(users.id, driverUserId))
      reportLocked()
      await blockMayCommit
    })

    await blockHasLock
    const mutations = Promise.allSettled([
      setAvailability(testDb, driverUserId, true),
      setFcmToken(testDb, driverUserId, 'late-device-token'),
    ])
    await new Promise((resolve) => setTimeout(resolve, 25))
    releaseBlock()
    const [, results] = await Promise.all([blocking, mutations])

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    const [profile] = await testDb.select().from(drivers).where(eq(drivers.userId, driverUserId))
    expect(profile).toMatchObject({ isAvailable: false, fcmToken: null })
  })
})

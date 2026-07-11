import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { authMiddleware, requireRole } from '../src/middleware/auth'
import { signAccessToken } from '../src/lib/tokens'
import { errorHandler } from '../src/middleware/error-handler'
import { refreshTokens, users } from '../src/db/schema'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
}
const ana = {
  name: 'Ana',
  phone: '(44) 99999-8888',
  email: 'Ana@Email.com',
  password: 'senha123',
  acceptedTerms: true,
}

type AuthBody = {
  user: { email: string | null; status: string; name: string; role: string }
  accessToken: string | null
  refreshToken: string | null
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
    env,
  )
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('POST /auth/register', () => {
  it('registers customer, 201 with user + tokens, email normalized', async () => {
    const res = await post('/auth/register', ana)
    expect(res.status).toBe(201)
    const body = (await res.json()) as AuthBody
    expect(body.user.email).toBe('ana@email.com')
    expect(body.accessToken).toBeTruthy()
  })
  it('409 on duplicate, 400 on invalid body', async () => {
    await post('/auth/register', ana)
    expect((await post('/auth/register', ana)).status).toBe(409)
    const bad = await post('/auth/register', { name: 'x' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'Validation failed' })
  })
  it('driver → 201 sem tokens, PENDING', async () => {
    const res = await post('/auth/register', { ...ana, role: 'DRIVER' })
    const body = (await res.json()) as AuthBody
    expect(body.user.status).toBe('PENDING')
    expect(body.accessToken).toBeNull()
  })
})

describe('POST /auth/login + GET /auth/me', () => {
  it('login → tokens → /me com bearer', async () => {
    await post('/auth/register', ana)
    const login = await post('/auth/login', { identifier: '44999998888', password: 'senha123' })
    expect(login.status).toBe(200)
    const { accessToken } = (await login.json()) as AuthBody
    const me = await app.request('/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } }, env)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ name: 'Ana', role: 'CUSTOMER' })
  })
  it('/me sem token → 401; token inválido → 401', async () => {
    expect((await app.request('/auth/me', {}, env)).status).toBe(401)
    expect((await app.request('/auth/me', { headers: { Authorization: 'Bearer lixo' } }, env)).status).toBe(401)
  })
  it('login errado → 401 envelope', async () => {
    const res = await post('/auth/login', { identifier: 'x@y.com', password: 'senha123' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Credenciais inválidas' })
  })
})

describe('POST /auth/refresh + /auth/logout', () => {
  it('refresh rotates; reuse kills family; logout revokes', async () => {
    await post('/auth/register', ana)
    const login = await post('/auth/login', { identifier: 'ana@email.com', password: 'senha123' })
    const { refreshToken } = (await login.json()) as AuthBody
    const r1 = await post('/auth/refresh', { refreshToken })
    expect(r1.status).toBe(200)
    const { refreshToken: rt2 } = (await r1.json()) as AuthBody
    expect((await post('/auth/refresh', { refreshToken })).status).toBe(401)
    expect((await post('/auth/refresh', { refreshToken: rt2 })).status).toBe(401)
    const login2 = await post('/auth/login', { identifier: 'ana@email.com', password: 'senha123' })
    const { refreshToken: rt3 } = (await login2.json()) as AuthBody
    expect((await post('/auth/logout', { refreshToken: rt3 })).status).toBe(204)
    expect((await post('/auth/refresh', { refreshToken: rt3 })).status).toBe(401)
  })
})

describe('requireRole unit', () => {
  const mini = new Hono<{ Bindings: typeof env; Variables: { auth?: unknown; db?: typeof testDb } }>()
  mini.onError(errorHandler)
  mini.use('*', async (c, next) => {
    c.set('db', testDb)
    await next()
  })
  mini.use('/admin/*', authMiddleware, requireRole('ADMIN'))
  mini.get('/admin/ping', (c) => c.json({ ok: true }))

  async function tokenFor(role: 'CUSTOMER' | 'ADMIN') {
    const [user] = await testDb.insert(users).values({
      name: role, role, status: 'ACTIVE', email: `${role}-${crypto.randomUUID()}@test.local`,
    }).returning()
    if (!user) throw new Error('test user was not created')
    const familyId = crypto.randomUUID()
    await testDb.insert(refreshTokens).values({
      userId: user.id, familyId, tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000),
    })
    return signAccessToken(
      { sub: user.id, role, name: user.name, tokenVersion: user.tokenVersion },
      env.JWT_SECRET,
      familyId,
    )
  }

  it('403 wrong role, 200 right role', async () => {
    const cust = await tokenFor('CUSTOMER')
    const admin = await tokenFor('ADMIN')
    expect((await mini.request('/admin/ping', { headers: { Authorization: `Bearer ${cust}` } }, env)).status).toBe(403)
    expect((await mini.request('/admin/ping', { headers: { Authorization: `Bearer ${admin}` } }, env)).status).toBe(200)
  })
})

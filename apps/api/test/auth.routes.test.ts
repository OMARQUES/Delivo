import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

const verifyTurnstileMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

vi.mock('../src/security/turnstile', async () => {
  const actual = await vi.importActual<typeof import('../src/security/turnstile')>('../src/security/turnstile')
  return {
    ...actual,
    createTurnstileVerifier: vi.fn(() => ({ verify: verifyTurnstileMock })),
  }
})

import { app } from '../src/app'
import { authMiddleware, requireRole } from '../src/middleware/auth'
import { signAccessToken } from '../src/lib/tokens'
import { errorHandler } from '../src/middleware/error-handler'
import { refreshTokens, users } from '../src/db/schema'
import { PostgresRateLimiter } from '../src/security/rate-limit'
import { POLICIES } from '../src/security/rate-limit-policies'
import { SecurityHttpError, TURNSTILE_INVALID_MESSAGE } from '../src/security/http'

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
const ana = {
  name: 'Ana',
  phone: '(44) 99999-8888',
  email: 'Ana@Email.com',
  password: 'senha123',
  acceptedTerms: true,
  turnstileToken: 'turnstile-token',
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
beforeEach(async () => {
  await truncateAll()
  verifyTurnstileMock.mockReset()
  verifyTurnstileMock.mockResolvedValue(undefined)
})
afterAll(closeTestDb)

describe('POST /auth/register', () => {
  it('registers customer, 201 with user + tokens, email normalized', async () => {
    const res = await post('/auth/register', ana)
    expect(res.status).toBe(201)
    const body = (await res.json()) as AuthBody
    expect(body.user.email).toBe('ana@email.com')
    expect(body.user).not.toHaveProperty('tokenVersion')
    expect(body.accessToken).toBeTruthy()
  })
  it('409 on duplicate, 400 on invalid body', async () => {
    await post('/auth/register', ana)
    expect((await post('/auth/register', ana)).status).toBe(409)
    const bad = await post('/auth/register', { name: 'x' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'Validation failed' })
  })
  it('verifies Turnstile and does not create an account after invalid challenge', async () => {
    verifyTurnstileMock.mockRejectedValueOnce(
      new SecurityHttpError(403, 'TURNSTILE_INVALID', TURNSTILE_INVALID_MESSAGE),
    )

    const res = await post('/auth/register', { ...ana, email: 'blocked@example.test' })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: TURNSTILE_INVALID_MESSAGE, code: 'TURNSTILE_INVALID' })
    expect(verifyTurnstileMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'turnstile-token',
      remoteIp: '127.0.0.1',
      action: 'register',
    }))
    const rows = await testDb.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = 'blocked@example.test'`)
    expect(rows).toHaveLength(0)
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
    const loginBody = (await login.json()) as AuthBody
    expect(loginBody.user).not.toHaveProperty('tokenVersion')
    const { accessToken } = loginBody
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
  it('requires Turnstile after five failures, then allows a challenged attempt and clears failures after success', async () => {
    await post('/auth/register', ana)
    for (let i = 0; i < 5; i++) {
      const failed = await post('/auth/login', { identifier: 'ana@email.com', password: 'errada123' })
      expect(failed.status).toBe(401)
    }

    const required = await post('/auth/login', { identifier: 'ana@email.com', password: 'errada123' })
    expect(required.status).toBe(403)
    expect(await required.json()).toEqual({
      error: 'Verificação de segurança necessária.',
      code: 'TURNSTILE_REQUIRED',
    })

    const challenged = await post('/auth/login', {
      identifier: 'ana@email.com',
      password: 'errada123',
      turnstileToken: 'login-token',
    })
    expect(challenged.status).toBe(401)
    expect(verifyTurnstileMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'login-token',
      remoteIp: '127.0.0.1',
      action: 'login',
    }))

    const success = await post('/auth/login', {
      identifier: 'ana@email.com',
      password: 'senha123',
      turnstileToken: 'login-token',
    })
    expect(success.status).toBe(200)

    const afterClear = await post('/auth/login', { identifier: 'ana@email.com', password: 'errada123' })
    expect(afterClear.status).toBe(401)
  })

  it('keeps the tenth failed login as 401 and rate-limits the following attempt', async () => {
    await post('/auth/register', { ...ana, phone: '44911112222', email: 'cooldown@example.test' })
    for (let i = 0; i < 9; i++) {
      const failed = await post('/auth/login', {
        identifier: 'cooldown@example.test',
        password: 'errada123',
        turnstileToken: i >= 5 ? 'login-token' : undefined,
      })
      expect(failed.status).toBe(401)
    }

    const tenth = await post('/auth/login', {
      identifier: 'cooldown@example.test',
      password: 'errada123',
      turnstileToken: 'login-token',
    })
    expect(tenth.status).toBe(401)

    const blocked = await post('/auth/login', {
      identifier: 'cooldown@example.test',
      password: 'senha123',
      turnstileToken: 'login-token',
    })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({
      error: 'Muitas tentativas. Tente novamente mais tarde.',
      code: 'RATE_LIMITED',
    })
  })
})

describe('POST /auth/refresh + /auth/logout', () => {
  it('refresh rotates; reuse kills family; logout revokes the active access session', async () => {
    await post('/auth/register', ana)
    const login = await post('/auth/login', { identifier: 'ana@email.com', password: 'senha123' })
    const { refreshToken } = (await login.json()) as AuthBody
    const r1 = await post('/auth/refresh', { refreshToken })
    expect(r1.status).toBe(200)
    const { refreshToken: rt2 } = (await r1.json()) as AuthBody
    expect((await post('/auth/refresh', { refreshToken })).status).toBe(401)
    expect((await post('/auth/refresh', { refreshToken: rt2 })).status).toBe(401)
    const login2 = await post('/auth/login', { identifier: 'ana@email.com', password: 'senha123' })
    const { refreshToken: rt3, accessToken: access3 } = (await login2.json()) as AuthBody
    expect((await app.request('/auth/me', { headers: { Authorization: `Bearer ${access3}` } }, env)).status).toBe(200)
    expect((await app.request('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${access3}` } }, env)).status).toBe(204)
    expect((await app.request('/auth/me', { headers: { Authorization: `Bearer ${access3}` } }, env)).status).toBe(401)
    expect((await post('/auth/refresh', { refreshToken: rt3 })).status).toBe(401)
  })

  it('logout-all invalidates every device immediately', async () => {
    await post('/auth/register', ana)
    const first = await post('/auth/login', { identifier: 'ana@email.com', password: 'senha123' })
    const second = await post('/auth/login', { identifier: 'ana@email.com', password: 'senha123' })
    const { accessToken: accessA } = (await first.json()) as AuthBody
    const { accessToken: accessB } = (await second.json()) as AuthBody

    expect((await app.request('/auth/logout-all', {
      method: 'POST', headers: { Authorization: `Bearer ${accessA}` },
    }, env)).status).toBe(204)
    expect((await app.request('/auth/me', { headers: { Authorization: `Bearer ${accessA}` } }, env)).status).toBe(401)
    expect((await app.request('/auth/me', { headers: { Authorization: `Bearer ${accessB}` } }, env)).status).toBe(401)
  })

  it('concurrent refresh reuse revokes the full session family', async () => {
    await post('/auth/register', ana)
    const login = await post('/auth/login', { identifier: 'ana@email.com', password: 'senha123' })
    const { refreshToken } = (await login.json()) as AuthBody
    const responses = await Promise.all([
      post('/auth/refresh', { refreshToken }),
      post('/auth/refresh', { refreshToken }),
    ])
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1)
    const winner = responses.find((response) => response.status === 200)
    const body = await winner!.json() as AuthBody
    expect((await post('/auth/refresh', { refreshToken: body.refreshToken })).status).toBe(401)
  })

  it('rate-limited refresh does not mark the token used or revoke its family', async () => {
    await post('/auth/register', { ...ana, phone: '44922223333', email: 'refresh@example.test' })
    const login = await post('/auth/login', { identifier: 'refresh@example.test', password: 'senha123' })
    const { refreshToken } = (await login.json()) as AuthBody
    const limiter = new PostgresRateLimiter(testDb, env.RATE_LIMIT_HMAC_SECRET)
    for (let i = 0; i < POLICIES.refreshFingerprint10Minutes.limit; i++) {
      await limiter.consume(POLICIES.refreshFingerprint10Minutes, refreshToken!)
    }

    const limited = await post('/auth/refresh', { refreshToken })

    expect(limited.status).toBe(429)
    const [row] = await testDb.select().from(refreshTokens).where(sql`${refreshTokens.tokenHash} is not null`).limit(1)
    expect(row?.usedAt).toBeNull()
    expect(row?.revokedAt).toBeNull()
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

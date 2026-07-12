import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { createTestSession, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

const verifyTurnstileMock = vi.hoisted(() => vi.fn(async () => undefined))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: 'email-test-id' })))
const hashPasswordCall = vi.hoisted(() => vi.fn())

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

vi.mock('../src/email/resend-sender', async () => {
  const actual = await vi.importActual<typeof import('../src/email/resend-sender')>('../src/email/resend-sender')
  return { ...actual, createResendSender: vi.fn(() => ({ send: sendEmailMock })) }
})

vi.mock('../src/lib/password', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/password')>('../src/lib/password')
  return {
    ...actual,
    hashPassword: async (password: string) => {
      hashPasswordCall(password)
      return actual.hashPassword(password)
    },
  }
})

import { app } from '../src/app'
import { authMiddleware, requireRole } from '../src/middleware/auth'
import { signAccessToken } from '../src/lib/tokens'
import { errorHandler } from '../src/middleware/error-handler'
import { authChallenges, authProviders, pendingRegistrations, refreshTokens, users } from '../src/db/schema'
import { PostgresRateLimiter } from '../src/security/rate-limit'
import { POLICIES } from '../src/security/rate-limit-policies'
import { SecurityHttpError, TURNSTILE_INVALID_MESSAGE } from '../src/security/http'
import { hashPassword } from '../src/lib/password'
import { deriveAuthCode } from '../src/security/auth-code'
import { createStoreWithOwner } from '../src/services/store.service'

const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'test-secret',
  RATE_LIMIT_HMAC_SECRET: 'rate-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  RESEND_API_KEY: 're_test_key',
  AUTH_CODE_SECRET: 'route-auth-code-secret-with-32-bytes',
  EMAIL_FROM: 'Test <test@example.com>',
  PUBLIC_WEB_URL: 'http://localhost:5173/verificar-email',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}
const ana = {
  name: 'Ana',
  phone: '(44) 99999-8888',
  email: 'Ana@Email.com',
  password: 'safe customer password',
  role: 'CUSTOMER' as const,
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

function postWithEnv(path: string, body: unknown, overrides: Partial<typeof env>) {
  return app.request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { ...env, ...overrides },
  )
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  verifyTurnstileMock.mockReset()
  verifyTurnstileMock.mockResolvedValue(undefined)
  sendEmailMock.mockReset()
  sendEmailMock.mockResolvedValue({ providerMessageId: 'email-test-id' })
  hashPasswordCall.mockClear()
})
afterAll(closeTestDb)

async function seedAccount(input: Partial<{
  name: string
  email: string
  phone: string | null
  password: string
  role: 'CUSTOMER' | 'DRIVER'
  status: 'ACTIVE' | 'PENDING_APPROVAL' | 'BLOCKED'
}> = {}) {
  const values = {
    name: input.name ?? 'Ana',
    email: input.email ?? 'ana@email.com',
    phone: input.phone === undefined ? '44999998888' : input.phone,
    password: input.password ?? 'senha123',
    role: input.role ?? 'CUSTOMER',
    status: input.status ?? 'ACTIVE',
  }
  const [user] = await testDb.insert(users).values({
    name: values.name,
    email: values.email,
    phone: values.phone,
    role: values.role,
    status: values.status,
    emailVerifiedAt: new Date(),
    termsAcceptedAt: new Date(),
  }).returning()
  if (!user) throw new Error('verified account fixture was not created')
  await testDb.insert(authProviders).values({
    userId: user.id,
    provider: 'PASSWORD',
    passwordHash: await hashPassword(values.password),
  })
  hashPasswordCall.mockClear()
  return user
}

async function challengeAndCode(verificationId: string) {
  const [challenge] = await testDb.select().from(authChallenges).where(and(
    eq(authChallenges.pendingRegistrationId, verificationId),
    isNull(authChallenges.consumedAt),
    isNull(authChallenges.invalidatedAt),
  )).orderBy(desc(authChallenges.createdAt), desc(authChallenges.id)).limit(1)
  if (!challenge) throw new Error('registration challenge not found')
  const code = await deriveAuthCode(env.AUTH_CODE_SECRET, {
    challengeId: challenge.id,
    purpose: challenge.purpose,
  })
  return { challenge, code }
}

describe('POST /auth/register', () => {
  it('returns only a detached 202 verification flow', async () => {
    const res = await post('/auth/register', ana)
    expect(res.status).toBe(202)
    const body = await res.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'resendAt', 'verificationId'])
    expect(body).not.toHaveProperty('user')
    expect(body).not.toHaveProperty('accessToken')
    expect(body).not.toHaveProperty('refreshToken')
    expect(await testDb.select().from(users)).toHaveLength(0)
    expect(await testDb.select().from(pendingRegistrations)).toHaveLength(1)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('returns the same 202 shape for an existing account without pending state', async () => {
    await seedAccount()
    const res = await post('/auth/register', ana)
    expect(res.status).toBe(202)
    expect(Object.keys(await res.json() as object).sort()).toEqual(['expiresAt', 'resendAt', 'verificationId'])
    expect(await testDb.select().from(pendingRegistrations)).toHaveLength(0)
  })

  it('returns generic validation for malformed bodies', async () => {
    const bad = await post('/auth/register', { name: 'x' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'Validation failed' })
  })

  it('runs Turnstile before password hashing or identity writes', async () => {
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
    expect(hashPasswordCall).not.toHaveBeenCalled()
    const rows = await testDb.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = 'blocked@example.test'`)
    expect(rows).toHaveLength(0)
    expect(await testDb.select().from(pendingRegistrations)).toHaveLength(0)
  })

  it('runs rate limiting before Turnstile and password hashing', async () => {
    const limiter = new PostgresRateLimiter(testDb, env.RATE_LIMIT_HMAC_SECRET)
    for (let i = 0; i < POLICIES.registerIpHour.limit; i++) {
      await limiter.consume(POLICIES.registerIpHour, '127.0.0.1')
    }
    const res = await post('/auth/register', { ...ana, email: 'limited@example.test' })
    expect(res.status).toBe(429)
    expect(verifyTurnstileMock).not.toHaveBeenCalled()
    expect(hashPasswordCall).not.toHaveBeenCalled()
    expect(await testDb.select().from(pendingRegistrations)).toHaveLength(0)
  })

  it('fails closed before password hashing or writes when email delivery is unavailable', async () => {
    const res = await postWithEnv('/auth/register', ana, { RESEND_API_KEY: undefined })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'Serviço de email temporariamente indisponível.',
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
    })
    expect(hashPasswordCall).not.toHaveBeenCalled()
    expect(await testDb.select().from(pendingRegistrations)).toHaveLength(0)
  })

  it('returns the stable password-policy error without identity writes', async () => {
    const res = await post('/auth/register', { ...ana, password: 'password' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'A senha não atende à política de segurança.',
      code: 'PASSWORD_POLICY_REJECTED',
    })
    expect(verifyTurnstileMock).not.toHaveBeenCalled()
    expect(hashPasswordCall).not.toHaveBeenCalled()
    expect(await testDb.select().from(pendingRegistrations)).toHaveLength(0)
  })
})

describe('POST /auth/verification/*', () => {
  it('confirms CUSTOMER with a discriminated session result', async () => {
    const started = await post('/auth/register', ana)
    const flow = await started.json() as { verificationId: string }
    const { code } = await challengeAndCode(flow.verificationId)

    const confirmed = await post('/auth/verification/confirm', { verificationId: flow.verificationId, code })
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toMatchObject({
      kind: 'CUSTOMER_SESSION',
      user: { email: 'ana@email.com', status: 'ACTIVE' },
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    })
    expect(confirmed.headers.get('cache-control')).toBe('no-store')
  })

  it('confirms DRIVER as pending approval without tokens', async () => {
    const started = await post('/auth/register', {
      ...ana,
      email: 'driver@example.test',
      phone: '44911111111',
      password: 'safe driver password',
      role: 'DRIVER',
    })
    const flow = await started.json() as { verificationId: string }
    const { code } = await challengeAndCode(flow.verificationId)
    const confirmed = await post('/auth/verification/confirm', { verificationId: flow.verificationId, code })
    expect(await confirmed.json()).toMatchObject({
      kind: 'DRIVER_PENDING_APPROVAL',
      user: { status: 'PENDING_APPROVAL' },
    })
  })

  it('separates malformed-code validation from valid-shape wrong-code errors', async () => {
    const started = await post('/auth/register', ana)
    const flow = await started.json() as { verificationId: string }
    const malformed = await post('/auth/verification/confirm', { verificationId: flow.verificationId, code: '12a456' })
    expect(malformed.status).toBe(400)
    const malformedBody = await malformed.json()
    expect(malformedBody).toMatchObject({ error: 'Validation failed' })
    expect(malformedBody).not.toHaveProperty('code')

    const { code } = await challengeAndCode(flow.verificationId)
    const wrong = `${code[0] === '0' ? '1' : '0'}${code.slice(1)}`
    const invalid = await post('/auth/verification/confirm', { verificationId: flow.verificationId, code: wrong })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })
  })

  it('resends with stable public flow ID and a replaced internal challenge', async () => {
    const started = await post('/auth/register', ana)
    const flow = await started.json() as { verificationId: string }
    const { challenge: oldChallenge } = await challengeAndCode(flow.verificationId)
    await testDb.update(authChallenges)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(authChallenges.id, oldChallenge.id))

    const resent = await post('/auth/verification/resend', { verificationId: flow.verificationId })
    expect(resent.status).toBe(202)
    expect(await resent.json()).toMatchObject({ verificationId: flow.verificationId })
    const { challenge: replacement } = await challengeAndCode(flow.verificationId)
    expect(replacement.id).not.toBe(oldChallenge.id)
    expect(resent.headers.get('cache-control')).toBe('no-store')
  })
})

describe('POST /auth/login + GET /auth/me', () => {
  it('login → tokens → /me com bearer', async () => {
    await seedAccount()
    const login = await post('/auth/login', { email: 'ana@email.com', password: 'senha123' })
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
    const res = await post('/auth/login', { email: 'x@y.com', password: 'senha123' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Credenciais inválidas' })
  })
  it('rejects phone-shaped and legacy identifier login bodies', async () => {
    expect((await post('/auth/login', { email: '44999998888', password: 'senha123' })).status).toBe(400)
    expect((await post('/auth/login', { identifier: 'ana@email.com', password: 'senha123' })).status).toBe(400)
  })
  it('requires Turnstile after five failures, then allows a challenged attempt and clears failures after success', async () => {
    await seedAccount()
    for (const email of [' ANA@email.com ', 'Ana@Email.com', 'ana@email.com', 'ANA@EMAIL.COM', 'ana@email.com']) {
      const failed = await post('/auth/login', { email, password: 'errada123' })
      expect(failed.status).toBe(401)
    }

    const required = await post('/auth/login', { email: 'ana@email.com', password: 'errada123' })
    expect(required.status).toBe(403)
    expect(await required.json()).toEqual({
      error: 'Verificação de segurança necessária.',
      code: 'TURNSTILE_REQUIRED',
    })

    const challenged = await post('/auth/login', {
      email: 'ana@email.com',
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
      email: 'ana@email.com',
      password: 'senha123',
      turnstileToken: 'login-token',
    })
    expect(success.status).toBe(200)

    const afterClear = await post('/auth/login', { email: 'ana@email.com', password: 'errada123' })
    expect(afterClear.status).toBe(401)
  })

  it('keeps the tenth failed login as 401 and rate-limits the following attempt', async () => {
    await seedAccount({ phone: '44911112222', email: 'cooldown@example.test' })
    for (let i = 0; i < 9; i++) {
      const failed = await post('/auth/login', {
        email: 'cooldown@example.test',
        password: 'errada123',
        turnstileToken: i >= 5 ? 'login-token' : undefined,
      })
      expect(failed.status).toBe(401)
    }

    const tenth = await post('/auth/login', {
      email: 'cooldown@example.test',
      password: 'errada123',
      turnstileToken: 'login-token',
    })
    expect(tenth.status).toBe(401)

    const blocked = await post('/auth/login', {
      email: 'cooldown@example.test',
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

describe('PATCH /auth/me/contact', () => {
  async function patchContact(token: string, body: unknown) {
    return app.request('/auth/me/contact', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }, env)
  }

  it('updates and clears only authenticated CUSTOMER contact with a minimal response', async () => {
    const customer = await seedAccount({ email: 'contact@example.test', phone: null })
    const token = await createTestSession(
      { sub: customer.id, role: 'CUSTOMER', name: customer.name },
      env.JWT_SECRET,
    )

    const updated = await patchContact(token, { phone: '(44) 99999-8888' })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ phone: '44999998888' })

    const cleared = await patchContact(token, { phone: null })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ phone: null })
    const [stored] = await testDb.select({ phone: users.phone }).from(users).where(eq(users.id, customer.id))
    expect(stored?.phone).toBeNull()
  })

  it('allows two CUSTOMER accounts to share one contact phone', async () => {
    const first = await seedAccount({ email: 'first-contact@example.test', phone: null })
    const second = await seedAccount({ email: 'second-contact@example.test', phone: null })
    const firstToken = await createTestSession({ sub: first.id, role: 'CUSTOMER', name: first.name }, env.JWT_SECRET)
    const secondToken = await createTestSession({ sub: second.id, role: 'CUSTOMER', name: second.name }, env.JWT_SECRET)

    expect((await patchContact(firstToken, { phone: '44999998888' })).status).toBe(200)
    expect((await patchContact(secondToken, { phone: '44999998888' })).status).toBe(200)
    const matching = await testDb.select({ id: users.id }).from(users).where(eq(users.phone, '44999998888'))
    expect(matching.map((row) => row.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('rejects unauthenticated and non-CUSTOMER principals', async () => {
    expect((await app.request('/auth/me/contact', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: null }),
    }, env)).status).toBe(401)

    const store = await createStoreWithOwner(testDb, {
      name: 'Contact Store', slug: 'contact-store', category: 'OUTROS', phone: '44900000000',
      city: 'Test', addressText: 'Test, 1', lat: -23.5, lng: -51.9,
      owner: { name: 'Store Owner', email: 'owner-contact@example.test', password: 'safe store password' },
    })
    const principals = [
      { sub: crypto.randomUUID(), role: 'DRIVER' as const, name: 'Driver' },
      { sub: crypto.randomUUID(), role: 'ADMIN' as const, name: 'Admin' },
      { sub: store.ownerUserId, role: 'STORE' as const, name: 'Store Owner' },
    ]
    for (const principal of principals) {
      const token = await createTestSession(principal, env.JWT_SECRET)
      expect((await patchContact(token, { phone: '44999998888' })).status).toBe(403)
    }
  })

  it('rejects attacker-controlled selectors without changing either account', async () => {
    const attacker = await seedAccount({ email: 'attacker-contact@example.test', phone: null })
    const victim = await seedAccount({ email: 'victim-contact@example.test', phone: '44911112222' })
    const token = await createTestSession({ sub: attacker.id, role: 'CUSTOMER', name: attacker.name }, env.JWT_SECRET)

    const response = await patchContact(token, { phone: '44999998888', userId: victim.id })
    expect(response.status).toBe(400)
    const rows = await testDb.select({ id: users.id, phone: users.phone }).from(users)
      .where(sql`${users.id} in (${attacker.id}, ${victim.id})`)
    expect(rows).toEqual(expect.arrayContaining([
      { id: attacker.id, phone: null },
      { id: victim.id, phone: '44911112222' },
    ]))
  })
})

describe('POST /auth/refresh + /auth/logout', () => {
  it('refresh rotates; reuse kills family; logout revokes the active access session', async () => {
    await seedAccount()
    const login = await post('/auth/login', { email: 'ana@email.com', password: 'senha123' })
    const { refreshToken } = (await login.json()) as AuthBody
    const r1 = await post('/auth/refresh', { refreshToken })
    expect(r1.status).toBe(200)
    const { refreshToken: rt2 } = (await r1.json()) as AuthBody
    expect((await post('/auth/refresh', { refreshToken })).status).toBe(401)
    expect((await post('/auth/refresh', { refreshToken: rt2 })).status).toBe(401)
    const login2 = await post('/auth/login', { email: 'ana@email.com', password: 'senha123' })
    const { refreshToken: rt3, accessToken: access3 } = (await login2.json()) as AuthBody
    expect((await app.request('/auth/me', { headers: { Authorization: `Bearer ${access3}` } }, env)).status).toBe(200)
    expect((await app.request('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${access3}` } }, env)).status).toBe(204)
    expect((await app.request('/auth/me', { headers: { Authorization: `Bearer ${access3}` } }, env)).status).toBe(401)
    expect((await post('/auth/refresh', { refreshToken: rt3 })).status).toBe(401)
  })

  it('logout-all invalidates every device immediately', async () => {
    await seedAccount()
    const first = await post('/auth/login', { email: 'ana@email.com', password: 'senha123' })
    const second = await post('/auth/login', { email: 'ana@email.com', password: 'senha123' })
    const { accessToken: accessA } = (await first.json()) as AuthBody
    const { accessToken: accessB } = (await second.json()) as AuthBody

    expect((await app.request('/auth/logout-all', {
      method: 'POST', headers: { Authorization: `Bearer ${accessA}` },
    }, env)).status).toBe(204)
    expect((await app.request('/auth/me', { headers: { Authorization: `Bearer ${accessA}` } }, env)).status).toBe(401)
    expect((await app.request('/auth/me', { headers: { Authorization: `Bearer ${accessB}` } }, env)).status).toBe(401)
  })

  it('concurrent refresh reuse revokes the full session family', async () => {
    await seedAccount()
    const login = await post('/auth/login', { email: 'ana@email.com', password: 'senha123' })
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
    await seedAccount({ phone: '44922223333', email: 'refresh@example.test' })
    const login = await post('/auth/login', { email: 'refresh@example.test', password: 'senha123' })
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

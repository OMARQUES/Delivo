import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, desc, eq, isNull } from 'drizzle-orm'
import {
  closeTestDb,
  createTestSession,
  createVerifiedTestUser,
  identityPersistenceTextValues,
  migrateTestDb,
  testDb,
  truncateAll,
} from './helpers/test-db'

const verifyTurnstileMock = vi.hoisted(() => vi.fn(async () => undefined))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: 'sec03a-message-id' })))
const requestLogMock = vi.hoisted(() => vi.fn())

vi.mock('hono/logger', async () => {
  const actual = await vi.importActual<typeof import('hono/logger')>('hono/logger')
  return { ...actual, logger: () => actual.logger(requestLogMock) }
})

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

vi.mock('../src/security/turnstile', async () => {
  const actual = await vi.importActual<typeof import('../src/security/turnstile')>('../src/security/turnstile')
  return { ...actual, createTurnstileVerifier: vi.fn(() => ({ verify: verifyTurnstileMock })) }
})

vi.mock('../src/email/resend-sender', async () => {
  const actual = await vi.importActual<typeof import('../src/email/resend-sender')>('../src/email/resend-sender')
  return { ...actual, createResendSender: vi.fn(() => ({ send: sendEmailMock })) }
})

import { app } from '../src/app'
import {
  authActionTickets,
  authChallenges,
  authProviders,
} from '../src/db/schema'
import { deriveAuthCode } from '../src/security/auth-code'

const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'sec03a-jwt-secret',
  RATE_LIMIT_HMAC_SECRET: 'sec03a-rate-limit-secret',
  TURNSTILE_SECRET_KEY: 'sec03a-turnstile-provider-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  AUTH_CODE_SECRET: 'sec03a-auth-code-secret-with-32-bytes',
  RESEND_API_KEY: 're_sec03a_raw_provider_api_key',
  EMAIL_FROM: 'Security Test <security@example.test>',
  PUBLIC_WEB_URL: 'http://localhost:5173/verificar-email',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const INTERNAL_RESPONSE_KEYS = new Set([
  'password',
  'passwordHash',
  'code',
  'codeHash',
  'tokenHash',
  'tokenVersion',
  'outboxId',
  'challengeId',
  'pendingRegistrationId',
  'providerUserId',
  'idempotencyKey',
  'dedupeKey',
])

function post(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }, env)
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key)
      collectKeys(nested, keys)
    }
  }
  return keys
}

function expectNoInternalResponseFields(value: unknown) {
  expect(collectKeys(value).filter((key) => INTERNAL_RESPONSE_KEYS.has(key))).toEqual([])
}

async function publicEnvelope(response: Response) {
  const body = await response.clone().json() as Record<string, unknown>
  const keys = Object.keys(body).sort()
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    keys,
    types: keys.map((key) => typeof body[key]),
  }
}

async function registrationChallenge(flowId: string) {
  const [challenge] = await testDb.select().from(authChallenges).where(and(
    eq(authChallenges.pendingRegistrationId, flowId),
    isNull(authChallenges.consumedAt),
    isNull(authChallenges.invalidatedAt),
  )).orderBy(desc(authChallenges.createdAt), desc(authChallenges.id)).limit(1)
  if (!challenge) throw new Error('registration challenge not found')
  return challenge
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  verifyTurnstileMock.mockReset()
  verifyTurnstileMock.mockResolvedValue(undefined)
  sendEmailMock.mockReset()
  sendEmailMock.mockResolvedValue({ providerMessageId: 'sec03a-message-id' })
  requestLogMock.mockReset()
})
afterEach(() => vi.restoreAllMocks())
afterAll(closeTestDb)

describe('SEC-03A public equivalence and response minimization', () => {
  it('keeps registration and recovery envelopes equivalent across account states', async () => {
    await createVerifiedTestUser({
      name: 'Existing', email: 'existing@example.test', password: 'existing secure password', status: 'ACTIVE',
    })
    await createVerifiedTestUser({
      name: 'Blocked', email: 'blocked@example.test', password: 'blocked secure password', status: 'BLOCKED',
    })

    const registrationInput = {
      name: 'Candidate',
      password: 'candidate secure password',
      role: 'CUSTOMER',
      acceptedTerms: true,
      turnstileToken: 'registration-turnstile-raw-token',
    }
    const freshRegistration = await post('/auth/register', {
      ...registrationInput, email: 'fresh@example.test',
    })
    const existingRegistration = await post('/auth/register', {
      ...registrationInput, email: 'existing@example.test',
    })
    const freshEnvelope = await publicEnvelope(freshRegistration)
    expect(freshEnvelope).toEqual({
      status: 202,
      cacheControl: 'no-store',
      keys: ['expiresAt', 'resendAt', 'verificationId'],
      types: ['string', 'string', 'string'],
    })
    expect(await publicEnvelope(existingRegistration)).toEqual(freshEnvelope)

    const recoveryResponses = await Promise.all([
      post('/auth/recovery/start', { email: 'existing@example.test', turnstileToken: 'recovery-token-a' }),
      post('/auth/recovery/start', { email: 'blocked@example.test', turnstileToken: 'recovery-token-b' }),
      post('/auth/recovery/start', { email: 'unknown@example.test', turnstileToken: 'recovery-token-c' }),
    ])
    const recoveryEnvelopes = await Promise.all(recoveryResponses.map(publicEnvelope))
    expect(recoveryEnvelopes[0]).toEqual({
      status: 202,
      cacheControl: 'no-store',
      keys: ['expiresAt', 'recoveryId'],
      types: ['string', 'string'],
    })
    expect(recoveryEnvelopes[1]).toEqual(recoveryEnvelopes[0])
    expect(recoveryEnvelopes[2]).toEqual(recoveryEnvelopes[0])

    for (const response of [freshRegistration, existingRegistration, ...recoveryResponses]) {
      expectNoInternalResponseFields(await response.clone().json())
    }
  })
})

describe('SEC-03A persisted and logged secret audit', () => {
  it('persists only hashes through registration, resend, recovery and store setup', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const customerPassword = 'customer raw passphrase 4821'
    const resetPassword = 'customer replacement passphrase 5932'
    const storePassword = 'store owner raw passphrase 7043'
    const registrationTurnstile = 'registration-turnstile-raw-8114'
    const recoveryTurnstile = 'recovery-turnstile-raw-9225'

    const registration = await post('/auth/register', {
      name: 'Audit Customer',
      email: 'audit-customer@example.test',
      password: customerPassword,
      role: 'CUSTOMER',
      acceptedTerms: true,
      turnstileToken: registrationTurnstile,
    })
    expect(registration.status).toBe(202)
    const registrationBody = await registration.json() as {
      verificationId: string; expiresAt: string; resendAt: string
    }
    expectNoInternalResponseFields(registrationBody)

    const originalChallenge = await registrationChallenge(registrationBody.verificationId)
    await testDb.update(authChallenges)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(authChallenges.id, originalChallenge.id))
    const resend = await post('/auth/verification/resend', {
      verificationId: registrationBody.verificationId,
    })
    expect(resend.status).toBe(202)
    expectNoInternalResponseFields(await resend.clone().json())

    const activeRegistrationChallenge = await registrationChallenge(registrationBody.verificationId)
    const registrationCode = await deriveAuthCode(env.AUTH_CODE_SECRET, {
      challengeId: activeRegistrationChallenge.id,
      purpose: activeRegistrationChallenge.purpose,
    })
    const confirmed = await post('/auth/verification/confirm', {
      verificationId: registrationBody.verificationId,
      code: registrationCode,
    })
    expect(confirmed.status).toBe(200)
    const confirmedBody = await confirmed.json() as {
      accessToken: string; refreshToken: string; user: { id: string }
    }
    expectNoInternalResponseFields(confirmedBody)

    const recovery = await post('/auth/recovery/start', {
      email: 'audit-customer@example.test',
      turnstileToken: recoveryTurnstile,
    })
    expect(recovery.status).toBe(202)
    const recoveryBody = await recovery.json() as { recoveryId: string; expiresAt: string }
    expectNoInternalResponseFields(recoveryBody)
    const recoveryCode = await deriveAuthCode(env.AUTH_CODE_SECRET, {
      challengeId: recoveryBody.recoveryId,
      purpose: 'PASSWORD_RECOVERY',
    })
    const recoveryVerification = await post('/auth/recovery/verify', {
      recoveryId: recoveryBody.recoveryId,
      code: recoveryCode,
    })
    expect(recoveryVerification.status).toBe(200)
    const recoveryTicket = await recoveryVerification.json() as { resetTicket: string; expiresAt: string }
    expectNoInternalResponseFields(recoveryTicket)
    expect((await post('/auth/recovery/reset', {
      resetTicket: recoveryTicket.resetTicket,
      newPassword: resetPassword,
    })).status).toBe(204)

    const adminToken = await createTestSession({
      sub: crypto.randomUUID(), role: 'ADMIN', name: 'Audit Admin',
    }, env.JWT_SECRET)
    const provisioned = await post('/admin/stores', {
      name: 'Audit Store',
      slug: 'audit-store',
      category: 'OUTROS',
      phone: '44999990000',
      city: 'Maringá',
      addressText: 'Rua Audit, 10',
      lat: -23.42,
      lng: -51.93,
      owner: { name: 'Audit Owner', email: 'audit-owner@example.test' },
    }, adminToken)
    expect(provisioned.status).toBe(201)
    const provisionedBody = await provisioned.json() as {
      owner: { id: string }; store: { id: string }; verification: { expiresAt: string; resendAt: string }
    }
    expectNoInternalResponseFields(provisionedBody)
    const [storeChallenge] = await testDb.select().from(authChallenges).where(and(
      eq(authChallenges.userId, provisionedBody.owner.id),
      eq(authChallenges.purpose, 'STORE_ACTIVATION'),
      isNull(authChallenges.consumedAt),
    )).limit(1)
    if (!storeChallenge) throw new Error('store activation challenge not found')
    const storeCode = await deriveAuthCode(env.AUTH_CODE_SECRET, {
      challengeId: storeChallenge.id,
      purpose: storeChallenge.purpose,
    })
    const storeConfirmation = await post('/auth/verification/confirm', {
      verificationId: storeChallenge.id,
      code: storeCode,
    })
    expect(storeConfirmation.status).toBe(200)
    const setupTicket = await storeConfirmation.json() as { passwordSetupTicket: string; expiresAt: string }
    expectNoInternalResponseFields(setupTicket)
    expect((await post('/auth/password-setup', {
      passwordSetupTicket: setupTicket.passwordSetupTicket,
      newPassword: storePassword,
    })).status).toBe(204)

    const persistedValues = await identityPersistenceTextValues()
    const rawSecrets = [
      customerPassword,
      resetPassword,
      storePassword,
      registrationTurnstile,
      recoveryTurnstile,
      env.JWT_SECRET,
      env.RATE_LIMIT_HMAC_SECRET,
      env.TURNSTILE_SECRET_KEY,
      env.AUTH_CODE_SECRET,
      env.RESEND_API_KEY,
      adminToken,
      confirmedBody.accessToken,
      confirmedBody.refreshToken,
      recoveryTicket.resetTicket,
      setupTicket.passwordSetupTicket,
    ]
    for (const secret of rawSecrets) {
      expect(persistedValues.some((value) => value.includes(secret))).toBe(false)
    }
    for (const code of [registrationCode, recoveryCode, storeCode]) {
      expect(persistedValues.some((value) => value.includes(code))).toBe(false)
    }

    const challenges = await testDb.select({ codeHash: authChallenges.codeHash }).from(authChallenges)
    expect(challenges.length).toBeGreaterThanOrEqual(4)
    expect(challenges.every(({ codeHash }) => /^[A-Za-z0-9_-]{43}$/.test(codeHash))).toBe(true)
    const tickets = await testDb.select({ tokenHash: authActionTickets.tokenHash }).from(authActionTickets)
    expect(tickets).toHaveLength(2)
    expect(tickets.every(({ tokenHash }) => /^[A-Za-z0-9_-]{43}$/.test(tokenHash))).toBe(true)
    const providers = await testDb.select({ passwordHash: authProviders.passwordHash }).from(authProviders)
    expect(providers.filter(({ passwordHash }) => passwordHash)).toHaveLength(2)

    expect(requestLogMock.mock.calls.length).toBeGreaterThan(0)
    const logged = JSON.stringify([...requestLogMock.mock.calls, ...errorSpy.mock.calls])
    for (const secret of [...rawSecrets, registrationCode, recoveryCode, storeCode]) {
      expect(logged).not.toContain(secret)
    }
  })
})

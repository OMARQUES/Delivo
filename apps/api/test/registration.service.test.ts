import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { StartRegistrationSchema } from '@delivery/shared/schemas'
import {
  authChallenges,
  authProviders,
  emailOutbox,
  pendingRegistrations,
  refreshTokens,
  users,
} from '../src/db/schema'
import type { Env } from '../src/env'
import { dispatchOutboxById } from '../src/email/outbox.service'
import { EmailDeliveryError } from '../src/email/resend-sender'
import { hashPassword, verifyPassword } from '../src/lib/password'
import { deriveAuthCode } from '../src/security/auth-code'
import {
  confirmRegistration,
  RegistrationError,
  resendRegistrationVerification,
  startRegistration,
  type IdentityContext,
} from '../src/services/registration.service'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const AUTH_CODE_SECRET = 'registration-auth-code-secret-with-32-bytes'
const JWT_SECRET = 'registration-jwt-secret-with-32-bytes'
const DAY_MS = 24 * 60 * 60_000
const NOW = new Date()

function context(now = NOW): IdentityContext {
  return {
    authCodeSecret: AUTH_CODE_SECRET,
    jwtSecret: JWT_SECRET,
    requestId: crypto.randomUUID(),
    now,
  }
}

function customerInput(overrides: Record<string, unknown> = {}) {
  return StartRegistrationSchema.parse({
    name: 'Ana Customer',
    email: 'ana@example.com',
    password: 'safe customer password',
    role: 'CUSTOMER',
    acceptedTerms: true,
    turnstileToken: 'turnstile-token',
    ...overrides,
  })
}

function driverInput(overrides: Record<string, unknown> = {}) {
  return StartRegistrationSchema.parse({
    name: 'Davi Driver',
    email: 'davi@example.com',
    phone: '(44) 99999-8888',
    password: 'safe driver password',
    role: 'DRIVER',
    acceptedTerms: true,
    turnstileToken: 'turnstile-token',
    ...overrides,
  })
}

async function activeChallengeForFlow(verificationId: string) {
  const [challenge] = await testDb
    .select()
    .from(authChallenges)
    .where(and(
      eq(authChallenges.pendingRegistrationId, verificationId),
      eq(authChallenges.purpose, 'REGISTRATION_VERIFY'),
      isNull(authChallenges.consumedAt),
      isNull(authChallenges.invalidatedAt),
    ))
    .orderBy(desc(authChallenges.createdAt), desc(authChallenges.id))
    .limit(1)
  if (!challenge) throw new Error('active challenge fixture not found')
  return challenge
}

async function codeForFlow(verificationId: string) {
  const challenge = await activeChallengeForFlow(verificationId)
  const code = await deriveAuthCode(AUTH_CODE_SECRET, {
    challengeId: challenge.id,
    purpose: challenge.purpose,
  })
  return { challenge, code }
}

async function confirmFlow(verificationId: string, ctx = context()) {
  const { code } = await codeForFlow(verificationId)
  return confirmRegistration(testDb, { verificationId, code }, ctx)
}

async function createExistingUser(email = 'existing@example.com') {
  const [user] = await testDb.insert(users).values({
    name: 'Existing User',
    email,
    emailVerifiedAt: NOW,
    role: 'CUSTOMER',
    status: 'ACTIVE',
    termsAcceptedAt: NOW,
  }).returning()
  if (!user) throw new Error('existing user fixture was not created')
  await testDb.insert(authProviders).values({
    userId: user.id,
    provider: 'PASSWORD',
    passwordHash: await hashPassword('existing password'),
  })
  return user
}

function emailEnv(): Env {
  return {
    APP_ENV: 'local',
    HYPERDRIVE: { connectionString: 'postgres://example.invalid/test' } as Hyperdrive,
    BUCKET: {} as R2Bucket,
    JWT_SECRET,
    RATE_LIMIT_HMAC_SECRET: 'rate-limit-secret',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    AUTH_CODE_SECRET,
    PUBLIC_WEB_URL: 'http://localhost:5173/verify',
  }
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('detached registration', () => {
  it('stores only a pending password hash before email confirmation', async () => {
    const input = customerInput()
    const started = await startRegistration(testDb, input, context())

    expect(await testDb.select().from(users)).toHaveLength(0)
    const [pending] = await testDb.select().from(pendingRegistrations)
    expect(pending).toMatchObject({
      id: started.response.verificationId,
      email: input.email,
      name: input.name,
      role: 'CUSTOMER',
      phone: null,
      consumedAt: null,
    })
    expect(pending?.passwordHash).not.toBe(input.password)
    expect(await verifyPassword(input.password, pending!.passwordHash)).toBe(true)
    expect(JSON.stringify(started.response)).not.toContain(input.password)
    expect(await testDb.select().from(authChallenges)).toHaveLength(1)
    expect(await testDb.select().from(emailOutbox)).toHaveLength(1)
  })

  it('confirms a customer atomically with provider and session', async () => {
    const input = customerInput()
    const started = await startRegistration(testDb, input, context())
    const result = await confirmFlow(started.response.verificationId)

    expect(result.kind).toBe('CUSTOMER_SESSION')
    if (result.kind !== 'CUSTOMER_SESSION') throw new Error('customer session expected')
    expect(result.user).toMatchObject({ email: input.email, status: 'ACTIVE', role: 'CUSTOMER' })
    expect(result.accessToken).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()

    const [user] = await testDb.select().from(users)
    const [provider] = await testDb.select().from(authProviders)
    const [refresh] = await testDb.select().from(refreshTokens)
    const [pending] = await testDb.select().from(pendingRegistrations)
    expect(user?.emailVerifiedAt).toEqual(NOW)
    expect(user?.termsAcceptedAt).toEqual(NOW)
    expect(provider).toMatchObject({ userId: user?.id, provider: 'PASSWORD' })
    expect(await verifyPassword(input.password, provider!.passwordHash!)).toBe(true)
    expect(refresh?.userId).toBe(user?.id)
    expect(refresh?.tokenHash).not.toBe(result.refreshToken)
    expect(pending).toMatchObject({ consumedAt: NOW, closeReason: 'CONFIRMED' })
  })

  it('confirms a driver as PENDING_APPROVAL without a session', async () => {
    const input = driverInput()
    const started = await startRegistration(testDb, input, context())
    const result = await confirmFlow(started.response.verificationId)

    expect(result).toMatchObject({
      kind: 'DRIVER_PENDING_APPROVAL',
      user: { email: input.email, phone: '44999998888', status: 'PENDING_APPROVAL', role: 'DRIVER' },
    })
    expect(await testDb.select().from(refreshTokens)).toHaveLength(0)
  })

  it('returns an indistinguishable synthetic flow for an existing account', async () => {
    await createExistingUser()
    const real = await startRegistration(testDb, customerInput({ email: 'new@example.com' }), context())
    const before = {
      pending: (await testDb.select().from(pendingRegistrations)).length,
      challenges: (await testDb.select().from(authChallenges)).length,
    }
    const synthetic = await startRegistration(testDb, customerInput({ email: 'existing@example.com' }), context())

    expect(Object.keys(synthetic.response).sort()).toEqual(Object.keys(real.response).sort())
    expect(synthetic.response.verificationId).not.toBe(real.response.verificationId)
    expect(synthetic.response.expiresAt).toBe(real.response.expiresAt)
    expect(synthetic.response.resendAt).toBe(real.response.resendAt)
    expect(await testDb.select().from(pendingRegistrations)).toHaveLength(before.pending)
    expect(await testDb.select().from(authChallenges)).toHaveLength(before.challenges)

    const resendNow = new Date(NOW.getTime() + 60_000)
    const realResend = await resendRegistrationVerification(
      testDb,
      { verificationId: real.response.verificationId },
      context(resendNow),
    )
    const syntheticResend = await resendRegistrationVerification(
      testDb,
      { verificationId: synthetic.response.verificationId },
      context(resendNow),
    )
    expect(syntheticResend).toMatchObject({
      verificationId: synthetic.response.verificationId,
      expiresAt: realResend.expiresAt,
      resendAt: realResend.resendAt,
      outboxId: null,
    })
  })

  it('queues at most one existing-account notice per user per UTC day', async () => {
    await createExistingUser()
    const input = customerInput({ email: 'existing@example.com' })
    const first = await startRegistration(testDb, input, context())
    const second = await startRegistration(testDb, input, context(new Date(NOW.getTime() + 60_000)))

    expect(second.outboxId).toBe(first.outboxId)
    expect(await testDb.select().from(emailOutbox)).toHaveLength(1)

    await startRegistration(testDb, input, context(new Date(NOW.getTime() + DAY_MS)))
    expect(await testDb.select().from(emailOutbox)).toHaveLength(2)
  })

  it('never transfers profile or password between independent attempts', async () => {
    const firstInput = customerInput({ name: 'First Attempt', password: 'first secure password' })
    const secondInput = customerInput({ name: 'Second Attempt', password: 'second secure password' })
    const first = await startRegistration(testDb, firstInput, context())
    const second = await startRegistration(testDb, secondInput, context())

    await confirmFlow(second.response.verificationId)
    await expect(confirmFlow(first.response.verificationId)).rejects.toMatchObject({
      code: 'CODE_INVALID_OR_EXPIRED',
    })

    const [user] = await testDb.select().from(users)
    const [provider] = await testDb.select().from(authProviders)
    expect(user?.name).toBe('Second Attempt')
    expect(await verifyPassword(secondInput.password, provider!.passwordHash!)).toBe(true)
    expect(await verifyPassword(firstInput.password, provider!.passwordHash!)).toBe(false)
  })

  it('allows one winner under concurrent independent confirmations', async () => {
    const first = await startRegistration(testDb, customerInput({ name: 'First Race' }), context())
    const second = await startRegistration(testDb, customerInput({ name: 'Second Race' }), context())
    const firstCode = await codeForFlow(first.response.verificationId)
    const secondCode = await codeForFlow(second.response.verificationId)

    const results = await Promise.allSettled([
      confirmRegistration(testDb, { verificationId: first.response.verificationId, code: firstCode.code }, context()),
      confirmRegistration(testDb, { verificationId: second.response.verificationId, code: secondCode.code }, context()),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(RegistrationError)
    expect(rejected?.reason).toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })
    expect(await testDb.select().from(users)).toHaveLength(1)
    expect(await testDb.select().from(authProviders)).toHaveLength(1)
    expect(await testDb.select().from(refreshTokens)).toHaveLength(1)
    const pending = await testDb.select().from(pendingRegistrations)
    expect(pending.map((row) => row.closeReason).sort()).toEqual(['ACCOUNT_COLLISION', 'CONFIRMED'])
  })

  it('commits wrong-code accounting before returning the generic error', async () => {
    const started = await startRegistration(testDb, customerInput(), context())
    const { challenge, code } = await codeForFlow(started.response.verificationId)
    const wrongCode = `${code[0] === '0' ? '1' : '0'}${code.slice(1)}`

    await expect(confirmRegistration(
      testDb,
      { verificationId: started.response.verificationId, code: wrongCode },
      context(),
    )).rejects.toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })

    const [stored] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, challenge.id))
    expect(stored).toMatchObject({ attemptCount: 1, consumedAt: null, invalidatedAt: null })
  })

  it('issues only one account and session for concurrent confirmation of one flow', async () => {
    const started = await startRegistration(testDb, customerInput(), context())
    const { code } = await codeForFlow(started.response.verificationId)
    const confirm = () => confirmRegistration(
      testDb,
      { verificationId: started.response.verificationId, code },
      context(),
    )

    const results = await Promise.allSettled([confirm(), confirm()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await testDb.select().from(users)).toHaveLength(1)
    expect(await testDb.select().from(authProviders)).toHaveLength(1)
    expect(await testDb.select().from(refreshTokens)).toHaveLength(1)
  })

  it('replaces only the internal challenge and preserves the 24-hour flow boundary', async () => {
    const started = await startRegistration(testDb, customerInput(), context())
    const oldChallenge = await activeChallengeForFlow(started.response.verificationId)
    const nearAbsoluteExpiry = new Date(NOW.getTime() + DAY_MS - 5 * 60_000)

    const resent = await resendRegistrationVerification(
      testDb,
      { verificationId: started.response.verificationId },
      context(nearAbsoluteExpiry),
    )

    expect(resent.verificationId).toBe(started.response.verificationId)
    expect(resent.expiresAt).toBe(new Date(NOW.getTime() + DAY_MS).toISOString())
    const newChallenge = await activeChallengeForFlow(started.response.verificationId)
    expect(newChallenge.id).not.toBe(oldChallenge.id)
    const [storedOld] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, oldChallenge.id))
    expect(storedOld).toMatchObject({ invalidationReason: 'REPLACED' })
    const outboxes = await testDb.select().from(emailOutbox).orderBy(emailOutbox.createdAt)
    expect(outboxes).toHaveLength(2)
    expect(outboxes[0]?.status).toBe('CANCELLED')
    expect(outboxes[1]?.status).toBe('PENDING')
  })

  it('keeps committed flow retryable after a transient provider failure', async () => {
    const started = await startRegistration(testDb, customerInput(), context())
    const result = await dispatchOutboxById(testDb, {
      send: async () => { throw new EmailDeliveryError('PROVIDER_UNAVAILABLE') },
    }, emailEnv(), started.outboxId!, new Date())

    expect(result.status).toBe('RETRY_SCHEDULED')
    expect(await testDb.select().from(pendingRegistrations)).toHaveLength(1)
    expect(await testDb.select().from(authChallenges)).toHaveLength(1)
    const [outbox] = await testDb.select().from(emailOutbox)
    expect(outbox).toMatchObject({ status: 'PENDING', attemptCount: 1, failureClass: 'PROVIDER_UNAVAILABLE' })
  })

  it('returns a synthetic resend before cooldown without mutating the flow', async () => {
    const started = await startRegistration(testDb, customerInput(), context())
    const result = await resendRegistrationVerification(
      testDb,
      { verificationId: started.response.verificationId },
      context(new Date(NOW.getTime() + 59_999)),
    )

    expect(result).toMatchObject({ verificationId: started.response.verificationId, outboxId: null })
    expect(await testDb.select().from(authChallenges)).toHaveLength(1)
    expect(await testDb.select().from(emailOutbox)).toHaveLength(1)
  })

  it('does not persist raw secrets in identity rows', async () => {
    const input = customerInput()
    const started = await startRegistration(testDb, input, context())
    const rows = await testDb.execute<{ document: string }>(sql`
      select jsonb_build_object(
        'pending', (select jsonb_agg(p) from pending_registrations p),
        'challenges', (select jsonb_agg(c) from auth_challenges c),
        'outbox', (select jsonb_agg(o) from email_outbox o)
      )::text as document
    `)
    const document = rows[0]?.document ?? ''
    const { code } = await codeForFlow(started.response.verificationId)
    expect(document).not.toContain(input.password)
    expect(document).not.toContain(code)
    expect(document).not.toContain(AUTH_CODE_SECRET)
    expect(document).not.toContain(JWT_SECRET)
  })
})

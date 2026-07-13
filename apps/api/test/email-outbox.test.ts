import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { authChallenges, emailOutbox } from '../src/db/schema'
import type { Env } from '../src/env'
import type { EmailSender } from '../src/email/sender'
import { EmailDeliveryError } from '../src/email/resend-sender'
import {
  dispatchDueOutbox,
  dispatchOutboxById,
  enqueueChallengeEmail,
  enqueueNoticeEmail,
} from '../src/email/outbox.service'
import { deriveAuthCode, hashAuthCode } from '../src/security/auth-code'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const AUTH_CODE_SECRET = 'outbox-auth-code-secret-with-32-bytes'
const START = new Date('2026-07-12T12:00:00.000Z')

function env(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'staging',
    HYPERDRIVE: { connectionString: 'postgres://example.invalid/test' } as Hyperdrive,
    BUCKET: {} as R2Bucket,
    JWT_SECRET: 'jwt-secret',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    RATE_LIMIT_HMAC_SECRET: 'rate-secret',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
    AUTH_CODE_SECRET,
    PUBLIC_WEB_URL: 'https://app.example.com/verify',
    ...overrides,
  }
}

function successfulSender(onSend?: EmailSender['send']): EmailSender {
  return {
    send: onSend ?? (async () => ({ providerMessageId: `email-${crypto.randomUUID()}` })),
  }
}

async function enqueueNotice(subject = crypto.randomUUID()) {
  return testDb.transaction((tx) => enqueueNoticeEmail(tx, {
    template: 'PASSWORD_CHANGED_NOTICE',
    recipient: `${subject}@example.com`,
    dedupeSubjectKey: subject,
  }))
}

async function createChallenge(input: {
  purpose?: 'REGISTRATION_VERIFY' | 'PASSWORD_RECOVERY'
  expiresAt?: Date
  invalidatedAt?: Date | null
} = {}) {
  const id = crypto.randomUUID()
  const purpose = input.purpose ?? 'PASSWORD_RECOVERY'
  const code = await deriveAuthCode(AUTH_CODE_SECRET, { challengeId: id, purpose })
  const codeHash = await hashAuthCode(AUTH_CODE_SECRET, { challengeId: id, purpose }, code)
  await testDb.insert(authChallenges).values({
    id,
    purpose,
    email: 'person@example.com',
    codeHash,
    expiresAt: input.expiresAt ?? new Date(START.getTime() + 10 * 60_000),
    invalidatedAt: input.invalidatedAt,
  })
  return { id, purpose, code }
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('email outbox', () => {
  it('reconstructs challenge code only in memory and never persists it', async () => {
    const challenge = await createChallenge()
    const id = await testDb.transaction((tx) => enqueueChallengeEmail(tx, {
      template: 'PASSWORD_RECOVERY',
      recipient: 'person@example.com',
      challengeId: challenge.id,
      flowId: challenge.id,
    }))
    await testDb.update(emailOutbox).set({ nextAttemptAt: START }).where(eq(emailOutbox.id, id))
    const send = vi.fn<EmailSender['send']>(async () => ({ providerMessageId: 'email-code' }))

    await expect(dispatchOutboxById(testDb, successfulSender(send), env(), id, START)).resolves.toEqual({
      status: 'SENT',
      providerMessageId: 'email-code',
    })

    expect(send).toHaveBeenCalledTimes(1)
    const [envelope] = send.mock.calls[0]!
    expect(envelope.text).toContain(challenge.code)
    expect(envelope.html).toContain(challenge.code)
    expect(envelope.text).toContain(`/recuperar-senha/codigo?id=${challenge.id}`)
    const [row] = await testDb.select().from(emailOutbox).where(eq(emailOutbox.id, id))
    expect(JSON.stringify(row)).not.toContain(challenge.code)
    expect(row).toMatchObject({ status: 'SENT', attemptCount: 1, providerMessageId: 'email-code' })
    expect(row?.leasedUntil).toBeNull()
  })

  it('allows only one provider call for concurrent dispatchers', async () => {
    const id = await enqueueNotice()
    await testDb.update(emailOutbox).set({ nextAttemptAt: START }).where(eq(emailOutbox.id, id))
    const send = vi.fn<EmailSender['send']>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { providerMessageId: 'email-once' }
    })
    const sender = successfulSender(send)

    const results = await Promise.all([
      dispatchOutboxById(testDb, sender, env(), id, START),
      dispatchOutboxById(testDb, sender, env(), id, START),
    ])

    expect(send).toHaveBeenCalledTimes(1)
    expect(results).toEqual(expect.arrayContaining([
      { status: 'SENT', providerMessageId: 'email-once' },
      { status: 'NOT_CLAIMED' },
    ]))
  })

  it('recovers an abandoned lease after two minutes', async () => {
    const id = await enqueueNotice()
    await testDb.update(emailOutbox).set({
      status: 'PROCESSING',
      leasedUntil: new Date(START.getTime() - 1),
    }).where(eq(emailOutbox.id, id))

    await expect(dispatchOutboxById(testDb, successfulSender(), env(), id, START)).resolves.toMatchObject({
      status: 'SENT',
    })
  })

  it('cancels code mail when its challenge is missing, inactive, expired, or mismatched', async () => {
    const cases = [
      { challenge: await createChallenge({ expiresAt: new Date(START.getTime() - 1) }), template: 'PASSWORD_RECOVERY' as const },
      { challenge: await createChallenge({ invalidatedAt: new Date(START.getTime() - 1) }), template: 'PASSWORD_RECOVERY' as const },
      { challenge: await createChallenge({ purpose: 'REGISTRATION_VERIFY' }), template: 'PASSWORD_RECOVERY' as const },
    ]
    const send = vi.fn<EmailSender['send']>()

    const missingChallengeId = crypto.randomUUID()
    await testDb.insert(emailOutbox).values({
      id: missingChallengeId,
      template: 'PASSWORD_RECOVERY',
      recipient: 'missing@example.com',
      idempotencyKey: `outbox:${missingChallengeId}`,
      nextAttemptAt: START,
    })
    await expect(dispatchOutboxById(
      testDb,
      successfulSender(send),
      env(),
      missingChallengeId,
      START,
    )).resolves.toEqual({ status: 'CANCELLED', failureClass: 'CHALLENGE_INACTIVE' })

    for (const [index, item] of cases.entries()) {
      const id = crypto.randomUUID()
      await testDb.insert(emailOutbox).values({
        id,
        template: item.template,
        recipient: `stale-${index}@example.com`,
        challengeId: item.challenge.id,
        idempotencyKey: `outbox:${id}`,
        nextAttemptAt: START,
      })
      await expect(dispatchOutboxById(testDb, successfulSender(send), env(), id, START)).resolves.toEqual({
        status: 'CANCELLED',
        failureClass: 'CHALLENGE_INACTIVE',
      })
    }

    expect(send).not.toHaveBeenCalled()
    expect(await testDb.select().from(emailOutbox)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'CANCELLED', leasedUntil: null }),
    ]))
  })

  it('keeps retryable failures pending with stable idempotency', async () => {
    const id = await enqueueNotice()
    await testDb.update(emailOutbox).set({ createdAt: START, nextAttemptAt: START }).where(eq(emailOutbox.id, id))
    const keys: string[] = []
    const send = vi.fn<EmailSender['send']>(async (_envelope, options) => {
      keys.push(options.idempotencyKey)
      if (keys.length === 1) throw new EmailDeliveryError('NETWORK')
      return { providerMessageId: 'email-retry' }
    })

    await expect(dispatchOutboxById(testDb, successfulSender(send), env(), id, START)).resolves.toEqual({
      status: 'RETRY_SCHEDULED',
      nextAttemptAt: new Date(START.getTime() + 5 * 60_000),
    })
    const [pending] = await testDb.select().from(emailOutbox).where(eq(emailOutbox.id, id))
    expect(pending).toMatchObject({ status: 'PENDING', attemptCount: 1, failureClass: 'NETWORK' })
    expect(pending?.leasedUntil).toBeNull()

    await expect(dispatchOutboxById(
      testDb,
      successfulSender(send),
      env(),
      id,
      new Date(START.getTime() + 5 * 60_000),
    )).resolves.toEqual({ status: 'SENT', providerMessageId: 'email-retry' })
    expect(keys).toEqual([`outbox:${id}`, `outbox:${id}`])
  })

  it('schedules notice attempts at 0, 5m, 30m, 2h and 12h then fails', async () => {
    const id = await enqueueNotice()
    await testDb.update(emailOutbox).set({ createdAt: START, nextAttemptAt: START }).where(eq(emailOutbox.id, id))
    const sender = successfulSender(async () => {
      throw new EmailDeliveryError('PROVIDER_UNAVAILABLE')
    })
    const attempts = [
      START,
      new Date(START.getTime() + 5 * 60_000),
      new Date(START.getTime() + 30 * 60_000),
      new Date(START.getTime() + 2 * 60 * 60_000),
      new Date(START.getTime() + 12 * 60 * 60_000),
    ]

    for (let index = 0; index < attempts.length - 1; index++) {
      await expect(dispatchOutboxById(testDb, sender, env(), id, attempts[index])).resolves.toEqual({
        status: 'RETRY_SCHEDULED',
        nextAttemptAt: attempts[index + 1],
      })
    }
    await expect(dispatchOutboxById(testDb, sender, env(), id, attempts[4])).resolves.toEqual({
      status: 'FAILED',
      failureClass: 'PROVIDER_UNAVAILABLE',
    })
    const [row] = await testDb.select().from(emailOutbox).where(eq(emailOutbox.id, id))
    expect(row).toMatchObject({ status: 'FAILED', attemptCount: 5, leasedUntil: null })
  })

  it('fails terminal provider errors without retry', async () => {
    const id = await enqueueNotice()
    const sender = successfulSender(async () => {
      throw new EmailDeliveryError('PROVIDER_REJECTED')
    })

    await expect(dispatchOutboxById(testDb, sender, env(), id, new Date())).resolves.toEqual({
      status: 'FAILED',
      failureClass: 'PROVIDER_REJECTED',
    })
  })

  it('claims at most 50 due rows per batch', async () => {
    const ids = Array.from({ length: 55 }, () => crypto.randomUUID())
    await testDb.insert(emailOutbox).values(ids.map((id, index) => ({
      id,
      template: 'ACCOUNT_EXISTS_NOTICE',
      recipient: `batch-${index}@example.com`,
      idempotencyKey: `outbox:${id}`,
      dedupeKey: `ACCOUNT_EXISTS_NOTICE:batch-${index}`,
      nextAttemptAt: START,
    })))
    const send = vi.fn<EmailSender['send']>(async () => ({ providerMessageId: crypto.randomUUID() }))

    await expect(dispatchDueOutbox(testDb, successfulSender(send), env(), START, 100)).resolves.toEqual({
      claimed: 50,
      sent: 50,
      retryScheduled: 0,
      cancelled: 0,
      failed: 0,
    })
    expect(send).toHaveBeenCalledTimes(50)
    const pending = await testDb.execute<{ count: number }>(sql`
      select count(*)::int as count from email_outbox where status = 'PENDING'
    `)
    expect(pending[0]?.count).toBe(5)
  })
})

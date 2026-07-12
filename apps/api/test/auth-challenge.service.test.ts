import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { authChallenges, emailOutbox, pendingRegistrations } from '../src/db/schema'
import type { AuthChallengePurpose } from '../src/db/schema'
import {
  createChallenge,
  replaceChallenge,
  verifyAndConsumeChallenge,
} from '../src/services/auth-challenge.service'
import { deriveAuthCode } from '../src/security/auth-code'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const SECRET = 'challenge-test-secret-with-at-least-32-bytes'
const NOW = new Date('2026-07-12T12:00:00.000Z')
const TEN_MINUTES_LATER = new Date(NOW.getTime() + 10 * 60_000)

function invalidCode(code: string): string {
  return `${code[0] === '0' ? '1' : '0'}${code.slice(1)}`
}

async function createEmailChallenge(overrides: Partial<{
  purpose: 'REGISTRATION_VERIFY' | 'PASSWORD_RECOVERY'
  expiresAt: Date
}> = {}) {
  return testDb.transaction((tx) => createChallenge(tx, {
    purpose: overrides.purpose ?? 'PASSWORD_RECOVERY',
    email: 'person@example.com',
    authCodeSecret: SECRET,
    expiresAt: overrides.expiresAt ?? TEN_MINUTES_LATER,
    now: NOW,
  }))
}

async function codeFor(challenge: { id: string; purpose: AuthChallengePurpose }) {
  return deriveAuthCode(SECRET, { challengeId: challenge.id, purpose: challenge.purpose })
}

async function verify(input: {
  challengeId: string
  expectedPurpose: AuthChallengePurpose
  code: string
  now?: Date
}) {
  return testDb.transaction((tx) => verifyAndConsumeChallenge(tx, {
    ...input,
    authCodeSecret: SECRET,
    now: input.now ?? NOW,
  }))
}

async function expectVerificationFailure(promise: ReturnType<typeof verify>) {
  const result = await promise
  expect(result).toMatchObject({
    ok: false,
    error: { name: 'ChallengeError', code: 'INVALID_OR_EXPIRED' },
  })
}

function expectGenericChallengeRejection(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({
    name: 'ChallengeError', code: 'INVALID_OR_EXPIRED',
  })
}

async function createPendingRegistration(expiresAt: Date) {
  const [pending] = await testDb.insert(pendingRegistrations).values({
    email: 'pending@example.com',
    name: 'Pending Person',
    role: 'CUSTOMER',
    passwordHash: 'not-a-password',
    termsAcceptedAt: NOW,
    expiresAt,
    createdAt: NOW,
    updatedAt: NOW,
  }).returning()
  if (!pending) throw new Error('pending registration fixture was not created')
  return pending
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('auth challenge service', () => {
  it('stores only a keyed hash, never the six-digit code', async () => {
    const challenge = await createEmailChallenge()
    const code = await codeFor(challenge)

    expect(challenge.codeHash).not.toBe(code)
    expect(JSON.stringify(challenge)).not.toContain(`"code":"${code}"`)
    expect(challenge.attemptCount).toBe(0)
  })

  it('caps caller-supplied expiry at ten minutes', async () => {
    const challenge = await createEmailChallenge({
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    })
    expect(challenge.expiresAt).toEqual(TEN_MINUTES_LATER)
  })

  it('atomically consumes a valid active challenge', async () => {
    const challenge = await createEmailChallenge()
    const result = await verify({
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      code: await codeFor(challenge),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.challenge.consumedAt).toEqual(NOW)
    expect(result.challenge.attemptCount).toBe(0)
  })

  it('maps malformed and wrong codes to one error while counting attempts', async () => {
    const malformed = await createEmailChallenge()
    await expectVerificationFailure(verify({
      challengeId: malformed.id,
      expectedPurpose: malformed.purpose,
      code: '12a456',
    }))

    const wrong = await createEmailChallenge()
    const correctCode = await codeFor(wrong)
    await expectVerificationFailure(verify({
      challengeId: wrong.id,
      expectedPurpose: wrong.purpose,
      code: invalidCode(correctCode),
    }))

    const rows = await testDb.select().from(authChallenges)
    expect(rows.find((row) => row.id === malformed.id)?.attemptCount).toBe(1)
    expect(rows.find((row) => row.id === wrong.id)?.attemptCount).toBe(1)
  })

  it('caps concurrent wrong attempts at five and invalidates on the fifth', async () => {
    const challenge = await createEmailChallenge()
    const wrongCode = invalidCode(await codeFor(challenge))

    const results = await Promise.all(Array.from({ length: 8 }, () => verify({
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      code: wrongCode,
    })))

    expect(results.every((result) => !result.ok)).toBe(true)
    const [stored] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, challenge.id))
    expect(stored).toMatchObject({ attemptCount: 5, invalidatedAt: NOW, invalidationReason: 'ATTEMPTS_EXHAUSTED' })
  })

  it('rejects the exact expiry boundary without incrementing attempts', async () => {
    const challenge = await createEmailChallenge()
    await expectVerificationFailure(verify({
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      code: await codeFor(challenge),
      now: challenge.expiresAt,
    }))

    const [stored] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, challenge.id))
    expect(stored?.attemptCount).toBe(0)
    expect(stored?.consumedAt).toBeNull()
  })

  it('rejects replay and purpose confusion with the same generic error', async () => {
    const challenge = await createEmailChallenge()
    const code = await codeFor(challenge)
    await verify({ challengeId: challenge.id, expectedPurpose: challenge.purpose, code })

    await expectVerificationFailure(verify({
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      code,
      now: new Date(NOW.getTime() + 1),
    }))

    const another = await createEmailChallenge()
    await expectVerificationFailure(verify({
      challengeId: another.id,
      expectedPurpose: 'REGISTRATION_VERIFY',
      code: await codeFor(another),
    }))
    const [stored] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, another.id))
    expect(stored?.attemptCount).toBe(0)
  })

  it('replaces a challenge and cancels its unsent outbox atomically', async () => {
    const oldChallenge = await createEmailChallenge()
    const outboxId = crypto.randomUUID()
    await testDb.insert(emailOutbox).values({
      id: outboxId,
      template: 'PASSWORD_RECOVERY',
      recipient: 'person@example.com',
      challengeId: oldChallenge.id,
      idempotencyKey: `outbox:${outboxId}`,
      nextAttemptAt: NOW,
    })

    const replacement = await testDb.transaction((tx) => replaceChallenge(tx, {
      challengeId: oldChallenge.id,
      expectedPurpose: oldChallenge.purpose,
      authCodeSecret: SECRET,
      expiresAt: new Date(NOW.getTime() + 9 * 60_000),
      now: NOW,
    }))

    const [storedOld] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, oldChallenge.id))
    const [storedOutbox] = await testDb.select().from(emailOutbox).where(eq(emailOutbox.id, outboxId))
    expect(replacement).toMatchObject({ purpose: oldChallenge.purpose, email: oldChallenge.email })
    expect(replacement.id).not.toBe(oldChallenge.id)
    expect(replacement.codeHash).not.toBe(oldChallenge.codeHash)
    expect(storedOld).toMatchObject({ invalidatedAt: NOW, invalidationReason: 'REPLACED' })
    expect(storedOutbox).toMatchObject({ status: 'CANCELLED', failureClass: 'CHALLENGE_REPLACED' })
    await expectVerificationFailure(verify({
      challengeId: oldChallenge.id,
      expectedPurpose: oldChallenge.purpose,
      code: await codeFor(oldChallenge),
    }))
  })

  it('clamps replacement expiry to the pending registration absolute expiry', async () => {
    const pendingExpiry = new Date(NOW.getTime() + 5 * 60_000)
    const pending = await createPendingRegistration(pendingExpiry)
    const oldChallenge = await testDb.transaction((tx) => createChallenge(tx, {
      purpose: 'REGISTRATION_VERIFY',
      pendingRegistrationId: pending.id,
      authCodeSecret: SECRET,
      expiresAt: TEN_MINUTES_LATER,
      now: NOW,
    }))

    const replacement = await testDb.transaction((tx) => replaceChallenge(tx, {
      challengeId: oldChallenge.id,
      expectedPurpose: 'REGISTRATION_VERIFY',
      authCodeSecret: SECRET,
      expiresAt: TEN_MINUTES_LATER,
      now: NOW,
    }))

    expect(oldChallenge.expiresAt).toEqual(pendingExpiry)
    expect(replacement.expiresAt).toEqual(pendingExpiry)
  })

  it('allows one replacement after attempts are exhausted', async () => {
    const challenge = await createEmailChallenge()
    const wrongCode = invalidCode(await codeFor(challenge))
    for (let attempt = 0; attempt < 5; attempt++) {
      await expectVerificationFailure(verify({
        challengeId: challenge.id,
        expectedPurpose: challenge.purpose,
        code: wrongCode,
      }))
    }

    const replacement = await testDb.transaction((tx) => replaceChallenge(tx, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      authCodeSecret: SECRET,
      expiresAt: TEN_MINUTES_LATER,
      now: NOW,
    }))
    expect(replacement.id).not.toBe(challenge.id)

    await expectGenericChallengeRejection(testDb.transaction((tx) => replaceChallenge(tx, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      authCodeSecret: SECRET,
      expiresAt: TEN_MINUTES_LATER,
      now: NOW,
    })))
  })

  it('allows only one concurrent replacement for the same challenge', async () => {
    const challenge = await createEmailChallenge()
    const replace = () => testDb.transaction((tx) => replaceChallenge(tx, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      authCodeSecret: SECRET,
      expiresAt: TEN_MINUTES_LATER,
      now: NOW,
    }))

    const results = await Promise.allSettled([replace(), replace()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await testDb.select().from(authChallenges)).toHaveLength(2)
  })
})

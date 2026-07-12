import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { authChallenges, emailOutbox, pendingRegistrations } from '../db/schema'
import type { AuthChallengePurpose } from '../db/schema'
import type { DbTx } from '../db/types'
import { deriveAuthCode, hashAuthCode, verifyAuthCode } from '../security/auth-code'

const MAX_CHALLENGE_TTL_MS = 10 * 60_000

export type AuthChallenge = typeof authChallenges.$inferSelect

type ChallengeSubject =
  | { pendingRegistrationId: string; userId?: never; email?: never }
  | { pendingRegistrationId?: never; userId: string; email?: never }
  | { pendingRegistrationId?: never; userId?: never; email: string }

export type CreateChallengeInput = ChallengeSubject & {
  purpose: AuthChallengePurpose
  authCodeSecret: string
  expiresAt: Date
  now?: Date
}

export type ReplaceChallengeInput = {
  challengeId: string
  expectedPurpose: AuthChallengePurpose
  authCodeSecret: string
  expiresAt: Date
  now?: Date
}

export type VerifyChallengeInput = {
  challengeId: string
  expectedPurpose: AuthChallengePurpose
  code: string
  authCodeSecret: string
  now?: Date
}

export type ChallengeVerificationResult =
  | { ok: true; challenge: AuthChallenge }
  | { ok: false; error: ChallengeError }

export class ChallengeError extends Error {
  readonly code = 'INVALID_OR_EXPIRED' as const

  constructor() {
    super('Challenge invalid or expired')
    this.name = 'ChallengeError'
  }
}

function invalidChallenge(): never {
  throw new ChallengeError()
}

function failedVerification(): ChallengeVerificationResult {
  return { ok: false, error: new ChallengeError() }
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime())
}

function normalizeSubject(input: ChallengeSubject): ChallengeSubject {
  const subjectCount = Number(input.pendingRegistrationId !== undefined)
    + Number(input.userId !== undefined)
    + Number(input.email !== undefined)
  if (subjectCount !== 1) return invalidChallenge()

  if (input.pendingRegistrationId !== undefined) {
    if (!input.pendingRegistrationId) return invalidChallenge()
    return { pendingRegistrationId: input.pendingRegistrationId }
  }
  if (input.userId !== undefined) {
    if (!input.userId) return invalidChallenge()
    return { userId: input.userId }
  }

  const email = input.email.trim().toLowerCase()
  if (!email) return invalidChallenge()
  return { email }
}

async function clampExpiryToPendingRegistration(
  tx: DbTx,
  subject: ChallengeSubject,
  requestedExpiry: Date,
  now: Date,
): Promise<Date> {
  if (!validDate(now) || !validDate(requestedExpiry)) return invalidChallenge()

  const maximumExpiry = new Date(now.getTime() + MAX_CHALLENGE_TTL_MS)
  let expiresAt = requestedExpiry.getTime() < maximumExpiry.getTime() ? requestedExpiry : maximumExpiry
  if (subject.pendingRegistrationId) {
    const [pending] = await tx
      .select({ expiresAt: pendingRegistrations.expiresAt, consumedAt: pendingRegistrations.consumedAt })
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.id, subject.pendingRegistrationId))
      .for('update')
    if (!pending || pending.consumedAt || pending.expiresAt.getTime() <= now.getTime()) return invalidChallenge()
    if (pending.expiresAt.getTime() < expiresAt.getTime()) expiresAt = pending.expiresAt
  }

  if (expiresAt.getTime() <= now.getTime()) return invalidChallenge()
  return expiresAt
}

async function insertChallenge(
  tx: DbTx,
  input: CreateChallengeInput,
  subject: ChallengeSubject,
  now: Date,
  expiresAt: Date,
): Promise<AuthChallenge> {
  const id = crypto.randomUUID()
  const context = { challengeId: id, purpose: input.purpose }
  const code = await deriveAuthCode(input.authCodeSecret, context)
  const codeHash = await hashAuthCode(input.authCodeSecret, context, code)
  const [created] = await tx.insert(authChallenges).values({
    id,
    purpose: input.purpose,
    ...subject,
    codeHash,
    expiresAt,
    createdAt: now,
  }).returning()
  if (!created) return invalidChallenge()
  return created
}

export async function createChallenge(tx: DbTx, input: CreateChallengeInput): Promise<AuthChallenge> {
  const now = input.now ?? new Date()
  const subject = normalizeSubject(input)
  const expiresAt = await clampExpiryToPendingRegistration(tx, subject, input.expiresAt, now)
  return insertChallenge(tx, input, subject, now, expiresAt)
}

function subjectFromChallenge(challenge: AuthChallenge): ChallengeSubject {
  return normalizeSubject({
    pendingRegistrationId: challenge.pendingRegistrationId ?? undefined,
    userId: challenge.userId ?? undefined,
    email: challenge.email ?? undefined,
  } as ChallengeSubject)
}

function replacementAllowed(challenge: AuthChallenge): boolean {
  if (challenge.consumedAt) return false
  if (!challenge.invalidatedAt) return true
  return challenge.invalidationReason === 'ATTEMPTS_EXHAUSTED'
}

export async function replaceChallenge(tx: DbTx, input: ReplaceChallengeInput): Promise<AuthChallenge> {
  const now = input.now ?? new Date()
  if (!validDate(now)) return invalidChallenge()

  const [previous] = await tx
    .select()
    .from(authChallenges)
    .where(and(
      eq(authChallenges.id, input.challengeId),
      eq(authChallenges.purpose, input.expectedPurpose),
    ))
    .for('update')
  if (!previous || !replacementAllowed(previous)) return invalidChallenge()

  const subject = subjectFromChallenge(previous)
  const expiresAt = await clampExpiryToPendingRegistration(tx, subject, input.expiresAt, now)
  const replacementReason = previous.attemptCount >= 5
    ? 'REPLACED_AFTER_ATTEMPTS_EXHAUSTED'
    : 'REPLACED'

  const [invalidated] = await tx
    .update(authChallenges)
    .set({ invalidatedAt: now, invalidationReason: replacementReason })
    .where(and(
      eq(authChallenges.id, previous.id),
      eq(authChallenges.purpose, input.expectedPurpose),
      isNull(authChallenges.consumedAt),
      or(
        isNull(authChallenges.invalidatedAt),
        eq(authChallenges.invalidationReason, 'ATTEMPTS_EXHAUSTED'),
      ),
    ))
    .returning({ id: authChallenges.id })
  if (!invalidated) return invalidChallenge()

  await tx
    .update(emailOutbox)
    .set({
      status: 'CANCELLED',
      leasedUntil: null,
      failureClass: 'CHALLENGE_REPLACED',
      updatedAt: now,
    })
    .where(and(
      eq(emailOutbox.challengeId, previous.id),
      inArray(emailOutbox.status, ['PENDING', 'PROCESSING']),
    ))

  return insertChallenge(tx, {
    purpose: previous.purpose,
    ...subject,
    authCodeSecret: input.authCodeSecret,
    expiresAt,
    now,
  }, subject, now, expiresAt)
}

function activeAt(challenge: AuthChallenge, now: Date): boolean {
  return !challenge.consumedAt
    && !challenge.invalidatedAt
    && challenge.attemptCount < 5
    && challenge.expiresAt.getTime() > now.getTime()
}

async function equalizeMissingChallengeVerification(input: VerifyChallengeInput): Promise<void> {
  await verifyAuthCode(
    input.authCodeSecret,
    { challengeId: input.challengeId, purpose: input.expectedPurpose },
    input.code,
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  )
}

export async function verifyAndConsumeChallenge(
  tx: DbTx,
  input: VerifyChallengeInput,
): Promise<ChallengeVerificationResult> {
  const now = input.now ?? new Date()
  if (!validDate(now)) return failedVerification()

  const [challenge] = await tx
    .select()
    .from(authChallenges)
    .where(and(
      eq(authChallenges.id, input.challengeId),
      eq(authChallenges.purpose, input.expectedPurpose),
    ))
    .for('update')

  if (!challenge) {
    await equalizeMissingChallengeVerification(input)
    return failedVerification()
  }

  const matches = await verifyAuthCode(
    input.authCodeSecret,
    { challengeId: challenge.id, purpose: challenge.purpose },
    input.code,
    challenge.codeHash,
  )
  if (!activeAt(challenge, now)) return failedVerification()

  const activePredicates = and(
    eq(authChallenges.id, challenge.id),
    eq(authChallenges.purpose, input.expectedPurpose),
    isNull(authChallenges.consumedAt),
    isNull(authChallenges.invalidatedAt),
    gt(authChallenges.expiresAt, now),
    lt(authChallenges.attemptCount, 5),
  )

  if (!matches) {
    await tx
      .update(authChallenges)
      .set({
        attemptCount: sql`${authChallenges.attemptCount} + 1`,
        invalidatedAt: sql`case
          when ${authChallenges.attemptCount} + 1 >= 5 then ${now.toISOString()}::timestamptz
          else ${authChallenges.invalidatedAt}
        end`,
        invalidationReason: sql`case
          when ${authChallenges.attemptCount} + 1 >= 5 then 'ATTEMPTS_EXHAUSTED'
          else ${authChallenges.invalidationReason}
        end`,
      })
      .where(activePredicates)
    return failedVerification()
  }

  const [consumed] = await tx
    .update(authChallenges)
    .set({ consumedAt: now })
    .where(activePredicates)
    .returning()
  if (!consumed) return failedVerification()
  return { ok: true, challenge: consumed }
}

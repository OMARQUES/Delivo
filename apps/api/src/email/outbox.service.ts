import { and, eq, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { authChallenges, emailOutbox, pendingRegistrations, users } from '../db/schema'
import type { DbTx } from '../db/types'
import type { Env } from '../env'
import { deriveAuthCode } from '../security/auth-code'
import { EmailDeliveryError } from './resend-sender'
import type { EmailSender } from './sender'
import { renderEmail } from './templates'
import type {
  ChallengeEmailInput,
  DispatchResult,
  DispatchSummary,
  EmailTemplate,
  NoticeEmailInput,
} from './types'

const LEASE_MS = 2 * 60_000
const MAX_BATCH_SIZE = 50
const NOTICE_ATTEMPT_OFFSETS_MS = [0, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000] as const
const RETRYABLE_FAILURES = new Set([
  'TIMEOUT',
  'NETWORK',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
])
const CODE_TEMPLATES = new Set<EmailTemplate>(['VERIFICATION_CODE', 'PASSWORD_RECOVERY'])

type Challenge = typeof authChallenges.$inferSelect
type OutboxRow = typeof emailOutbox.$inferSelect

function normalizeRecipient(recipient: string): string {
  const normalized = recipient.trim().toLowerCase()
  if (!normalized) throw new Error('Email recipient is required')
  return normalized
}

function outboxKeys(id: string, dedupeKey: string) {
  return { id, idempotencyKey: `outbox:${id}`, dedupeKey }
}

async function existingOutboxId(tx: DbTx, dedupeKey: string): Promise<string> {
  const [existing] = await tx
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(eq(emailOutbox.dedupeKey, dedupeKey))
    .limit(1)
  if (!existing) throw new Error('Unable to resolve deduplicated email')
  return existing.id
}

function challengeAcceptsTemplate(challenge: Challenge, template: ChallengeEmailInput['template']): boolean {
  if (template === 'PASSWORD_RECOVERY') return challenge.purpose === 'PASSWORD_RECOVERY'
  return challenge.purpose !== 'PASSWORD_RECOVERY'
}

function challengeFlowId(challenge: Challenge): string {
  return challenge.pendingRegistrationId ?? challenge.id
}

async function challengeRecipient(tx: DbTx, challenge: Challenge): Promise<string | null> {
  if (challenge.email) return challenge.email
  if (challenge.pendingRegistrationId) {
    const [pending] = await tx
      .select({ email: pendingRegistrations.email })
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.id, challenge.pendingRegistrationId))
      .limit(1)
    return pending?.email ?? null
  }
  if (challenge.userId) {
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, challenge.userId))
      .limit(1)
    return user?.email ?? null
  }
  return null
}

export async function enqueueChallengeEmail(tx: DbTx, input: ChallengeEmailInput): Promise<string> {
  const [challenge] = await tx
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.id, input.challengeId))
    .limit(1)
  if (!challenge || !challengeAcceptsTemplate(challenge, input.template)) {
    throw new Error('Challenge does not match email template')
  }
  if (challengeFlowId(challenge) !== input.flowId) throw new Error('Challenge does not match email flow')

  const recipient = normalizeRecipient(input.recipient)
  const expectedRecipient = await challengeRecipient(tx, challenge)
  if (!expectedRecipient || normalizeRecipient(expectedRecipient) !== recipient) {
    throw new Error('Challenge does not match email recipient')
  }

  const id = crypto.randomUUID()
  const dedupeKey = `challenge:${input.template}:${input.challengeId}`
  const inserted = await tx.insert(emailOutbox).values({
    ...outboxKeys(id, dedupeKey),
    template: input.template,
    recipient,
    challengeId: input.challengeId,
  }).onConflictDoNothing({ target: emailOutbox.dedupeKey }).returning({ id: emailOutbox.id })
  return inserted[0]?.id ?? existingOutboxId(tx, dedupeKey)
}

export async function enqueueNoticeEmail(tx: DbTx, input: NoticeEmailInput): Promise<string> {
  const subjectKey = input.dedupeSubjectKey.trim()
  if (!subjectKey) throw new Error('Notice dedupe subject is required')
  const id = crypto.randomUUID()
  const dedupeKey = `notice:${input.template}:${subjectKey}`
  const inserted = await tx.insert(emailOutbox).values({
    ...outboxKeys(id, dedupeKey),
    template: input.template,
    recipient: normalizeRecipient(input.recipient),
  }).onConflictDoNothing({ target: emailOutbox.dedupeKey }).returning({ id: emailOutbox.id })
  return inserted[0]?.id ?? existingOutboxId(tx, dedupeKey)
}

async function claimOutbox(db: Db, id: string, now: Date): Promise<{ row: OutboxRow; leaseUntil: Date } | null> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS)
  const nowParam = now.toISOString()
  const claimed = await db.execute<{ id: string }>(sql`
    with candidate as (
      select id
      from email_outbox
      where id = ${id}
        and (
          (status = 'PENDING' and next_attempt_at <= ${nowParam}::timestamptz)
          or (status = 'PROCESSING' and leased_until <= ${nowParam}::timestamptz)
        )
      for update skip locked
    )
    update email_outbox as outbox
    set status = 'PROCESSING',
        leased_until = ${nowParam}::timestamptz + interval '2 minutes',
        updated_at = ${nowParam}::timestamptz
    from candidate
    where outbox.id = candidate.id
    returning outbox.id
  `)
  if (!claimed[0]) return null
  const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, id)).limit(1)
  return row ? { row, leaseUntil } : null
}

function ownsLease(rowId: string, leaseUntil: Date) {
  return and(
    eq(emailOutbox.id, rowId),
    eq(emailOutbox.status, 'PROCESSING'),
    eq(emailOutbox.leasedUntil, leaseUntil),
  )
}

async function finishWithStatus(
  db: Db,
  row: OutboxRow,
  leaseUntil: Date,
  now: Date,
  status: 'CANCELLED' | 'FAILED',
  failureClass: string,
  countAttempt: boolean,
): Promise<DispatchResult> {
  const updated = await db.update(emailOutbox).set({
    status,
    attemptCount: countAttempt ? row.attemptCount + 1 : row.attemptCount,
    failureClass,
    leasedUntil: null,
    updatedAt: now,
  }).where(ownsLease(row.id, leaseUntil)).returning({ id: emailOutbox.id })
  return updated[0] ? { status, failureClass } : { status: 'NOT_CLAIMED' }
}

function activeChallenge(row: OutboxRow, challenge: Challenge | undefined, now: Date): challenge is Challenge {
  if (!row.challengeId || !challenge) return false
  if (challenge.consumedAt || challenge.invalidatedAt || challenge.attemptCount >= 5) return false
  if (challenge.expiresAt.getTime() <= now.getTime()) return false
  return challengeAcceptsTemplate(challenge, row.template as ChallengeEmailInput['template'])
}

async function renderOutboxEnvelope(db: Db, row: OutboxRow, env: Env, now: Date) {
  const publicWebUrl = env.PUBLIC_WEB_URL?.trim()
  if (!publicWebUrl) throw new EmailDeliveryError('CONFIG')

  if (!CODE_TEMPLATES.has(row.template as EmailTemplate)) {
    try {
      return { envelope: renderEmail({
        to: row.recipient,
        template: row.template as EmailTemplate,
        publicWebUrl,
      }), challenge: null }
    } catch {
      throw new EmailDeliveryError('CONFIG')
    }
  }

  const [challenge] = row.challengeId
    ? await db.select().from(authChallenges).where(eq(authChallenges.id, row.challengeId)).limit(1)
    : []
  if (!activeChallenge(row, challenge, now)) return { envelope: null, challenge: null }
  const secret = env.AUTH_CODE_SECRET?.trim()
  if (!secret) throw new EmailDeliveryError('CONFIG')
  try {
    const code = await deriveAuthCode(secret, { challengeId: challenge.id, purpose: challenge.purpose })
    return {
      envelope: renderEmail({
        to: row.recipient,
        template: row.template as EmailTemplate,
        code,
        publicWebUrl,
        flowId: challengeFlowId(challenge),
      }),
      challenge,
    }
  } catch {
    throw new EmailDeliveryError('CONFIG')
  }
}

function failureClass(error: unknown): string {
  return error instanceof EmailDeliveryError ? error.failureClass : 'CONFIG'
}

function nextNoticeAttempt(row: OutboxRow, attemptCount: number): Date | null {
  const offset = NOTICE_ATTEMPT_OFFSETS_MS[attemptCount]
  return offset === undefined ? null : new Date(row.createdAt.getTime() + offset)
}

async function scheduleRetry(
  db: Db,
  row: OutboxRow,
  leaseUntil: Date,
  now: Date,
  failure: string,
  challenge: Challenge | null,
): Promise<DispatchResult> {
  const attemptCount = row.attemptCount + 1
  const nextAttemptAt = nextNoticeAttempt(row, attemptCount)
  if (!nextAttemptAt) return finishWithStatus(db, row, leaseUntil, now, 'FAILED', failure, true)
  if (challenge && nextAttemptAt.getTime() >= challenge.expiresAt.getTime()) {
    return finishWithStatus(db, row, leaseUntil, now, 'CANCELLED', 'CHALLENGE_INACTIVE', true)
  }
  const updated = await db.update(emailOutbox).set({
    status: 'PENDING',
    attemptCount,
    nextAttemptAt,
    failureClass: failure,
    leasedUntil: null,
    updatedAt: now,
  }).where(ownsLease(row.id, leaseUntil)).returning({ id: emailOutbox.id })
  return updated[0] ? { status: 'RETRY_SCHEDULED', nextAttemptAt } : { status: 'NOT_CLAIMED' }
}

export async function dispatchOutboxById(
  db: Db,
  sender: EmailSender,
  env: Env,
  id: string,
  now = new Date(),
): Promise<DispatchResult> {
  const claim = await claimOutbox(db, id, now)
  if (!claim) return { status: 'NOT_CLAIMED' }
  const { row, leaseUntil } = claim

  let rendered: Awaited<ReturnType<typeof renderOutboxEnvelope>>
  try {
    rendered = await renderOutboxEnvelope(db, row, env, now)
  } catch (error) {
    if (error instanceof EmailDeliveryError) {
      return finishWithStatus(db, row, leaseUntil, now, 'FAILED', error.failureClass, false)
    }
    throw error
  }
  if (!rendered.envelope) {
    return finishWithStatus(db, row, leaseUntil, now, 'CANCELLED', 'CHALLENGE_INACTIVE', false)
  }

  let providerMessageId: string
  try {
    const result = await sender.send(rendered.envelope, { idempotencyKey: row.idempotencyKey })
    providerMessageId = result.providerMessageId
  } catch (error) {
    const failure = failureClass(error)
    if (!RETRYABLE_FAILURES.has(failure)) {
      return finishWithStatus(db, row, leaseUntil, now, 'FAILED', failure, true)
    }
    return scheduleRetry(db, row, leaseUntil, now, failure, rendered.challenge)
  }

  const updated = await db.update(emailOutbox).set({
    status: 'SENT',
    attemptCount: row.attemptCount + 1,
    providerMessageId,
    failureClass: null,
    sentAt: now,
    leasedUntil: null,
    updatedAt: now,
  }).where(ownsLease(row.id, leaseUntil)).returning({ id: emailOutbox.id })
  return updated[0]
    ? { status: 'SENT', providerMessageId }
    : { status: 'NOT_CLAIMED' }
}

export async function dispatchDueOutbox(
  db: Db,
  sender: EmailSender,
  env: Env,
  now = new Date(),
  limit = MAX_BATCH_SIZE,
): Promise<DispatchSummary> {
  const boundedLimit = Math.min(MAX_BATCH_SIZE, Math.max(0, Math.floor(limit)))
  const due = boundedLimit === 0 ? [] : await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(or(
      and(eq(emailOutbox.status, 'PENDING'), lte(emailOutbox.nextAttemptAt, now)),
      and(eq(emailOutbox.status, 'PROCESSING'), lte(emailOutbox.leasedUntil, now)),
    ))
    .orderBy(emailOutbox.nextAttemptAt, emailOutbox.createdAt)
    .limit(boundedLimit)

  const summary: DispatchSummary = {
    claimed: 0,
    sent: 0,
    retryScheduled: 0,
    cancelled: 0,
    failed: 0,
  }
  for (const { id } of due) {
    const result = await dispatchOutboxById(db, sender, env, id, now)
    if (result.status === 'NOT_CLAIMED') continue
    summary.claimed++
    if (result.status === 'SENT') summary.sent++
    else if (result.status === 'RETRY_SCHEDULED') summary.retryScheduled++
    else if (result.status === 'CANCELLED') summary.cancelled++
    else summary.failed++
  }
  return summary
}

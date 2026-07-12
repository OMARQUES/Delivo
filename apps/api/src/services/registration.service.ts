import type { z } from 'zod'
import {
  ConfirmVerificationSchema,
  ResendVerificationSchema,
  type StartRegistrationInput,
} from '@delivery/shared/schemas'
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  authChallenges,
  authProviders,
  pendingRegistrations,
  users,
} from '../db/schema'
import type { DbTx } from '../db/types'
import { enqueueChallengeEmail, enqueueNoticeEmail } from '../email/outbox.service'
import { hashPassword } from '../lib/password'
import {
  ChallengeError,
  createChallenge,
  replaceChallenge,
  verifyAndConsumeChallenge,
} from './auth-challenge.service'
import {
  isUniqueViolation,
  issueSessionTokens,
  toPublicUser,
  type PublicUser,
} from './auth.service'
import { appendIdentityEvent } from './identity-audit.service'

const CHALLENGE_TTL_MS = 10 * 60_000
const PENDING_TTL_MS = 24 * 60 * 60_000
const RESEND_COOLDOWN_MS = 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ConfirmVerificationInput = z.output<typeof ConfirmVerificationSchema>
type ResendVerificationInput = z.output<typeof ResendVerificationSchema>

export type IdentityContext = {
  authCodeSecret: string
  jwtSecret: string
  requestId: string
  now?: Date
}

export type RegistrationFlow = {
  verificationId: string
  expiresAt: string
  resendAt: string
}

type ConfirmationResult =
  | { kind: 'CUSTOMER_SESSION'; user: PublicUser; accessToken: string; refreshToken: string }
  | { kind: 'DRIVER_PENDING_APPROVAL'; user: PublicUser }

export type RegistrationErrorCode = 'FLOW_INVALID_OR_EXPIRED' | 'CODE_INVALID_OR_EXPIRED'

export class RegistrationError extends Error {
  constructor(public readonly code: RegistrationErrorCode) {
    super(code === 'CODE_INVALID_OR_EXPIRED'
      ? 'Verification code invalid or expired'
      : 'Registration flow invalid or expired')
    this.name = 'RegistrationError'
  }
}

function contextNow(ctx: IdentityContext): Date {
  const now = ctx.now ?? new Date()
  if (
    !ctx.authCodeSecret.trim()
    || !ctx.jwtSecret.trim()
    || !UUID_RE.test(ctx.requestId)
    || !Number.isFinite(now.getTime())
  ) {
    throw new Error('Identity context is invalid')
  }
  return now
}

function flowResponse(verificationId: string, challengeCreatedAt: Date, challengeExpiresAt: Date): RegistrationFlow {
  return {
    verificationId,
    expiresAt: challengeExpiresAt.toISOString(),
    resendAt: new Date(challengeCreatedAt.getTime() + RESEND_COOLDOWN_MS).toISOString(),
  }
}

function syntheticFlow(now: Date): RegistrationFlow {
  return flowResponse(
    crypto.randomUUID(),
    now,
    new Date(now.getTime() + CHALLENGE_TTL_MS),
  )
}

function syntheticResendFlow(verificationId: string, now: Date): RegistrationFlow & { outboxId: null } {
  return {
    ...flowResponse(verificationId, now, new Date(now.getTime() + CHALLENGE_TTL_MS)),
    outboxId: null,
  }
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export async function startRegistration(
  db: Db,
  input: StartRegistrationInput,
  ctx: IdentityContext,
): Promise<{ response: RegistrationFlow; outboxId: string | null }> {
  const now = contextNow(ctx)

  // Equal work for new and existing emails prevents a cheap timing oracle.
  const passwordHash = await hashPassword(input.password)

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
      .limit(1)

    if (existing) {
      const outboxId = await enqueueNoticeEmail(tx, {
        template: 'ACCOUNT_EXISTS_NOTICE',
        recipient: input.email,
        dedupeSubjectKey: `${existing.id}:${utcDay(now)}`,
      })
      return { response: syntheticFlow(now), outboxId }
    }

    const pendingExpiry = new Date(now.getTime() + PENDING_TTL_MS)
    const [pending] = await tx.insert(pendingRegistrations).values({
      email: input.email,
      name: input.name,
      phone: input.phone ?? null,
      role: input.role,
      passwordHash,
      termsAcceptedAt: now,
      expiresAt: pendingExpiry,
      createdAt: now,
      updatedAt: now,
    }).returning()
    if (!pending) throw new Error('Pending registration was not created')

    const challenge = await createChallenge(tx, {
      purpose: 'REGISTRATION_VERIFY',
      pendingRegistrationId: pending.id,
      authCodeSecret: ctx.authCodeSecret,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      now,
    })
    const outboxId = await enqueueChallengeEmail(tx, {
      template: 'VERIFICATION_CODE',
      recipient: pending.email,
      challengeId: challenge.id,
      flowId: pending.id,
    })

    return { response: flowResponse(pending.id, challenge.createdAt, challenge.expiresAt), outboxId }
  })
}

export async function registrationFlowEmail(
  db: Db,
  verificationId: string,
  now = new Date(),
): Promise<string | null> {
  const [pending] = await db
    .select({ email: pendingRegistrations.email })
    .from(pendingRegistrations)
    .where(and(
      eq(pendingRegistrations.id, verificationId),
      isNull(pendingRegistrations.consumedAt),
      gt(pendingRegistrations.expiresAt, now),
    ))
    .limit(1)
  return pending?.email ?? null
}

async function activeRegistrationChallenge(tx: DbTx, verificationId: string) {
  const [challenge] = await tx
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
  return challenge
}

async function currentRegistrationChallenge(tx: DbTx, verificationId: string) {
  const [challenge] = await tx
    .select()
    .from(authChallenges)
    .where(and(
      eq(authChallenges.pendingRegistrationId, verificationId),
      eq(authChallenges.purpose, 'REGISTRATION_VERIFY'),
      isNull(authChallenges.consumedAt),
      or(
        isNull(authChallenges.invalidatedAt),
        eq(authChallenges.invalidationReason, 'ATTEMPTS_EXHAUSTED'),
      ),
    ))
    .orderBy(desc(authChallenges.createdAt), desc(authChallenges.id))
    .limit(1)
  return challenge
}

async function closePending(
  tx: DbTx,
  pendingId: string,
  now: Date,
  reason: 'CONFIRMED' | 'ACCOUNT_COLLISION',
) {
  const [closed] = await tx
    .update(pendingRegistrations)
    .set({ consumedAt: now, closeReason: reason, updatedAt: now })
    .where(and(
      eq(pendingRegistrations.id, pendingId),
      isNull(pendingRegistrations.consumedAt),
      gt(pendingRegistrations.expiresAt, now),
    ))
    .returning()
  return closed
}

async function auditChallengeOutcome(
  tx: DbTx,
  ctx: IdentityContext,
  result: 'INVALID_OR_EXPIRED' | 'ACCOUNT_COLLISION',
  targetUserId?: string,
) {
  await appendIdentityEvent(tx, {
    eventType: 'CHALLENGE_OUTCOME',
    result,
    targetUserId,
    requestId: ctx.requestId,
    metadata: { purpose: 'REGISTRATION_VERIFY' },
  })
}

type ConfirmationTransactionResult =
  | { ok: true; value: ConfirmationResult }
  | { ok: false }

export async function confirmRegistration(
  db: Db,
  input: ConfirmVerificationInput,
  ctx: IdentityContext,
): Promise<ConfirmationResult> {
  const now = contextNow(ctx)
  const transactionResult = await db.transaction<ConfirmationTransactionResult>(async (tx) => {
    const current = await activeRegistrationChallenge(tx, input.verificationId)
    const verification = await verifyAndConsumeChallenge(tx, {
      challengeId: current?.id ?? input.verificationId,
      expectedPurpose: 'REGISTRATION_VERIFY',
      code: input.code,
      authCodeSecret: ctx.authCodeSecret,
      now,
    })
    if (!verification.ok || !verification.challenge.pendingRegistrationId) {
      await auditChallengeOutcome(tx, ctx, 'INVALID_OR_EXPIRED')
      return { ok: false }
    }

    const [pending] = await tx
      .select()
      .from(pendingRegistrations)
      .where(eq(pendingRegistrations.id, verification.challenge.pendingRegistrationId))
      .for('update')
    if (!pending || pending.consumedAt || pending.expiresAt.getTime() <= now.getTime()) {
      await auditChallengeOutcome(tx, ctx, 'INVALID_OR_EXPIRED')
      return { ok: false }
    }

    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${pending.email}`)
      .limit(1)
    if (existing) {
      await closePending(tx, pending.id, now, 'ACCOUNT_COLLISION')
      await auditChallengeOutcome(tx, ctx, 'ACCOUNT_COLLISION', existing.id)
      return { ok: false }
    }

    const claimed = await closePending(tx, pending.id, now, 'CONFIRMED')
    if (!claimed) {
      await auditChallengeOutcome(tx, ctx, 'INVALID_OR_EXPIRED')
      return { ok: false }
    }

    let user: typeof users.$inferSelect
    try {
      user = await tx.transaction(async (savepoint) => {
        const [created] = await savepoint.insert(users).values({
          id: crypto.randomUUID(),
          name: pending.name,
          phone: pending.phone,
          email: pending.email,
          role: pending.role,
          status: pending.role === 'DRIVER' ? 'PENDING_APPROVAL' : 'ACTIVE',
          emailVerifiedAt: now,
          termsAcceptedAt: pending.termsAcceptedAt,
          registrationSource: 'SELF_SERVICE',
          createdAt: now,
          updatedAt: now,
        }).returning()
        if (!created) throw new Error('Verified user was not created')
        await savepoint.insert(authProviders).values({
          userId: created.id,
          provider: 'PASSWORD',
          passwordHash: pending.passwordHash,
          createdAt: now,
          updatedAt: now,
        })
        return created
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      await tx.update(pendingRegistrations).set({
        closeReason: 'ACCOUNT_COLLISION',
        updatedAt: now,
      }).where(eq(pendingRegistrations.id, pending.id))
      await auditChallengeOutcome(tx, ctx, 'ACCOUNT_COLLISION')
      return { ok: false }
    }

    const publicUser = toPublicUser(user)
    let value: ConfirmationResult
    if (user.role === 'DRIVER') {
      value = { kind: 'DRIVER_PENDING_APPROVAL', user: publicUser }
    } else {
      const tokens = await issueSessionTokens(tx, publicUser, user.tokenVersion, ctx.jwtSecret, now)
      value = { kind: 'CUSTOMER_SESSION', user: publicUser, ...tokens }
    }

    await appendIdentityEvent(tx, {
      eventType: 'REGISTRATION_CONFIRMED',
      result: user.role === 'DRIVER' ? 'DRIVER_PENDING_APPROVAL' : 'CUSTOMER_ACTIVE',
      targetUserId: user.id,
      requestId: ctx.requestId,
      metadata: { purpose: 'REGISTRATION_VERIFY' },
    })
    return { ok: true, value }
  })

  if (!transactionResult.ok) throw new RegistrationError('CODE_INVALID_OR_EXPIRED')
  return transactionResult.value
}

export async function resendRegistrationVerification(
  db: Db,
  input: ResendVerificationInput,
  ctx: IdentityContext,
): Promise<RegistrationFlow & { outboxId: string | null }> {
  const now = contextNow(ctx)

  try {
    const result = await db.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(pendingRegistrations)
        .where(eq(pendingRegistrations.id, input.verificationId))
        .limit(1)
      if (!pending || pending.consumedAt || pending.expiresAt.getTime() <= now.getTime()) {
        return syntheticResendFlow(input.verificationId, now)
      }

      const current = await currentRegistrationChallenge(tx, pending.id)
      if (!current || now.getTime() < current.createdAt.getTime() + RESEND_COOLDOWN_MS) {
        return syntheticResendFlow(input.verificationId, now)
      }

      const replacement = await replaceChallenge(tx, {
        challengeId: current.id,
        expectedPurpose: 'REGISTRATION_VERIFY',
        authCodeSecret: ctx.authCodeSecret,
        expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
        now,
      })
      const outboxId = await enqueueChallengeEmail(tx, {
        template: 'VERIFICATION_CODE',
        recipient: pending.email,
        challengeId: replacement.id,
        flowId: pending.id,
      })
      await appendIdentityEvent(tx, {
        eventType: 'CHALLENGE_OUTCOME',
        result: 'REISSUED',
        requestId: ctx.requestId,
        metadata: { purpose: 'REGISTRATION_VERIFY' },
      })
      return {
        ...flowResponse(pending.id, replacement.createdAt, replacement.expiresAt),
        outboxId,
      }
    })
    return result
  } catch (error) {
    if (error instanceof ChallengeError) return syntheticResendFlow(input.verificationId, now)
    throw error
  }
}

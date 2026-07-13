import { passwordPolicyIssue, type PasswordRole } from '@delivery/shared'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  authChallenges,
  authProviders,
  emailOutbox,
  users,
  type UserRole,
  type UserStatus,
} from '../db/schema'
import type { DbTx } from '../db/types'
import { enqueueChallengeEmail, enqueueNoticeEmail } from '../email/outbox.service'
import { hashPassword } from '../lib/password'
import { deriveAuthCode, hashAuthCode } from '../security/auth-code'
import { createChallenge, verifyAndConsumeChallenge } from './auth-challenge.service'
import {
  ActionTicketError,
  claimActionTicket,
  inspectActionTicket,
  issueActionTicket,
} from './auth-ticket.service'
import { appendIdentityEvent } from './identity-audit.service'
import type { IdentityContext } from './registration.service'
import { revokeAllSessionsInTx } from './security-session.service'

const RECOVERY_TTL_MS = 10 * 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type PasswordRecoveryErrorCode =
  | 'CODE_INVALID_OR_EXPIRED'
  | 'FLOW_INVALID_OR_EXPIRED'
  | 'PASSWORD_POLICY_REJECTED'

export class PasswordRecoveryError extends Error {
  constructor(
    public readonly code: PasswordRecoveryErrorCode,
    public readonly policyIssue?: string,
  ) {
    super(code)
    this.name = 'PasswordRecoveryError'
  }
}

type RecoveryResponse = {
  recoveryId: string
  expiresAt: string
}

function contextNow(ctx: IdentityContext): Date {
  const now = ctx.now ?? new Date()
  if (
    !ctx.authCodeSecret.trim()
    || !UUID_RE.test(ctx.requestId)
    || !Number.isFinite(now.getTime())
  ) {
    throw new Error('Identity context is invalid')
  }
  return now
}

function recoveryResponse(recoveryId: string, expiresAt: Date): RecoveryResponse {
  return { recoveryId, expiresAt: expiresAt.toISOString() }
}

async function syntheticRecovery(now: Date, authCodeSecret: string): Promise<RecoveryResponse> {
  const recoveryId = crypto.randomUUID()
  const codeContext = { challengeId: recoveryId, purpose: 'PASSWORD_RECOVERY' as const }
  const code = await deriveAuthCode(authCodeSecret, codeContext)
  await hashAuthCode(authCodeSecret, codeContext, code)
  return recoveryResponse(recoveryId, new Date(now.getTime() + RECOVERY_TTL_MS))
}

function recoveryEligible(input: {
  role: UserRole
  status: UserStatus
  emailVerifiedAt: Date | null
  passwordHash: string | null
}): boolean {
  if (!input.emailVerifiedAt || !input.passwordHash) return false
  if (input.status === 'ACTIVE') return true
  return input.role === 'DRIVER' && input.status === 'PENDING_APPROVAL'
}

async function invalidateLiveRecoveryChallenges(tx: DbTx, userId: string, now: Date): Promise<void> {
  const live = await tx
    .select({ id: authChallenges.id })
    .from(authChallenges)
    .where(and(
      eq(authChallenges.userId, userId),
      eq(authChallenges.purpose, 'PASSWORD_RECOVERY'),
      isNull(authChallenges.consumedAt),
      isNull(authChallenges.invalidatedAt),
    ))
    .for('update')
  if (live.length === 0) return

  const ids = live.map(({ id }) => id)
  await tx
    .update(authChallenges)
    .set({ invalidatedAt: now, invalidationReason: 'REPLACED' })
    .where(inArray(authChallenges.id, ids))
  await tx
    .update(emailOutbox)
    .set({
      status: 'CANCELLED',
      leasedUntil: null,
      failureClass: 'CHALLENGE_REPLACED',
      updatedAt: now,
    })
    .where(and(
      inArray(emailOutbox.challengeId, ids),
      inArray(emailOutbox.status, ['PENDING', 'PROCESSING']),
    ))
}

export async function startPasswordRecovery(
  db: Db,
  email: string,
  ctx: IdentityContext,
): Promise<{ response: RecoveryResponse; outboxId: string | null }> {
  const now = contextNow(ctx)
  const normalizedEmail = email.trim().toLowerCase()

  return db.transaction(async (tx) => {
    const [credential] = await tx
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
        emailVerifiedAt: users.emailVerifiedAt,
        passwordHash: authProviders.passwordHash,
      })
      .from(users)
      .innerJoin(authProviders, and(
        eq(authProviders.userId, users.id),
        eq(authProviders.provider, 'PASSWORD'),
      ))
      .where(sql`lower(${users.email}) = ${normalizedEmail}`)
      .for('update')

    if (!credential || !recoveryEligible(credential)) {
      return {
        response: await syntheticRecovery(now, ctx.authCodeSecret),
        outboxId: null,
      }
    }

    await invalidateLiveRecoveryChallenges(tx, credential.id, now)
    const challenge = await createChallenge(tx, {
      purpose: 'PASSWORD_RECOVERY',
      userId: credential.id,
      authCodeSecret: ctx.authCodeSecret,
      expiresAt: new Date(now.getTime() + RECOVERY_TTL_MS),
      now,
    })
    const outboxId = await enqueueChallengeEmail(tx, {
      template: 'PASSWORD_RECOVERY',
      recipient: credential.email,
      challengeId: challenge.id,
      flowId: challenge.id,
    })
    return { response: recoveryResponse(challenge.id, challenge.expiresAt), outboxId }
  })
}

export async function verifyPasswordRecovery(
  db: Db,
  recoveryId: string,
  code: string,
  ctx: IdentityContext,
): Promise<{ resetTicket: string; expiresAt: string }> {
  const now = contextNow(ctx)
  const result = await db.transaction(async (tx) => {
    const verification = await verifyAndConsumeChallenge(tx, {
      challengeId: recoveryId,
      expectedPurpose: 'PASSWORD_RECOVERY',
      code,
      authCodeSecret: ctx.authCodeSecret,
      now,
    })
    if (!verification.ok || !verification.challenge.userId) {
      await appendIdentityEvent(tx, {
        eventType: 'CHALLENGE_OUTCOME',
        result: 'INVALID_OR_EXPIRED',
        requestId: ctx.requestId,
        metadata: { purpose: 'PASSWORD_RECOVERY' },
      })
      return { ok: false as const }
    }

    const ticket = await issueActionTicket(tx, {
      userId: verification.challenge.userId,
      purpose: 'PASSWORD_RESET',
      challengeId: verification.challenge.id,
      authCodeSecret: ctx.authCodeSecret,
      now,
    })
    await appendIdentityEvent(tx, {
      eventType: 'CHALLENGE_OUTCOME',
      result: 'VERIFIED',
      targetUserId: verification.challenge.userId,
      requestId: ctx.requestId,
      metadata: { purpose: 'PASSWORD_RECOVERY' },
    })
    return {
      ok: true as const,
      value: { resetTicket: ticket.token, expiresAt: ticket.expiresAt.toISOString() },
    }
  })

  if (!result.ok) throw new PasswordRecoveryError('CODE_INVALID_OR_EXPIRED')
  return result.value
}

function assertPasswordPolicy(password: string, role: PasswordRole): void {
  const issue = typeof password === 'string' ? passwordPolicyIssue(password, role) : 'PASSWORD_INVALID'
  if (issue) throw new PasswordRecoveryError('PASSWORD_POLICY_REJECTED', issue)
}

function invalidReset(): PasswordRecoveryError {
  return new PasswordRecoveryError('FLOW_INVALID_OR_EXPIRED')
}

async function lockResetCredential(tx: DbTx, userId: string) {
  const [user] = await tx
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
  if (!user) throw invalidReset()

  const [provider] = await tx
    .select()
    .from(authProviders)
    .where(and(
      eq(authProviders.userId, user.id),
      eq(authProviders.provider, 'PASSWORD'),
      isNotNull(authProviders.passwordHash),
    ))
    .for('update')
  if (!provider || !recoveryEligible({ ...user, passwordHash: provider.passwordHash })) {
    throw invalidReset()
  }
  return { user, provider }
}

export async function resetPassword(
  db: Db,
  resetTicket: string,
  newPassword: string,
  ctx: IdentityContext,
): Promise<void> {
  const now = contextNow(ctx)
  let preflight: Awaited<ReturnType<typeof inspectActionTicket>>
  try {
    preflight = await inspectActionTicket(db, {
      token: resetTicket,
      purpose: 'PASSWORD_RESET',
      authCodeSecret: ctx.authCodeSecret,
      now,
    })
  } catch (error) {
    if (error instanceof ActionTicketError) throw invalidReset()
    throw error
  }

  assertPasswordPolicy(newPassword, preflight.role)
  const passwordHash = await hashPassword(newPassword)

  try {
    await db.transaction(async (tx) => {
      const ticket = await claimActionTicket(tx, {
        token: resetTicket,
        purpose: 'PASSWORD_RESET',
        authCodeSecret: ctx.authCodeSecret,
        now,
      })
      const { user, provider } = await lockResetCredential(tx, ticket.userId)
      assertPasswordPolicy(newPassword, user.role)

      const [updatedProvider] = await tx
        .update(authProviders)
        .set({ passwordHash, updatedAt: now })
        .where(and(
          eq(authProviders.id, provider.id),
          eq(authProviders.userId, user.id),
          eq(authProviders.provider, 'PASSWORD'),
        ))
        .returning({ id: authProviders.id })
      if (!updatedProvider) throw invalidReset()

      await revokeAllSessionsInTx(tx, user.id, now)
      await appendIdentityEvent(tx, {
        eventType: 'PASSWORD_RESET',
        result: 'SUCCESS',
        targetUserId: user.id,
        requestId: ctx.requestId,
        metadata: { purpose: 'PASSWORD_RECOVERY' },
      })
      await enqueueNoticeEmail(tx, {
        template: 'PASSWORD_CHANGED_NOTICE',
        recipient: user.email,
        dedupeSubjectKey: ticket.id,
      })
    })
  } catch (error) {
    if (error instanceof ActionTicketError) throw invalidReset()
    throw error
  }
}

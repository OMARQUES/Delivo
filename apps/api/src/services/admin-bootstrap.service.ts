import { NormalizedEmail } from '@delivery/shared/schemas'
import { passwordPolicyIssue } from '@delivery/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { authChallenges, authProviders, users } from '../db/schema'
import type { DbTx } from '../db/types'
import { enqueueChallengeEmail } from '../email/outbox.service'
import { hashPassword, verifyPassword } from '../lib/password'
import { ChallengeError, createChallenge, replaceChallenge } from './auth-challenge.service'
import { isUniqueViolation } from './auth.service'
import { appendIdentityEvent } from './identity-audit.service'

const CHALLENGE_TTL_MS = 10 * 60_000
const RESEND_COOLDOWN_MS = 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type BootstrapAdminInput = { name: string; email: string; password: string }
export type BootstrapContext = { authCodeSecret: string; requestId: string; now?: Date }
export type BootstrapAdminResult = {
  state: 'CREATED' | 'RESENT' | 'ALREADY_ACTIVE'
  outboxId: string | null
}
export type AdminBootstrapErrorCode =
  | 'INVALID_INPUT'
  | 'PASSWORD_POLICY_REJECTED'
  | 'BOOTSTRAP_UNAVAILABLE'
  | 'RESEND_TOO_SOON'

export class AdminBootstrapError extends Error {
  constructor(public readonly code: AdminBootstrapErrorCode) {
    super(code)
    this.name = 'AdminBootstrapError'
  }
}

function fail(code: AdminBootstrapErrorCode): never {
  throw new AdminBootstrapError(code)
}

function normalizeInput(input: BootstrapAdminInput): BootstrapAdminInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT')
  const keys = Object.keys(input)
  if (keys.length !== 3 || !keys.every((key) => ['name', 'email', 'password'].includes(key))) {
    fail('INVALID_INPUT')
  }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const emailResult = NormalizedEmail.safeParse(input.email)
  if (name.length < 2 || name.length > 120 || !emailResult.success || typeof input.password !== 'string') {
    fail('INVALID_INPUT')
  }
  if (passwordPolicyIssue(input.password, 'ADMIN')) fail('PASSWORD_POLICY_REJECTED')
  return { name, email: emailResult.data, password: input.password }
}

function contextNow(ctx: BootstrapContext): Date {
  const now = ctx.now ?? new Date()
  if (
    !ctx.authCodeSecret.trim()
    || !UUID_RE.test(ctx.requestId)
    || !Number.isFinite(now.getTime())
  ) throw new Error('Admin bootstrap context is invalid')
  return now
}

function assertActiveBootstrapAdmin(admin: typeof users.$inferSelect): void {
  if (
    admin.status !== 'ACTIVE'
    || !admin.emailVerifiedAt
    || admin.registrationSource !== 'BOOTSTRAP'
  ) fail('BOOTSTRAP_UNAVAILABLE')
}

async function assertPasswordProvider(
  tx: DbTx,
  userId: string,
): Promise<string> {
  const [provider] = await tx.select({ passwordHash: authProviders.passwordHash })
    .from(authProviders)
    .where(and(
      eq(authProviders.userId, userId),
      eq(authProviders.provider, 'PASSWORD'),
    ))
    .limit(1)
    .for('update')
  if (!provider?.passwordHash) fail('BOOTSTRAP_UNAVAILABLE')
  return provider.passwordHash
}

export async function bootstrapAdmin(
  db: Db,
  rawInput: BootstrapAdminInput,
  ctx: BootstrapContext,
): Promise<BootstrapAdminResult> {
  const input = normalizeInput(rawInput)
  const now = contextNow(ctx)

  try {
    return await db.transaction(async (tx) => {
      // Serializes the singleton invariant even when two operators bootstrap concurrently.
      await tx.execute(sql`select pg_advisory_xact_lock(20303, 4)`)

      const admins = await tx.select().from(users)
        .where(eq(users.role, 'ADMIN'))
        .orderBy(users.createdAt, users.id)
        .limit(2)
      if (admins.length > 1) fail('BOOTSTRAP_UNAVAILABLE')

      const existing = admins[0]
      if (!existing) {
        const [emailOwner] = await tx.select({ id: users.id }).from(users)
          .where(sql`lower(${users.email}) = ${input.email}`)
          .limit(1)
        if (emailOwner) fail('BOOTSTRAP_UNAVAILABLE')

        const passwordHash = await hashPassword(input.password)
        const [admin] = await tx.insert(users).values({
          name: input.name,
          email: input.email,
          role: 'ADMIN',
          status: 'PENDING_EMAIL',
          registrationSource: 'BOOTSTRAP',
          emailVerifiedAt: null,
          termsAcceptedAt: null,
          createdAt: now,
          updatedAt: now,
        }).returning()
        if (!admin) fail('BOOTSTRAP_UNAVAILABLE')

        await tx.insert(authProviders).values({
          userId: admin.id,
          provider: 'PASSWORD',
          passwordHash,
          createdAt: now,
          updatedAt: now,
        })
        const challenge = await createChallenge(tx, {
          purpose: 'ADMIN_ACTIVATION',
          userId: admin.id,
          authCodeSecret: ctx.authCodeSecret.trim(),
          expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
          now,
        })
        const outboxId = await enqueueChallengeEmail(tx, {
          template: 'VERIFICATION_CODE',
          recipient: admin.email,
          challengeId: challenge.id,
          flowId: challenge.id,
        })
        await appendIdentityEvent(tx, {
          eventType: 'CHALLENGE_OUTCOME',
          result: 'ISSUED',
          targetUserId: admin.id,
          requestId: ctx.requestId,
          metadata: { purpose: 'ADMIN_ACTIVATION' },
        })
        return { state: 'CREATED', outboxId }
      }

      if (existing.email !== input.email || existing.registrationSource !== 'BOOTSTRAP') {
        fail('BOOTSTRAP_UNAVAILABLE')
      }
      if (existing.status === 'ACTIVE') {
        assertActiveBootstrapAdmin(existing)
        await assertPasswordProvider(tx, existing.id)
        return { state: 'ALREADY_ACTIVE', outboxId: null }
      }

      const [currentChallenge] = await tx.select().from(authChallenges)
        .where(and(
          eq(authChallenges.userId, existing.id),
          eq(authChallenges.purpose, 'ADMIN_ACTIVATION'),
        ))
        .orderBy(desc(authChallenges.createdAt), desc(authChallenges.id))
        .limit(1)
        .for('update')
      if (!currentChallenge) fail('BOOTSTRAP_UNAVAILABLE')

      const [lockedAdmin] = await tx.select().from(users)
        .where(eq(users.id, existing.id))
        .limit(1)
        .for('update')
      if (!lockedAdmin || lockedAdmin.email !== input.email) fail('BOOTSTRAP_UNAVAILABLE')
      if (lockedAdmin.status === 'ACTIVE') {
        assertActiveBootstrapAdmin(lockedAdmin)
        await assertPasswordProvider(tx, lockedAdmin.id)
        return { state: 'ALREADY_ACTIVE', outboxId: null }
      }
      if (
        lockedAdmin.status !== 'PENDING_EMAIL'
        || lockedAdmin.emailVerifiedAt
        || lockedAdmin.registrationSource !== 'BOOTSTRAP'
      ) fail('BOOTSTRAP_UNAVAILABLE')

      const passwordHash = await assertPasswordProvider(tx, lockedAdmin.id)
      if (!(await verifyPassword(input.password, passwordHash))) fail('BOOTSTRAP_UNAVAILABLE')
      if (now.getTime() < currentChallenge.createdAt.getTime() + RESEND_COOLDOWN_MS) {
        fail('RESEND_TOO_SOON')
      }

      const replacement = await replaceChallenge(tx, {
        challengeId: currentChallenge.id,
        expectedPurpose: 'ADMIN_ACTIVATION',
        authCodeSecret: ctx.authCodeSecret.trim(),
        expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
        now,
      })
      const outboxId = await enqueueChallengeEmail(tx, {
        template: 'VERIFICATION_CODE',
        recipient: lockedAdmin.email,
        challengeId: replacement.id,
        flowId: replacement.id,
      })
      await appendIdentityEvent(tx, {
        eventType: 'CHALLENGE_OUTCOME',
        result: 'REISSUED',
        targetUserId: lockedAdmin.id,
        requestId: ctx.requestId,
        metadata: { purpose: 'ADMIN_ACTIVATION' },
      })
      return { state: 'RESENT', outboxId }
    })
  } catch (error) {
    if (isUniqueViolation(error)) fail('BOOTSTRAP_UNAVAILABLE')
    if (error instanceof ChallengeError) fail('BOOTSTRAP_UNAVAILABLE')
    throw error
  }
}

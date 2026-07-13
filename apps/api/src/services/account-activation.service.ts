import { passwordPolicyIssue } from '@delivery/shared'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { z } from 'zod'
import { ConfirmVerificationSchema } from '@delivery/shared/schemas'
import type { Db } from '../db/client'
import { authProviders, stores, users } from '../db/schema'
import type { DbTx } from '../db/types'
import { hashPassword } from '../lib/password'
import { verifyAndConsumeChallenge } from './auth-challenge.service'
import {
  ActionTicketError,
  claimActionTicket,
  inspectActionTicket,
  issueActionTicket,
} from './auth-ticket.service'
import { appendIdentityEvent } from './identity-audit.service'
import type { IdentityContext } from './registration.service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ConfirmVerificationInput = z.output<typeof ConfirmVerificationSchema>
type PrivilegedPurpose = 'STORE_ACTIVATION' | 'ADMIN_ACTIVATION'

export type AccountActivationErrorCode =
  | 'CODE_INVALID_OR_EXPIRED'
  | 'FLOW_INVALID_OR_EXPIRED'
  | 'PASSWORD_POLICY_REJECTED'

export class AccountActivationError extends Error {
  constructor(
    public readonly code: AccountActivationErrorCode,
    public readonly policyIssue?: string,
  ) {
    super(code)
    this.name = 'AccountActivationError'
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

function invalidCode(): AccountActivationError {
  return new AccountActivationError('CODE_INVALID_OR_EXPIRED')
}

function invalidFlow(): AccountActivationError {
  return new AccountActivationError('FLOW_INVALID_OR_EXPIRED')
}

async function auditInvalidChallenge(tx: DbTx, ctx: IdentityContext, purpose: PrivilegedPurpose) {
  await appendIdentityEvent(tx, {
    eventType: 'CHALLENGE_OUTCOME',
    result: 'INVALID_OR_EXPIRED',
    requestId: ctx.requestId,
    metadata: { purpose },
  })
}

async function confirmStore(
  tx: DbTx,
  userId: string,
  challengeId: string,
  ctx: IdentityContext,
  now: Date,
) {
  const [owner] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
  const [store] = await tx.select().from(stores).where(eq(stores.ownerUserId, userId)).for('update')
  if (
    !owner
    || !store
    || owner.role !== 'STORE'
    || owner.status !== 'PENDING_EMAIL'
    || owner.emailVerifiedAt !== null
    || owner.registrationSource !== 'ADMIN_PROVISIONED'
    || store.securityStatus !== 'PENDING_ACTIVATION'
  ) {
    await auditInvalidChallenge(tx, ctx, 'STORE_ACTIVATION')
    return null
  }

  const [provider] = await tx.select({ id: authProviders.id }).from(authProviders)
    .where(eq(authProviders.userId, owner.id)).limit(1).for('update')
  if (provider) {
    await auditInvalidChallenge(tx, ctx, 'STORE_ACTIVATION')
    return null
  }

  const ticket = await issueActionTicket(tx, {
    userId: owner.id,
    purpose: 'INITIAL_PASSWORD_SETUP',
    challengeId,
    authCodeSecret: ctx.authCodeSecret,
    now,
  })
  await appendIdentityEvent(tx, {
    eventType: 'CHALLENGE_OUTCOME',
    result: 'VERIFIED',
    targetUserId: owner.id,
    requestId: ctx.requestId,
    metadata: { purpose: 'STORE_ACTIVATION' },
  })
  return {
    kind: 'PASSWORD_SETUP_REQUIRED' as const,
    passwordSetupTicket: ticket.token,
    expiresAt: ticket.expiresAt.toISOString(),
  }
}

async function confirmAdmin(tx: DbTx, userId: string, ctx: IdentityContext, now: Date) {
  const [admin] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
  const [provider] = await tx.select({ id: authProviders.id }).from(authProviders).where(and(
    eq(authProviders.userId, userId),
    eq(authProviders.provider, 'PASSWORD'),
    isNotNull(authProviders.passwordHash),
  )).limit(1).for('update')
  if (
    !admin
    || !provider
    || admin.role !== 'ADMIN'
    || admin.status !== 'PENDING_EMAIL'
    || admin.emailVerifiedAt !== null
    || admin.registrationSource !== 'BOOTSTRAP'
  ) {
    await auditInvalidChallenge(tx, ctx, 'ADMIN_ACTIVATION')
    return null
  }

  const [activated] = await tx.update(users).set({
    status: 'ACTIVE',
    emailVerifiedAt: now,
    updatedAt: now,
  }).where(and(
    eq(users.id, admin.id),
    eq(users.role, 'ADMIN'),
    eq(users.status, 'PENDING_EMAIL'),
    isNull(users.emailVerifiedAt),
  )).returning({ id: users.id })
  if (!activated) throw invalidFlow()

  await appendIdentityEvent(tx, {
    eventType: 'CHALLENGE_OUTCOME',
    result: 'VERIFIED',
    targetUserId: admin.id,
    requestId: ctx.requestId,
    metadata: { purpose: 'ADMIN_ACTIVATION' },
  })
  return { kind: 'EMAIL_VERIFIED' as const }
}

export async function confirmPrivilegedEmail(
  db: Db,
  input: ConfirmVerificationInput,
  purpose: PrivilegedPurpose,
  ctx: IdentityContext,
): Promise<
  | { kind: 'EMAIL_VERIFIED' }
  | { kind: 'PASSWORD_SETUP_REQUIRED'; passwordSetupTicket: string; expiresAt: string }
> {
  const now = contextNow(ctx)
  const result = await db.transaction(async (tx) => {
    const verification = await verifyAndConsumeChallenge(tx, {
      challengeId: input.verificationId,
      expectedPurpose: purpose,
      code: input.code,
      authCodeSecret: ctx.authCodeSecret,
      now,
    })
    if (!verification.ok || !verification.challenge.userId) {
      await auditInvalidChallenge(tx, ctx, purpose)
      return null
    }
    return purpose === 'STORE_ACTIVATION'
      ? confirmStore(tx, verification.challenge.userId, verification.challenge.id, ctx, now)
      : confirmAdmin(tx, verification.challenge.userId, ctx, now)
  })
  if (!result) throw invalidCode()
  return result
}

function assertStorePasswordPolicy(password: string): void {
  const issue = typeof password === 'string' ? passwordPolicyIssue(password, 'STORE') : 'PASSWORD_INVALID'
  if (issue) throw new AccountActivationError('PASSWORD_POLICY_REJECTED', issue)
}

export async function setupInitialPassword(
  db: Db,
  ticketToken: string,
  password: string,
  ctx: IdentityContext,
): Promise<void> {
  const now = contextNow(ctx)
  let preflight: Awaited<ReturnType<typeof inspectActionTicket>>
  try {
    preflight = await inspectActionTicket(db, {
      token: ticketToken,
      purpose: 'INITIAL_PASSWORD_SETUP',
      authCodeSecret: ctx.authCodeSecret,
      now,
    })
  } catch (error) {
    if (error instanceof ActionTicketError) throw invalidFlow()
    throw error
  }
  if (preflight.role !== 'STORE') throw invalidFlow()
  assertStorePasswordPolicy(password)
  const passwordHash = await hashPassword(password)

  try {
    await db.transaction(async (tx) => {
      const ticket = await claimActionTicket(tx, {
        token: ticketToken,
        purpose: 'INITIAL_PASSWORD_SETUP',
        authCodeSecret: ctx.authCodeSecret,
        now,
      })
      const [owner] = await tx.select().from(users).where(eq(users.id, ticket.userId)).for('update')
      if (
        !owner
        || owner.role !== 'STORE'
        || owner.status !== 'PENDING_EMAIL'
        || owner.emailVerifiedAt !== null
        || owner.registrationSource !== 'ADMIN_PROVISIONED'
      ) throw invalidFlow()

      const [store] = await tx.select().from(stores).where(eq(stores.ownerUserId, owner.id)).for('update')
      if (!store || store.securityStatus !== 'PENDING_ACTIVATION') throw invalidFlow()

      const [existingProvider] = await tx.select({ id: authProviders.id }).from(authProviders)
        .where(eq(authProviders.userId, owner.id)).limit(1).for('update')
      if (existingProvider) throw invalidFlow()

      assertStorePasswordPolicy(password)
      const [provider] = await tx.insert(authProviders).values({
        userId: owner.id,
        provider: 'PASSWORD',
        passwordHash,
        createdAt: now,
        updatedAt: now,
      }).returning({ id: authProviders.id })
      if (!provider) throw invalidFlow()

      const [activatedOwner] = await tx.update(users).set({
        status: 'ACTIVE',
        emailVerifiedAt: now,
        updatedAt: now,
      }).where(and(
        eq(users.id, owner.id),
        eq(users.role, 'STORE'),
        eq(users.status, 'PENDING_EMAIL'),
        isNull(users.emailVerifiedAt),
      )).returning({ id: users.id })
      if (!activatedOwner) throw invalidFlow()

      const [activatedStore] = await tx.update(stores).set({
        securityStatus: 'ACTIVE',
        updatedAt: now,
      }).where(and(
        eq(stores.id, store.id),
        eq(stores.ownerUserId, owner.id),
        eq(stores.securityStatus, 'PENDING_ACTIVATION'),
      )).returning({ id: stores.id })
      if (!activatedStore) throw invalidFlow()

      await appendIdentityEvent(tx, {
        eventType: 'STORE_ACTIVATED',
        result: 'SUCCESS',
        targetUserId: owner.id,
        requestId: ctx.requestId,
        metadata: { purpose: 'STORE_ACTIVATION' },
      })
    })
  } catch (error) {
    if (error instanceof ActionTicketError) throw invalidFlow()
    throw error
  }
}

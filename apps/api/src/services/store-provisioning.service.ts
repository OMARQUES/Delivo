import type { StoreCreateInput } from '@delivery/shared/schemas'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { authChallenges, stores, users } from '../db/schema'
import { enqueueChallengeEmail } from '../email/outbox.service'
import { ChallengeError, createChallenge, replaceChallenge } from './auth-challenge.service'
import { isUniqueViolation, toPublicUser, type PublicUser } from './auth.service'
import { appendIdentityEvent } from './identity-audit.service'
import type { IdentityContext } from './registration.service'
import { StoreError } from './store.service'

const ACTIVATION_TTL_MS = 10 * 60_000
const RESEND_COOLDOWN_MS = 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type Store = typeof stores.$inferSelect
export type PendingStoreOwner = PublicUser & { role: 'STORE'; status: 'PENDING_EMAIL' }
export type StoreActivationFlow = {
  verificationId: string
  expiresAt: string
  resendAt: string
  outboxId: string
}

export type PendingStoreActivationTarget = {
  email: string
}

function toPendingStoreOwner(owner: typeof users.$inferSelect): PendingStoreOwner {
  if (owner.role !== 'STORE' || owner.status !== 'PENDING_EMAIL') {
    throw new Error('Provisioned store owner state is invalid')
  }
  return { ...toPublicUser(owner), role: owner.role, status: owner.status }
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

function activationFlow(
  verificationId: string,
  createdAt: Date,
  expiresAt: Date,
  outboxId: string,
): StoreActivationFlow {
  return {
    verificationId,
    expiresAt: expiresAt.toISOString(),
    resendAt: new Date(createdAt.getTime() + RESEND_COOLDOWN_MS).toISOString(),
    outboxId,
  }
}

function assertPendingActivation(input: {
  storeStatus: Store['securityStatus']
  ownerRole: PublicUser['role']
  ownerStatus: PublicUser['status']
  registrationSource: typeof users.$inferSelect['registrationSource']
  emailVerifiedAt: Date | null
}): void {
  if (
    input.storeStatus !== 'PENDING_ACTIVATION'
    || input.ownerRole !== 'STORE'
    || input.ownerStatus !== 'PENDING_EMAIL'
    || input.registrationSource !== 'ADMIN_PROVISIONED'
    || input.emailVerifiedAt !== null
  ) {
    throw new StoreError('Ativação da loja indisponível', 409)
  }
}

function currentStoreChallengeCondition(userId: string) {
  return and(
    eq(authChallenges.userId, userId),
    eq(authChallenges.purpose, 'STORE_ACTIVATION'),
    isNull(authChallenges.consumedAt),
    or(
      isNull(authChallenges.invalidatedAt),
      eq(authChallenges.invalidationReason, 'ATTEMPTS_EXHAUSTED'),
    ),
  )
}

export async function provisionStoreWithOwner(
  db: Db,
  input: StoreCreateInput,
  ctx: IdentityContext,
): Promise<{ store: Store; owner: PendingStoreOwner } & StoreActivationFlow> {
  const now = contextNow(ctx)
  try {
    return await db.transaction(async (tx) => {
      const [owner] = await tx.insert(users).values({
        name: input.owner.name,
        email: input.owner.email,
        role: 'STORE',
        status: 'PENDING_EMAIL',
        registrationSource: 'ADMIN_PROVISIONED',
        termsAcceptedAt: null,
        emailVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
      }).returning()
      if (!owner) throw new StoreError('Falha ao criar proprietário da loja', 400)

      const [store] = await tx.insert(stores).values({
        ownerUserId: owner.id,
        name: input.name,
        slug: input.slug,
        category: input.category,
        phone: input.phone,
        city: input.city,
        addressText: input.addressText,
        lat: input.lat,
        lng: input.lng,
        securityStatus: 'PENDING_ACTIVATION',
        createdAt: now,
        updatedAt: now,
      }).returning()
      if (!store) throw new StoreError('Falha ao criar loja', 400)

      const challenge = await createChallenge(tx, {
        purpose: 'STORE_ACTIVATION',
        userId: owner.id,
        authCodeSecret: ctx.authCodeSecret.trim(),
        expiresAt: new Date(now.getTime() + ACTIVATION_TTL_MS),
        now,
      })
      const outboxId = await enqueueChallengeEmail(tx, {
        template: 'VERIFICATION_CODE',
        recipient: owner.email,
        challengeId: challenge.id,
        flowId: challenge.id,
      })
      await appendIdentityEvent(tx, {
        eventType: 'CHALLENGE_OUTCOME',
        result: 'ISSUED',
        targetUserId: owner.id,
        requestId: ctx.requestId,
        metadata: { purpose: 'STORE_ACTIVATION' },
      })

      return {
        store,
        owner: toPendingStoreOwner(owner),
        ...activationFlow(challenge.id, challenge.createdAt, challenge.expiresAt, outboxId),
      }
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreError('Slug ou email já em uso', 409)
    throw error
  }
}

export async function getPendingStoreActivationTarget(
  db: Db,
  storeId: string,
): Promise<PendingStoreActivationTarget> {
  const [row] = await db.select({
    storeStatus: stores.securityStatus,
    ownerId: users.id,
    ownerRole: users.role,
    ownerStatus: users.status,
    registrationSource: users.registrationSource,
    emailVerifiedAt: users.emailVerifiedAt,
    email: users.email,
  }).from(stores).innerJoin(users, eq(users.id, stores.ownerUserId)).where(eq(stores.id, storeId)).limit(1)
  if (!row) throw new StoreError('Loja não encontrada', 404)
  assertPendingActivation(row)

  const [challenge] = await db.select({ id: authChallenges.id })
    .from(authChallenges)
    .where(currentStoreChallengeCondition(row.ownerId))
    .orderBy(desc(authChallenges.createdAt), desc(authChallenges.id))
    .limit(1)
  if (!challenge) throw new StoreError('Ativação da loja indisponível', 409)
  return { email: row.email }
}

export async function resendStoreActivation(
  db: Db,
  storeId: string,
  ctx: IdentityContext,
): Promise<StoreActivationFlow> {
  const now = contextNow(ctx)
  try {
    return await db.transaction(async (tx) => {
      const [store] = await tx.select({
        storeStatus: stores.securityStatus,
        ownerId: stores.ownerUserId,
      }).from(stores)
        .where(eq(stores.id, storeId))
        .for('update')
      if (!store) throw new StoreError('Loja não encontrada', 404)

      const [owner] = await tx.select({
        ownerId: users.id,
        ownerRole: users.role,
        ownerStatus: users.status,
        registrationSource: users.registrationSource,
        emailVerifiedAt: users.emailVerifiedAt,
        email: users.email,
      }).from(users)
        .where(eq(users.id, store.ownerId))
        .for('update')
      if (!owner) throw new StoreError('Ativação da loja indisponível', 409)
      const row = { ...store, ...owner }
      assertPendingActivation(row)

      const [current] = await tx.select()
        .from(authChallenges)
        .where(currentStoreChallengeCondition(row.ownerId))
        .orderBy(desc(authChallenges.createdAt), desc(authChallenges.id))
        .limit(1)
        .for('update')
      if (!current) throw new StoreError('Ativação da loja indisponível', 409)
      if (now.getTime() < current.createdAt.getTime() + RESEND_COOLDOWN_MS) {
        throw new StoreError('Aguarde antes de reenviar a ativação', 409)
      }

      const replacement = await replaceChallenge(tx, {
        challengeId: current.id,
        expectedPurpose: 'STORE_ACTIVATION',
        authCodeSecret: ctx.authCodeSecret.trim(),
        expiresAt: new Date(now.getTime() + ACTIVATION_TTL_MS),
        now,
      })
      const outboxId = await enqueueChallengeEmail(tx, {
        template: 'VERIFICATION_CODE',
        recipient: row.email,
        challengeId: replacement.id,
        flowId: replacement.id,
      })
      await appendIdentityEvent(tx, {
        eventType: 'CHALLENGE_OUTCOME',
        result: 'REISSUED',
        targetUserId: row.ownerId,
        requestId: ctx.requestId,
        metadata: { purpose: 'STORE_ACTIVATION' },
      })
      return activationFlow(replacement.id, replacement.createdAt, replacement.expiresAt, outboxId)
    })
  } catch (error) {
    if (error instanceof ChallengeError) throw new StoreError('Ativação da loja mudou; tente novamente', 409)
    throw error
  }
}

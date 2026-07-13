import type { StoreCreateInput } from '@delivery/shared/schemas'
import type { Db } from '../db/client'
import { stores, users } from '../db/schema'
import { enqueueChallengeEmail } from '../email/outbox.service'
import { createChallenge } from './auth-challenge.service'
import { isUniqueViolation, toPublicUser, type PublicUser } from './auth.service'
import type { IdentityContext } from './registration.service'
import { StoreError } from './store.service'

const ACTIVATION_TTL_MS = 10 * 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type Store = typeof stores.$inferSelect

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

export async function provisionStoreWithOwner(
  db: Db,
  input: StoreCreateInput,
  ctx: IdentityContext,
): Promise<{ store: Store; owner: PublicUser; verificationId: string; outboxId: string }> {
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

      return {
        store,
        owner: toPublicUser(owner),
        verificationId: challenge.id,
        outboxId,
      }
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreError('Slug ou email já em uso', 409)
    throw error
  }
}

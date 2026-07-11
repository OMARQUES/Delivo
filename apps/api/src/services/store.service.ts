import { eq, sql } from 'drizzle-orm'
import type { StoreCreateInput, StoreUpdateInput } from '@delivery/shared/schemas'
import { isOpenNow } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { stores, users, authProviders, refreshTokens } from '../db/schema'
import { hashPassword } from '../lib/password'

export class StoreError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 409,
  ) {
    super(message)
  }
}

/**
 * Detecta unique_violation (SQLSTATE 23505). Drizzle embrulha o erro do driver
 * em DrizzleQueryError, então o código pode estar no topo ou em `e.cause.code`.
 */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  const causeCode = (e as { cause?: { code?: string } })?.cause?.code
  return code === '23505' || causeCode === '23505'
}

/** Cria user (role STORE) + loja numa transação. Rollback total em conflito. */
export async function createStoreWithOwner(db: Db, input: StoreCreateInput) {
  try {
    return await db.transaction(async (tx) => {
      const [owner] = await tx
        .insert(users)
        .values({ name: input.owner.name, email: input.owner.email, role: 'STORE', status: 'ACTIVE' })
        .returning()
      if (!owner) throw new StoreError('Falha ao criar usuário da loja', 400)
      await tx.insert(authProviders).values({
        userId: owner.id,
        provider: 'PASSWORD',
        passwordHash: await hashPassword(input.owner.password),
      })
      const [store] = await tx
        .insert(stores)
        .values({
          ownerUserId: owner.id,
          name: input.name,
          slug: input.slug,
          category: input.category,
          phone: input.phone,
          city: input.city,
          addressText: input.addressText,
          lat: input.lat,
          lng: input.lng,
        })
        .returning()
      if (!store) throw new StoreError('Falha ao criar loja', 400)
      return store
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new StoreError('Slug ou email já em uso', 409)
    throw e
  }
}

const PUBLIC_COLUMNS = {
  id: stores.id,
  name: stores.name,
  slug: stores.slug,
  category: stores.category,
  phone: stores.phone,
  city: stores.city,
  addressText: stores.addressText,
  lat: stores.lat,
  lng: stores.lng,
  logoKey: stores.logoKey,
  deliveryFeeMode: stores.deliveryFeeMode,
  deliveryFixedFeeCents: stores.deliveryFixedFeeCents,
  deliveryMinFeeCents: stores.deliveryMinFeeCents,
  deliveryPerKmCents: stores.deliveryPerKmCents,
  deliveryMaxKm: stores.deliveryMaxKm,
  minOrderCents: stores.minOrderCents,
  deliveryEtaMinutes: stores.deliveryEtaMinutes,
  pickupEtaMinutes: stores.pickupEtaMinutes,
  openingHours: stores.openingHours,
  isPaused: stores.isPaused,
}

function withOpen<T extends { openingHours: { dow: number; open: string; close: string }[]; isPaused: boolean }>(s: T) {
  return { ...s, isOpen: !s.isPaused && isOpenNow(s.openingHours) }
}

/** Home: só lojas ativas, com isOpen computado (abertas primeiro fica pro front/SQL depois). */
export async function listPublicStores(db: Db) {
  const rows = await db.select(PUBLIC_COLUMNS).from(stores).where(eq(stores.securityStatus, 'ACTIVE'))
  return rows.map(withOpen)
}

export async function getStoreBySlug(db: Db, slug: string) {
  const [row] = await db
    .select(PUBLIC_COLUMNS)
    .from(stores)
    .where(sql`lower(${stores.slug}) = ${slug.toLowerCase()} and ${stores.securityStatus} = 'ACTIVE'`)
    .limit(1)
  return row ? withOpen(row) : null
}

export async function getStoreByOwner(db: Db, ownerUserId: string) {
  const [row] = await db.select().from(stores).where(eq(stores.ownerUserId, ownerUserId)).limit(1)
  return row ?? null
}

export async function updateStore(db: Db, storeId: string, input: StoreUpdateInput) {
  if (Object.keys(input).length === 0) throw new StoreError('Nada para atualizar', 400)
  const [row] = await db.update(stores).set(input).where(eq(stores.id, storeId)).returning()
  if (!row) throw new StoreError('Loja não encontrada', 404)
  return row
}

export async function setStoreSecurityStatus(
  db: Db,
  storeId: string,
  securityStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED',
) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(stores).where(eq(stores.id, storeId)).limit(1)
    if (!current) throw new StoreError('Loja não encontrada', 404)
    if (current.securityStatus === 'CLOSED' && securityStatus !== 'CLOSED') {
      throw new StoreError('Loja encerrada não pode ser reativada', 409)
    }
    if (current.securityStatus === securityStatus) return current

    const [store] = await tx
      .update(stores)
      .set({ securityStatus })
      .where(eq(stores.id, storeId))
      .returning()
    if (!store) throw new StoreError('Loja não encontrada', 404)

    if (securityStatus === 'SUSPENDED' || securityStatus === 'CLOSED') {
      await tx
        .update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, store.ownerUserId))
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.userId, store.ownerUserId))
    }
    return store
  })
}

/** Comissão da plataforma em basis points (0..10000 = 0..100%). Admin-only. */
export async function setStoreCommission(db: Db, storeId: string, commissionBps: number) {
  const [row] = await db.update(stores).set({ commissionBps }).where(eq(stores.id, storeId)).returning()
  if (!row) throw new StoreError('Loja não encontrada', 404)
  return row
}

export async function setStoreLogo(db: Db, storeId: string, logoKey: string) {
  const [row] = await db.update(stores).set({ logoKey }).where(eq(stores.id, storeId)).returning()
  if (!row) throw new StoreError('Loja não encontrada', 404)
  return row
}

/** Lista completa pro admin (inclui inativas + owner). */
export async function listAllStores(db: Db) {
  return db.select().from(stores)
}

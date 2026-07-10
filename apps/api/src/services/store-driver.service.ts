import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { normalizePhone } from '@delivery/shared/schemas'
import type { Db } from '../db/client'
import { storeDrivers, stores, users, type DriverSchedule } from '../db/schema'

export type StoreDriverTerms = {
  dailyRateCents: number
  perDeliveryCents: number
  schedule: DriverSchedule
}

export class StoreDriverError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) {
    super(message)
  }
}

function isUniqueViolation(error: unknown) {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : null
  }
  return false
}

export async function inviteDriver(db: Db, storeId: string, phone: string, terms: StoreDriverTerms) {
  const normalized = normalizePhone(phone)
  const [driver] = await db.select().from(users).where(eq(users.phone, normalized)).limit(1)
  if (!driver) throw new StoreDriverError('Entregador não encontrado', 404)
  if (driver.role !== 'DRIVER' || driver.status !== 'ACTIVE') {
    throw new StoreDriverError('A conta informada não é de um entregador ativo', 400)
  }
  // Vínculo é único por (loja, entregador) mesmo quando REMOVED — reconvidar reativa o mesmo registro.
  const [existing] = await db.select().from(storeDrivers)
    .where(and(eq(storeDrivers.storeId, storeId), eq(storeDrivers.driverUserId, driver.id)))
    .limit(1)
  if (existing) {
    if (existing.status !== 'REMOVED') throw new StoreDriverError('Entregador já vinculado à loja', 409)
    const [revived] = await db.update(storeDrivers)
      .set({
        status: 'INVITED', ...terms,
        pendingDailyRateCents: null, pendingPerDeliveryCents: null,
        pendingSchedule: null, pendingProposedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(storeDrivers.id, existing.id))
      .returning()
    return revived!
  }
  try {
    const [link] = await db.insert(storeDrivers).values({
      storeId,
      driverUserId: driver.id,
      ...terms,
    }).returning()
    return link!
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreDriverError('Entregador já vinculado à loja', 409)
    throw error
  }
}

export async function confirmLink(db: Db, driverUserId: string, linkId: string) {
  const [link] = await db.update(storeDrivers)
    .set({ status: 'CONFIRMED', updatedAt: new Date() })
    .where(and(
      eq(storeDrivers.id, linkId),
      eq(storeDrivers.driverUserId, driverUserId),
      eq(storeDrivers.status, 'INVITED'),
    ))
    .returning()
  if (!link) throw new StoreDriverError('Convite não encontrado', 404)
  return link
}

export async function removeLink(db: Db, storeId: string, linkId: string) {
  const [link] = await db.update(storeDrivers)
    .set({
      status: 'REMOVED',
      pendingDailyRateCents: null, pendingPerDeliveryCents: null,
      pendingSchedule: null, pendingProposedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.storeId, storeId)))
    .returning()
  if (!link) throw new StoreDriverError('Vínculo não encontrado', 404)
  return link
}

export async function proposeLinkTerms(
  db: Db,
  storeId: string,
  linkId: string,
  terms: Partial<StoreDriverTerms>,
) {
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(storeDrivers).where(and(
      eq(storeDrivers.id, linkId),
      eq(storeDrivers.storeId, storeId),
      eq(storeDrivers.status, 'CONFIRMED'),
    )).for('update')
    if (!link) throw new StoreDriverError('Vínculo confirmado não encontrado', 404)
    const [proposed] = await tx.update(storeDrivers).set({
      pendingDailyRateCents: terms.dailyRateCents ?? link.dailyRateCents,
      pendingPerDeliveryCents: terms.perDeliveryCents ?? link.perDeliveryCents,
      pendingSchedule: terms.schedule ?? link.schedule,
      pendingProposedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.status, 'CONFIRMED'))).returning()
    if (!proposed) throw new StoreDriverError('Vínculo mudou — recarregue', 409)
    return proposed
  })
}

export async function confirmLinkTermsChange(db: Db, driverUserId: string, linkId: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(storeDrivers).where(and(
      eq(storeDrivers.id, linkId),
      eq(storeDrivers.driverUserId, driverUserId),
      eq(storeDrivers.status, 'CONFIRMED'),
    )).for('update')
    if (!link) throw new StoreDriverError('Vínculo confirmado não encontrado', 404)
    if (
      link.pendingProposedAt == null
      || link.pendingDailyRateCents == null
      || link.pendingPerDeliveryCents == null
      || link.pendingSchedule == null
    ) throw new StoreDriverError('Sem alteração pendente', 409)
    const [confirmed] = await tx.update(storeDrivers).set({
      dailyRateCents: link.pendingDailyRateCents,
      perDeliveryCents: link.pendingPerDeliveryCents,
      schedule: link.pendingSchedule,
      pendingDailyRateCents: null, pendingPerDeliveryCents: null,
      pendingSchedule: null, pendingProposedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.status, 'CONFIRMED'))).returning()
    if (!confirmed) throw new StoreDriverError('Vínculo mudou — recarregue', 409)
    return confirmed
  })
}

export async function rejectLinkTermsChange(db: Db, driverUserId: string, linkId: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(storeDrivers).where(and(
      eq(storeDrivers.id, linkId),
      eq(storeDrivers.driverUserId, driverUserId),
      eq(storeDrivers.status, 'CONFIRMED'),
    )).for('update')
    if (!link) throw new StoreDriverError('Vínculo confirmado não encontrado', 404)
    if (link.pendingProposedAt == null) throw new StoreDriverError('Sem alteração pendente', 409)
    const [rejected] = await tx.update(storeDrivers).set({
      pendingDailyRateCents: null, pendingPerDeliveryCents: null,
      pendingSchedule: null, pendingProposedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.status, 'CONFIRMED'))).returning()
    if (!rejected) throw new StoreDriverError('Vínculo mudou — recarregue', 409)
    return rejected
  })
}

export async function listStoreDrivers(db: Db, storeId: string) {
  const rows = await db.select({ link: storeDrivers, driverName: users.name, driverPhone: users.phone })
    .from(storeDrivers)
    .innerJoin(users, eq(storeDrivers.driverUserId, users.id))
    .where(and(eq(storeDrivers.storeId, storeId), ne(storeDrivers.status, 'REMOVED')))
    .orderBy(desc(storeDrivers.createdAt))
  return rows.map((row) => ({ ...row.link, driverName: row.driverName, driverPhone: row.driverPhone }))
}

export async function listDriverLinks(db: Db, driverUserId: string) {
  const rows = await db.select({ link: storeDrivers, storeName: stores.name, storeAddressText: stores.addressText })
    .from(storeDrivers)
    .innerJoin(stores, eq(storeDrivers.storeId, stores.id))
    .where(and(eq(storeDrivers.driverUserId, driverUserId), inArray(storeDrivers.status, ['INVITED', 'CONFIRMED'])))
    .orderBy(desc(storeDrivers.createdAt))
  return rows.map((row) => ({ ...row.link, storeName: row.storeName, storeAddressText: row.storeAddressText }))
}

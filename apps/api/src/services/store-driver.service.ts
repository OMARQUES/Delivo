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
      .set({ status: 'INVITED', ...terms, updatedAt: new Date() })
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
    .set({ status: 'REMOVED', updatedAt: new Date() })
    .where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.storeId, storeId)))
    .returning()
  if (!link) throw new StoreDriverError('Vínculo não encontrado', 404)
  return link
}

export async function updateLinkTerms(
  db: Db,
  storeId: string,
  linkId: string,
  terms: Partial<StoreDriverTerms>,
) {
  const [link] = await db.update(storeDrivers)
    .set({ ...terms, updatedAt: new Date() })
    .where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.storeId, storeId)))
    .returning()
  if (!link) throw new StoreDriverError('Vínculo não encontrado', 404)
  return link
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

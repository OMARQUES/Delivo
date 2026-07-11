import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm'
import { normalizePhone } from '@delivery/shared/schemas'
import { datedScheduleExpiry, saoPauloDate, schedulesConflict, type ScheduleItem } from '@delivery/shared'
import type { Db } from '../db/client'
import { driverShifts, shiftStartAuthorizations, storeDrivers, stores, users, type DriverSchedule } from '../db/schema'

export type StoreDriverTerms = {
  dailyRateCents: number
  perDeliveryCents: number
  schedule: DriverSchedule
}
type ScheduleReader = Pick<Db, 'select'>

export class StoreDriverError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) {
    super(message)
  }
}

export function isLinkExpired(link: { expiresAt: Date | null }, now = new Date()) {
  return link.expiresAt != null && link.expiresAt <= now
}

export function isLinkActive(link: { status: string; expiresAt: Date | null }, now = new Date()) {
  return link.status !== 'REMOVED' && !isLinkExpired(link, now)
}

export async function driverActiveSchedule(db: ScheduleReader, driverUserId: string, excludeLinkId?: string): Promise<ScheduleItem[]> {
  const links = await db.select().from(storeDrivers).where(and(
    eq(storeDrivers.driverUserId, driverUserId), eq(storeDrivers.status, 'CONFIRMED'),
  ))
  const today = saoPauloDate()
  const base = links.filter((link) => link.id !== excludeLinkId && !isLinkExpired(link))
    .flatMap((link) => link.schedule).filter((item) => !('date' in item) || item.date >= today)
  const authorizations = await db.select({ authorization: shiftStartAuthorizations, linkId: storeDrivers.id })
    .from(shiftStartAuthorizations).innerJoin(storeDrivers, eq(storeDrivers.id, shiftStartAuthorizations.storeDriverId))
    .where(and(eq(storeDrivers.driverUserId, driverUserId), eq(shiftStartAuthorizations.status, 'ACCEPTED'),
      gt(shiftStartAuthorizations.authorizedUntil, new Date()),
    ))
  const time = (date: Date) => new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
  const exceptions: ScheduleItem[] = authorizations.filter((row) => row.linkId !== excludeLinkId).map(({ authorization }) => ({
    date: authorization.workDate, start: time(authorization.scheduledStartAt), end: time(authorization.scheduledEndAt),
  }))
  return [...base, ...exceptions]
}

export async function assertNoScheduleConflict(db: ScheduleReader, driverUserId: string, candidate: ScheduleItem[], excludeLinkId?: string) {
  const today = saoPauloDate()
  const future = candidate.filter((item) => !('date' in item) || item.date >= today)
  if (schedulesConflict(await driverActiveSchedule(db, driverUserId, excludeLinkId), future)) {
    throw new StoreDriverError('Conflito de horário com a agenda do entregador', 409)
  }
}

async function assertNoActiveShift(db: ScheduleReader, linkId: string, message: string) {
  const [active] = await db.select({ id: driverShifts.id }).from(driverShifts).where(and(
    eq(driverShifts.storeDriverId, linkId), eq(driverShifts.status, 'ACTIVE'),
  )).limit(1)
  if (active) throw new StoreDriverError(message, 409)
}

export async function inviteDriver(db: Db, storeId: string, phone: string, terms: StoreDriverTerms) {
  const normalized = normalizePhone(phone)
  const [driver] = await db.select().from(users).where(eq(users.phone, normalized)).limit(1)
  if (!driver) throw new StoreDriverError('Entregador não encontrado', 404)
  if (driver.role !== 'DRIVER' || driver.status !== 'ACTIVE') {
    throw new StoreDriverError('A conta informada não é de um entregador ativo', 400)
  }
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, driver.id)).for('update')
    await assertNoScheduleConflict(tx, driver.id, terms.schedule)
    const [link] = await tx.insert(storeDrivers).values({ storeId, driverUserId: driver.id, ...terms,
      expiresAt: datedScheduleExpiry(terms.schedule),
    }).returning()
    return link!
  })
}

export async function confirmLink(db: Db, driverUserId: string, linkId: string) {
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
    const [link] = await tx.select().from(storeDrivers).where(and(
      eq(storeDrivers.id, linkId),
      eq(storeDrivers.driverUserId, driverUserId),
      eq(storeDrivers.status, 'INVITED'),
    )).for('update')
    if (!link) throw new StoreDriverError('Convite não encontrado', 404)
    await assertNoScheduleConflict(tx, driverUserId, link.schedule, link.id)
    const [confirmed] = await tx.update(storeDrivers).set({ status: 'CONFIRMED', updatedAt: new Date() })
      .where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.status, 'INVITED'))).returning()
    if (!confirmed) throw new StoreDriverError('Convite mudou — recarregue', 409)
    return confirmed
  })
}

export async function removeLink(db: Db, storeId: string, linkId: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(storeDrivers).where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.storeId, storeId))).for('update')
    if (!current) throw new StoreDriverError('Vínculo não encontrado', 404)
    await assertNoActiveShift(tx, linkId, 'Encerre o turno ativo antes de remover o vínculo')
    const [link] = await tx.update(storeDrivers)
    .set({
      status: 'REMOVED',
      pendingDailyRateCents: null, pendingPerDeliveryCents: null,
      pendingSchedule: null, pendingProposedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.storeId, storeId)))
    .returning()
    return link!
  })
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
    await assertNoScheduleConflict(tx, link.driverUserId, terms.schedule ?? link.schedule, linkId)
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
    await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
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
    const scheduleChanged = JSON.stringify(link.pendingSchedule) !== JSON.stringify(link.schedule)
    if (scheduleChanged) await assertNoActiveShift(tx, linkId, 'Encerre o turno ativo antes de alterar a agenda')
    await assertNoScheduleConflict(tx, driverUserId, link.pendingSchedule, linkId)
    const [confirmed] = await tx.update(storeDrivers).set({
      dailyRateCents: link.pendingDailyRateCents,
      perDeliveryCents: link.pendingPerDeliveryCents,
      schedule: link.pendingSchedule,
      expiresAt: scheduleChanged ? datedScheduleExpiry(link.pendingSchedule) : link.expiresAt,
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
  return rows.filter((row) => isLinkActive(row.link))
    .map((row) => ({ ...row.link, driverName: row.driverName, driverPhone: row.driverPhone }))
}

export async function listDriverLinks(db: Db, driverUserId: string) {
  const rows = await db.select({ link: storeDrivers, storeName: stores.name, storeAddressText: stores.addressText })
    .from(storeDrivers)
    .innerJoin(stores, eq(storeDrivers.storeId, stores.id))
    .where(and(eq(storeDrivers.driverUserId, driverUserId), inArray(storeDrivers.status, ['INVITED', 'CONFIRMED'])))
    .orderBy(desc(storeDrivers.createdAt))
  return rows.filter((row) => isLinkActive(row.link))
    .map((row) => ({ ...row.link, storeName: row.storeName, storeAddressText: row.storeAddressText }))
}

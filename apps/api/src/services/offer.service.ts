import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { datedScheduleExpiry, offerScheduleItems, saoPauloDate, type OfferCreateInput } from '@delivery/shared'
import type { Db } from '../db/client'
import { driverOffers, offerAcceptances, storeDrivers, stores, users } from '../db/schema'
import { assertNoScheduleConflict, StoreDriverError } from './store-driver.service'

export class OfferError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message) }
}
function uniqueViolation(error: unknown) {
  let current: unknown = error
  for (let i = 0; i < 5 && typeof current === 'object' && current !== null; i += 1) {
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : null
  }
  return false
}
export function createOffer(db: Db, storeId: string, input: OfferCreateInput) {
  return db.insert(driverOffers).values({ storeId, dailyRateCents: input.dailyRateCents, perDeliveryCents: input.perDeliveryCents,
    slots: input.slots, recurrence: input.recurrence, startTime: input.start, endTime: input.end, note: input.note || null,
  }).returning().then((rows) => rows[0]!)
}
export async function closeOffer(db: Db, storeId: string, offerId: string) {
  const [offer] = await db.update(driverOffers).set({ status: 'CLOSED', updatedAt: new Date() }).where(and(
    eq(driverOffers.id, offerId), eq(driverOffers.storeId, storeId), eq(driverOffers.status, 'OPEN'),
  )).returning()
  if (!offer) throw new OfferError('Oferta aberta não encontrada', 404)
  return offer
}
export async function listStoreOffers(db: Db, storeId: string) {
  const offers = await db.select().from(driverOffers).where(eq(driverOffers.storeId, storeId)).orderBy(desc(driverOffers.createdAt))
  const acceptances = await db.select({ offerId: offerAcceptances.offerId, driverUserId: users.id, driverName: users.name, driverPhone: users.phone })
    .from(offerAcceptances).innerJoin(users, eq(users.id, offerAcceptances.driverUserId))
    .innerJoin(driverOffers, eq(driverOffers.id, offerAcceptances.offerId))
    .where(and(eq(driverOffers.storeId, storeId), eq(offerAcceptances.status, 'ACCEPTED')))
  return offers.map((offer) => ({ ...offer, acceptances: acceptances.filter((item) => item.offerId === offer.id) }))
}
export async function listOpenOffers(db: Db, driverUserId: string) {
  const rows = await db.select({ id: driverOffers.id, storeId: driverOffers.storeId, status: driverOffers.status,
    dailyRateCents: driverOffers.dailyRateCents, perDeliveryCents: driverOffers.perDeliveryCents,
    slots: driverOffers.slots, acceptedCount: driverOffers.acceptedCount, recurrence: driverOffers.recurrence,
    startTime: driverOffers.startTime, endTime: driverOffers.endTime, note: driverOffers.note,
    createdAt: driverOffers.createdAt, storeName: stores.name, storeAddressText: stores.addressText,
  }).from(driverOffers).innerJoin(stores, eq(stores.id, driverOffers.storeId))
    .leftJoin(offerAcceptances, and(eq(offerAcceptances.offerId, driverOffers.id), eq(offerAcceptances.driverUserId, driverUserId)))
    .where(and(eq(driverOffers.status, 'OPEN'), lt(driverOffers.acceptedCount, driverOffers.slots), sql`${offerAcceptances.id} is null`))
    .orderBy(desc(driverOffers.createdAt))
  const today = saoPauloDate()
  return rows.filter((offer) => offer.recurrence.kind === 'WEEKLY' || offer.recurrence.dates.some((date) => date >= today))
}
export async function acceptOffer(db: Db, driverUserId: string, offerId: string) {
  try {
    return await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
      const [offer] = await tx.select().from(driverOffers).where(eq(driverOffers.id, offerId)).for('update')
      if (!offer) throw new OfferError('Oferta não encontrada', 404)
      if (offer.acceptedCount >= offer.slots) throw new OfferError('Vagas esgotadas', 409)
      if (offer.status !== 'OPEN') throw new OfferError('Oferta encerrada', 409)
      const [answered] = await tx.select({ id: offerAcceptances.id }).from(offerAcceptances).where(and(
        eq(offerAcceptances.offerId, offerId), eq(offerAcceptances.driverUserId, driverUserId),
      )).limit(1)
      if (answered) throw new OfferError('Você já respondeu esta oferta', 409)
      const today = saoPauloDate()
      const effectiveRecurrence = offer.recurrence.kind === 'DATES'
        ? { kind: 'DATES' as const, dates: offer.recurrence.dates.filter((date) => date >= today) }
        : offer.recurrence
      if (effectiveRecurrence.kind === 'DATES' && effectiveRecurrence.dates.length === 0) throw new OfferError('Oferta expirada', 409)
      const effectiveSchedule = offerScheduleItems({ recurrence: effectiveRecurrence, start: offer.startTime, end: offer.endTime })
      try { await assertNoScheduleConflict(tx, driverUserId, effectiveSchedule) }
      catch (error) {
        if (error instanceof StoreDriverError) throw new OfferError('Conflito de horário com sua agenda', 409)
        throw error
      }
      const [claimed] = await tx.update(driverOffers).set({
        acceptedCount: sql`${driverOffers.acceptedCount} + 1`,
        status: sql`case when ${driverOffers.acceptedCount} + 1 >= ${driverOffers.slots} then 'CLOSED'::driver_offer_status else ${driverOffers.status} end`,
        updatedAt: new Date(),
      }).where(and(eq(driverOffers.id, offerId), eq(driverOffers.status, 'OPEN'), lt(driverOffers.acceptedCount, driverOffers.slots))).returning()
      if (!claimed) throw new OfferError('Vagas esgotadas', 409)
      await tx.insert(offerAcceptances).values({ offerId, driverUserId, status: 'ACCEPTED' })
      const schedule = offerScheduleItems({ recurrence: offer.recurrence, start: offer.startTime, end: offer.endTime })
      const expiresAt = offer.recurrence.kind === 'DATES' ? datedScheduleExpiry(schedule) : null
      const terms = { status: 'CONFIRMED' as const, dailyRateCents: offer.dailyRateCents, perDeliveryCents: offer.perDeliveryCents,
        schedule, expiresAt, pendingDailyRateCents: null, pendingPerDeliveryCents: null, pendingSchedule: null,
        pendingProposedAt: null, updatedAt: new Date(),
      }
      const [link] = await tx.insert(storeDrivers).values({ storeId: offer.storeId, driverUserId, ...terms }).returning()
      return { offer: claimed, link: link! }
    })
  } catch (error) {
    if (error instanceof OfferError) throw error
    if (uniqueViolation(error)) throw new OfferError('Você já respondeu esta oferta', 409)
    throw error
  }
}
export async function dismissOffer(db: Db, driverUserId: string, offerId: string) {
  const [offer] = await db.select({ id: driverOffers.id }).from(driverOffers).where(and(eq(driverOffers.id, offerId), eq(driverOffers.status, 'OPEN'))).limit(1)
  if (!offer) throw new OfferError('Oferta aberta não encontrada', 404)
  try {
    const [dismissed] = await db.insert(offerAcceptances).values({ offerId, driverUserId, status: 'DISMISSED' }).returning()
    return dismissed!
  } catch (error) {
    if (uniqueViolation(error)) throw new OfferError('Você já respondeu esta oferta', 409)
    throw error
  }
}

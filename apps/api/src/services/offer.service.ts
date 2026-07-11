import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { offerScheduleItems, scheduleConflicts, type OfferCreateInput } from '@delivery/shared'
import type { Db } from '../db/client'
import { driverOffers, offerAcceptances, storeDrivers, stores, users } from '../db/schema'
import { isLinkActive } from './store-driver.service'

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
  const today = todaySP()
  return rows.filter((offer) => offer.recurrence.kind === 'WEEKLY' || offer.recurrence.dates.some((date) => date >= today))
}
function todaySP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function expiresAfterLastDate(dates: string[]) {
  const last = [...dates].sort().at(-1)!
  const [year, month, day] = last.split('-').map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10)
  return new Date(`${next}T00:00:00-03:00`)
}
export async function acceptOffer(db: Db, driverUserId: string, offerId: string) {
  try {
    return await db.transaction(async (tx) => {
      const [offer] = await tx.select().from(driverOffers).where(eq(driverOffers.id, offerId)).for('update')
      if (!offer) throw new OfferError('Oferta não encontrada', 404)
      if (offer.acceptedCount >= offer.slots) throw new OfferError('Vagas esgotadas', 409)
      if (offer.status !== 'OPEN') throw new OfferError('Oferta encerrada', 409)
      // Serializa aceites do mesmo entregador em ofertas diferentes. Sem este
      // lock, duas transações poderiam validar a mesma agenda antiga e criar
      // vínculos conflitantes ao mesmo tempo.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
      const [answered] = await tx.select({ id: offerAcceptances.id }).from(offerAcceptances).where(and(
        eq(offerAcceptances.offerId, offerId), eq(offerAcceptances.driverUserId, driverUserId),
      )).limit(1)
      if (answered) throw new OfferError('Você já respondeu esta oferta', 409)
      const links = await tx.select().from(storeDrivers).where(eq(storeDrivers.driverUserId, driverUserId))
      const activeLinks = links.filter((link) => isLinkActive(link))
      if (activeLinks.some((link) => link.storeId === offer.storeId)) throw new OfferError('Você já está vinculado a esta loja', 409)
      const today = todaySP()
      const effectiveRecurrence = offer.recurrence.kind === 'DATES'
        ? { kind: 'DATES' as const, dates: offer.recurrence.dates.filter((date) => date >= today) }
        : offer.recurrence
      if (effectiveRecurrence.kind === 'DATES' && effectiveRecurrence.dates.length === 0) throw new OfferError('Oferta expirada', 409)
      const confirmedSchedule = activeLinks.filter((link) => link.status === 'CONFIRMED')
        .flatMap((link) => link.schedule).filter((item) => !('date' in item) || item.date >= today)
      if (scheduleConflicts(confirmedSchedule, { recurrence: effectiveRecurrence, start: offer.startTime, end: offer.endTime }))
        throw new OfferError('Conflito de horário com sua agenda', 409)
      const [claimed] = await tx.update(driverOffers).set({
        acceptedCount: sql`${driverOffers.acceptedCount} + 1`,
        status: sql`case when ${driverOffers.acceptedCount} + 1 >= ${driverOffers.slots} then 'CLOSED'::driver_offer_status else ${driverOffers.status} end`,
        updatedAt: new Date(),
      }).where(and(eq(driverOffers.id, offerId), eq(driverOffers.status, 'OPEN'), lt(driverOffers.acceptedCount, driverOffers.slots))).returning()
      if (!claimed) throw new OfferError('Vagas esgotadas', 409)
      await tx.insert(offerAcceptances).values({ offerId, driverUserId, status: 'ACCEPTED' })
      const schedule = offerScheduleItems({ recurrence: offer.recurrence, start: offer.startTime, end: offer.endTime })
      const expiresAt = offer.recurrence.kind === 'DATES' ? expiresAfterLastDate(offer.recurrence.dates) : null
      const existing = links.find((link) => link.storeId === offer.storeId)
      const terms = { status: 'CONFIRMED' as const, dailyRateCents: offer.dailyRateCents, perDeliveryCents: offer.perDeliveryCents,
        schedule, expiresAt, pendingDailyRateCents: null, pendingPerDeliveryCents: null, pendingSchedule: null,
        pendingProposedAt: null, updatedAt: new Date(),
      }
      const [link] = existing
        ? await tx.update(storeDrivers).set(terms).where(eq(storeDrivers.id, existing.id)).returning()
        : await tx.insert(storeDrivers).values({ storeId: offer.storeId, driverUserId, ...terms }).returning()
      return { offer: claimed, link: link! }
    })
  } catch (error) {
    if (error instanceof OfferError) throw error
    if (uniqueViolation(error)) throw new OfferError('Você já respondeu esta oferta ou já está vinculado à loja', 409)
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

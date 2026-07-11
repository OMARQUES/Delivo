import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm'
import { addCivilDays, datedScheduleExpiry, occurrenceForWorkDate, schedulesConflict, type ScheduleItem } from '@delivery/shared'
import type { Db } from '../db/client'
import { driverShifts, orders, shiftStartAuthorizations, shiftTermProposals, storeDrivers, users } from '../db/schema'
import { recordPerDeliveryAdjustment } from './finance.service'
import { driverActiveSchedule, isLinkExpired } from './store-driver.service'

export class ShiftProposalError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message) }
}
type ShiftReader = Pick<Db, 'select'>

function isUniqueViolation(error: unknown) {
  let current: unknown = error
  for (let i = 0; i < 5 && typeof current === 'object' && current !== null; i += 1) {
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : null
  }
  return false
}

function endFor(workDate: string, start: string, end: string) {
  return new Date(`${end <= start ? addCivilDays(workDate, 1) : workDate}T${end}:00-03:00`)
}

export async function createShiftAuthorization(db: Db, storeId: string, input: {
  storeDriverId: string; workDate: string; authorizedUntil: string; newEnd?: string
  dailyRateCents?: number; perDeliveryCents?: number; note: string
}) {
  const now = new Date()
  return db.transaction(async (tx) => {
    const [candidateLink] = await tx.select({ driverUserId: storeDrivers.driverUserId }).from(storeDrivers).where(and(
      eq(storeDrivers.id, input.storeDriverId), eq(storeDrivers.storeId, storeId), eq(storeDrivers.status, 'CONFIRMED'),
    )).limit(1)
    if (!candidateLink) throw new ShiftProposalError('Vínculo confirmado não encontrado', 404)
    await tx.select({ id: users.id }).from(users).where(eq(users.id, candidateLink.driverUserId)).for('update')
    const [link] = await tx.select().from(storeDrivers).where(and(
      eq(storeDrivers.id, input.storeDriverId), eq(storeDrivers.storeId, storeId), eq(storeDrivers.status, 'CONFIRMED'),
    )).for('update')
    if (!link) throw new ShiftProposalError('Vínculo confirmado não encontrado', 404)
    if (isLinkExpired(link, now)) throw new ShiftProposalError('Vínculo expirado', 409)
    const occurrence = occurrenceForWorkDate(link.schedule, input.workDate)
    if (!occurrence) throw new ShiftProposalError('Não existe turno agendado nesta data', 409)
    if (now.getTime() <= occurrence.scheduledStartAt.getTime() + 30 * 60_000) {
      throw new ShiftProposalError('A autorização excepcional só é necessária após a tolerância normal', 409)
    }
    const authorizedUntil = new Date(input.authorizedUntil)
    const scheduledEndAt = input.newEnd ? endFor(input.workDate, occurrence.item.start, input.newEnd) : occurrence.scheduledEndAt
    if (authorizedUntil <= now) throw new ShiftProposalError('O novo limite precisa estar no futuro', 400)
    if (authorizedUntil >= scheduledEndAt) throw new ShiftProposalError('O limite para iniciar deve ser anterior ao fim do turno', 400)
    if (scheduledEndAt.getTime() - occurrence.scheduledStartAt.getTime() > 24 * 60 * 60_000) {
      throw new ShiftProposalError('A ocorrência não pode ultrapassar 24 horas', 400)
    }
    const candidateSchedule: ScheduleItem[] = [{ date: input.workDate, start: occurrence.item.start, end: input.newEnd ?? occurrence.item.end }]
    const ownOther = link.schedule.filter((item) => item !== occurrence.item)
    const other = await driverActiveSchedule(tx, link.driverUserId, link.id)
    if (schedulesConflict([...other, ...ownOther], candidateSchedule)) throw new ShiftProposalError('A extensão conflita com outra agenda', 409)
    await tx.update(shiftStartAuthorizations).set({ status: 'CANCELLED', decidedAt: now, updatedAt: now }).where(and(
      eq(shiftStartAuthorizations.storeDriverId, link.id), eq(shiftStartAuthorizations.workDate, input.workDate),
      inArray(shiftStartAuthorizations.status, ['PENDING', 'ACCEPTED']), lte(shiftStartAuthorizations.authorizedUntil, now),
    ))
    try {
      const [created] = await tx.insert(shiftStartAuthorizations).values({
        storeDriverId: link.id, workDate: input.workDate, authorizedUntil,
        scheduledStartAt: occurrence.scheduledStartAt, scheduledEndAt,
        dailyRateCents: input.dailyRateCents ?? link.dailyRateCents,
        perDeliveryCents: input.perDeliveryCents ?? link.perDeliveryCents,
        note: input.note,
      }).returning()
      return created!
    } catch (error) {
      if (isUniqueViolation(error)) throw new ShiftProposalError('Já existe uma autorização aberta para esta ocorrência', 409)
      throw error
    }
  })
}

export async function decideShiftAuthorization(db: Db, driverUserId: string, authorizationId: string, accept: boolean) {
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
    const [row] = await tx.select({ authorization: shiftStartAuthorizations, owner: storeDrivers.driverUserId })
      .from(shiftStartAuthorizations).innerJoin(storeDrivers, eq(storeDrivers.id, shiftStartAuthorizations.storeDriverId))
      .where(and(eq(shiftStartAuthorizations.id, authorizationId), eq(storeDrivers.driverUserId, driverUserId), eq(shiftStartAuthorizations.status, 'PENDING')))
      .for('update')
    if (!row) throw new ShiftProposalError('Autorização pendente não encontrada', 404)
    if (accept && (new Date() >= row.authorization.authorizedUntil || new Date() >= row.authorization.scheduledEndAt)) {
      throw new ShiftProposalError('Autorização expirada', 409)
    }
    if (accept) {
      const [link] = await tx.select().from(storeDrivers).where(eq(storeDrivers.id, row.authorization.storeDriverId)).limit(1)
      if (!link) throw new ShiftProposalError('Vínculo não encontrado', 404)
      const occurrence = occurrenceForWorkDate(link.schedule, row.authorization.workDate)
      if (!occurrence) throw new ShiftProposalError('A ocorrência não existe mais', 409)
      const time = (date: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
      const candidate: ScheduleItem[] = [{ date: row.authorization.workDate,
        start: time(row.authorization.scheduledStartAt), end: time(row.authorization.scheduledEndAt),
      }]
      const other = await driverActiveSchedule(tx, driverUserId, link.id)
      const ownOther = link.schedule.filter((item) => item !== occurrence.item)
      if (schedulesConflict([...other, ...ownOther], candidate)) throw new ShiftProposalError('A autorização passou a conflitar com outra agenda', 409)
      if (link.expiresAt && row.authorization.scheduledEndAt > link.expiresAt) {
        await tx.update(storeDrivers).set({ expiresAt: row.authorization.scheduledEndAt, updatedAt: new Date() })
          .where(eq(storeDrivers.id, link.id))
      }
    }
    const [updated] = await tx.update(shiftStartAuthorizations).set({
      status: accept ? 'ACCEPTED' : 'REJECTED', decidedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(shiftStartAuthorizations.id, authorizationId), eq(shiftStartAuthorizations.status, 'PENDING'))).returning()
    return updated!
  })
}

export async function cancelShiftAuthorization(db: Db, storeId: string, authorizationId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ authorization: shiftStartAuthorizations, link: storeDrivers })
      .from(shiftStartAuthorizations).innerJoin(storeDrivers, eq(storeDrivers.id, shiftStartAuthorizations.storeDriverId))
      .where(and(eq(shiftStartAuthorizations.id, authorizationId), eq(storeDrivers.storeId, storeId),
        inArray(shiftStartAuthorizations.status, ['PENDING', 'ACCEPTED']),
      )).for('update')
    if (!row) throw new ShiftProposalError('Autorização aberta não encontrada', 404)
    const [updated] = await tx.update(shiftStartAuthorizations).set({ status: 'CANCELLED', decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(shiftStartAuthorizations.id, authorizationId)).returning()
    const accepted = await tx.select({ end: shiftStartAuthorizations.scheduledEndAt }).from(shiftStartAuthorizations).where(and(
      eq(shiftStartAuthorizations.storeDriverId, row.link.id), eq(shiftStartAuthorizations.status, 'ACCEPTED'),
    ))
    const dated = row.link.schedule.some((item) => 'date' in item)
    const expiries = dated ? [datedScheduleExpiry(row.link.schedule), ...accepted.map((item) => item.end)].filter((item): item is Date => item != null) : []
    await tx.update(storeDrivers).set({ expiresAt: dated && expiries.length ? new Date(Math.max(...expiries.map((item) => item.getTime()))) : null, updatedAt: new Date() })
      .where(eq(storeDrivers.id, row.link.id))
    return updated!
  })
}

export async function listDriverAuthorizations(db: Db, driverUserId: string) {
  return db.select({ authorization: shiftStartAuthorizations, storeId: storeDrivers.storeId })
    .from(shiftStartAuthorizations).innerJoin(storeDrivers, eq(storeDrivers.id, shiftStartAuthorizations.storeDriverId))
    .where(and(eq(storeDrivers.driverUserId, driverUserId),
      inArray(shiftStartAuthorizations.status, ['PENDING', 'ACCEPTED']),
      gt(shiftStartAuthorizations.authorizedUntil, new Date()),
    ))
    .orderBy(desc(shiftStartAuthorizations.createdAt)).then((rows) => rows.map((row) => ({ ...row.authorization, storeId: row.storeId })))
}

export async function proposeActiveShiftTerms(db: Db, storeId: string, shiftId: string, input: {
  dailyRateCents: number; perDeliveryCents: number; applyRetroactive: boolean; note?: string
}) {
  return db.transaction(async (tx) => {
    const [shift] = await tx.select().from(driverShifts).where(and(
      eq(driverShifts.id, shiftId), eq(driverShifts.storeId, storeId), eq(driverShifts.status, 'ACTIVE'),
    )).for('update')
    if (!shift) throw new ShiftProposalError('Turno ativo não encontrado', 404)
    if (shift.dailyRateCents === input.dailyRateCents && shift.perDeliveryCents === input.perDeliveryCents && !input.applyRetroactive) {
      throw new ShiftProposalError('Informe valores diferentes ou solicite retroativo', 400)
    }
    try {
      const [proposal] = await tx.insert(shiftTermProposals).values({ shiftId, ...input, note: input.note || null }).returning()
      return proposal!
    } catch (error) {
      if (isUniqueViolation(error)) throw new ShiftProposalError('Já existe uma proposta pendente neste turno', 409)
      throw error
    }
  })
}

export async function decideActiveShiftTerms(db: Db, driverUserId: string, shiftId: string, proposalId: string, accept: boolean) {
  return db.transaction(async (tx) => {
    const [shift] = await tx.select().from(driverShifts).where(and(
      eq(driverShifts.id, shiftId), eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.status, 'ACTIVE'),
    )).for('update')
    if (!shift) throw new ShiftProposalError('Turno ativo não encontrado', 404)
    const [proposal] = await tx.select().from(shiftTermProposals).where(and(
      eq(shiftTermProposals.id, proposalId), eq(shiftTermProposals.shiftId, shiftId), eq(shiftTermProposals.status, 'PENDING'),
    )).for('update')
    if (!proposal) throw new ShiftProposalError('Proposta pendente não encontrada', 404)
    if (!accept) {
      const [rejected] = await tx.update(shiftTermProposals).set({ status: 'REJECTED', decidedAt: new Date() })
        .where(eq(shiftTermProposals.id, proposal.id)).returning()
      return { proposal: rejected!, shift }
    }
    const adjustmentSeq = shift.adjustmentSeq + 1
    const [updatedShift] = await tx.update(driverShifts).set({
      dailyRateCents: proposal.dailyRateCents, perDeliveryCents: proposal.perDeliveryCents, adjustmentSeq,
    }).where(and(eq(driverShifts.id, shiftId), eq(driverShifts.status, 'ACTIVE'))).returning()
    if (!updatedShift) throw new ShiftProposalError('Turno mudou — recarregue', 409)
    if (proposal.applyRetroactive) {
      const delivered = await tx.select({ id: orders.id }).from(orders).where(and(
        eq(orders.shiftId, shiftId), eq(orders.status, 'DELIVERED'),
      )).for('update')
      await recordPerDeliveryAdjustment(tx, { seq: adjustmentSeq, storeId: shift.storeId,
        driverUserId, orderIds: delivered.map((order) => order.id), targetPerDeliveryCents: proposal.perDeliveryCents,
      })
    }
    const [accepted] = await tx.update(shiftTermProposals).set({ status: 'ACCEPTED', decidedAt: new Date() })
      .where(eq(shiftTermProposals.id, proposal.id)).returning()
    return { proposal: accepted!, shift: updatedShift }
  })
}

export async function cancelActiveShiftTerms(db: Db, storeId: string, shiftId: string, proposalId: string) {
  const [proposal] = await db.update(shiftTermProposals).set({ status: 'CANCELLED', decidedAt: new Date() })
    .from(driverShifts).where(and(eq(shiftTermProposals.id, proposalId), eq(shiftTermProposals.shiftId, shiftId),
      eq(shiftTermProposals.status, 'PENDING'), eq(driverShifts.id, shiftId), eq(driverShifts.storeId, storeId),
    )).returning()
  if (!proposal) throw new ShiftProposalError('Proposta pendente não encontrada', 404)
  return proposal
}

export async function pendingTermsForShift(db: ShiftReader, shiftId: string) {
  const [proposal] = await db.select().from(shiftTermProposals).where(and(
    eq(shiftTermProposals.shiftId, shiftId), eq(shiftTermProposals.status, 'PENDING'),
  )).limit(1)
  return proposal ?? null
}

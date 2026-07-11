import { and, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm'
import { haversineKm, SHIFT_START_RADIUS_KM } from '@delivery/shared/constants'
import { addCivilDays, findStartOccurrence } from '@delivery/shared'
import type { Db } from '../db/client'
import { driverShifts, orders, shiftStartAuthorizations, shiftTermProposals, storeDrivers, stores, users } from '../db/schema'
import { recordShiftDaily } from './finance.service'
import { isLinkExpired } from './store-driver.service'
import { pendingTermsForShift } from './shift-proposal.service'

export class ShiftError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 409) {
    super(message)
  }
}

function uniqueConstraint(error: unknown) {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === '23505') {
      return 'constraint' in current && typeof current.constraint === 'string' ? current.constraint : ''
    }
    current = 'cause' in current ? current.cause : null
  }
  return null
}

export async function startShift(db: Db, driverUserId: string, storeDriverId: string, gps: { lat: number; lng: number }) {
  const now = new Date()
  try {
    return await db.transaction(async (tx) => {
      // Mesmo lock usado pelos aceites GENERAL: impede iniciar turno e pegar o
      // pool simultaneamente.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
      const [link] = await tx.select().from(storeDrivers).where(and(
        eq(storeDrivers.id, storeDriverId), eq(storeDrivers.driverUserId, driverUserId), eq(storeDrivers.status, 'CONFIRMED'),
      )).for('update')
      if (!link) throw new ShiftError('Vínculo confirmado não encontrado', 404)
      if (!link.schedule.length) throw new ShiftError('Vínculo sem agenda — defina um horário antes de iniciar', 409)
      const [store] = await tx.select({ lat: stores.lat, lng: stores.lng }).from(stores).where(eq(stores.id, link.storeId)).limit(1)
      if (!store) throw new ShiftError('Loja não encontrada', 404)
      if (haversineKm(store, gps) > SHIFT_START_RADIUS_KM) throw new ShiftError('Você está fora do raio da loja', 409)
      const [generalAssignment] = await tx.select({ id: orders.id }).from(orders).where(and(
        eq(orders.driverId, driverUserId),
        isNull(orders.shiftId),
        inArray(orders.status, ['ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER', 'OUT_FOR_DELIVERY']),
      )).limit(1)
      if (generalAssignment) throw new ShiftError('Finalize as entregas do pool geral antes de iniciar o turno', 409)

      const regular = findStartOccurrence(link.schedule, now, 30)
      const authorizations = regular ? [] : await tx.select().from(shiftStartAuthorizations).where(and(
        eq(shiftStartAuthorizations.storeDriverId, link.id), eq(shiftStartAuthorizations.status, 'ACCEPTED'),
      )).orderBy(desc(shiftStartAuthorizations.createdAt)).for('update')
      const authorization = authorizations.find((item) => now <= item.authorizedUntil && now < item.scheduledEndAt)
      if (isLinkExpired(link, now) && !authorization) throw new ShiftError('Vínculo expirado', 409)
      if (!regular && (!authorization || now > authorization.authorizedUntil || now >= authorization.scheduledEndAt)) {
        throw new ShiftError('Fora da janela de início (30 min antes até 30 min depois)', 409)
      }
      const occurrence = regular ?? {
        workDate: authorization!.workDate,
        scheduledStartAt: authorization!.scheduledStartAt,
        scheduledEndAt: authorization!.scheduledEndAt,
      }
      const dailyRateCents = authorization?.dailyRateCents ?? link.dailyRateCents
      const perDeliveryCents = authorization?.perDeliveryCents ?? link.perDeliveryCents
      const prior = await tx.select({ start: driverShifts.scheduledStartAt, end: driverShifts.scheduledEndAt })
        .from(driverShifts).where(and(eq(driverShifts.driverUserId, driverUserId),
          gte(driverShifts.workDate, addCivilDays(occurrence.workDate, -1)),
          lte(driverShifts.workDate, addCivilDays(occurrence.workDate, 1)),
        ))
      if (prior.some((shift) => shift.start && shift.end && shift.start < occurrence.scheduledEndAt && occurrence.scheduledStartAt < shift.end)) {
        throw new ShiftError('Sobreposição de horário com outro turno', 409)
      }
      const [shift] = await tx.insert(driverShifts).values({
        storeId: link.storeId,
        storeDriverId: link.id,
        driverUserId,
        dailyRateCents,
        perDeliveryCents,
        workDate: occurrence.workDate,
        scheduledStartAt: occurrence.scheduledStartAt,
        scheduledEndAt: occurrence.scheduledEndAt,
        startedAt: now,
      }).returning()
      if (authorization) await tx.update(shiftStartAuthorizations).set({ status: 'USED', updatedAt: now })
        .where(and(eq(shiftStartAuthorizations.id, authorization.id), eq(shiftStartAuthorizations.status, 'ACCEPTED')))
      return shift!
    })
  } catch (error) {
    const constraint = uniqueConstraint(error)
    if (constraint === 'driver_shifts_link_day_unique') throw new ShiftError('Você já iniciou um turno deste vínculo hoje', 409)
    if (constraint === 'driver_shifts_one_active_per_driver') throw new ShiftError('Você já tem um turno ativo', 409)
    throw error
  }
}

export async function getActiveShift(db: Db, driverUserId: string) {
  const [row] = await db.select({ shift: driverShifts, storeName: stores.name, storeAddressText: stores.addressText })
    .from(driverShifts)
    .innerJoin(stores, eq(driverShifts.storeId, stores.id))
    .where(and(eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.status, 'ACTIVE')))
    .limit(1)
  return row ? { ...row.shift, storeName: row.storeName, storeAddressText: row.storeAddressText,
    pendingTerms: await pendingTermsForShift(db, row.shift.id),
  } : null
}

async function closeShift(db: Db, shiftId: string, owner: { driverUserId?: string; storeId?: string }, closedBy: 'DRIVER' | 'STORE', actorId?: string) {
  return db.transaction(async (tx) => {
    const filters = [eq(driverShifts.id, shiftId), eq(driverShifts.status, 'ACTIVE')]
    if (owner.driverUserId) filters.push(eq(driverShifts.driverUserId, owner.driverUserId))
    if (owner.storeId) filters.push(eq(driverShifts.storeId, owner.storeId))
    const [current] = await tx.select().from(driverShifts).where(and(...filters)).for('update')
    if (!current) throw new ShiftError('Turno ativo não encontrado', 404)
    const assigned = await tx.select({ status: orders.status, returnedAt: orders.returnedAt }).from(orders)
      .where(eq(orders.shiftId, shiftId)).for('update')
    if (hasUnfinishedOrder(assigned)) throw new ShiftError('Finalize ou devolva todas as entregas antes de encerrar o turno', 409)
    const endedAt = new Date()
    const [closed] = await tx.update(driverShifts).set({
      status: 'CLOSED', endedAt, closedBy,
      earlyClose: current.scheduledEndAt ? endedAt < current.scheduledEndAt : false,
      dailyDecision: 'APPROVED', dailyDecidedAt: endedAt, dailyDecidedBy: actorId ?? null,
      dailyDecisionReason: 'Turno liberado pela loja', autoApproveAt: null, reopenUntil: null,
    }).where(and(eq(driverShifts.id, shiftId), eq(driverShifts.status, 'ACTIVE'))).returning()
    if (!closed) throw new ShiftError('Turno já encerrado', 409)
    await tx.update(shiftTermProposals).set({ status: 'CANCELLED', decidedAt: endedAt }).where(and(
      eq(shiftTermProposals.shiftId, shiftId), eq(shiftTermProposals.status, 'PENDING'),
    ))
    await recordShiftDaily(tx, closed)
    return closed
  })
}

function hasUnfinishedOrder(rows: Array<{ status: string; returnedAt: Date | null }>) {
  return rows.some((order) => !['DELIVERED', 'CANCELLED'].includes(order.status)
    && !(order.status === 'DELIVERY_FAILED' && order.returnedAt != null))
}

/** Encerramento operacional: libera o driver, mas a diária aguarda decisão da loja. */
export async function endShift(db: Db, driverUserId: string, shiftId: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(driverShifts).where(and(
      eq(driverShifts.id, shiftId), eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.status, 'ACTIVE'),
    )).for('update')
    if (!current) throw new ShiftError('Turno ativo não encontrado', 404)
    const assigned = await tx.select({ status: orders.status, returnedAt: orders.returnedAt }).from(orders)
      .where(eq(orders.shiftId, shiftId)).for('update')
    if (hasUnfinishedOrder(assigned)) throw new ShiftError('Finalize ou devolva todas as entregas antes de encerrar o turno', 409)
    const endedAt = new Date()
    const [pending] = await tx.update(driverShifts).set({
      status: 'PENDING_DAILY', endedAt, closedBy: 'DRIVER',
      earlyClose: current.scheduledEndAt ? endedAt < current.scheduledEndAt : false,
      dailyDecision: 'PENDING', dailyDecidedAt: null, dailyDecidedBy: null, dailyDecisionReason: null,
      autoApproveAt: new Date(endedAt.getTime() + 24 * 60 * 60_000), reopenUntil: null,
    }).where(and(eq(driverShifts.id, shiftId), eq(driverShifts.status, 'ACTIVE'))).returning()
    if (!pending) throw new ShiftError('Turno mudou — recarregue', 409)
    await tx.update(shiftTermProposals).set({ status: 'CANCELLED', decidedAt: endedAt }).where(and(
      eq(shiftTermProposals.shiftId, shiftId), eq(shiftTermProposals.status, 'PENDING'),
    ))
    return pending
  })
}

/** Ação da própria loja: encerra e aprova imediatamente a diária. */
export async function releaseShift(db: Db, storeId: string, shiftId: string, actorId?: string) {
  return closeShift(db, shiftId, { storeId }, 'STORE', actorId)
}

export async function decideShiftDaily(db: Db, storeId: string, actorId: string, shiftId: string, approve: boolean, reason?: string) {
  if (!approve && (!reason || reason.trim().length < 3)) throw new ShiftError('Informe o motivo da recusa da diária', 400)
  return db.transaction(async (tx) => {
    const [shift] = await tx.select().from(driverShifts).where(and(
      eq(driverShifts.id, shiftId), eq(driverShifts.storeId, storeId),
      inArray(driverShifts.status, ['PENDING_DAILY', 'REOPEN_ALLOWED']), eq(driverShifts.dailyDecision, 'PENDING'),
    )).for('update')
    if (!shift) throw new ShiftError('Turno aguardando diária não encontrado', 404)
    const decidedAt = new Date()
    const [closed] = await tx.update(driverShifts).set({
      status: 'CLOSED', dailyDecision: approve ? 'APPROVED' : 'REJECTED', dailyDecidedAt: decidedAt,
      dailyDecidedBy: actorId, dailyDecisionReason: approve ? (reason || 'Diária aprovada pela loja') : reason!.trim(),
      autoApproveAt: null, reopenUntil: null,
    }).where(and(eq(driverShifts.id, shiftId), inArray(driverShifts.status, ['PENDING_DAILY', 'REOPEN_ALLOWED']))).returning()
    if (!closed) throw new ShiftError('Turno mudou — recarregue', 409)
    if (approve) await recordShiftDaily(tx, closed)
    return closed
  })
}

export async function offerShiftReactivation(db: Db, storeId: string, shiftId: string) {
  return db.transaction(async (tx) => {
    const [shift] = await tx.select().from(driverShifts).where(and(
      eq(driverShifts.id, shiftId), eq(driverShifts.storeId, storeId),
      eq(driverShifts.status, 'PENDING_DAILY'), eq(driverShifts.dailyDecision, 'PENDING'),
    )).for('update')
    if (!shift) throw new ShiftError('Turno aguardando diária não encontrado', 404)
    const [link] = await tx.select({ status: storeDrivers.status }).from(storeDrivers)
      .where(and(eq(storeDrivers.id, shift.storeDriverId), eq(storeDrivers.status, 'CONFIRMED'))).limit(1)
    if (!link) throw new ShiftError('O vínculo não está mais confirmado', 409)
    const now = new Date()
    if (!shift.scheduledEndAt || now >= shift.scheduledEndAt) throw new ShiftError('O horário programado do turno já terminou', 409)
    const reopenUntil = new Date(Math.min(now.getTime() + 30 * 60_000, shift.scheduledEndAt.getTime()))
    const [offered] = await tx.update(driverShifts).set({ status: 'REOPEN_ALLOWED', reopenUntil })
      .where(and(eq(driverShifts.id, shiftId), eq(driverShifts.status, 'PENDING_DAILY'))).returning()
    return offered!
  })
}

export async function reactivateShift(db: Db, driverUserId: string, shiftId: string) {
  try {
    const result = await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
      const [shift] = await tx.select().from(driverShifts).where(and(
        eq(driverShifts.id, shiftId), eq(driverShifts.driverUserId, driverUserId),
        eq(driverShifts.status, 'REOPEN_ALLOWED'), eq(driverShifts.dailyDecision, 'PENDING'),
      )).for('update')
      if (!shift) throw new ShiftError('Reativação não encontrada', 404)
      const now = new Date()
      if (!shift.reopenUntil || now > shift.reopenUntil) {
        await tx.update(driverShifts).set({ status: 'PENDING_DAILY', reopenUntil: null }).where(eq(driverShifts.id, shiftId))
        return null
      }
      const [active] = await tx.update(driverShifts).set({
        status: 'ACTIVE', endedAt: null, closedBy: null, earlyClose: false,
        dailyDecision: null, dailyDecidedAt: null, dailyDecidedBy: null, dailyDecisionReason: null,
        autoApproveAt: null, reopenUntil: null, reopenCount: shift.reopenCount + 1,
      }).where(and(eq(driverShifts.id, shiftId), eq(driverShifts.status, 'REOPEN_ALLOWED'))).returning()
      if (!active) throw new ShiftError('Turno mudou — recarregue', 409)
      return active
    })
    if (!result) throw new ShiftError('O prazo de 30 minutos para reativar terminou', 409)
    return result
  } catch (error) {
    if (uniqueConstraint(error) === 'driver_shifts_one_active_per_driver') throw new ShiftError('Você já tem outro turno ativo', 409)
    throw error
  }
}

export async function listDriverRecentShifts(db: Db, driverUserId: string) {
  return db.select().from(driverShifts).where(eq(driverShifts.driverUserId, driverUserId))
    .orderBy(desc(driverShifts.startedAt)).limit(30)
}

export async function autoApproveStaleShiftDailies(db: Db, now = new Date()) {
  const candidates = await db.select({ id: driverShifts.id }).from(driverShifts).where(and(
    inArray(driverShifts.status, ['PENDING_DAILY', 'REOPEN_ALLOWED']), eq(driverShifts.dailyDecision, 'PENDING'),
    lte(driverShifts.autoApproveAt, now),
  ))
  let approved = 0
  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      const [shift] = await tx.update(driverShifts).set({
        status: 'CLOSED', dailyDecision: 'APPROVED', dailyDecidedAt: now,
        dailyDecisionReason: 'Diária aprovada automaticamente após 24 horas', autoApproveAt: null, reopenUntil: null,
      }).where(and(eq(driverShifts.id, candidate.id), inArray(driverShifts.status, ['PENDING_DAILY', 'REOPEN_ALLOWED']),
        eq(driverShifts.dailyDecision, 'PENDING'), lte(driverShifts.autoApproveAt, now),
      )).returning()
      if (!shift) return
      await recordShiftDaily(tx, shift)
      approved += 1
    })
  }
  return approved
}

export async function listActiveStoreShifts(db: Db, storeId: string) {
  const rows = await db.select({ shift: driverShifts, driverName: users.name })
    .from(driverShifts)
    .innerJoin(users, eq(driverShifts.driverUserId, users.id))
    .where(and(eq(driverShifts.storeId, storeId), inArray(driverShifts.status, ['ACTIVE', 'PENDING_DAILY', 'REOPEN_ALLOWED'])))
    .orderBy(desc(driverShifts.startedAt))
  return Promise.all(rows.map(async (row) => ({ ...row.shift, driverName: row.driverName,
    pendingTerms: await pendingTermsForShift(db, row.shift.id),
  })))
}

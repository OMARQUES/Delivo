import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { haversineKm, SHIFT_START_RADIUS_KM } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { driverShifts, orders, storeDrivers, stores, users, type DriverSchedule } from '../db/schema'
import { recordPerDeliveryAdjustment, recordShiftDaily } from './finance.service'

export class ShiftError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 409) {
    super(message)
  }
}

function saoPauloParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday }
}

function scheduledEnd(schedule: DriverSchedule, now: Date) {
  const { date, weekday } = saoPauloParts(now)
  const item = schedule.find((entry) => entry.dow === weekday)
  if (!item) return null
  const end = new Date(`${date}T${item.end}:00-03:00`)
  if (item.end <= item.start) end.setUTCDate(end.getUTCDate() + 1)
  return Number.isNaN(end.getTime()) ? null : end
}

function isUniqueViolation(error: unknown) {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : null
  }
  return false
}

export async function startShift(db: Db, driverUserId: string, storeId: string, gps: { lat: number; lng: number }) {
  const [link] = await db.select().from(storeDrivers).where(and(
    eq(storeDrivers.storeId, storeId),
    eq(storeDrivers.driverUserId, driverUserId),
    eq(storeDrivers.status, 'CONFIRMED'),
  )).limit(1)
  if (!link) throw new ShiftError('Vínculo confirmado não encontrado', 404)
  const [store] = await db.select({ lat: stores.lat, lng: stores.lng }).from(stores).where(eq(stores.id, storeId)).limit(1)
  if (!store) throw new ShiftError('Loja não encontrada', 404)
  if (haversineKm(store, gps) > SHIFT_START_RADIUS_KM) throw new ShiftError('Você está fora do raio da loja', 409)

  const now = new Date()
  try {
    return await db.transaction(async (tx) => {
      // Mesmo lock usado pelos aceites GENERAL: impede iniciar turno e pegar o
      // pool simultaneamente.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
      const [generalAssignment] = await tx.select({ id: orders.id }).from(orders).where(and(
        eq(orders.driverId, driverUserId),
        isNull(orders.shiftId),
        inArray(orders.status, ['ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER', 'OUT_FOR_DELIVERY']),
      )).limit(1)
      if (generalAssignment) throw new ShiftError('Finalize as entregas do pool geral antes de iniciar o turno', 409)
      const [shift] = await tx.insert(driverShifts).values({
        storeId,
        driverUserId,
        dailyRateCents: link.dailyRateCents,
        perDeliveryCents: link.perDeliveryCents,
        workDate: saoPauloParts(now).date,
        scheduledEndAt: scheduledEnd(link.schedule, now),
        startedAt: now,
      }).returning()
      return shift!
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ShiftError('Já existe um turno ativo ou um turno nesta loja hoje', 409)
    throw error
  }
}

export async function getActiveShift(db: Db, driverUserId: string) {
  const [row] = await db.select({ shift: driverShifts, storeName: stores.name, storeAddressText: stores.addressText })
    .from(driverShifts)
    .innerJoin(stores, eq(driverShifts.storeId, stores.id))
    .where(and(eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.status, 'ACTIVE')))
    .limit(1)
  return row ? { ...row.shift, storeName: row.storeName, storeAddressText: row.storeAddressText } : null
}

async function closeShift(db: Db, shiftId: string, owner: { driverUserId?: string; storeId?: string }, closedBy: 'DRIVER' | 'STORE') {
  return db.transaction(async (tx) => {
    const filters = [eq(driverShifts.id, shiftId), eq(driverShifts.status, 'ACTIVE')]
    if (owner.driverUserId) filters.push(eq(driverShifts.driverUserId, owner.driverUserId))
    if (owner.storeId) filters.push(eq(driverShifts.storeId, owner.storeId))
    const [current] = await tx.select().from(driverShifts).where(and(...filters)).for('update')
    if (!current) throw new ShiftError('Turno ativo não encontrado', 404)
    const endedAt = new Date()
    const [closed] = await tx.update(driverShifts).set({
      status: 'CLOSED', endedAt, closedBy,
      earlyClose: current.scheduledEndAt ? endedAt < current.scheduledEndAt : false,
    }).where(and(eq(driverShifts.id, shiftId), eq(driverShifts.status, 'ACTIVE'))).returning()
    if (!closed) throw new ShiftError('Turno já encerrado', 409)
    await recordShiftDaily(tx, closed)
    return closed
  })
}

export function endShift(db: Db, driverUserId: string, shiftId: string) {
  return closeShift(db, shiftId, { driverUserId }, 'DRIVER')
}

export function releaseShift(db: Db, storeId: string, shiftId: string) {
  return closeShift(db, shiftId, { storeId }, 'STORE')
}

export async function updateActiveShift(
  db: Db,
  storeId: string,
  shiftId: string,
  input: { dailyRateCents?: number; perDeliveryCents?: number; applyRetroactive?: boolean },
) {
  return db.transaction(async (tx) => {
    const [shift] = await tx.select().from(driverShifts).where(and(
      eq(driverShifts.id, shiftId),
      eq(driverShifts.storeId, storeId),
      eq(driverShifts.status, 'ACTIVE'),
    )).for('update')
    if (!shift) throw new ShiftError('Turno ativo não encontrado', 404)

    const dailyRateCents = input.dailyRateCents ?? shift.dailyRateCents
    const perDeliveryCents = input.perDeliveryCents ?? shift.perDeliveryCents
    const hasChange = dailyRateCents !== shift.dailyRateCents || perDeliveryCents !== shift.perDeliveryCents
    if (!hasChange && !input.applyRetroactive) return shift

    const adjustmentSeq = shift.adjustmentSeq + 1
    const [updated] = await tx.update(driverShifts).set({
      dailyRateCents,
      perDeliveryCents,
      adjustmentSeq,
    }).where(and(eq(driverShifts.id, shiftId), eq(driverShifts.status, 'ACTIVE'))).returning()
    if (!updated) throw new ShiftError('Turno mudou — recarregue', 409)

    if (input.applyRetroactive) {
      // O lock do turno serializa este bloco com completeDelivery. Os locks dos
      // pedidos garantem que todo DELIVERED visto aqui já possui ledger base.
      const delivered = await tx.select({ id: orders.id }).from(orders).where(and(
        eq(orders.shiftId, shiftId),
        eq(orders.status, 'DELIVERED'),
      )).for('update')
      await recordPerDeliveryAdjustment(tx, {
        seq: adjustmentSeq,
        storeId,
        driverUserId: shift.driverUserId,
        orderIds: delivered.map((order) => order.id),
        targetPerDeliveryCents: perDeliveryCents,
      })
    }
    return updated
  })
}

export async function listActiveStoreShifts(db: Db, storeId: string) {
  const rows = await db.select({ shift: driverShifts, driverName: users.name })
    .from(driverShifts)
    .innerJoin(users, eq(driverShifts.driverUserId, users.id))
    .where(and(eq(driverShifts.storeId, storeId), eq(driverShifts.status, 'ACTIVE')))
    .orderBy(desc(driverShifts.startedAt))
  return rows.map((row) => ({ ...row.shift, driverName: row.driverName }))
}

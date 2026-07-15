import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import { canTransition, type DriverRequestTarget, type OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { driverShifts, drivers, orders, storeDrivers } from '../db/schema'
import { OrderError } from './order.service'
import { addEvent } from './order-events'
import { enqueueOrderPaymentDisposition } from './payment.service'
import { expirePendingAmendment, getPendingAmendment } from './amendment.service'
import { recordOrderLedger } from './finance.service'

export { addEvent } from './order-events'

/** Cliente cancela direto — só PENDING. */
export async function customerCancelOrder(db: Db, customerId: string, orderId: string) {
  return db.transaction(async (tx) => {
    const rows = await tx.update(orders)
      .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Cancelado pelo cliente' })
      .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId), eq(orders.status, 'PENDING')))
      .returning()
    if (rows.length === 0) throw new OrderError('Pedido não pode mais ser cancelado direto — solicite à loja', 409)
    await addEvent(tx, orderId, 'CANCELLED', 'CUSTOMER', customerId)
    await expirePendingAmendment(tx, orderId)
    await enqueueOrderPaymentDisposition(tx, orderId, 'CUSTOMER_CANCELLED', new Date())
    return rows[0]!
  })
}

const REQUESTABLE: OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER']

/** Pós-aceite: vira solicitação pra loja decidir. */
export async function customerRequestCancel(db: Db, customerId: string, orderId: string, note?: string) {
  const rows = await db
    .update(orders)
    .set({ cancelRequestedAt: new Date(), cancelRequestNote: note ?? null })
    .where(and(
      eq(orders.id, orderId),
      eq(orders.customerId, customerId),
      inArray(orders.status, REQUESTABLE),
      isNull(orders.cancelRequestedAt),
    ))
    .returning()
  if (rows.length === 0) throw new OrderError('Não é possível solicitar cancelamento deste pedido', 409)
  return rows[0]!
}

/** Cron: PENDING velho -> CANCELLED. Retorna quantos. */
export async function cancelStalePendingOrders(db: Db, olderThanMinutes = 30) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const candidates = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.status, 'PENDING'), lt(orders.createdAt, cutoff)))
  let count = 0
  for (const candidate of candidates) await db.transaction(async (tx) => {
    const [row] = await tx.update(orders).set({ status: 'CANCELLED', batchId: null, cancelReason: 'Loja não confirmou a tempo' })
      .where(and(eq(orders.id, candidate.id), eq(orders.status, 'PENDING'))).returning({ id: orders.id })
    if (!row) return
    await addEvent(tx, row.id, 'CANCELLED', 'SYSTEM', null, 'timeout 30min')
    await expirePendingAmendment(tx, row.id)
    await enqueueOrderPaymentDisposition(tx, row.id, 'STALE_PENDING', new Date())
    count++
  })
  return count
}

const STORE_ALLOWED: OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']
const REQUESTABLE_FOR_DRIVER: OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER']

async function setDriverRequestTarget(
  db: Db,
  storeId: string,
  orderId: string,
  target: DriverRequestTarget,
  requestedDriverId?: string,
) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, orderId), eq(orders.storeId, storeId),
    )).for('update')
    if (!order) throw new OrderError('Pedido não encontrado', 404)
    if (order.fulfillment !== 'DELIVERY') throw new OrderError('Pedido é retirada — sem entrega', 400)
    if (order.driverId) throw new OrderError('Pedido já tem entregador', 409)
    if (order.batchId) throw new OrderError('Pedido já está em um pacote', 409)
    if (!REQUESTABLE_FOR_DRIVER.includes(order.status)) {
      throw new OrderError(order.status === 'PENDING' ? 'Aceite o pedido antes de solicitar entregador' : 'Pedido não está em andamento', 409)
    }
    if (order.driverRequestTarget === 'GENERAL' && target !== 'GENERAL') {
      throw new OrderError('Pedido já foi enviado ao pool geral', 409)
    }
    if (target === 'GENERAL' && order.driverRequestTarget === 'GENERAL') return order
    if (target === 'SPECIFIC') {
      if (!requestedDriverId) throw new OrderError('Escolha o entregador', 400)
      const [active] = await tx.select({ id: driverShifts.id }).from(driverShifts)
        .innerJoin(storeDrivers, eq(storeDrivers.id, driverShifts.storeDriverId))
        .where(and(
        eq(driverShifts.storeId, storeId),
        eq(driverShifts.driverUserId, requestedDriverId),
        eq(driverShifts.status, 'ACTIVE'),
        eq(storeDrivers.status, 'CONFIRMED'),
      )).limit(1)
      if (!active) throw new OrderError('Entregador não está em turno nesta loja', 409)
    }
    const [updated] = await tx.update(orders).set({
      driverRequestedAt: new Date(),
      driverRequestTarget: target,
      requestedDriverId: target === 'SPECIFIC' ? requestedDriverId : null,
      driverRequestRefusedAt: null,
    }).where(and(eq(orders.id, orderId), isNull(orders.driverId))).returning()
    if (!updated) throw new OrderError('Pedido mudou — recarregue', 409)
    if (updated.status !== 'READY') return updated
    const [awaiting] = await tx.update(orders).set({ status: 'AWAITING_DRIVER' }).where(and(
      eq(orders.id, orderId), eq(orders.status, 'READY'), isNull(orders.driverId),
    )).returning()
    if (!awaiting) throw new OrderError('Pedido mudou — recarregue', 409)
    await addEvent(tx, orderId, 'AWAITING_DRIVER', 'SYSTEM', null, 'aguardando entregador')
    return awaiting
  })
}

export function requestDriver(db: Db, storeId: string, orderId: string) {
  return setDriverRequestTarget(db, storeId, orderId, 'GENERAL')
}

export function requestDriverOwn(db: Db, storeId: string, orderId: string) {
  return setDriverRequestTarget(db, storeId, orderId, 'OWN')
}

export function requestDriverSpecific(db: Db, storeId: string, orderId: string, driverUserId: string) {
  return setDriverRequestTarget(db, storeId, orderId, 'SPECIFIC', driverUserId)
}

/** Loja retira o chamado (qualquer alvo, inclusive pool geral) enquanto ninguém aceitou. AWAITING_DRIVER volta pra READY. */
export async function withdrawDriverRequest(db: Db, storeId: string, orderId: string, actorId: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, orderId), eq(orders.storeId, storeId),
    )).for('update')
    if (!order) throw new OrderError('Pedido não encontrado', 404)
    if (order.driverId) throw new OrderError('Um entregador já aceitou — peça pra ele liberar', 409)
    if (!order.driverRequestedAt) throw new OrderError('Pedido não tem chamado ativo', 409)
    const [updated] = await tx.update(orders).set({
      driverRequestedAt: null,
      driverRequestTarget: null,
      requestedDriverId: null,
      driverRequestRefusedAt: null,
      ...(order.status === 'AWAITING_DRIVER' ? { status: 'READY' as const } : {}),
    }).where(and(eq(orders.id, orderId), isNull(orders.driverId))).returning()
    if (!updated) throw new OrderError('Pedido mudou — recarregue', 409)
    if (order.status === 'AWAITING_DRIVER') await addEvent(tx, orderId, 'READY', 'STORE', actorId, 'chamado de entregador retirado')
    return updated
  })
}

export async function listAvailableDriverTokens(db: Db): Promise<string[]> {
  const rows = await db
    .select({ fcmToken: drivers.fcmToken })
    .from(drivers)
    .leftJoin(driverShifts, and(
      eq(driverShifts.driverUserId, drivers.userId),
      eq(driverShifts.status, 'ACTIVE'),
    ))
    .where(and(eq(drivers.isAvailable, true), isNotNull(drivers.fcmToken), isNull(driverShifts.id)))
  return rows.map((r) => r.fcmToken!).filter(Boolean)
}

export async function listShiftDriverTokens(db: Db, storeId: string, driverUserId?: string): Promise<string[]> {
  const filters = [
    eq(driverShifts.storeId, storeId),
    eq(driverShifts.status, 'ACTIVE'),
    isNotNull(drivers.fcmToken),
  ]
  if (driverUserId) filters.push(eq(driverShifts.driverUserId, driverUserId))
  const rows = await db.select({ fcmToken: drivers.fcmToken }).from(driverShifts)
    .innerJoin(drivers, eq(drivers.userId, driverShifts.driverUserId))
    .innerJoin(storeDrivers, eq(storeDrivers.id, driverShifts.storeDriverId))
    .where(and(...filters, eq(storeDrivers.status, 'CONFIRMED')))
  return rows.map((row) => row.fcmToken!).filter(Boolean)
}

export async function storeUpdateOrderStatus(
  db: Db,
  storeId: string,
  orderId: string,
  to: OrderStatus,
  actorId: string,
  reason?: string,
) {
  if (to === 'AWAITING_DRIVER') throw new OrderError('Use o botão Solicitar entregador', 400)
  if (!STORE_ALLOWED.includes(to)) throw new OrderError('Transição não permitida para a loja', 403)
  if (to === 'CANCELLED' && !reason) throw new OrderError('Cancelamento exige motivo', 400)

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.storeId, storeId))).for('update')
    if (!order) throw new OrderError('Pedido não encontrado', 404)
    if (to !== 'CANCELLED' && (await getPendingAmendment(tx, orderId))) throw new OrderError('Resolva a alteração pendente antes de avançar o pedido', 409)
    if (order.fulfillment === 'DELIVERY' && to === 'DELIVERED') throw new OrderError('Entrega ao cliente só pode ser finalizada pelo entregador', 409)
    if (order.fulfillment === 'DELIVERY' && order.driverId && to === 'OUT_FOR_DELIVERY') throw new OrderError('Pedido com entregador deve ser coletado pelo app do entregador', 409)
    if (!canTransition(order.status, to)) throw new OrderError(`Transição inválida: ${order.status} → ${to}`, 409)
    const rows = await tx.update(orders).set({ status: to, ...(to === 'CANCELLED' ? { batchId: null, cancelReason: reason, cancelRequestedAt: null, cancelRequestNote: null } : {}) })
      .where(and(eq(orders.id, orderId), eq(orders.status, order.status))).returning()
    if (rows.length === 0) throw new OrderError('Pedido mudou de status — recarregue', 409)
    await addEvent(tx, orderId, to, 'STORE', actorId, reason)
    if (to === 'CANCELLED') { await expirePendingAmendment(tx, orderId); await enqueueOrderPaymentDisposition(tx, orderId, 'STORE_CANCELLED', new Date()) }
    if (to === 'DELIVERED') await recordOrderLedger(tx, orderId)
    let final = rows[0]!
  if (to === 'READY' && final.driverRequestedAt && !final.driverId && !final.batchId) {
    const auto = await tx
      .update(orders)
      .set({ status: 'AWAITING_DRIVER' })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'READY'), isNull(orders.driverId)))
      .returning()
    if (auto.length > 0) {
      await addEvent(tx, orderId, 'AWAITING_DRIVER', 'SYSTEM', null, 'aguardando entregador')
      final = auto[0]!
    }
  }
    return final
  })
}

export async function storeResolveCancelRequest(
  db: Db,
  storeId: string,
  orderId: string,
  approve: boolean,
  actorId: string,
) {
  return db.transaction(async (tx) => {
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
    .limit(1)
  if (!order) throw new OrderError('Pedido não encontrado', 404)
  if (!order.cancelRequestedAt) throw new OrderError('Sem solicitação de cancelamento', 409)
  if (approve) {
    if (!canTransition(order.status, 'CANCELLED')) throw new OrderError('Pedido não é mais cancelável', 409)
    const rows = await tx
      .update(orders)
      .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Cancelamento aprovado pela loja', cancelRequestedAt: null })
      .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId), eq(orders.status, order.status)))
      .returning()
    if (rows.length === 0) throw new OrderError('Pedido mudou de status — recarregue', 409)
    await addEvent(tx, orderId, 'CANCELLED', 'STORE', actorId, 'solicitação do cliente aprovada')
    await expirePendingAmendment(tx, orderId)
    await enqueueOrderPaymentDisposition(tx, orderId, 'STORE_CANCEL_REQUEST_APPROVED', new Date())
    return rows[0]!
  }
  const rows = await tx
    .update(orders)
    .set({ cancelRequestedAt: null, cancelRequestNote: null })
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
    .returning()
  await addEvent(tx, orderId, order.status, 'STORE', actorId, 'solicitação de cancelamento negada')
  return rows[0]!
  })
}

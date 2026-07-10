import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import { canTransition, type OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { drivers, orders } from '../db/schema'
import type { PaymentProvider } from '../lib/payment-provider'
import { OrderError } from './order.service'
import { addEvent } from './order-events'
import { refundOrderPaymentIfAny } from './payment.service'
import { expirePendingAmendment, getPendingAmendment } from './amendment.service'
import { recordOrderLedger } from './finance.service'

export { addEvent } from './order-events'

/** Cliente cancela direto — só PENDING. */
export async function customerCancelOrder(db: Db, customerId: string, orderId: string, provider?: PaymentProvider | null) {
  const rows = await db
    .update(orders)
    .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Cancelado pelo cliente' })
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId), eq(orders.status, 'PENDING')))
    .returning()
  if (rows.length === 0) throw new OrderError('Pedido não pode mais ser cancelado direto — solicite à loja', 409)
  await addEvent(db, orderId, 'CANCELLED', 'CUSTOMER', customerId)
  await expirePendingAmendment(db, orderId)
  await refundOrderPaymentIfAny(db, provider ?? null, orderId)
  return rows[0]!
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
export async function cancelStalePendingOrders(db: Db, olderThanMinutes = 30, provider?: PaymentProvider | null) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const rows = await db
    .update(orders)
    .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Loja não confirmou a tempo' })
    .where(and(eq(orders.status, 'PENDING'), lt(orders.createdAt, cutoff)))
    .returning({ id: orders.id })
  for (const r of rows) {
    await addEvent(db, r.id, 'CANCELLED', 'SYSTEM', null, 'timeout 30min')
    await expirePendingAmendment(db, r.id)
    await refundOrderPaymentIfAny(db, provider ?? null, r.id)
  }
  return rows.length
}

const STORE_ALLOWED: OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']
const REQUESTABLE_FOR_DRIVER: OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER']

export async function requestDriver(db: Db, storeId: string, orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
  if (!order) throw new OrderError('Pedido não encontrado', 404)
  if (order.fulfillment !== 'DELIVERY') throw new OrderError('Pedido é retirada — sem entrega', 400)
  if (order.driverId) throw new OrderError('Pedido já tem entregador', 409)
  if (order.batchId) throw new OrderError('Pedido já está em um pacote', 409)
  if (order.status === 'PENDING') throw new OrderError('Aceite o pedido antes de solicitar entregador', 409)
  if (!REQUESTABLE_FOR_DRIVER.includes(order.status)) throw new OrderError('Pedido não está em andamento', 409)
  // OWN → GENERAL permitido: escalada EXPLÍCITA da loja pro pool geral (decisão: sem fallback automático)
  if (order.driverRequestedAt && order.driverRequestTarget !== 'OWN') return order

  const [updated] = await db
    .update(orders)
    .set({ driverRequestedAt: new Date(), driverRequestTarget: 'GENERAL' })
    .where(and(eq(orders.id, orderId), isNull(orders.driverId)))
    .returning()
  if (!updated) throw new OrderError('Pedido mudou — recarregue', 409)

  if (updated.status === 'READY') {
    const rows = await db
      .update(orders)
      .set({ status: 'AWAITING_DRIVER' })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'READY'), isNull(orders.driverId)))
      .returning()
    if (rows.length > 0) {
      await addEvent(db, orderId, 'AWAITING_DRIVER', 'SYSTEM', null, 'aguardando entregador')
      return rows[0]!
    }
  }
  return updated
}

export async function requestDriverOwn(db: Db, storeId: string, orderId: string) {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId))).limit(1)
  if (!order) throw new OrderError('Pedido não encontrado', 404)
  if (order.fulfillment !== 'DELIVERY') throw new OrderError('Pedido é retirada — sem entrega', 400)
  if (order.driverId) throw new OrderError('Pedido já tem entregador', 409)
  if (order.batchId) throw new OrderError('Pedido já está em um pacote', 409)
  if (!REQUESTABLE_FOR_DRIVER.includes(order.status)) {
    throw new OrderError(order.status === 'PENDING' ? 'Aceite o pedido antes de solicitar entregador' : 'Pedido não está em andamento', 409)
  }
  if (order.driverRequestedAt && order.driverRequestTarget !== 'OWN') {
    throw new OrderError('Pedido já foi enviado ao pool geral', 409)
  }
  const now = new Date()
  const [updated] = await db.update(orders)
    .set({ driverRequestedAt: now, driverRequestTarget: 'OWN' })
    .where(and(eq(orders.id, orderId), isNull(orders.driverId)))
    .returning()
  if (!updated) throw new OrderError('Pedido mudou — recarregue', 409)
  if (updated.status === 'READY') {
    const [awaiting] = await db.update(orders).set({ status: 'AWAITING_DRIVER' })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'READY'), isNull(orders.driverId)))
      .returning()
    if (awaiting) {
      await addEvent(db, orderId, 'AWAITING_DRIVER', 'SYSTEM', null, 'aguardando entregador próprio')
      return awaiting
    }
  }
  return updated
}

export async function listAvailableDriverTokens(db: Db): Promise<string[]> {
  const rows = await db
    .select({ fcmToken: drivers.fcmToken })
    .from(drivers)
    .where(and(eq(drivers.isAvailable, true), isNotNull(drivers.fcmToken)))
  return rows.map((r) => r.fcmToken!).filter(Boolean)
}

export async function storeUpdateOrderStatus(
  db: Db,
  storeId: string,
  orderId: string,
  to: OrderStatus,
  actorId: string,
  reason?: string,
  provider?: PaymentProvider | null,
) {
  if (to === 'AWAITING_DRIVER') throw new OrderError('Use o botão Solicitar entregador', 400)
  if (!STORE_ALLOWED.includes(to)) throw new OrderError('Transição não permitida para a loja', 403)
  if (to === 'CANCELLED' && !reason) throw new OrderError('Cancelamento exige motivo', 400)

  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
    .limit(1)
  if (!order) throw new OrderError('Pedido não encontrado', 404)
  if (to !== 'CANCELLED' && (await getPendingAmendment(db, orderId)))
    throw new OrderError('Resolva a alteração pendente antes de avançar o pedido', 409)
  if (order.fulfillment === 'DELIVERY' && to === 'DELIVERED')
    throw new OrderError('Entrega ao cliente só pode ser finalizada pelo entregador', 409)
  if (order.fulfillment === 'DELIVERY' && order.driverId && to === 'OUT_FOR_DELIVERY')
    throw new OrderError('Pedido com entregador deve ser coletado pelo app do entregador', 409)
  if (!canTransition(order.status, to)) throw new OrderError(`Transição inválida: ${order.status} → ${to}`, 409)

  const rows = await db
    .update(orders)
    .set({ status: to, ...(to === 'CANCELLED' ? { batchId: null, cancelReason: reason, cancelRequestedAt: null, cancelRequestNote: null } : {}) })
    .where(and(eq(orders.id, orderId), eq(orders.status, order.status)))
    .returning()
  if (rows.length === 0) throw new OrderError('Pedido mudou de status — recarregue', 409)
  await addEvent(db, orderId, to, 'STORE', actorId, reason)
  if (to === 'CANCELLED') {
    await expirePendingAmendment(db, orderId)
    await refundOrderPaymentIfAny(db, provider ?? null, orderId)
  }
  if (to === 'DELIVERED') await recordOrderLedger(db, orderId)
  let final = rows[0]!
  if (to === 'READY' && final.driverRequestedAt && !final.driverId && !final.batchId) {
    const auto = await db
      .update(orders)
      .set({ status: 'AWAITING_DRIVER' })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'READY'), isNull(orders.driverId)))
      .returning()
    if (auto.length > 0) {
      await addEvent(db, orderId, 'AWAITING_DRIVER', 'SYSTEM', null, 'aguardando entregador')
      final = auto[0]!
    }
  }
  return final
}

export async function storeResolveCancelRequest(
  db: Db,
  storeId: string,
  orderId: string,
  approve: boolean,
  actorId: string,
  provider?: PaymentProvider | null,
) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
    .limit(1)
  if (!order) throw new OrderError('Pedido não encontrado', 404)
  if (!order.cancelRequestedAt) throw new OrderError('Sem solicitação de cancelamento', 409)
  if (approve) {
    if (!canTransition(order.status, 'CANCELLED')) throw new OrderError('Pedido não é mais cancelável', 409)
    const rows = await db
      .update(orders)
      .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Cancelamento aprovado pela loja', cancelRequestedAt: null })
      .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId), eq(orders.status, order.status)))
      .returning()
    if (rows.length === 0) throw new OrderError('Pedido mudou de status — recarregue', 409)
    await addEvent(db, orderId, 'CANCELLED', 'STORE', actorId, 'solicitação do cliente aprovada')
    await expirePendingAmendment(db, orderId)
    await refundOrderPaymentIfAny(db, provider ?? null, orderId)
    return rows[0]!
  }
  const rows = await db
    .update(orders)
    .set({ cancelRequestedAt: null, cancelRequestNote: null })
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
    .returning()
  await addEvent(db, orderId, order.status, 'STORE', actorId, 'solicitação de cancelamento negada')
  return rows[0]!
}

import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { canTransition, type OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { orderEvents, orders } from '../db/schema'
import { OrderError } from './order.service'

export async function addEvent(
  db: Db,
  orderId: string,
  status: OrderStatus,
  actorRole: string,
  actorId: string | null,
  note?: string,
) {
  await db.insert(orderEvents).values({ orderId, status, actorRole, actorId, note: note ?? null })
}

/** Cliente cancela direto — só PENDING. */
export async function customerCancelOrder(db: Db, customerId: string, orderId: string) {
  const rows = await db
    .update(orders)
    .set({ status: 'CANCELLED', cancelReason: 'Cancelado pelo cliente' })
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId), eq(orders.status, 'PENDING')))
    .returning()
  if (rows.length === 0) throw new OrderError('Pedido não pode mais ser cancelado direto — solicite à loja', 409)
  await addEvent(db, orderId, 'CANCELLED', 'CUSTOMER', customerId)
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
export async function cancelStalePendingOrders(db: Db, olderThanMinutes = 30) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const rows = await db
    .update(orders)
    .set({ status: 'CANCELLED', cancelReason: 'Loja não confirmou a tempo' })
    .where(and(eq(orders.status, 'PENDING'), lt(orders.createdAt, cutoff)))
    .returning({ id: orders.id })
  for (const r of rows) await addEvent(db, r.id, 'CANCELLED', 'SYSTEM', null, 'timeout 30min')
  return rows.length
}

const STORE_ALLOWED: OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']

export async function storeUpdateOrderStatus(
  db: Db,
  storeId: string,
  orderId: string,
  to: OrderStatus,
  actorId: string,
  reason?: string,
) {
  if (to === 'AWAITING_DRIVER') throw new OrderError('Dispatch de entregador chega no Plano 6', 400)
  if (!STORE_ALLOWED.includes(to)) throw new OrderError('Transição não permitida para a loja', 403)
  if (to === 'CANCELLED' && !reason) throw new OrderError('Cancelamento exige motivo', 400)

  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
    .limit(1)
  if (!order) throw new OrderError('Pedido não encontrado', 404)
  if (!canTransition(order.status, to)) throw new OrderError(`Transição inválida: ${order.status} → ${to}`, 409)

  const rows = await db
    .update(orders)
    .set({ status: to, ...(to === 'CANCELLED' ? { cancelReason: reason } : {}) })
    .where(and(eq(orders.id, orderId), eq(orders.status, order.status)))
    .returning()
  if (rows.length === 0) throw new OrderError('Pedido mudou de status — recarregue', 409)
  await addEvent(db, orderId, to, 'STORE', actorId, reason)
  return rows[0]!
}

export async function storeResolveCancelRequest(
  db: Db,
  storeId: string,
  orderId: string,
  approve: boolean,
  actorId: string,
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
      .set({ status: 'CANCELLED', cancelReason: 'Cancelamento aprovado pela loja', cancelRequestedAt: null })
      .where(and(eq(orders.id, orderId), eq(orders.status, order.status)))
      .returning()
    if (rows.length === 0) throw new OrderError('Pedido mudou de status — recarregue', 409)
    await addEvent(db, orderId, 'CANCELLED', 'STORE', actorId, 'solicitação do cliente aprovada')
    return rows[0]!
  }
  const rows = await db
    .update(orders)
    .set({ cancelRequestedAt: null, cancelRequestNote: null })
    .where(eq(orders.id, orderId))
    .returning()
  await addEvent(db, orderId, order.status, 'STORE', actorId, 'solicitação de cancelamento negada')
  return rows[0]!
}

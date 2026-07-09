import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import type { OrderStatus } from '@delivery/shared/constants'
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

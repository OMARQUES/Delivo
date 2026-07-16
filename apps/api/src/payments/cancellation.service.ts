import { and, eq, lte } from 'drizzle-orm'
import type { Db, DbTransaction } from '../db/client'
import { orderEvents, orders, payments } from '../db/schema'
import { OrderError } from '../services/order.service'
import { expirePendingAmendment } from '../services/amendment.service'
import { ensureCancelledOrderPaymentDisposition } from '../services/payment.service'

export type CancellationResult = {
  order: typeof orders.$inferSelect
  operationId: string | null
  changed: boolean
}

type Actor =
  | { role: 'CUSTOMER'; id: string; reason: 'Cancelado pelo cliente'; note: 'cancelamento de pagamento solicitado pelo cliente' }
  | { role: 'SYSTEM'; id: null; reason: 'Pagamento não confirmado em 30 minutos'; note: 'pagamento expirado após 30 minutos' }

async function cancelLocked(
  tx: DbTransaction,
  payment: typeof payments.$inferSelect,
  actor: Actor,
  now: Date,
): Promise<CancellationResult | null> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).for('update')
  if (!order) throw new OrderError('Pedido não encontrado', 404)
  if (order.status === 'CANCELLED') {
    const disposition = await ensureCancelledOrderPaymentDisposition(tx, payment, now)
    return { order, operationId: disposition.operationId, changed: false }
  }
  if (order.status !== 'AWAITING_PAYMENT') return null

  const [cancelled] = await tx.update(orders).set({
    status: 'CANCELLED',
    batchId: null,
    cancelReason: actor.reason,
    cancelRequestedAt: null,
    cancelRequestNote: null,
    updatedAt: now,
  }).where(and(eq(orders.id, order.id), eq(orders.status, 'AWAITING_PAYMENT'))).returning()
  if (!cancelled) return null
  await tx.insert(orderEvents).values({
    orderId: order.id,
    status: 'CANCELLED',
    actorRole: actor.role,
    actorId: actor.id,
    note: actor.note,
  })
  await expirePendingAmendment(tx, order.id)
  const disposition = await ensureCancelledOrderPaymentDisposition(tx, payment, now)
  return { order: cancelled, operationId: disposition.operationId, changed: true }
}

export async function cancelCustomerOrder(
  db: Db,
  customerId: string,
  orderId: string,
  now: Date,
): Promise<CancellationResult> {
  const [candidate] = await db.select({ paymentId: payments.id }).from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
    .limit(1)
  if (!candidate) throw new OrderError('Pedido não encontrado', 404)

  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, candidate.paymentId)).for('update')
    if (!payment) throw new OrderError('Pedido não encontrado', 404)
    const awaiting = await cancelLocked(tx, payment, {
      role: 'CUSTOMER',
      id: customerId,
      reason: 'Cancelado pelo cliente',
      note: 'cancelamento de pagamento solicitado pelo cliente',
    }, now)
    if (awaiting) return awaiting

    const [order] = await tx.select().from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId))).for('update')
    if (!order) throw new OrderError('Pedido não encontrado', 404)
    if (order.status !== 'PENDING') throw new OrderError('Pedido não pode mais ser cancelado direto — solicite à loja', 409)
    const [cancelled] = await tx.update(orders).set({
      status: 'CANCELLED',
      batchId: null,
      cancelReason: 'Cancelado pelo cliente',
      updatedAt: now,
    }).where(and(eq(orders.id, order.id), eq(orders.status, 'PENDING'))).returning()
    if (!cancelled) throw new OrderError('Pedido mudou de status — recarregue', 409)
    await tx.insert(orderEvents).values({ orderId, status: 'CANCELLED', actorRole: 'CUSTOMER', actorId: customerId })
    await expirePendingAmendment(tx, orderId)
    const disposition = await ensureCancelledOrderPaymentDisposition(tx, payment, now)
    return { order: cancelled, operationId: disposition.operationId, changed: true }
  })
}

export async function expireAwaitingPayment(
  db: Db,
  paymentId: string,
  now: Date,
): Promise<CancellationResult | null> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(and(
      eq(payments.id, paymentId),
      eq(payments.status, 'PENDING'),
      lte(payments.expiresAt, now),
    )).for('update')
    if (!payment) return null
    return cancelLocked(tx, payment, {
      role: 'SYSTEM',
      id: null,
      reason: 'Pagamento não confirmado em 30 minutos',
      note: 'pagamento expirado após 30 minutos',
    }, now)
  })
}

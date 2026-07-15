import { and, eq, lt, sql } from 'drizzle-orm'
import { PIX_EXPIRATION_MINUTES } from '@delivery/shared/constants'
import type { Db, DbTransaction } from '../db/client'
import { orders, payments } from '../db/schema'
import { enqueuePaymentOperation } from '../payments/operation-queue.service'

export class PaymentError extends Error {
  constructor(
    message: string,
    public status: 400 | 402 | 409 | 503 = 400,
  ) {
    super(message)
  }
}

export type OrderPaymentTransition =
  | 'CUSTOMER_CANCELLED' | 'STORE_CANCELLED' | 'STORE_CANCEL_REQUEST_APPROVED'
  | 'STALE_PENDING' | 'DELIVERY_FAILED' | 'AMENDMENT_REJECTED' | 'PIX_EXPIRED'

export async function enqueueOrderPaymentDisposition(
  tx: Db | DbTransaction,
  orderId: string,
  transition: OrderPaymentTransition,
  now: Date,
): Promise<{ operationId: string | null; type: 'CANCEL' | 'REFUND_FULL' | null }> {
  const payment = await getOrderPayment(tx, orderId, true)
  if (!payment || payment.status === 'REFUNDED') {
    return { operationId: null, type: null }
  }
  const type = payment.status === 'APPROVED' ? 'REFUND_FULL' : payment.status === 'PENDING' ? 'CANCEL' : null
  if (!type) return { operationId: null, type: null }
  const key = `${type === 'REFUND_FULL' ? 'refund-full' : 'cancel'}:${payment.id}:${transition}`
  const result = await enqueuePaymentOperation(tx, {
    paymentId: payment.id, type, amountCents: null, businessKey: key, idempotencyKey: key,
  }, now)
  return { operationId: result.id, type }
}

export async function getOrderPayment(db: Db | DbTransaction, orderId: string, lock = false) {
  let query = db.select().from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(sql`${payments.createdAt} desc`)
    .limit(1)
  if (lock) query = query.for('update') as typeof query
  const [row] = await query
  return row ?? null
}

/** Cron: AWAITING_PAYMENT velhos -> CANCELLED + payment EXPIRED. */
export async function expireStaleAwaitingPayment(
  db: Db,
  olderThanMinutes = PIX_EXPIRATION_MINUTES,
) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const candidates = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.status, 'AWAITING_PAYMENT'), lt(orders.createdAt, cutoff)))
  const stale: { id: string }[] = []
  const { addEvent } = await import('./order-events')
  const { expirePendingAmendment } = await import('./amendment.service')
  for (const candidate of candidates) await db.transaction(async (tx) => {
    const [order] = await tx.update(orders).set({ status: 'CANCELLED', batchId: null, cancelReason: 'Pagamento não realizado a tempo' })
      .where(and(eq(orders.id, candidate.id), eq(orders.status, 'AWAITING_PAYMENT'))).returning({ id: orders.id })
    if (!order) return
    await addEvent(tx, order.id, 'CANCELLED', 'SYSTEM', null, 'pagamento expirado')
    await expirePendingAmendment(tx, order.id)
    await enqueueOrderPaymentDisposition(tx, order.id, 'PIX_EXPIRED', new Date())
    stale.push(order)
  })
  return stale.length
}

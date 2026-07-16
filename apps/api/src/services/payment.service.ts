import { eq, sql } from 'drizzle-orm'
import type { Db, DbTransaction } from '../db/client'
import { payments } from '../db/schema'
import { enqueuePaymentOperation } from '../payments/operation-queue.service'
import { providerIdempotencyKey } from '../payments/provider'

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

const TRANSITION_CODE: Record<OrderPaymentTransition, string> = {
  CUSTOMER_CANCELLED: 'cc',
  STORE_CANCELLED: 'sc',
  STORE_CANCEL_REQUEST_APPROVED: 'sca',
  STALE_PENDING: 'sp',
  DELIVERY_FAILED: 'df',
  AMENDMENT_REJECTED: 'ar',
  PIX_EXPIRED: 'px',
}

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
  const idempotencyKey = providerIdempotencyKey(type === 'REFUND_FULL' ? 'rf' : 'c', `${TRANSITION_CODE[transition]}:${payment.id}`)
  const result = await enqueuePaymentOperation(tx, {
    paymentId: payment.id, type, amountCents: null, businessKey: key, idempotencyKey,
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

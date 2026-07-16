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

export type PaymentDispositionResult = {
  operationId: string | null
  type: 'CANCEL' | 'REFUND_FULL' | null
  inserted: boolean
}

export async function ensureCancelledOrderPaymentDisposition(
  tx: Db | DbTransaction,
  payment: typeof payments.$inferSelect,
  now: Date,
): Promise<PaymentDispositionResult> {
  if (!payment.providerOrderId) return { operationId: null, type: null, inserted: false }
  const type = payment.status === 'PENDING'
    ? 'CANCEL' as const
    : payment.status === 'APPROVED'
      ? 'REFUND_FULL' as const
      : null
  if (!type) return { operationId: null, type: null, inserted: false }
  const prefix = type === 'CANCEL' ? 'cancel' : 'refund-full'
  const operation = await enqueuePaymentOperation(tx, {
    paymentId: payment.id,
    type,
    amountCents: null,
    businessKey: `${prefix}:${payment.id}:ORDER_CANCELLED`,
    idempotencyKey: providerIdempotencyKey(type === 'CANCEL' ? 'c:oc' : 'rf:oc', payment.id),
  }, now)
  return { operationId: operation.id, type, inserted: operation.inserted }
}

export async function enqueueOrderPaymentDisposition(
  tx: Db | DbTransaction,
  orderId: string,
  now: Date,
): Promise<PaymentDispositionResult> {
  const payment = await getOrderPayment(tx, orderId, true)
  return payment
    ? ensureCancelledOrderPaymentDisposition(tx, payment, now)
    : { operationId: null, type: null, inserted: false }
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

import { and, eq, lt, sql } from 'drizzle-orm'
import { PIX_EXPIRATION_MINUTES } from '@delivery/shared/constants'
import type { OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { orders, payments } from '../db/schema'
import type { PaymentProvider } from '../payments/provider'
import { addEvent } from './order-events'
import { enqueuePaymentOperation } from '../payments/operation-queue.service'

export class PaymentError extends Error {
  constructor(
    message: string,
    public status: 400 | 402 | 409 | 503 = 400,
  ) {
    super(message)
  }
}

export type PaymentDispositionReason =
  | { kind: 'ORDER_CANCELLED'; businessKey: string }
  | { kind: 'PIX_EXPIRED'; businessKey: string }
  | { kind: 'AMENDMENT_REFUND'; businessKey: string; amendmentId: string; amountCents: number }

export async function enqueueOrderPaymentDisposition(db: Db, orderId: string, reason: PaymentDispositionReason, now: Date): Promise<boolean> {
  const payment = await getOrderPayment(db, orderId)
  if (!payment) return false
  const approved = payment.status === 'APPROVED'
  const partial = reason.kind === 'AMENDMENT_REFUND'
  if (partial) {
    if (!approved || reason.amountCents <= 0) return false
    await enqueuePaymentOperation(db, { paymentId: payment.id, type: 'REFUND_PARTIAL', amountCents: reason.amountCents, businessKey: reason.businessKey, idempotencyKey: reason.businessKey }, now)
    return true
  }
  await enqueuePaymentOperation(db, {
    paymentId: payment.id,
    type: approved ? 'REFUND_FULL' : 'CANCEL',
    amountCents: null,
    businessKey: reason.businessKey,
    idempotencyKey: reason.businessKey,
  }, now)
  return approved
}

export async function getOrderPayment(db: Db, orderId: string) {
  const [row] = await db.select().from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(sql`${payments.createdAt} desc`)
    .limit(1)
  return row ?? null
}

/**
 * Cancelamento de pedido: estorna se pago; cancela no gateway se pendente.
 * Retorna true se estornou (pagamento aprovado existia).
 */
export async function refundOrderPaymentIfAny(
  db: Db,
  provider: PaymentProvider | null,
  orderId: string,
  event: { status?: OrderStatus; note?: string } = {},
): Promise<boolean> {
  return enqueueOrderPaymentDisposition(db, orderId, {
    kind: 'ORDER_CANCELLED',
    businessKey: `order-cancel:${orderId}:${event.status ?? 'CANCELLED'}`,
  }, new Date())
}

/** Cron: AWAITING_PAYMENT velhos -> CANCELLED + payment EXPIRED. */
export async function expireStaleAwaitingPayment(
  db: Db,
  provider: PaymentProvider | null,
  olderThanMinutes = PIX_EXPIRATION_MINUTES,
) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const stale = await db.update(orders)
    .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Pagamento não realizado a tempo' })
    .where(and(eq(orders.status, 'AWAITING_PAYMENT'), lt(orders.createdAt, cutoff)))
    .returning({ id: orders.id })
  for (const o of stale) {
    await addEvent(db, o.id, 'CANCELLED', 'SYSTEM', null, 'pagamento expirado')
    const { expirePendingAmendment } = await import('./amendment.service')
    await expirePendingAmendment(db, o.id)
    const payment = await getOrderPayment(db, o.id)
    if (payment && payment.status === 'PENDING') {
      await enqueuePaymentOperation(db, {
        paymentId: payment.id, type: 'CANCEL', amountCents: null,
        businessKey: `cancel:${payment.id}:PIX_EXPIRED`,
        idempotencyKey: `cancel:${payment.id}:PIX_EXPIRED`,
      }, new Date())
    }
  }
  return stale.length
}

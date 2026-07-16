import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { orderEvents, orders, paymentOperations, payments } from '../db/schema'
import { PaymentProviderError, providerIdempotencyKey, type PaymentProvider } from './provider'
import { applyProviderSnapshotInTransaction } from './transition.service'
import { retryDisposition } from './retry'
import { enqueuePaymentOperation } from './operation-queue.service'
import type { PaymentOperationResultCode } from './operation-queue.service'

async function markReview(db: Db, operationId: string, failureClass: string, now: Date, observedProviderStatus?: string | null) {
  await db.update(paymentOperations).set({ status: 'REVIEW_REQUIRED', failureClass, observedProviderStatus: observedProviderStatus ?? null, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operationId))
}

function retryable(error: unknown): error is PaymentProviderError {
  return error instanceof PaymentProviderError && ['TRANSIENT_UNCERTAIN', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE'].includes(error.kind)
}

type OperationOutcome =
  | { kind: 'SUCCEEDED'; resultCode: PaymentOperationResultCode }
  | { kind: 'ESCALATE_TO_REFUND' }
  | { kind: 'RETRY'; failureClass: string }
  | { kind: 'REVIEW_REQUIRED'; failureClass: string }

function evaluateOperation(operation: typeof paymentOperations.$inferSelect, decision: string, refundedAmountCents: number, expectedAmountCents: number): OperationOutcome {
  if (operation.type === 'CANCEL') {
    if (decision === 'CANCELLED' || decision === 'EXPIRED') return { kind: 'SUCCEEDED', resultCode: 'CANCELLED' }
    if (decision === 'REFUNDED' && refundedAmountCents === expectedAmountCents) return { kind: 'SUCCEEDED', resultCode: 'REFUNDED' }
    if (decision === 'APPROVED' || decision === 'PARTIALLY_REFUNDED') return { kind: 'ESCALATE_TO_REFUND' }
    if (decision === 'PENDING') return { kind: 'RETRY', failureClass: 'CANCEL_PENDING' }
    return { kind: 'REVIEW_REQUIRED', failureClass: 'CANCEL_OUTCOME_INVALID' }
  }
  if (operation.type === 'REFUND_FULL') {
    return decision === 'REFUNDED' && refundedAmountCents === operation.expectedRefundedAmountCents
      ? { kind: 'SUCCEEDED', resultCode: 'REFUNDED' }
      : decision === 'PENDING' || decision === 'APPROVED' || decision === 'PARTIALLY_REFUNDED'
        ? { kind: 'RETRY', failureClass: 'REFUND_NOT_COMPLETE' }
        : { kind: 'REVIEW_REQUIRED', failureClass: 'REFUND_FULL_OUTCOME_INVALID' }
  }
  if ((decision === 'PARTIALLY_REFUNDED' || decision === 'REFUNDED') && refundedAmountCents === operation.expectedRefundedAmountCents) return { kind: 'SUCCEEDED', resultCode: 'PARTIALLY_REFUNDED' }
  if ((decision === 'PARTIALLY_REFUNDED' || decision === 'REFUNDED') && refundedAmountCents < (operation.expectedRefundedAmountCents ?? 0)) return { kind: 'RETRY', failureClass: 'REFUND_NOT_COMPLETE' }
  if ((decision === 'PARTIALLY_REFUNDED' || decision === 'REFUNDED') && refundedAmountCents > (operation.expectedRefundedAmountCents ?? 0)) return { kind: 'REVIEW_REQUIRED', failureClass: 'MISMATCH_REFUNDED_TARGET' }
  return { kind: 'REVIEW_REQUIRED', failureClass: 'REFUND_PARTIAL_OUTCOME_INVALID' }
}

async function settleSnapshot(
  db: Db,
  operation: typeof paymentOperations.$inferSelect,
  snapshot: Awaited<ReturnType<PaymentProvider['getOrder']>>,
  now: Date,
): Promise<OperationOutcome> {
  return db.transaction(async (tx) => {
    const result = await applyProviderSnapshotInTransaction(tx, operation.paymentId, snapshot, now, {
      enqueueLateRefund: operation.type !== 'CANCEL',
      releaseOrderOnApproval: operation.type !== 'CANCEL',
    })
    const [payment] = await tx.select().from(payments).where(eq(payments.id, operation.paymentId)).for('update')
    if (!payment) throw new Error('payment not found')
    const outcome = result.decision === 'REVIEW_REQUIRED'
      ? { kind: 'REVIEW_REQUIRED' as const, failureClass: 'SNAPSHOT_REVIEW_REQUIRED' }
      : evaluateOperation(operation, result.decision, snapshot.refundedAmountCents, payment.expectedAmountCents)
    if (outcome.kind === 'REVIEW_REQUIRED') {
      await tx.update(paymentOperations).set({ status: 'REVIEW_REQUIRED', failureClass: outcome.failureClass, observedProviderStatus: snapshot.orderStatus, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operation.id))
    } else if (outcome.kind === 'RETRY') {
      const disposition = retryDisposition(now, operation.attemptCount, 0.1)
      if (disposition.kind === 'REVIEW_REQUIRED') {
        await tx.update(paymentOperations).set({ status: 'REVIEW_REQUIRED', failureClass: 'RETRY_EXHAUSTED', observedProviderStatus: snapshot.orderStatus, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operation.id))
        return { kind: 'REVIEW_REQUIRED', failureClass: 'RETRY_EXHAUSTED' }
      }
      await tx.update(paymentOperations).set({ status: 'PENDING', nextAttemptAt: disposition.nextAttemptAt, failureClass: outcome.failureClass, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operation.id))
    } else {
      if (outcome.kind === 'ESCALATE_TO_REFUND') {
        const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).for('update')
        if (!order) throw new Error('order not found')
        if (order.status === 'AWAITING_PAYMENT') {
          await tx.update(orders).set({ status: 'CANCELLED', updatedAt: now }).where(and(eq(orders.id, order.id), eq(orders.status, 'AWAITING_PAYMENT')))
          await tx.insert(orderEvents).values({ orderId: order.id, status: 'CANCELLED', actorRole: 'SYSTEM', actorId: null, note: 'pagamento aprovado após cancelamento; estorno pendente' })
        }
        await enqueuePaymentOperation(tx, {
          paymentId: payment.id,
          type: 'REFUND_FULL',
          amountCents: null,
          businessKey: `refund-full:${operation.paymentId}:ESCALATED_CANCEL:${operation.id}`,
          idempotencyKey: providerIdempotencyKey('rf:ec', operation.id),
        }, now)
      }
      await tx.update(paymentOperations).set({ status: 'SUCCEEDED', resultCode: outcome.kind === 'ESCALATE_TO_REFUND' ? 'ESCALATED_TO_REFUND' : outcome.resultCode, completedAt: now, observedProviderStatus: snapshot.orderStatus, leaseOwner: null, leasedUntil: null, failureClass: null, updatedAt: now }).where(eq(paymentOperations.id, operation.id))
    }
    return outcome
  })
}

export async function processPaymentOperation(db: Db, provider: PaymentProvider, operationId: string, leaseOwner: string, now: Date): Promise<void> {
  const [operation] = await db.select().from(paymentOperations).where(and(eq(paymentOperations.id, operationId), eq(paymentOperations.status, 'PROCESSING'), eq(paymentOperations.leaseOwner, leaseOwner))).limit(1)
  if (!operation) return
  const [payment] = await db.select().from(payments).where(eq(payments.id, operation.paymentId)).limit(1)
  if (!payment || !payment.providerOrderId) return markReview(db, operationId, 'PAYMENT_NOT_ACTIONABLE', now)
  if (operation.type === 'REFUND_PARTIAL' && (!operation.amountCents || operation.amountCents > payment.expectedAmountCents - payment.refundedAmountCents)) return markReview(db, operationId, 'REFUND_AMOUNT_INVALID', now)

  try {
    let snapshot
    if (operation.type === 'CANCEL') snapshot = await provider.cancelOrder(payment.providerOrderId, operation.idempotencyKey)
    else if (operation.type === 'REFUND_FULL') snapshot = await provider.refundOrder(payment.providerOrderId, operation.idempotencyKey)
    else snapshot = await provider.refundPartial(payment.providerOrderId, payment.providerTransactionId ?? '', operation.amountCents!, operation.idempotencyKey)
    await settleSnapshot(db, operation, snapshot, now)
  } catch (error) {
    if (retryable(error)) {
      try {
        const current = await provider.getOrder(payment.providerOrderId)
        const outcome = await settleSnapshot(db, operation, current, now)
        if (outcome.kind === 'SUCCEEDED' || outcome.kind === 'ESCALATE_TO_REFUND' || outcome.kind === 'REVIEW_REQUIRED') {
          return
        }
      } catch { /* retry below */ }
      const disposition = retryDisposition(now, operation.attemptCount, Math.random() * 0.25, error.retryAfterSeconds)
      if (disposition.kind === 'REVIEW_REQUIRED') return markReview(db, operationId, 'RETRY_EXHAUSTED', now)
      await db.update(paymentOperations).set({ status: 'PENDING', nextAttemptAt: disposition.nextAttemptAt, failureClass: error.kind, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operationId))
      return
    }
    if (error instanceof PaymentProviderError) return markReview(db, operationId, error.kind, now)
    throw error
  }
}

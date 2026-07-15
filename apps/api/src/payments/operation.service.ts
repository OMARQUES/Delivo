import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { paymentOperations, payments } from '../db/schema'
import { PaymentProviderError, type PaymentProvider } from './provider'
import { applyProviderSnapshotInTransaction } from './transition.service'
import { MAX_PAYMENT_OPERATION_ATTEMPTS, nextAttemptAt } from './retry'
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

function evaluateOperation(operation: typeof paymentOperations.$inferSelect, decision: string, refundedAmountCents: number): OperationOutcome {
  if (operation.type === 'CANCEL') {
    if (decision === 'CANCELLED' || decision === 'EXPIRED') return { kind: 'SUCCEEDED', resultCode: 'CANCELLED' }
    if (decision === 'REFUNDED') return { kind: 'SUCCEEDED', resultCode: 'REFUNDED' }
    if (decision === 'APPROVED' || decision === 'PARTIALLY_REFUNDED') return { kind: 'ESCALATE_TO_REFUND' }
    if (decision === 'PENDING') return { kind: 'RETRY', failureClass: 'CANCEL_PENDING' }
    return { kind: 'REVIEW_REQUIRED', failureClass: 'CANCEL_OUTCOME_INVALID' }
  }
  if (operation.type === 'REFUND_FULL') {
    return decision === 'REFUNDED' && refundedAmountCents === operation.expectedRefundedAmountCents
      ? { kind: 'SUCCEEDED', resultCode: 'REFUNDED' }
      : decision === 'APPROVED' || decision === 'PARTIALLY_REFUNDED'
        ? { kind: 'RETRY', failureClass: 'REFUND_NOT_COMPLETE' }
        : { kind: 'REVIEW_REQUIRED', failureClass: 'REFUND_FULL_OUTCOME_INVALID' }
  }
  if (decision === 'PARTIALLY_REFUNDED' && refundedAmountCents === operation.expectedRefundedAmountCents) return { kind: 'SUCCEEDED', resultCode: 'PARTIALLY_REFUNDED' }
  if (decision === 'PARTIALLY_REFUNDED' && refundedAmountCents < (operation.expectedRefundedAmountCents ?? 0)) return { kind: 'RETRY', failureClass: 'REFUND_NOT_COMPLETE' }
  if (decision === 'PARTIALLY_REFUNDED' && refundedAmountCents > (operation.expectedRefundedAmountCents ?? 0)) return { kind: 'REVIEW_REQUIRED', failureClass: 'MISMATCH_REFUNDED_TARGET' }
  return { kind: 'REVIEW_REQUIRED', failureClass: 'REFUND_PARTIAL_OUTCOME_INVALID' }
}

async function settleSnapshot(
  db: Db,
  operation: typeof paymentOperations.$inferSelect,
  snapshot: Awaited<ReturnType<PaymentProvider['getOrder']>>,
  now: Date,
): Promise<OperationOutcome> {
  return db.transaction(async (tx) => {
    const result = await applyProviderSnapshotInTransaction(tx, operation.paymentId, snapshot, now, { enqueueLateRefund: operation.type === 'CANCEL' })
    const outcome = result.decision === 'REVIEW_REQUIRED'
      ? { kind: 'REVIEW_REQUIRED' as const, failureClass: 'SNAPSHOT_REVIEW_REQUIRED' }
      : evaluateOperation(operation, result.decision, snapshot.refundedAmountCents)
    if (outcome.kind === 'REVIEW_REQUIRED') {
      await tx.update(paymentOperations).set({ status: 'REVIEW_REQUIRED', failureClass: outcome.failureClass, observedProviderStatus: snapshot.orderStatus, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operation.id))
    } else if (outcome.kind === 'RETRY') {
      await tx.update(paymentOperations).set({ status: 'PENDING', nextAttemptAt: nextAttemptAt(now, operation.attemptCount, 0.1), failureClass: outcome.failureClass, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operation.id))
    } else {
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
      if (operation.attemptCount >= MAX_PAYMENT_OPERATION_ATTEMPTS) return markReview(db, operationId, 'RETRY_EXHAUSTED', now)
      await db.update(paymentOperations).set({ status: 'PENDING', nextAttemptAt: nextAttemptAt(now, operation.attemptCount, Math.random() * 0.25, error.retryAfterSeconds), failureClass: error.kind, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operationId))
      return
    }
    if (error instanceof PaymentProviderError) return markReview(db, operationId, error.kind, now)
    throw error
  }
}

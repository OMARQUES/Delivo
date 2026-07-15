import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { paymentOperations, payments } from '../db/schema'
import { PaymentProviderError, type PaymentProvider } from './provider'
import { applyProviderSnapshot } from './transition.service'
import { MAX_PAYMENT_OPERATION_ATTEMPTS, nextAttemptAt } from './retry'

type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

export type PaymentOperationInput = {
  paymentId: string
  type: 'CANCEL' | 'REFUND_FULL' | 'REFUND_PARTIAL'
  amountCents: number | null
  businessKey: string
  idempotencyKey: string
}

export async function enqueuePaymentOperation(tx: Db | DbTransaction, input: PaymentOperationInput, now: Date): Promise<void> {
  if (input.type === 'REFUND_PARTIAL' && (!Number.isSafeInteger(input.amountCents) || input.amountCents! <= 0)) throw new Error('partial refund amount invalid')
  if (input.type !== 'REFUND_PARTIAL' && input.amountCents !== null) throw new Error('non-partial refund amount invalid')
  await tx.insert(paymentOperations).values({ ...input, status: 'PENDING', nextAttemptAt: now, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: paymentOperations.businessKey })
}

export async function claimDueOperations(db: Db, now: Date, limit: number, leaseOwner: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const due = await tx.select({ id: paymentOperations.id, attemptCount: paymentOperations.attemptCount }).from(paymentOperations).where(or(
      and(eq(paymentOperations.status, 'PENDING'), or(isNull(paymentOperations.nextAttemptAt), lte(paymentOperations.nextAttemptAt, now))),
      and(eq(paymentOperations.status, 'PROCESSING'), lte(paymentOperations.leasedUntil, now)),
    )).orderBy(paymentOperations.createdAt).limit(Math.max(1, Math.min(100, limit))).for('update', { skipLocked: true })
    if (due.length === 0) return []
    const ids = due.map((row) => row.id)
    for (const row of due) {
      await tx.update(paymentOperations).set({ status: 'PROCESSING', leaseOwner, leasedUntil: new Date(now.getTime() + 5 * 60_000), attemptCount: sql`${paymentOperations.attemptCount} + 1`, updatedAt: now }).where(eq(paymentOperations.id, row.id))
    }
    return ids
  })
}

async function markReview(db: Db, operationId: string, failureClass: string, now: Date, observedProviderStatus?: string | null) {
  await db.update(paymentOperations).set({ status: 'REVIEW_REQUIRED', failureClass, observedProviderStatus: observedProviderStatus ?? null, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentOperations.id, operationId))
}

function retryable(error: unknown): error is PaymentProviderError {
  return error instanceof PaymentProviderError && ['TRANSIENT_UNCERTAIN', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE'].includes(error.kind)
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
    const result = await applyProviderSnapshot(db, payment.id, snapshot, now)
    if (result.decision === 'REVIEW_REQUIRED') return markReview(db, operationId, 'SNAPSHOT_REVIEW_REQUIRED', now, snapshot.orderStatus)
    await db.update(paymentOperations).set({ status: 'SUCCEEDED', completedAt: now, observedProviderStatus: snapshot.orderStatus, leaseOwner: null, leasedUntil: null, failureClass: null, updatedAt: now }).where(eq(paymentOperations.id, operationId))
  } catch (error) {
    if (retryable(error)) {
      try {
        const current = await provider.getOrder(payment.providerOrderId)
        const result = await applyProviderSnapshot(db, payment.id, current, now)
        if (result.decision !== 'REVIEW_REQUIRED') {
          await db.update(paymentOperations).set({ status: 'SUCCEEDED', completedAt: now, observedProviderStatus: current.orderStatus, leaseOwner: null, leasedUntil: null, failureClass: null, updatedAt: now }).where(eq(paymentOperations.id, operationId))
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

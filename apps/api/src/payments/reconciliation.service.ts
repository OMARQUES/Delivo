import { and, eq, isNotNull, isNull, lte, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { paymentOperations, paymentWebhookInbox, payments } from '../db/schema'
import { claimDueOperations, enqueuePaymentOperation } from './operation-queue.service'
import { processPaymentOperation } from './operation.service'
import { recoverUncertainCreate } from './checkout.service'
import type { PaymentProvider } from './provider'
import { applyProviderSnapshot } from './transition.service'
import { processWebhookInboxItem } from './webhook-inbox.service'

export type ReconciliationSummary = {
  leasesRecovered: number
  inboxProcessed: number
  operationsProcessed: number
  createsRecovered: number
  snapshotsRefreshed: number
  pixExpired: number
  reviewsRechecked: number
  stageFailures: number
}

export const DEFAULT_RECONCILIATION_LIMITS = { inbox: 25, operations: 25, creates: 20, snapshots: 50, expirations: 50, reviews: 10 } as const

type Limits = Partial<Record<keyof typeof DEFAULT_RECONCILIATION_LIMITS, number>>

async function recoverLeases(db: Db, now: Date): Promise<number> {
  const inbox = await db.update(paymentWebhookInbox).set({ status: 'PENDING', leaseOwner: null, leasedUntil: null, nextAttemptAt: now, updatedAt: now }).where(and(eq(paymentWebhookInbox.status, 'PROCESSING'), lte(paymentWebhookInbox.leasedUntil, now))).returning({ id: paymentWebhookInbox.id })
  const ops = await db.update(paymentOperations).set({ status: 'PENDING', leaseOwner: null, leasedUntil: null, nextAttemptAt: now, updatedAt: now }).where(and(eq(paymentOperations.status, 'PROCESSING'), lte(paymentOperations.leasedUntil, now))).returning({ id: paymentOperations.id })
  return inbox.length + ops.length
}

export async function runPaymentReconciliation(db: Db, provider: PaymentProvider, now: Date, limits: Limits = {}): Promise<ReconciliationSummary> {
  const cap = { ...DEFAULT_RECONCILIATION_LIMITS, ...limits }
  const summary: ReconciliationSummary = { leasesRecovered: 0, inboxProcessed: 0, operationsProcessed: 0, createsRecovered: 0, snapshotsRefreshed: 0, pixExpired: 0, reviewsRechecked: 0, stageFailures: 0 }
  try { summary.leasesRecovered = await recoverLeases(db, now) } catch { summary.stageFailures++ }

  try {
    const account = await provider.getAccountId()
    const due = await db.select({ id: paymentWebhookInbox.id }).from(paymentWebhookInbox).where(and(eq(paymentWebhookInbox.status, 'PENDING'), or(isNull(paymentWebhookInbox.nextAttemptAt), lte(paymentWebhookInbox.nextAttemptAt, now)))).limit(cap.inbox)
    for (const row of due) {
      try { await processWebhookInboxItem(db, provider, row.id, crypto.randomUUID(), now); summary.inboxProcessed++ } catch { summary.stageFailures++ }
    }

    const operationLeaseOwner = crypto.randomUUID()
    const operationIds = await claimDueOperations(db, now, cap.operations, operationLeaseOwner)
    for (const id of operationIds) {
      try { await processPaymentOperation(db, provider, id, operationLeaseOwner, now); summary.operationsProcessed++ } catch { summary.stageFailures++ }
    }

    const uncertain = await db.select({ id: payments.id }).from(payments).where(and(isNull(payments.providerOrderId), eq(payments.status, 'PENDING'))).limit(cap.creates)
    for (const row of uncertain) {
      try { const result = await recoverUncertainCreate(db, provider, row.id, now); if (result === 'RECOVERED') summary.createsRecovered++ } catch { summary.stageFailures++ }
    }

    const pending = await db.select().from(payments).where(and(eq(payments.status, 'PENDING'), isNotNull(payments.providerOrderId))).limit(cap.snapshots)
    for (const payment of pending) {
      try { const snapshot = await provider.getOrder(payment.providerOrderId!); if (snapshot.accountId !== account) throw new Error('MISMATCH_ACCOUNT'); await applyProviderSnapshot(db, payment.id, snapshot, now); summary.snapshotsRefreshed++ } catch { summary.stageFailures++ }
    }

    const expiring = await db.select().from(payments).where(and(eq(payments.status, 'PENDING'), eq(payments.method, 'PIX'), lte(payments.expiresAt, now))).limit(cap.expirations)
    for (const payment of expiring) {
      try { await enqueuePaymentOperation(db, { paymentId: payment.id, type: 'CANCEL', amountCents: null, businessKey: `cancel:${payment.id}:PIX_EXPIRED`, idempotencyKey: `cancel:${payment.id}:PIX_EXPIRED` }, now); summary.pixExpired++ } catch { summary.stageFailures++ }
    }

    const reviewable = await db.select().from(payments).where(and(eq(payments.reconciliationState, 'REVIEW_REQUIRED'), isNotNull(payments.providerOrderId), or(eq(payments.reconciliationFailure, 'ORDER_NOT_FOUND'), eq(payments.reconciliationFailure, 'PROVIDER_UNAVAILABLE'), eq(payments.reconciliationFailure, 'TRANSIENT_UNCERTAIN')))).limit(cap.reviews)
    for (const payment of reviewable) {
      try { const snapshot = await provider.getOrder(payment.providerOrderId!); await applyProviderSnapshot(db, payment.id, snapshot, now); summary.reviewsRechecked++ } catch { summary.stageFailures++ }
    }
  } catch { summary.stageFailures++ }
  return summary
}

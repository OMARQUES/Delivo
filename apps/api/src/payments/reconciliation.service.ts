import { and, asc, eq, isNotNull, isNull, lte, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { paymentOperations, paymentWebhookInbox, payments } from '../db/schema'
import { claimDueOperations, enqueuePaymentOperation, propagateReviewedDependencies } from './operation-queue.service'
import { processPaymentOperation } from './operation.service'
import { recoverUncertainCreate } from './checkout.service'
import type { PaymentProvider } from './provider'
import { applyProviderSnapshot } from './transition.service'
import { processWebhookInboxItem } from './webhook-inbox.service'

export type ReconciliationContext = {
  resolvePayerEmail: (userEmail: string | null, userId: string) => string
}

export type ReconciliationSummary = {
  leasesRecovered: number
  dependenciesReviewed: number
  operationsReleased: number
  inboxProcessed: number
  operationsProcessed: number
  createsRecovered: number
  snapshotsRefreshed: number
  pixExpired: number
  reviewsRechecked: number
  stageFailures: number
}

export const DEFAULT_RECONCILIATION_LIMITS = { inbox: 25, operations: 25, creates: 20, snapshots: 50, expirations: 50, reviews: 10 } as const
export type Limits = Partial<Record<keyof typeof DEFAULT_RECONCILIATION_LIMITS, number>>

function cap(value: number | undefined, fallback: number) {
  if (value === 0) return 0
  return Math.max(1, Math.min(100, Math.floor(value ?? fallback)))
}

async function recoverLeases(db: Db, now: Date): Promise<number> {
  const inbox = await db.update(paymentWebhookInbox).set({ status: 'PENDING', leaseOwner: null, leasedUntil: null, nextAttemptAt: now, updatedAt: now }).where(and(eq(paymentWebhookInbox.status, 'PROCESSING'), lte(paymentWebhookInbox.leasedUntil, now))).returning({ id: paymentWebhookInbox.id })
  const ops = await db.update(paymentOperations).set({ status: 'PENDING', leaseOwner: null, leasedUntil: null, nextAttemptAt: now, updatedAt: now }).where(and(eq(paymentOperations.status, 'PROCESSING'), lte(paymentOperations.leasedUntil, now))).returning({ id: paymentOperations.id })
  return inbox.length + ops.length
}

async function runStage(summary: ReconciliationSummary, action: () => Promise<void>) {
  try { await action() } catch { summary.stageFailures++ }
}

export async function runPaymentReconciliation(
  db: Db,
  provider: PaymentProvider,
  now: Date,
  context: ReconciliationContext,
  limits: Limits = {},
): Promise<ReconciliationSummary> {
  const capBy = (key: keyof typeof DEFAULT_RECONCILIATION_LIMITS) => cap(limits[key], DEFAULT_RECONCILIATION_LIMITS[key])
  const summary: ReconciliationSummary = { leasesRecovered: 0, dependenciesReviewed: 0, operationsReleased: 0, inboxProcessed: 0, operationsProcessed: 0, createsRecovered: 0, snapshotsRefreshed: 0, pixExpired: 0, reviewsRechecked: 0, stageFailures: 0 }

  await runStage(summary, async () => { summary.leasesRecovered = await recoverLeases(db, now) })

  await runStage(summary, async () => {
    summary.dependenciesReviewed = await propagateReviewedDependencies(db, now, capBy('operations'))
  })

  await runStage(summary, async () => {
    const limit = capBy('inbox')
    if (!limit) return
    const due = await db.select({ id: paymentWebhookInbox.id }).from(paymentWebhookInbox).where(and(eq(paymentWebhookInbox.status, 'PENDING'), or(isNull(paymentWebhookInbox.nextAttemptAt), lte(paymentWebhookInbox.nextAttemptAt, now)))).orderBy(asc(paymentWebhookInbox.nextAttemptAt), asc(paymentWebhookInbox.createdAt)).limit(limit)
    for (const row of due) {
      try { await processWebhookInboxItem(db, provider, row.id, crypto.randomUUID(), now); summary.inboxProcessed++ } catch { summary.stageFailures++ }
    }
  })

  await runStage(summary, async () => {
    const limit = capBy('operations')
    if (!limit) return
    const leaseOwner = crypto.randomUUID()
    const ids = await claimDueOperations(db, now, limit, leaseOwner)
    summary.operationsReleased = ids.length
    for (const id of ids) {
      try { await processPaymentOperation(db, provider, id, leaseOwner, now); summary.operationsProcessed++ } catch { summary.stageFailures++ }
    }
  })

  await runStage(summary, async () => {
    const limit = capBy('creates')
    if (!limit) return
    const uncertain = await db.select({ id: payments.id }).from(payments).where(and(isNull(payments.providerOrderId), eq(payments.status, 'PENDING'), or(isNull(payments.nextReconcileAt), lte(payments.nextReconcileAt, now)))).orderBy(asc(payments.nextReconcileAt), asc(payments.createdAt)).limit(limit)
    for (const row of uncertain) {
      try {
        const result = await recoverUncertainCreate(db, provider, row.id, now, context.resolvePayerEmail)
        if (result === 'RECOVERED') summary.createsRecovered++
      } catch { summary.stageFailures++ }
    }
  })

  await runStage(summary, async () => {
    const limit = capBy('snapshots')
    if (!limit) return
    const account = await provider.getAccountId()
    const pending = await db.select().from(payments).where(and(eq(payments.status, 'PENDING'), isNotNull(payments.providerOrderId), or(isNull(payments.nextReconcileAt), lte(payments.nextReconcileAt, now)))).orderBy(asc(payments.nextReconcileAt), asc(payments.createdAt)).limit(limit)
    for (const payment of pending) {
      try {
        const snapshot = await provider.getOrder(payment.providerOrderId!)
        if (snapshot.accountId !== account) throw new Error('MISMATCH_ACCOUNT')
        await applyProviderSnapshot(db, payment.id, snapshot, now)
        summary.snapshotsRefreshed++
      } catch { summary.stageFailures++ }
    }
  })

  await runStage(summary, async () => {
    const limit = capBy('expirations')
    if (!limit) return
    const expiring = await db.select().from(payments).where(and(eq(payments.status, 'PENDING'), eq(payments.method, 'PIX'), isNotNull(payments.providerOrderId), lte(payments.expiresAt, now))).orderBy(asc(payments.expiresAt), asc(payments.createdAt)).limit(limit)
    for (const payment of expiring) {
      try { await enqueuePaymentOperation(db, { paymentId: payment.id, type: 'CANCEL', amountCents: null, businessKey: `cancel:${payment.id}:PIX_EXPIRED`, idempotencyKey: `cancel:${payment.id}:PIX_EXPIRED` }, now); summary.pixExpired++ } catch { summary.stageFailures++ }
    }
  })

  await runStage(summary, async () => {
    const limit = capBy('reviews')
    if (!limit) return
    const reviewable = await db.select().from(payments).where(and(eq(payments.reconciliationState, 'REVIEW_REQUIRED'), isNotNull(payments.providerOrderId), or(eq(payments.reconciliationFailure, 'ORDER_NOT_FOUND'), eq(payments.reconciliationFailure, 'PROVIDER_UNAVAILABLE'), eq(payments.reconciliationFailure, 'TRANSIENT_UNCERTAIN')), or(isNull(payments.nextReconcileAt), lte(payments.nextReconcileAt, now)))).orderBy(asc(payments.nextReconcileAt), asc(payments.createdAt)).limit(limit)
    for (const payment of reviewable) {
      try {
        const snapshot = await provider.getOrder(payment.providerOrderId!)
        await applyProviderSnapshot(db, payment.id, snapshot, now)
        summary.reviewsRechecked++
      } catch {
        await db.update(payments).set({ nextReconcileAt: new Date(now.getTime() + 15 * 60_000), lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, payment.id))
        summary.stageFailures++
      }
    }
  })

  return summary
}

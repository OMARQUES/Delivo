import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { paymentOperations, paymentWebhookInbox, payments } from '../db/schema'
import { claimDueOperations, enqueuePaymentOperation, propagateReviewedDependencies } from './operation-queue.service'
import { processPaymentOperation } from './operation.service'
import { recoverUncertainCreate } from './checkout.service'
import type { PaymentProvider } from './provider'
import { PaymentProviderError } from './provider'
import { applyProviderSnapshot } from './transition.service'
import { processWebhookInboxItem } from './webhook-inbox.service'
import { retryDisposition } from './retry'

export type ReconciliationContext = {
  resolvePayerEmail: (userEmail: string | null, userId: string) => string
}

export type ReconciliationStage =
  | 'leases'
  | 'dependencies'
  | 'inbox'
  | 'operations'
  | 'creates'
  | 'snapshots'
  | 'expirations'
  | 'reviews'

type BoundedStage = Exclude<ReconciliationStage, 'leases' | 'dependencies'>
export type ReconciliationOptions = {
  limits?: Partial<Record<BoundedStage, number>>
  stages?: readonly ReconciliationStage[]
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

const allStages: readonly ReconciliationStage[] = ['leases', 'dependencies', 'inbox', 'operations', 'creates', 'snapshots', 'expirations', 'reviews']

function cap(value: number | undefined, fallback: number) {
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

function duePayment(now: Date) {
  return or(isNull(payments.nextReconcileAt), lte(payments.nextReconcileAt, now))
}

async function claimPayment(db: Db, paymentId: string, now: Date, state: 'PENDING' | 'REVIEW_REQUIRED') {
  const [claimed] = await db.update(payments).set({
    reconciliationAttemptCount: sql`${payments.reconciliationAttemptCount} + 1`,
    nextReconcileAt: new Date(now.getTime() + 5 * 60_000),
    updatedAt: now,
  }).where(and(eq(payments.id, paymentId), eq(payments.reconciliationState, state), duePayment(now))).returning()
  return claimed
}

async function retryPayment(db: Db, paymentId: string, attemptCount: number, now: Date, error: unknown, state: 'PENDING' | 'REVIEW_REQUIRED') {
  const retryAfterSeconds = error instanceof PaymentProviderError ? error.retryAfterSeconds : undefined
  const disposition = retryDisposition(now, attemptCount, 0.1, retryAfterSeconds)
  if (disposition.kind === 'REVIEW_REQUIRED') {
    await db.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'RETRY_EXHAUSTED', nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, paymentId))
    return
  }
  const failure = error instanceof PaymentProviderError ? error.kind : 'UNEXPECTED'
  await db.update(payments).set({ reconciliationState: state, reconciliationFailure: failure, nextReconcileAt: disposition.nextAttemptAt, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, paymentId))
}

async function persistMismatch(db: Db, paymentId: string, now: Date) {
  await db.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'MISMATCH_ACCOUNT', nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, paymentId))
}

async function refreshPendingSnapshot(db: Db, provider: PaymentProvider, paymentId: string, account: string, now: Date): Promise<'REFRESHED' | 'FAILED'> {
  const payment = await claimPayment(db, paymentId, now, 'PENDING')
  if (!payment) return 'FAILED'
  try {
    const snapshot = await provider.getOrder(payment.providerOrderId!)
    if (snapshot.accountId !== account) {
      await persistMismatch(db, payment.id, now)
      return 'FAILED'
    }
    await applyProviderSnapshot(db, payment.id, snapshot, now)
    return 'REFRESHED'
  } catch (error) {
    await retryPayment(db, payment.id, payment.reconciliationAttemptCount, now, error, 'PENDING')
    throw error
  }
}

async function recheckReview(db: Db, provider: PaymentProvider, paymentId: string, now: Date): Promise<'REFRESHED' | 'FAILED'> {
  const payment = await claimPayment(db, paymentId, now, 'REVIEW_REQUIRED')
  if (!payment) return 'FAILED'
  try {
    const snapshot = await provider.getOrder(payment.providerOrderId!)
    await applyProviderSnapshot(db, payment.id, snapshot, now)
    return 'REFRESHED'
  } catch (error) {
    await retryPayment(db, payment.id, payment.reconciliationAttemptCount, now, error, 'REVIEW_REQUIRED')
    throw error
  }
}

export async function runPaymentReconciliation(
  db: Db,
  provider: PaymentProvider,
  now: Date,
  context: ReconciliationContext,
  options: ReconciliationOptions = {},
): Promise<ReconciliationSummary> {
  const stages = new Set(options.stages ?? allStages)
  const limits = options.limits ?? {}
  const capBy = (key: BoundedStage) => cap(limits[key], DEFAULT_RECONCILIATION_LIMITS[key])
  const summary: ReconciliationSummary = { leasesRecovered: 0, dependenciesReviewed: 0, operationsReleased: 0, inboxProcessed: 0, operationsProcessed: 0, createsRecovered: 0, snapshotsRefreshed: 0, pixExpired: 0, reviewsRechecked: 0, stageFailures: 0 }

  if (stages.has('leases')) await runStage(summary, async () => { summary.leasesRecovered = await recoverLeases(db, now) })
  if (stages.has('dependencies')) await runStage(summary, async () => { summary.dependenciesReviewed = await propagateReviewedDependencies(db, now, capBy('operations')) })
  if (stages.has('inbox')) await runStage(summary, async () => {
    const due = await db.select({ id: paymentWebhookInbox.id }).from(paymentWebhookInbox).where(and(eq(paymentWebhookInbox.status, 'PENDING'), or(isNull(paymentWebhookInbox.nextAttemptAt), lte(paymentWebhookInbox.nextAttemptAt, now)))).orderBy(asc(paymentWebhookInbox.nextAttemptAt), asc(paymentWebhookInbox.createdAt)).limit(capBy('inbox'))
    for (const row of due) {
      try {
        const result = await processWebhookInboxItem(db, provider, row.id, crypto.randomUUID(), now)
        if (result === 'CLAIMED') summary.inboxProcessed++
      } catch { summary.stageFailures++ }
    }
  })
  if (stages.has('operations')) await runStage(summary, async () => {
    const leaseOwner = crypto.randomUUID()
    const ids = await claimDueOperations(db, now, capBy('operations'), leaseOwner)
    summary.operationsReleased = ids.length
    for (const id of ids) {
      try { await processPaymentOperation(db, provider, id, leaseOwner, now); summary.operationsProcessed++ } catch { summary.stageFailures++ }
    }
  })
  if (stages.has('creates')) await runStage(summary, async () => {
    const uncertain = await db.select({ id: payments.id }).from(payments).where(and(isNull(payments.providerOrderId), eq(payments.status, 'PENDING'), duePayment(now))).orderBy(asc(payments.nextReconcileAt), asc(payments.createdAt)).limit(capBy('creates'))
    for (const row of uncertain) {
      try { if (await recoverUncertainCreate(db, provider, row.id, now, context.resolvePayerEmail) === 'RECOVERED') summary.createsRecovered++ } catch { summary.stageFailures++ }
    }
  })
  if (stages.has('snapshots')) await runStage(summary, async () => {
    const account = await provider.getAccountId()
    const pending = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.status, 'PENDING'), isNotNull(payments.providerOrderId), duePayment(now))).orderBy(asc(payments.nextReconcileAt), asc(payments.createdAt)).limit(capBy('snapshots'))
    for (const row of pending) {
      try { if (await refreshPendingSnapshot(db, provider, row.id, account, now) === 'REFRESHED') summary.snapshotsRefreshed++ } catch { summary.stageFailures++ }
    }
  })
  if (stages.has('expirations')) await runStage(summary, async () => {
    const expiring = await db.select().from(payments).where(and(eq(payments.status, 'PENDING'), eq(payments.method, 'PIX'), isNotNull(payments.providerOrderId), lte(payments.expiresAt, now))).orderBy(asc(payments.expiresAt), asc(payments.createdAt)).limit(capBy('expirations'))
    for (const payment of expiring) {
      try { await enqueuePaymentOperation(db, { paymentId: payment.id, type: 'CANCEL', amountCents: null, businessKey: `cancel:${payment.id}:PIX_EXPIRED`, idempotencyKey: `cancel:${payment.id}:PIX_EXPIRED` }, now); summary.pixExpired++ } catch { summary.stageFailures++ }
    }
  })
  if (stages.has('reviews')) await runStage(summary, async () => {
    const reviewable = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.reconciliationState, 'REVIEW_REQUIRED'), isNotNull(payments.providerOrderId), or(eq(payments.reconciliationFailure, 'ORDER_NOT_FOUND'), eq(payments.reconciliationFailure, 'PROVIDER_UNAVAILABLE'), eq(payments.reconciliationFailure, 'TRANSIENT_UNCERTAIN')), duePayment(now))).orderBy(asc(payments.nextReconcileAt), asc(payments.createdAt)).limit(capBy('reviews'))
    for (const row of reviewable) {
      try { if (await recheckReview(db, provider, row.id, now) === 'REFRESHED') summary.reviewsRechecked++ } catch { summary.stageFailures++ }
    }
  })

  return summary
}

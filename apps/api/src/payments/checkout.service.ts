import { and, eq } from 'drizzle-orm'
import type { Db, DbTransaction } from '../db/client'
import { orderEvents, orders, payments, users } from '../db/schema'
import { ONLINE_PAYMENT_EXPIRATION_MS } from './constants'
import { PaymentProviderError, type PaymentProvider, type ProviderFailureKind } from './provider'
import { retryDisposition } from './retry'
import { applyProviderSnapshotInTransaction } from './transition.service'

const CREATE_RECOVERY_KINDS: ReadonlySet<ProviderFailureKind> = new Set([
  'CREATE_REQUIRES_RECOVERY',
  'RESOURCE_LOCKED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TRANSIENT_UNCERTAIN',
])

type CreateRecoveryOutcome = 'RECOVERED' | 'RETRY_PIX' | 'RETRY_CARD' | 'REVIEW_REQUIRED'

function requiresCreateRecovery(error: unknown): error is PaymentProviderError {
  return error instanceof PaymentProviderError && CREATE_RECOVERY_KINDS.has(error.kind)
}

export type CheckoutErrorCode = 'PAYMENT_REJECTED' | 'PAYMENT_REVIEW_REQUIRED' | 'PAYMENT_UNCERTAIN'

export class CheckoutError extends Error {
  constructor(public readonly code: CheckoutErrorCode, public readonly status: 402 | 503, public readonly providerError?: PaymentProviderError) {
    super(`Payment checkout failure: ${code}`)
  }
}

export async function createPaymentAttempt(tx: Db | DbTransaction, input: {
  orderId: string
  method: 'PIX' | 'CARD'
  amountCents: number
  applicationId: string
  accountId: string
  liveMode: boolean
  expiresAt?: Date
  now: Date
}): Promise<typeof payments.$inferSelect> {
  const [payment] = await tx.insert(payments).values({
    orderId: input.orderId,
    method: input.method,
    expectedAmountCents: input.amountCents,
    expectedCurrency: 'BRL',
    expectedCountry: 'BR',
    expectedApplicationId: input.applicationId,
    expectedAccountId: input.accountId,
    expectedLiveMode: input.liveMode,
    expiresAt: input.expiresAt,
    createIdempotencyKey: crypto.randomUUID(),
    createdAt: input.now,
    updatedAt: input.now,
  }).returning()
  if (!payment) throw new Error('payment attempt was not created')
  return payment
}

export async function createOnlinePayment(db: Db, provider: PaymentProvider, input: {
  paymentId: string
  payerEmail: string
  card?: { token: string; methodId: string }
}): Promise<{ kind: 'PIX'; qrCode: string; qrCodeBase64: string | null; expiresAt: string } | { kind: 'APPROVED' | 'PENDING' }> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1)
  if (!payment) throw new CheckoutError('PAYMENT_REVIEW_REQUIRED', 503)
  const accountId = await provider.getAccountId()
  if (accountId !== payment.expectedAccountId) throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')
  try {
    const snapshot = await provider.createOrder(payment.method === 'PIX'
      ? { method: 'PIX', orderId: payment.orderId, amountCents: payment.expectedAmountCents, payerEmail: input.payerEmail, idempotencyKey: payment.createIdempotencyKey, expiresAt: payment.expiresAt ?? new Date(Date.now() + ONLINE_PAYMENT_EXPIRATION_MS) }
      : { method: 'CARD', orderId: payment.orderId, amountCents: payment.expectedAmountCents, payerEmail: input.payerEmail, idempotencyKey: payment.createIdempotencyKey, cardToken: input.card?.token ?? '', cardPaymentMethodId: input.card?.methodId ?? '', installments: 1 })
    const persisted = await whileStillUncertain(db, payment.id, (tx) => applyProviderSnapshotInTransaction(tx, payment.id, snapshot, new Date()))
    if (!persisted.applied) {
      const [current] = await db.select().from(payments).where(eq(payments.id, payment.id)).limit(1)
      if (!current || current.reconciliationState === 'REVIEW_REQUIRED') throw new CheckoutError('PAYMENT_REVIEW_REQUIRED', 503)
      if (current.status === 'REJECTED' || current.status === 'CANCELLED' || current.status === 'EXPIRED') throw new CheckoutError('PAYMENT_REJECTED', 402)
      return current.method === 'PIX' && current.qrCode
        ? { kind: 'PIX', qrCode: current.qrCode, qrCodeBase64: current.qrCodeBase64, expiresAt: (current.expiresAt ?? new Date()).toISOString() }
        : { kind: current.status === 'APPROVED' ? 'APPROVED' : 'PENDING' }
    }
    const result = persisted.value
    if (result.decision === 'REVIEW_REQUIRED') throw new CheckoutError('PAYMENT_REVIEW_REQUIRED', 503)
    if (result.decision === 'REJECTED') throw new CheckoutError('PAYMENT_REJECTED', 402)
    if (payment.method === 'PIX' && snapshot.pix) return { kind: 'PIX', qrCode: snapshot.pix.qrCode, qrCodeBase64: snapshot.pix.qrCodeBase64, expiresAt: (snapshot.pix.expiresAt ?? payment.expiresAt ?? new Date()).toISOString() }
    return { kind: result.decision === 'APPROVED' || result.decision === 'PARTIALLY_REFUNDED' ? 'APPROVED' : 'PENDING' }
  } catch (error) {
    if (requiresCreateRecovery(error)) {
      const outcome = await recoverUncertainCreate(db, provider, payment.id, new Date(), () => input.payerEmail, { trigger: error })
      if (outcome === 'RECOVERED') return checkoutResultFromStoredPayment(db, payment.id, error)
      if (outcome === 'REVIEW_REQUIRED') throw new CheckoutError('PAYMENT_REVIEW_REQUIRED', 503, error)
      throw new CheckoutError('PAYMENT_UNCERTAIN', 503, error)
    }
    throw error
  }
}

export type PayerEmailResolver = (userEmail: string | null, userId: string) => string

type StillUncertainMutation<T> = (tx: DbTransaction, payment: typeof payments.$inferSelect) => Promise<T>

type DbScope = Db | DbTransaction

function isDatabase(scope: DbScope): scope is Db {
  return typeof (scope as Db).transaction === 'function'
}

async function inTransaction<T>(scope: DbScope, action: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return isDatabase(scope) ? scope.transaction(action) : action(scope)
}

async function whileStillUncertain<T>(db: DbScope, paymentId: string, mutation: StillUncertainMutation<T>) {
  return inTransaction(db, async (tx) => {
    const [current] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
    if (!current || current.status !== 'PENDING' || current.providerOrderId !== null) return { applied: false as const }
    return { applied: true as const, value: await mutation(tx, current) }
  })
}

async function checkoutResultFromStoredPayment(
  db: Db,
  paymentId: string,
  providerError?: PaymentProviderError,
): Promise<{ kind: 'PIX'; qrCode: string; qrCodeBase64: string | null; expiresAt: string } | { kind: 'APPROVED' | 'PENDING' }> {
  const [current] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1)
  if (!current || current.reconciliationState === 'REVIEW_REQUIRED') throw new CheckoutError('PAYMENT_REVIEW_REQUIRED', 503, providerError)
  if (current.status === 'REJECTED' || current.status === 'CANCELLED' || current.status === 'EXPIRED') throw new CheckoutError('PAYMENT_REJECTED', 402)
  if (current.method === 'PIX' && current.qrCode) {
    return { kind: 'PIX', qrCode: current.qrCode, qrCodeBase64: current.qrCodeBase64, expiresAt: (current.expiresAt ?? new Date()).toISOString() }
  }
  return { kind: current.status === 'APPROVED' ? 'APPROVED' : 'PENDING' }
}

async function currentRecoveryOutcome(db: Db, paymentId: string, fallback: Exclude<CreateRecoveryOutcome, 'RECOVERED'>): Promise<CreateRecoveryOutcome> {
  const [current] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1)
  if (!current) return 'REVIEW_REQUIRED'
  if (current.providerOrderId !== null || current.status !== 'PENDING') return 'RECOVERED'
  if (current.reconciliationState === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED'
  return fallback
}

async function persistRecoveryReview(db: Db, paymentId: string, now: Date, failure: string) {
  return whileStillUncertain(db, paymentId, async (tx, payment) => {
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, payment.orderId)).limit(1)
    const changed = payment.reconciliationState !== 'REVIEW_REQUIRED' || payment.reconciliationFailure !== failure
    await tx.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: failure, nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, payment.id))
    if (changed && order) await tx.insert(orderEvents).values({ orderId: payment.orderId, status: order.status, actorRole: 'SYSTEM', actorId: null, note: 'pagamento em revisão' })
  })
}

async function scheduleCreateRecoveryRetry(
  db: Db,
  payment: typeof payments.$inferSelect,
  now: Date,
  failure: string,
  retryAfterSeconds?: number,
): Promise<CreateRecoveryOutcome> {
  const retry = retryDisposition(now, payment.reconciliationAttemptCount, 0.1, retryAfterSeconds)
  if (retry.kind === 'REVIEW_REQUIRED') {
    const persisted = await persistRecoveryReview(db, payment.id, now, 'RETRY_EXHAUSTED')
    return persisted.applied ? 'REVIEW_REQUIRED' : currentRecoveryOutcome(db, payment.id, 'REVIEW_REQUIRED')
  }
  const fallback = payment.method === 'PIX' ? 'RETRY_PIX' : 'RETRY_CARD'
  const persisted = await whileStillUncertain(db, payment.id, async (tx, current) => {
    await tx.update(payments).set({
      reconciliationState: 'PENDING',
      reconciliationFailure: failure,
      nextReconcileAt: retry.nextAttemptAt,
      lastReconciledAt: now,
      updatedAt: now,
    }).where(eq(payments.id, current.id))
  })
  return persisted.applied ? fallback : currentRecoveryOutcome(db, payment.id, fallback)
}

export async function recoverUncertainCreate(
  db: Db,
  provider: PaymentProvider,
  paymentId: string,
  now: Date,
  resolvePayerEmail: PayerEmailResolver,
  options: { trigger?: PaymentProviderError } = {},
): Promise<CreateRecoveryOutcome> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1)
  if (!payment) {
    await persistRecoveryReview(db, paymentId, now, 'PAYMENT_NOT_FOUND')
    return 'REVIEW_REQUIRED'
  }
  let matches: Awaited<ReturnType<PaymentProvider['searchOrders']>>
  try {
    matches = await provider.searchOrders(payment.orderId, payment.createdAt, now)
  } catch (error) {
    if (requiresCreateRecovery(error)) {
      return scheduleCreateRecoveryRetry(db, payment, now, error.kind, error.retryAfterSeconds)
    }
    const persisted = await persistRecoveryReview(db, payment.id, now, error instanceof PaymentProviderError ? error.kind : 'SEARCH_FAILED')
    return persisted.applied ? 'REVIEW_REQUIRED' : currentRecoveryOutcome(db, payment.id, 'REVIEW_REQUIRED')
  }
  if (matches.length > 1) {
    const persisted = await persistRecoveryReview(db, payment.id, now, 'AMBIGUOUS_PROVIDER_CREATE')
    return persisted.applied ? 'REVIEW_REQUIRED' : currentRecoveryOutcome(db, payment.id, 'REVIEW_REQUIRED')
  }
  if (matches.length === 0 && payment.method === 'CARD') {
    return scheduleCreateRecoveryRetry(
      db,
      payment,
      now,
      options.trigger?.kind ?? 'CREATE_NOT_VISIBLE',
      options.trigger?.retryAfterSeconds,
    )
  }
  if (matches.length === 0 && payment.method === 'PIX') {
    return inTransaction(db, async (tx) => {
      const [current] = await tx.select().from(payments).where(eq(payments.id, payment.id)).for('update')
      if (!current || current.status !== 'PENDING' || current.providerOrderId !== null) return 'RECOVERED'
      const [order] = await tx.select().from(orders).where(eq(orders.id, current.orderId)).for('update')
      if (!order) return 'REVIEW_REQUIRED'
      if (order.status === 'CANCELLED') {
        const retry = retryDisposition(now, current.reconciliationAttemptCount, 0.1)
        if (retry.kind === 'REVIEW_REQUIRED') {
          await tx.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'RETRY_EXHAUSTED', nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, current.id))
          return 'REVIEW_REQUIRED'
        }
        await tx.update(payments).set({ reconciliationState: 'PENDING', reconciliationFailure: 'CANCELLED_CREATE_SEARCH_PENDING', nextReconcileAt: retry.nextAttemptAt, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, current.id))
        return 'RETRY_PIX'
      }
      if (current.expiresAt && current.expiresAt <= now) {
        await tx.update(payments).set({ status: 'EXPIRED', reconciliationState: 'HEALTHY', reconciliationFailure: null, nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, current.id))
        if (order.status === 'AWAITING_PAYMENT') {
          await tx.update(orders).set({ status: 'CANCELLED', updatedAt: now }).where(and(eq(orders.id, order.id), eq(orders.status, 'AWAITING_PAYMENT')))
          await tx.insert(orderEvents).values({ orderId: order.id, status: 'CANCELLED', actorRole: 'SYSTEM', actorId: null, note: 'pagamento não aprovado' })
        }
        return 'RECOVERED'
      }
      const [identity] = await tx.select({ email: users.email, userId: users.id }).from(users).where(eq(users.id, order.customerId)).limit(1)
      if (!identity) {
        await tx.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'PAYER_NOT_FOUND', nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, current.id))
        return 'REVIEW_REQUIRED'
      }
      try {
        const accountId = await provider.getAccountId()
        if (accountId !== current.expectedAccountId) throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')
        const snapshot = await provider.createOrder({ method: 'PIX', orderId: current.orderId, amountCents: current.expectedAmountCents, payerEmail: resolvePayerEmail(identity.email, identity.userId), idempotencyKey: current.createIdempotencyKey, expiresAt: current.expiresAt ?? new Date(now.getTime() + ONLINE_PAYMENT_EXPIRATION_MS) })
        const persisted = await applyProviderSnapshotInTransaction(tx, current.id, snapshot, now)
        return persisted.decision === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'RECOVERED'
      } catch (error) {
        if (requiresCreateRecovery(error)) {
          const retry = retryDisposition(now, current.reconciliationAttemptCount, 0.1, error.retryAfterSeconds)
          if (retry.kind === 'REVIEW_REQUIRED') {
            await tx.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'RETRY_EXHAUSTED', nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, current.id))
            return 'REVIEW_REQUIRED'
          }
          await tx.update(payments).set({ reconciliationState: 'PENDING', reconciliationFailure: error.kind, nextReconcileAt: retry.nextAttemptAt, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, current.id))
          return 'RETRY_PIX'
        }
        const failure = error instanceof PaymentProviderError ? error.kind : 'CREATE_FAILED'
        await tx.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: failure, nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, current.id))
        return 'REVIEW_REQUIRED'
      }
    })
  }
  let authoritative: Awaited<ReturnType<PaymentProvider['getOrder']>>
  try {
    authoritative = await provider.getOrder(matches[0]!.providerOrderId)
  } catch (error) {
    if (requiresCreateRecovery(error) || (error instanceof PaymentProviderError && error.kind === 'ORDER_NOT_FOUND')) {
      return scheduleCreateRecoveryRetry(
        db,
        payment,
        now,
        error instanceof PaymentProviderError ? error.kind : 'AUTHORITATIVE_READ_FAILED',
        error instanceof PaymentProviderError ? error.retryAfterSeconds : undefined,
      )
    }
    const reviewed = await persistRecoveryReview(db, payment.id, now, error instanceof PaymentProviderError ? error.kind : 'AUTHORITATIVE_READ_FAILED')
    return reviewed.applied ? 'REVIEW_REQUIRED' : currentRecoveryOutcome(db, payment.id, 'REVIEW_REQUIRED')
  }
  const persisted = await whileStillUncertain(db, payment.id, (tx) => applyProviderSnapshotInTransaction(tx, payment.id, authoritative, now))
  if (!persisted.applied) return currentRecoveryOutcome(db, payment.id, 'REVIEW_REQUIRED')
  return persisted.value.decision === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'RECOVERED'
}

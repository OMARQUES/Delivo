import { and, eq } from 'drizzle-orm'
import type { Db, DbTransaction } from '../db/client'
import { orderEvents, orders, payments, users } from '../db/schema'
import { PaymentProviderError, type PaymentProvider } from './provider'
import { applyProviderSnapshot } from './transition.service'

export type CheckoutErrorCode = 'PAYMENT_REJECTED' | 'PAYMENT_REVIEW_REQUIRED' | 'PAYMENT_UNCERTAIN'

export class CheckoutError extends Error {
  constructor(public readonly code: CheckoutErrorCode, public readonly status: 402 | 503) {
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
}): Promise<{ kind: 'PIX'; qrCode: string; qrCodeBase64: string; expiresAt: string } | { kind: 'APPROVED' | 'PENDING' }> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1)
  if (!payment) throw new CheckoutError('PAYMENT_REVIEW_REQUIRED', 503)
  const accountId = await provider.getAccountId()
  if (accountId !== payment.expectedAccountId) throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')
  try {
    const snapshot = await provider.createOrder(payment.method === 'PIX'
      ? { method: 'PIX', orderId: payment.orderId, amountCents: payment.expectedAmountCents, payerEmail: input.payerEmail, idempotencyKey: payment.createIdempotencyKey, expiresAt: payment.expiresAt ?? new Date(Date.now() + 15 * 60_000) }
      : { method: 'CARD', orderId: payment.orderId, amountCents: payment.expectedAmountCents, payerEmail: input.payerEmail, idempotencyKey: payment.createIdempotencyKey, cardToken: input.card?.token ?? '', cardPaymentMethodId: input.card?.methodId ?? '', installments: 1 })
    const result = await applyProviderSnapshot(db, payment.id, snapshot, new Date())
    if (result.decision === 'REVIEW_REQUIRED') throw new CheckoutError('PAYMENT_REVIEW_REQUIRED', 503)
    if (result.decision === 'REJECTED') throw new CheckoutError('PAYMENT_REJECTED', 402)
    if (payment.method === 'PIX' && snapshot.pix) return { kind: 'PIX', qrCode: snapshot.pix.qrCode, qrCodeBase64: snapshot.pix.qrCodeBase64, expiresAt: (snapshot.pix.expiresAt ?? payment.expiresAt ?? new Date()).toISOString() }
    return { kind: result.decision === 'APPROVED' || result.decision === 'PARTIALLY_REFUNDED' ? 'APPROVED' : 'PENDING' }
  } catch (error) {
    if (error instanceof PaymentProviderError && error.kind === 'TRANSIENT_UNCERTAIN') throw new CheckoutError('PAYMENT_UNCERTAIN', 503)
    throw error
  }
}

export type PayerEmailResolver = (userEmail: string | null, userId: string) => string

async function persistRecoveryReview(db: Db, paymentId: string, now: Date, failure: string) {
  await db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
    if (!payment) return
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, payment.orderId)).limit(1)
    const changed = payment.reconciliationState !== 'REVIEW_REQUIRED' || payment.reconciliationFailure !== failure
    await tx.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: failure, nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, payment.id))
    if (changed && order) await tx.insert(orderEvents).values({ orderId: payment.orderId, status: order.status, actorRole: 'SYSTEM', actorId: null, note: 'pagamento em revisão' })
  })
}

async function expireUncertainPix(db: Db, paymentId: string, now: Date) {
  await db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
    if (!payment || payment.status !== 'PENDING') return
    const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).for('update')
    if (!order) return
    await tx.update(payments).set({ status: 'EXPIRED', reconciliationState: 'HEALTHY', reconciliationFailure: null, nextReconcileAt: null, lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, payment.id))
    if (order.status === 'AWAITING_PAYMENT') {
      await tx.update(orders).set({ status: 'CANCELLED', updatedAt: now }).where(and(eq(orders.id, order.id), eq(orders.status, 'AWAITING_PAYMENT')))
      await tx.insert(orderEvents).values({ orderId: order.id, status: 'CANCELLED', actorRole: 'SYSTEM', actorId: null, note: 'pagamento não aprovado' })
    }
  })
}

export async function recoverUncertainCreate(
  db: Db,
  provider: PaymentProvider,
  paymentId: string,
  now: Date,
  resolvePayerEmail: PayerEmailResolver,
): Promise<'RECOVERED' | 'RETRY_PIX' | 'FRESH_CARD_REQUIRED' | 'REVIEW_REQUIRED'> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1)
  if (!payment) {
    await persistRecoveryReview(db, paymentId, now, 'PAYMENT_NOT_FOUND')
    return 'REVIEW_REQUIRED'
  }
  let matches: Awaited<ReturnType<PaymentProvider['searchOrders']>>
  try {
    matches = await provider.searchOrders(payment.orderId)
  } catch (error) {
    if (payment.method === 'PIX' && error instanceof PaymentProviderError && ['TRANSIENT_UNCERTAIN', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE'].includes(error.kind)) {
      await db.update(payments).set({ reconciliationState: 'PENDING', reconciliationFailure: error.kind, nextReconcileAt: new Date(now.getTime() + 60_000), lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, payment.id))
      return 'RETRY_PIX'
    }
    await persistRecoveryReview(db, payment.id, now, error instanceof PaymentProviderError ? error.kind : 'SEARCH_FAILED')
    return 'REVIEW_REQUIRED'
  }
  if (matches.length > 1) {
    await persistRecoveryReview(db, payment.id, now, 'AMBIGUOUS_PROVIDER_CREATE')
    return 'REVIEW_REQUIRED'
  }
  if (matches.length === 0 && payment.method === 'CARD') {
    await persistRecoveryReview(db, payment.id, now, 'FRESH_CARD_REQUIRED')
    return 'FRESH_CARD_REQUIRED'
  }
  if (matches.length === 0 && payment.method === 'PIX') {
    if (payment.expiresAt && payment.expiresAt <= now) {
      await expireUncertainPix(db, payment.id, now)
      return 'RECOVERED'
    }
    const [identity] = await db.select({ email: users.email, userId: users.id }).from(orders).innerJoin(users, eq(users.id, orders.customerId)).where(eq(orders.id, payment.orderId)).limit(1)
    if (!identity) {
      await persistRecoveryReview(db, payment.id, now, 'PAYER_NOT_FOUND')
      return 'REVIEW_REQUIRED'
    }
    try {
      const accountId = await provider.getAccountId()
      if (accountId !== payment.expectedAccountId) throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')
      const snapshot = await provider.createOrder({ method: 'PIX', orderId: payment.orderId, amountCents: payment.expectedAmountCents, payerEmail: resolvePayerEmail(identity.email, identity.userId), idempotencyKey: payment.createIdempotencyKey, expiresAt: payment.expiresAt ?? new Date(now.getTime() + 15 * 60_000) })
      const result = await applyProviderSnapshot(db, payment.id, snapshot, now)
      return result.decision === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'RECOVERED'
    } catch (error) {
      if (error instanceof PaymentProviderError && ['TRANSIENT_UNCERTAIN', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE'].includes(error.kind)) {
        await db.update(payments).set({ reconciliationState: 'PENDING', reconciliationFailure: error.kind, nextReconcileAt: new Date(now.getTime() + 60_000), lastReconciledAt: now, updatedAt: now }).where(eq(payments.id, payment.id))
        return 'RETRY_PIX'
      }
      await persistRecoveryReview(db, payment.id, now, error instanceof PaymentProviderError ? error.kind : 'CREATE_FAILED')
      return 'REVIEW_REQUIRED'
    }
  }
  const result = await applyProviderSnapshot(db, payment.id, matches[0]!, now)
  return result.decision === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'RECOVERED'
}

import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { payments } from '../db/schema'
import { PaymentProviderError, type PaymentProvider } from './provider'
import { applyProviderSnapshot } from './transition.service'

type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

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

export async function recoverUncertainCreate(db: Db, provider: PaymentProvider, paymentId: string, now: Date): Promise<'RECOVERED' | 'RETRY_PIX' | 'FRESH_CARD_REQUIRED' | 'REVIEW_REQUIRED'> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1)
  if (!payment) return 'REVIEW_REQUIRED'
  const matches = await provider.searchOrders(payment.orderId)
  if (matches.length > 1) return 'REVIEW_REQUIRED'
  if (matches.length === 0) return payment.method === 'PIX' ? 'RETRY_PIX' : 'FRESH_CARD_REQUIRED'
  const result = await applyProviderSnapshot(db, payment.id, matches[0]!, now)
  return result.decision === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'RECOVERED'
}

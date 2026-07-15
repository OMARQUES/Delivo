import { and, eq, lte, or } from 'drizzle-orm'
import { createDb, type Db } from '../db/client'
import type { Env } from '../env'
import { paymentWebhookInbox, payments } from '../db/schema'
import { createPaymentProvider } from './mercadopago'
import { PaymentProviderError, type PaymentProvider } from './provider'
import { retryDisposition } from './retry'
import { applyProviderSnapshot } from './transition.service'

export async function enqueueWebhook(db: Db, input: {
  topic: 'order'
  resourceId: string
  requestId: string
  signatureTimestamp: string
}, now: Date): Promise<{ id: string; inserted: boolean }> {
  const [inserted] = await db.insert(paymentWebhookInbox).values({
    topic: input.topic,
    resourceId: input.resourceId,
    requestId: input.requestId,
    signatureTimestamp: input.signatureTimestamp,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
  }).onConflictDoNothing({ target: [paymentWebhookInbox.provider, paymentWebhookInbox.topic, paymentWebhookInbox.resourceId, paymentWebhookInbox.requestId] }).returning({ id: paymentWebhookInbox.id })
  if (inserted) return { id: inserted.id, inserted: true }
  const [existing] = await db.select({ id: paymentWebhookInbox.id }).from(paymentWebhookInbox).where(and(
    eq(paymentWebhookInbox.provider, 'MERCADO_PAGO'),
    eq(paymentWebhookInbox.topic, input.topic),
    eq(paymentWebhookInbox.resourceId, input.resourceId),
    eq(paymentWebhookInbox.requestId, input.requestId),
  )).limit(1)
  if (!existing) throw new Error('webhook dedupe row unavailable')
  return { id: existing.id, inserted: false }
}

async function markReview(db: Db, inboxId: string, failureClass: string, now: Date) {
  await db.update(paymentWebhookInbox).set({ status: 'REVIEW_REQUIRED', failureClass, updatedAt: now, processedAt: now, leaseOwner: null, leasedUntil: null }).where(eq(paymentWebhookInbox.id, inboxId))
}

export async function processWebhookInboxItem(db: Db, provider: PaymentProvider, inboxId: string, leaseOwner: string, now: Date): Promise<void> {
  const [claimed] = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(paymentWebhookInbox).where(and(
      eq(paymentWebhookInbox.id, inboxId),
      eq(paymentWebhookInbox.status, 'PENDING'),
      or(eq(paymentWebhookInbox.nextAttemptAt, now), lte(paymentWebhookInbox.nextAttemptAt, now)),
    )).for('update', { skipLocked: true }).limit(1)
    if (!row) return []
    const [updated] = await tx.update(paymentWebhookInbox).set({ status: 'PROCESSING', attemptCount: row.attemptCount + 1, leaseOwner, leasedUntil: new Date(now.getTime() + 5 * 60_000), updatedAt: now }).where(eq(paymentWebhookInbox.id, row.id)).returning()
    return updated ? [updated] : []
  })
  if (!claimed) return

  try {
    const providerAccount = await provider.getAccountId()
    const snapshot = await provider.getOrder(claimed.resourceId)
    if (snapshot.accountId !== providerAccount) {
      await markReview(db, inboxId, 'MISMATCH_ACCOUNT', now)
      return
    }
    const byProviderId = await db.select({ id: payments.id }).from(payments).where(eq(payments.providerOrderId, snapshot.providerOrderId)).limit(2)
    const candidates = byProviderId.length > 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshot.externalReference)
      ? byProviderId
      : await db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, snapshot.externalReference)).limit(2)
    if (candidates.length !== 1) {
      await markReview(db, inboxId, candidates.length === 0 ? 'UNKNOWN_ORDER' : 'AMBIGUOUS_ORDER', now)
      return
    }
    await applyProviderSnapshot(db, candidates[0]!.id, snapshot, now)
    await db.update(paymentWebhookInbox).set({ status: 'PROCESSED', processedAt: now, failureClass: null, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentWebhookInbox.id, inboxId))
  } catch (error) {
    const failureClass = error instanceof PaymentProviderError ? error.kind : 'UNEXPECTED'
    const retryAfterSeconds = error instanceof PaymentProviderError ? error.retryAfterSeconds : undefined
    const disposition = retryDisposition(now, claimed.attemptCount, 0.1, retryAfterSeconds)
    if (disposition.kind === 'REVIEW_REQUIRED') {
      await markReview(db, inboxId, 'RETRY_EXHAUSTED', now)
      return
    }
    await db.update(paymentWebhookInbox).set({ status: 'PENDING', nextAttemptAt: disposition.nextAttemptAt, failureClass, leaseOwner: null, leasedUntil: null, updatedAt: now }).where(eq(paymentWebhookInbox.id, inboxId))
    throw error
  }
}

export async function processWebhookInBackground(env: Env, inboxId: string, now: Date): Promise<void> {
  const { db, client } = createDb(env)
  try {
    const provider = createPaymentProvider(env)
    if (provider) await processWebhookInboxItem(db, provider, inboxId, crypto.randomUUID(), now)
  } finally {
    await client.end()
  }
}

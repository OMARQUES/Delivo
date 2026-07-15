import { and, eq, ne, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { orderEvents, orders, payments } from '../db/schema'
import type { ProviderOrderSnapshot } from './provider'
import { validateSnapshot, type SnapshotDecision } from './snapshot-validation'
import { enqueuePaymentOperation } from './operation-queue.service'

type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

export type TransitionResult = {
  changed: boolean
  decision: SnapshotDecision['kind']
  operationEnqueued: boolean
}

function expectedFrom(payment: typeof payments.$inferSelect) {
  return {
    paymentId: payment.id,
    orderId: payment.orderId,
    amountCents: payment.expectedAmountCents,
    currency: payment.expectedCurrency as 'BRL',
    countryCode: payment.expectedCountry as 'BR',
    method: payment.method,
    applicationId: payment.expectedApplicationId,
    accountId: payment.expectedAccountId,
    liveMode: payment.expectedLiveMode,
  }
}

async function event(tx: Parameters<Parameters<Db['transaction']>[0]>[0], orderId: string, status: typeof orders.$inferSelect.status, note: string) {
  await tx.insert(orderEvents).values({ orderId, status, actorRole: 'SYSTEM', actorId: null, note })
}

export async function applyProviderSnapshotInTransaction(tx: DbTransaction, paymentId: string, snapshot: ProviderOrderSnapshot, now: Date, options: { enqueueLateRefund?: boolean; releaseOrderOnApproval?: boolean } = {}): Promise<TransitionResult> {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
    if (!payment) throw new Error('payment not found')
    const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).for('update')
    if (!order) throw new Error('order not found')
    let decision = validateSnapshot(snapshot, expectedFrom(payment))
    if (decision.kind !== 'REVIEW_REQUIRED' && ((payment.providerOrderId !== null && payment.providerOrderId !== snapshot.providerOrderId) || (payment.providerTransactionId !== null && payment.providerTransactionId !== snapshot.providerTransactionId))) {
      decision = { kind: 'REVIEW_REQUIRED', failureCode: 'MISMATCH_PROVIDER_IDS' }
    }
    if (decision.kind !== 'REVIEW_REQUIRED') {
      const [conflict] = await tx.select({ id: payments.id }).from(payments).where(and(ne(payments.id, payment.id), or(eq(payments.providerOrderId, snapshot.providerOrderId), eq(payments.providerTransactionId, snapshot.providerTransactionId)))).limit(1)
      if (conflict) decision = { kind: 'REVIEW_REQUIRED', failureCode: 'MISMATCH_PROVIDER_IDS' }
    }
    const providerFields = {
      providerOrderId: snapshot.providerOrderId,
      providerTransactionId: snapshot.providerTransactionId,
      providerStatus: snapshot.orderStatus,
      providerStatusDetail: snapshot.orderStatusDetail,
      refundedAmountCents: snapshot.refundedAmountCents,
      qrCode: snapshot.pix?.qrCode ?? null,
      qrCodeBase64: snapshot.pix?.qrCodeBase64 ?? null,
      ticketUrl: snapshot.pix?.ticketUrl ?? null,
      expiresAt: snapshot.pix?.expiresAt ?? payment.expiresAt,
      lastReconciledAt: now,
      updatedAt: now,
    }

    if (decision.kind === 'REVIEW_REQUIRED') {
      const changed = payment.reconciliationState !== 'REVIEW_REQUIRED' || payment.reconciliationFailure !== decision.failureCode
      await tx.update(payments).set({
        providerStatus: snapshot.orderStatus,
        providerStatusDetail: snapshot.orderStatusDetail,
        lastReconciledAt: now,
        updatedAt: now,
        reconciliationState: 'REVIEW_REQUIRED',
        reconciliationFailure: decision.failureCode,
        nextReconcileAt: null,
      }).where(eq(payments.id, payment.id))
      if (changed) await event(tx, order.id, order.status, 'pagamento em revisão')
      return { changed, decision: decision.kind, operationEnqueued: false }
    }

    if (payment.status === 'REFUNDED') return { changed: false, decision: decision.kind, operationEnqueued: false }
    if (payment.status === 'APPROVED' && ['PENDING', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(decision.kind)) {
      return { changed: false, decision: decision.kind, operationEnqueued: false }
    }

    if (decision.kind === 'PENDING') {
      const changed = payment.reconciliationState !== 'HEALTHY' || payment.providerStatus !== snapshot.orderStatus
      await tx.update(payments).set({ ...providerFields, status: payment.status === 'PENDING' ? 'PENDING' : payment.status, reconciliationState: 'HEALTHY', reconciliationFailure: null, reconciliationAttemptCount: 0, nextReconcileAt: new Date(now.getTime() + 5 * 60_000) }).where(eq(payments.id, payment.id))
      return { changed, decision: decision.kind, operationEnqueued: false }
    }

    if (decision.kind === 'APPROVED' || decision.kind === 'PARTIALLY_REFUNDED' || decision.kind === 'REFUNDED') {
      const alreadyApproved = payment.status === 'APPROVED'
      await tx.update(payments).set({ ...providerFields, status: decision.kind === 'REFUNDED' ? 'REFUNDED' : 'APPROVED', refundedAmountCents: snapshot.refundedAmountCents, reconciliationState: 'HEALTHY', reconciliationFailure: null, reconciliationAttemptCount: 0, nextReconcileAt: null }).where(eq(payments.id, payment.id))
      if (order.status === 'CANCELLED' && options.enqueueLateRefund !== false) {
        const operation = await enqueuePaymentOperation(tx, { paymentId: payment.id, type: 'REFUND_FULL', amountCents: null, businessKey: `refund-full:${payment.id}:LATE_APPROVAL`, idempotencyKey: `refund-full:${payment.id}:LATE_APPROVAL` }, now)
        if (operation.inserted) await event(tx, order.id, order.status, 'pagamento tardio: estorno pendente')
        return { changed: !alreadyApproved || operation.inserted, decision: decision.kind, operationEnqueued: operation.inserted }
      }
      if (alreadyApproved) return { changed: false, decision: decision.kind, operationEnqueued: false }
      if (order.status === 'AWAITING_PAYMENT' && options.releaseOrderOnApproval !== false) {
        await tx.update(orders).set({ status: 'PENDING', updatedAt: now }).where(and(eq(orders.id, order.id), eq(orders.status, 'AWAITING_PAYMENT')))
        await event(tx, order.id, 'PENDING', 'pagamento confirmado')
      }
      return { changed: true, decision: decision.kind, operationEnqueued: false }
    }

    const nextStatus = decision.kind
    const changed = payment.status !== nextStatus
    await tx.update(payments).set({ ...providerFields, status: nextStatus, reconciliationState: 'HEALTHY', reconciliationFailure: null, reconciliationAttemptCount: 0, nextReconcileAt: null }).where(eq(payments.id, payment.id))
    if (changed && order.status === 'AWAITING_PAYMENT') {
      await tx.update(orders).set({ status: 'CANCELLED', updatedAt: now }).where(and(eq(orders.id, order.id), eq(orders.status, 'AWAITING_PAYMENT')))
      await event(tx, order.id, 'CANCELLED', 'pagamento não aprovado')
    }
    return { changed, decision: decision.kind, operationEnqueued: false }
}

export async function applyProviderSnapshot(db: Db, paymentId: string, snapshot: ProviderOrderSnapshot, now: Date, options: { enqueueLateRefund?: boolean; releaseOrderOnApproval?: boolean } = {}): Promise<TransitionResult> {
  return db.transaction((tx) => applyProviderSnapshotInTransaction(tx, paymentId, snapshot, now, options))
}

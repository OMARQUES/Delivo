import type { ExpectedPayment, ProviderOrderSnapshot } from './provider'

export type SnapshotDecision =
  | { kind: 'PENDING'; qrAvailable: boolean }
  | { kind: 'APPROVED' }
  | { kind: 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED' }
  | { kind: 'PARTIALLY_REFUNDED'; refundedAmountCents: number }
  | { kind: 'REVIEW_REQUIRED'; failureCode: `MISMATCH_${string}` | `UNSUPPORTED_${string}` }

function review(failureCode: `MISMATCH_${string}` | `UNSUPPORTED_${string}`): SnapshotDecision {
  return { kind: 'REVIEW_REQUIRED', failureCode }
}

export function validateSnapshot(snapshot: ProviderOrderSnapshot, expected: ExpectedPayment): SnapshotDecision {
  if (snapshot.providerOrderId.length === 0 || snapshot.providerTransactionId.length === 0 || snapshot.providerOrderId === snapshot.providerTransactionId) return review('MISMATCH_PROVIDER_IDS')
  if (snapshot.externalReference !== expected.orderId) return review('MISMATCH_EXTERNAL_REFERENCE')
  if (snapshot.totalAmountCents !== expected.amountCents) return review('MISMATCH_AMOUNT')
  if (snapshot.countryCode !== expected.countryCode) return review('MISMATCH_COUNTRY')
  if (snapshot.currency !== expected.currency) return review('MISMATCH_CURRENCY')
  if (snapshot.method !== expected.method) return review('MISMATCH_METHOD')
  if (snapshot.applicationId !== expected.applicationId) return review('MISMATCH_APPLICATION')
  if (snapshot.accountId !== expected.accountId) return review('MISMATCH_ACCOUNT')
  if (snapshot.liveMode !== expected.liveMode) return review('MISMATCH_ENVIRONMENT')
  if (snapshot.processingMode !== 'automatic') return review('UNSUPPORTED_PROCESSING_MODE')
  if (snapshot.transactionCount !== 1) return review('MISMATCH_TRANSACTION_COUNT')
  if (!Number.isSafeInteger(snapshot.refundedAmountCents) || snapshot.refundedAmountCents < 0 || snapshot.refundedAmountCents > snapshot.totalAmountCents) return review('MISMATCH_REFUNDED_AMOUNT')

  const orderStatus = snapshot.orderStatus.toLowerCase()
  const transactionStatus = snapshot.transactionStatus?.toLowerCase() ?? null
  const orderDetail = snapshot.orderStatusDetail.toLowerCase()
  const transactionDetail = snapshot.transactionStatusDetail?.toLowerCase() ?? null
  const statuses = [orderStatus, transactionStatus].filter((status): status is string => status !== null)
  const details = [orderDetail, transactionDetail].filter((detail): detail is string => detail !== null)
  const failed = orderStatus === 'failed' || orderStatus === 'rejected' || transactionStatus === 'failed' || transactionStatus === 'rejected'
  if ([...statuses, ...details].some((value) => value.includes('charged_back') || value.includes('chargeback'))) return review('UNSUPPORTED_CHARGEBACK')
  if (!failed && (
    statuses.some((status) => status.includes('capture') || status.includes('challenge'))
    || details.some((detail) => detail !== 'waiting_capture' && (detail.includes('capture') || detail.includes('challenge')))
  )) return review('UNSUPPORTED_CAPTURE')
  if (statuses.some((status) => status.includes('partially_refunded')) || orderDetail.includes('partially_refunded') || transactionDetail?.includes('partially_refunded')) {
    return snapshot.refundedAmountCents > 0 ? { kind: 'PARTIALLY_REFUNDED', refundedAmountCents: snapshot.refundedAmountCents } : review('MISMATCH_REFUNDED_AMOUNT')
  }

  const supported = new Set(['created', 'pending', 'processing', 'in_process', 'in_review', 'action_required', 'waiting_payment', 'waiting_transfer', 'processed', 'accredited', 'failed', 'rejected', 'canceled', 'cancelled', 'expired', 'refunded'])
  if (statuses.some((status) => !supported.has(status) && !status.startsWith('cc_rejected'))) return review('UNSUPPORTED_PROVIDER_STATE')
  if (failed || [...details, transactionStatus].some((value) => value?.startsWith('cc_rejected'))) return { kind: 'REJECTED' }
  if (orderStatus === 'canceled' || orderStatus === 'cancelled') return { kind: 'CANCELLED' }
  if (orderStatus === 'expired') return { kind: 'EXPIRED' }
  if (orderStatus === 'refunded') {
    return snapshot.refundedAmountCents === expected.amountCents
      ? { kind: 'REFUNDED' }
      : review('MISMATCH_REFUNDED_AMOUNT')
  }
  if (orderStatus === 'processed' && (orderDetail === 'accredited' || transactionStatus === 'accredited' || transactionStatus === 'processed')) return { kind: 'APPROVED' }
  if (['created', 'pending', 'processing', 'in_process', 'in_review', 'action_required', 'waiting_payment', 'waiting_transfer'].includes(orderStatus)) return { kind: 'PENDING', qrAvailable: snapshot.pix !== null }
  return review('UNSUPPORTED_PROVIDER_STATE')
}

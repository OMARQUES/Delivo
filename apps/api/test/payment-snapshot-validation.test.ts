import { describe, expect, it } from 'vitest'
import { providerSnapshot } from './helpers/payment-provider'
import { validateSnapshot } from '../src/payments/snapshot-validation'
import type { ExpectedPayment, ProviderOrderSnapshot } from '../src/payments/provider'

const expected: ExpectedPayment = {
  paymentId: 'payment-test', orderId: 'order-local', amountCents: 6400,
  currency: 'BRL', countryCode: 'BR', method: 'PIX', applicationId: 'app-test', accountId: 'account-test', liveMode: false,
}
const valid = providerSnapshot()

describe('validateSnapshot', () => {
  it.each([
    ['MISMATCH_EXTERNAL_REFERENCE', { externalReference: 'other' }],
    ['MISMATCH_AMOUNT', { totalAmountCents: 999 }],
    ['MISMATCH_COUNTRY', { countryCode: 'AR' }],
    ['MISMATCH_CURRENCY', { currency: 'USD' }],
    ['MISMATCH_METHOD', { method: 'CARD' }],
    ['MISMATCH_APPLICATION', { applicationId: 'other' }],
    ['MISMATCH_ACCOUNT', { accountId: 'other' }],
    ['MISMATCH_ENVIRONMENT', { liveMode: true }],
    ['MISMATCH_TRANSACTION_COUNT', { transactionCount: 2 }],
  ] as const)('%s fails closed', (failureCode, patch) => {
    expect(validateSnapshot({ ...valid, ...patch } as ProviderOrderSnapshot, expected)).toEqual({ kind: 'REVIEW_REQUIRED', failureCode })
  })

  it.each([
    ['created', 'created', 'PENDING'],
    ['processing', 'in_process', 'PENDING'],
    ['action_required', 'waiting_transfer', 'PENDING'],
    ['processed', 'accredited', 'APPROVED'],
    ['failed', 'cc_rejected_other', 'REJECTED'],
    ['canceled', 'canceled', 'CANCELLED'],
    ['expired', 'expired', 'EXPIRED'],
    ['refunded', 'refunded', 'REFUNDED'],
  ] as const)('%s/%s maps to %s', (orderStatus, transactionStatus, kind) => {
    const decision = validateSnapshot({
      ...valid,
      orderStatus,
      transactionStatus,
      transactionStatusDetail: transactionStatus,
      ...(orderStatus === 'refunded' ? { refundedAmountCents: expected.amountCents } : {}),
    }, expected)
    expect(decision).toEqual(kind === 'PENDING' ? { kind, qrAvailable: true } : { kind })
  })

  it('maps partial refund and keeps exact cents', () => {
    expect(validateSnapshot({ ...valid, orderStatus: 'processed', orderStatusDetail: 'partially_refunded', refundedAmountCents: 1200 }, expected)).toEqual({ kind: 'PARTIALLY_REFUNDED', refundedAmountCents: 1200 })
  })

  it.each([
    ['charged_back', 'UNSUPPORTED_CHARGEBACK'],
    ['capture_required', 'UNSUPPORTED_CAPTURE'],
    ['mystery', 'UNSUPPORTED_PROVIDER_STATE'],
  ] as const)('%s requires review', (status, failureCode) => {
    expect(validateSnapshot({ ...valid, orderStatus: status, transactionStatus: status }, expected)).toEqual({ kind: 'REVIEW_REQUIRED', failureCode })
  })

  it('rejects provider IDs conflict and refunded overflow', () => {
    expect(validateSnapshot({ ...valid, providerOrderId: 'same' , providerTransactionId: 'same' }, expected)).toEqual({ kind: 'REVIEW_REQUIRED', failureCode: 'MISMATCH_PROVIDER_IDS' })
    expect(validateSnapshot({ ...valid, refundedAmountCents: 6401 }, expected)).toEqual({ kind: 'REVIEW_REQUIRED', failureCode: 'MISMATCH_REFUNDED_AMOUNT' })
  })
})

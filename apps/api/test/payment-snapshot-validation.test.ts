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

  it('fails closed when adapter omits application identity', () => {
    expect(validateSnapshot({ ...valid, applicationId: null }, expected)).toEqual({ kind: 'REVIEW_REQUIRED', failureCode: 'MISMATCH_APPLICATION' })
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

  it.each([
    'bad_filled_card_data',
    'invalid_card_token',
    'high_risk',
    'rejected_by_issuer',
    'required_call_for_authorize',
    'max_attempts_exceeded',
    'card_disabled',
    'insufficient_amount',
    'card_insufficient_amount',
    'amount_limit_exceeded',
    'processing_error',
    'invalid_installments',
    '3ds_challenge_expired',
    'new_future_decline_detail',
  ])('maps validated failed transaction detail %s to REJECTED', (detail) => {
    expect(validateSnapshot({
      ...valid,
      orderStatus: 'failed',
      orderStatusDetail: 'failed',
      transactionStatus: 'failed',
      transactionStatusDetail: detail,
    }, expected)).toEqual({ kind: 'REJECTED' })
  })

  it.each([
    ['created', 'created'],
    ['processing', 'in_process'],
    ['action_required', 'waiting_payment'],
    ['action_required', 'waiting_capture'],
    ['action_required', 'waiting_transfer'],
  ])('maps %s/%s to PENDING', (orderStatus, detail) => {
    expect(validateSnapshot({
      ...valid,
      orderStatus,
      orderStatusDetail: detail,
      transactionStatus: orderStatus,
      transactionStatusDetail: detail,
    }, expected)).toMatchObject({ kind: 'PENDING' })
  })

  it.each(['waiting_payment', 'waiting_transfer'])(
    'accepts documented transaction waiting state %s under action_required',
    (transactionStatus) => {
      expect(validateSnapshot({
        ...valid,
        orderStatus: 'action_required',
        orderStatusDetail: transactionStatus,
        transactionStatus,
        transactionStatusDetail: transactionStatus,
      }, expected)).toMatchObject({ kind: 'PENDING' })
    },
  )

  it('fails closed on chargeback detail even when top-level states look approved', () => {
    expect(validateSnapshot({
      ...valid,
      orderStatus: 'processed',
      orderStatusDetail: 'charged_back',
      transactionStatus: 'processed',
      transactionStatusDetail: 'charged_back',
    }, expected)).toEqual({ kind: 'REVIEW_REQUIRED', failureCode: 'UNSUPPORTED_CHARGEBACK' })
  })

  it('fails closed on an active challenge flow but not a failed challenge detail', () => {
    expect(validateSnapshot({
      ...valid,
      orderStatus: 'action_required',
      orderStatusDetail: '3ds_challenge_required',
      transactionStatus: 'action_required',
      transactionStatusDetail: '3ds_challenge_required',
    }, expected)).toEqual({ kind: 'REVIEW_REQUIRED', failureCode: 'UNSUPPORTED_CAPTURE' })
    expect(validateSnapshot({
      ...valid,
      orderStatus: 'failed',
      orderStatusDetail: 'failed',
      transactionStatus: 'failed',
      transactionStatusDetail: '3ds_challenge_expired',
    }, expected)).toEqual({ kind: 'REJECTED' })
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

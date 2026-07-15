import { describe, expect, it } from 'vitest'
import { validateSnapshot } from '../src/payments/snapshot-validation'
import type { ExpectedPayment } from '../src/payments/provider'
import { providerSnapshot } from './helpers/payment-provider'

const expected: ExpectedPayment = {
  paymentId: '00000000-0000-4000-8000-000000000001',
  orderId: '00000000-0000-4000-8000-000000000002',
  amountCents: 6400,
  currency: 'BRL',
  countryCode: 'BR',
  method: 'PIX',
  applicationId: 'app-test',
  accountId: 'account-test',
  liveMode: false,
}

function refunded(refundedAmountCents: number) {
  return providerSnapshot({
    externalReference: expected.orderId,
    totalAmountCents: expected.amountCents,
    orderStatus: 'refunded',
    orderStatusDetail: 'refunded',
    transactionStatus: 'refunded',
    transactionStatusDetail: 'refunded',
    refundedAmountCents,
  })
}

describe('validateSnapshot financial invariants', () => {
  it('rejects every processing mode except automatic', () => {
    expect(validateSnapshot(providerSnapshot({
      externalReference: expected.orderId,
      processingMode: 'aggregator',
    }), expected)).toEqual({
      kind: 'REVIEW_REQUIRED',
      failureCode: 'UNSUPPORTED_PROCESSING_MODE',
    })
  })

  it.each([0, 1, 6399])('rejects refunded state below exact total: %s', (amount) => {
    expect(validateSnapshot(refunded(amount), expected)).toEqual({
      kind: 'REVIEW_REQUIRED',
      failureCode: 'MISMATCH_REFUNDED_AMOUNT',
    })
  })

  it('accepts refunded state only at exact total', () => {
    expect(validateSnapshot(refunded(6400), expected)).toEqual({ kind: 'REFUNDED' })
  })

  it('rejects refunded amount above total before status classification', () => {
    expect(validateSnapshot(refunded(6401), expected)).toEqual({
      kind: 'REVIEW_REQUIRED',
      failureCode: 'MISMATCH_REFUNDED_AMOUNT',
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { logPaymentProviderFailure } from '../src/payments/provider-diagnostics'
import { PaymentProviderError } from '../src/payments/provider'

describe('logPaymentProviderFailure', () => {
  it('emits only the diagnostic allowlist', () => {
    const logger = { error: vi.fn() }
    logPaymentProviderFailure(
      new PaymentProviderError('PROVIDER_RESPONSE_INVALID', 400),
      { paymentMethod: 'PIX', requestId: '00000000-0000-4000-8000-000000000001' },
      logger,
    )

    expect(logger.error).toHaveBeenCalledWith('payment_provider_failure', {
      failureClass: 'PROVIDER_RESPONSE_INVALID',
      upstreamStatus: 400,
      paymentMethod: 'PIX',
      requestId: '00000000-0000-4000-8000-000000000001',
    })
    expect(Object.keys(logger.error.mock.calls[0]![1]).sort()).toEqual([
      'failureClass', 'paymentMethod', 'requestId', 'upstreamStatus',
    ])
  })

  it('uses null when provider has no upstream status', () => {
    const logger = { error: vi.fn() }
    logPaymentProviderFailure(
      new PaymentProviderError('TRANSIENT_UNCERTAIN'),
      { paymentMethod: 'CARD', requestId: '00000000-0000-4000-8000-000000000002' },
      logger,
    )

    expect(logger.error).toHaveBeenCalledWith('payment_provider_failure', {
      failureClass: 'TRANSIENT_UNCERTAIN',
      upstreamStatus: null,
      paymentMethod: 'CARD',
      requestId: '00000000-0000-4000-8000-000000000002',
    })
  })
})

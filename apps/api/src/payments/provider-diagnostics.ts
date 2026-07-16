import type { OnlinePaymentMethod } from './provider'
import { PaymentProviderError } from './provider'

type ErrorLogger = Pick<Console, 'error'>

export function logPaymentProviderFailure(
  error: PaymentProviderError,
  context: { paymentMethod: OnlinePaymentMethod; requestId: string },
  logger: ErrorLogger = console,
): void {
  logger.error('payment_provider_failure', {
    failureClass: error.kind,
    upstreamStatus: error.httpStatus ?? null,
    paymentMethod: context.paymentMethod,
    requestId: context.requestId,
  })
}

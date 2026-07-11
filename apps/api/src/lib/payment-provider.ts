export type PixPaymentResult = {
  providerPaymentId: string
  status: 'PENDING'
  qrCode: string
  qrCodeBase64: string
  ticketUrl: string | null
  expiresAt: Date
}

export type CardPaymentResult = {
  providerPaymentId: string
  /** MP resolve cartão sincronamente */
  status: 'APPROVED' | 'REJECTED' | 'PENDING'
  statusDetail: string
}

export type ProviderPaymentStatus = {
  providerPaymentId: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REFUNDED' | 'EXPIRED'
}

export interface PaymentProvider {
  createPixPayment(input: {
    orderId: string
    amountCents: number
    description: string
    payerEmail: string
    expiresAt: Date
    notificationUrl: string | null
  }): Promise<PixPaymentResult>

  createCardPayment(input: {
    orderId: string
    amountCents: number
    description: string
    payerEmail: string
    cardToken: string
    cardPaymentMethodId: string
    installments: number
  }): Promise<CardPaymentResult>

  getPayment(providerPaymentId: string): Promise<ProviderPaymentStatus>

  /** Estorno TOTAL. Idempotente no gateway. */
  refundPayment(providerPaymentId: string): Promise<void>

  /** Estorno PARCIAL (amount em centavos). Idempotente por (payment, amount). */
  refundPartial(providerPaymentId: string, amountCents: number): Promise<void>

  /** Cancela pagamento pendente (PIX expirado). Best-effort. */
  cancelPayment(providerPaymentId: string): Promise<void>
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    public status: 400 | 402 | 502 = 502,
    /** HTTP status cru do gateway (ex.: 404 = pagamento inexistente no MP) */
    public httpStatus?: number,
  ) {
    super(message)
  }
}

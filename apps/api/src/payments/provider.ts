export type OnlinePaymentMethod = 'PIX' | 'CARD'

export type ProviderFailureKind =
  | 'TRANSIENT_UNCERTAIN'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CREDENTIAL_OR_CONFIG'
  | 'ORDER_NOT_FOUND'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'CREATE_REQUIRES_RECOVERY'
  | 'MUTATION_REQUIRES_READ'
  | 'RESOURCE_LOCKED'

export type ProviderOrderSnapshot = {
  providerOrderId: string
  providerTransactionId: string
  orderStatus: string
  orderStatusDetail: string
  transactionStatus: string | null
  transactionStatusDetail: string | null
  externalReference: string
  totalAmountCents: number
  refundedAmountCents: number
  countryCode: string
  currency: string | null
  processingMode: string
  method: OnlinePaymentMethod | 'UNKNOWN'
  paymentMethodId: string
  applicationId: string | null
  accountId: string | null
  liveMode: boolean
  transactionCount: number
  pix: {
    qrCode: string
    qrCodeBase64: string | null
    ticketUrl: string | null
    expiresAt: Date | null
  } | null
  updatedAt: Date | null
}

export type ProviderOrderMatch = Pick<ProviderOrderSnapshot, 'providerOrderId' | 'externalReference'>

export type ExpectedPayment = {
  paymentId: string
  orderId: string
  amountCents: number
  currency: 'BRL'
  countryCode: 'BR'
  method: OnlinePaymentMethod
  applicationId: string
  accountId: string
  liveMode: boolean
}

type CreateOrderBase = {
  orderId: string
  amountCents: number
  payerEmail: string
  idempotencyKey: string
}

export type CreateOrderInput =
  | (CreateOrderBase & { method: 'PIX'; expiresAt: Date })
  | (CreateOrderBase & {
      method: 'CARD'
      cardToken: string
      cardPaymentMethodId: string
      installments: 1
    })

export interface PaymentProvider {
  createOrder(input: CreateOrderInput): Promise<ProviderOrderSnapshot>
  getOrder(providerOrderId: string): Promise<ProviderOrderSnapshot>
  searchOrders(externalReference: string, createdAt: Date, now: Date): Promise<ProviderOrderMatch[]>
  cancelOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrderSnapshot>
  refundOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrderSnapshot>
  refundPartial(
    providerOrderId: string,
    providerTransactionId: string,
    amountCents: number,
    idempotencyKey: string,
  ): Promise<ProviderOrderSnapshot>
  getAccountId(): Promise<string>
}

export class PaymentProviderError extends Error {
  constructor(
    public readonly kind: ProviderFailureKind,
    public readonly httpStatus?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Payment provider failure: ${kind}`)
    this.name = 'PaymentProviderError'
  }
}

const PROVIDER_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{1,64}$/

export function assertProviderIdempotencyKey(value: string): string {
  if (!PROVIDER_IDEMPOTENCY_KEY_RE.test(value)) throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')
  return value
}

export function providerIdempotencyKey(scope: string, stableId: string): string {
  return assertProviderIdempotencyKey(`${scope}:${stableId}`)
}

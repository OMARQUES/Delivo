import type { Env } from '../env'
import { PIX_EXPIRATION_DURATION } from './constants'
import { formatProviderAmount, parseProviderAmount } from './money'
import {
  PaymentProviderError,
  type CreateOrderInput,
  type PaymentProvider,
  type ProviderOrderSnapshot,
} from './provider'

const ORDERS_BASE = 'https://api.mercadopago.com/v1/orders'
const USER_URL = 'https://api.mercadolibre.com/users/me'

type ProviderConfig = { applicationId: string; accountId: string; liveMode: boolean }
type Json = Record<string, unknown>

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
  return value
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optionalIdentifier(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function normalizeCountry(value: unknown): string {
  const country = requiredString(value).toUpperCase()
  return country === 'BRA' ? 'BR' : country
}

function amount(value: unknown): number {
  if (typeof value !== 'string') throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
  try { return parseProviderAmount(value) } catch { throw new PaymentProviderError(`PROVIDER_RESPONSE_INVALID`) }
}

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
  return date
}

export class MercadoPagoOrdersProvider implements PaymentProvider {
  private verifiedAccountId: string | null = null

  constructor(
    private readonly accessToken: string,
    private readonly config: ProviderConfig,
    private readonly timeoutMs = 8_000,
  ) {}

  private async request<T>(url: string, init: RequestInit = {}, idempotencyKey?: string): Promise<T | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const incoming = init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init.headers ?? {}) as Record<string, string>
    const headers: Record<string, string> = {
      ...incoming,
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    }
    try {
      const response = await fetch(url, { ...init, headers, signal: controller.signal })
      if (!response.ok) {
        const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10)
        const kind = response.status === 401 || response.status === 403
          ? 'CREDENTIAL_OR_CONFIG'
          : response.status === 404
            ? 'ORDER_NOT_FOUND'
            : response.status === 429
              ? 'RATE_LIMITED'
              : response.status >= 500
                ? 'PROVIDER_UNAVAILABLE'
                : 'PROVIDER_RESPONSE_INVALID'
        throw new PaymentProviderError(kind, response.status, Number.isFinite(retryAfter) ? retryAfter : undefined)
      }
      const text = await response.text()
      if (!text) return null
      try { return JSON.parse(text) as T } catch { throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID', response.status) }
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error
      throw new PaymentProviderError('TRANSIENT_UNCERTAIN')
    } finally {
      clearTimeout(timeout)
    }
  }

  private normalize(raw: unknown): ProviderOrderSnapshot {
    const order = asObject(raw)
    const transactions = asObject(order.transactions).payments
    if (!Array.isArray(transactions) || transactions.length !== 1) throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
    const transaction = asObject(transactions[0])
    const paymentMethod = asObject(transaction.payment_method)
    const methodId = requiredString(paymentMethod.id ?? transaction.payment_method_id)
    const method: ProviderOrderSnapshot['method'] = methodId.toLowerCase() === 'pix' || paymentMethod.type === 'bank_transfer' ? 'PIX' : paymentMethod.type === 'credit_card' ? 'CARD' : 'UNKNOWN'
    const orderId = requiredString(order.id)
    const transactionId = requiredString(transaction.id)
    const totalAmountCents = amount(order.total_amount)
    const refundedRaw = transaction.refunded_amount ?? order.refunded_amount ?? '0.00'
    const integrationData = asObject(order.integration_data)
    const pix = method === 'PIX'
      ? { qrCode: requiredString(paymentMethod.qr_code), qrCodeBase64: requiredString(paymentMethod.qr_code_base64), ticketUrl: optionalString(paymentMethod.ticket_url), expiresAt: dateOrNull(transaction.date_of_expiration ?? order.date_of_expiration) }
      : null
    return {
      providerOrderId: orderId,
      providerTransactionId: transactionId,
      orderStatus: requiredString(order.status),
      orderStatusDetail: requiredString(order.status_detail),
      transactionStatus: optionalString(transaction.status),
      transactionStatusDetail: optionalString(transaction.status_detail),
      externalReference: requiredString(order.external_reference),
      totalAmountCents,
      refundedAmountCents: amount(refundedRaw),
      countryCode: normalizeCountry(order.country_code),
      currency: optionalString(order.currency) ?? 'BRL',
      processingMode: requiredString(order.processing_mode),
      method,
      paymentMethodId: methodId,
      applicationId: optionalIdentifier(integrationData.application_id),
      accountId: optionalIdentifier(order.user_id ?? order.collector_id) ?? this.verifiedAccountId,
      liveMode: typeof order.live_mode === 'boolean' ? order.live_mode : this.config.liveMode,
      transactionCount: transactions.length,
      pix,
      updatedAt: dateOrNull(order.last_updated_date),
    }
  }

  async createOrder(input: CreateOrderInput): Promise<ProviderOrderSnapshot> {
    const amountText = formatProviderAmount(input.amountCents)
    const payment = input.method === 'PIX'
      ? { amount: amountText, payment_method: { id: 'pix', type: 'bank_transfer' }, expiration_time: PIX_EXPIRATION_DURATION }
      : { amount: amountText, payment_method: { id: input.cardPaymentMethodId, type: 'credit_card', token: input.cardToken, installments: 1 } }
    const raw = await this.request<Json>(ORDERS_BASE, {
      method: 'POST',
      body: JSON.stringify({ type: 'online', processing_mode: 'automatic', external_reference: input.orderId, total_amount: amountText, payer: { email: input.payerEmail }, transactions: { payments: [payment] } }),
    }, input.idempotencyKey)
    if (!raw) throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
    return this.normalize(raw)
  }

  async getOrder(providerOrderId: string): Promise<ProviderOrderSnapshot> {
    const raw = await this.request<Json>(`${ORDERS_BASE}/${encodeURIComponent(providerOrderId)}`)
    if (!raw) throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
    return this.normalize(raw)
  }

  async searchOrders(externalReference: string): Promise<ProviderOrderSnapshot[]> {
    const raw = await this.request<Json>(`${ORDERS_BASE}/search?external_reference=${encodeURIComponent(externalReference)}`)
    const results = asObject(raw).results
    if (!Array.isArray(results)) throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
    return results.map((item) => this.normalize(item))
  }

  private async mutation(path: string, key: string, body: Json): Promise<ProviderOrderSnapshot> {
    const raw = await this.request<Json>(`${ORDERS_BASE}/${path}`, { method: 'POST', body: JSON.stringify(body) }, key)
    if (!raw) return this.getOrder(path.split('/')[0]!)
    return this.normalize(raw)
  }

  cancelOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrderSnapshot> {
    return this.mutation(`${encodeURIComponent(providerOrderId)}/cancel`, idempotencyKey, {})
  }

  refundOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrderSnapshot> {
    return this.mutation(`${encodeURIComponent(providerOrderId)}/refund`, idempotencyKey, {})
  }

  refundPartial(providerOrderId: string, providerTransactionId: string, amountCents: number, idempotencyKey: string): Promise<ProviderOrderSnapshot> {
    return this.mutation(`${encodeURIComponent(providerOrderId)}/refund`, idempotencyKey, { transactions: [{ id: providerTransactionId, amount: formatProviderAmount(amountCents) }] })
  }

  async getAccountId(): Promise<string> {
    const raw = await this.request<Json>(USER_URL)
    const id = raw && (asObject(raw).id)
    if (typeof id !== 'string' && typeof id !== 'number') throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')
    this.verifiedAccountId = String(id)
    return this.verifiedAccountId
  }
}

export function createPaymentProvider(env: Env): PaymentProvider | null {
  if (!env.MP_ACCESS_TOKEN || !env.MP_APPLICATION_ID || !env.MP_ACCOUNT_ID || (env.MP_LIVE_MODE !== 'true' && env.MP_LIVE_MODE !== 'false')) return null
  return new MercadoPagoOrdersProvider(env.MP_ACCESS_TOKEN, { applicationId: env.MP_APPLICATION_ID, accountId: env.MP_ACCOUNT_ID, liveMode: env.MP_LIVE_MODE === 'true' })
}

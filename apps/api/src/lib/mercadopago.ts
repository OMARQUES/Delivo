import type {
  CardPaymentResult, PaymentProvider, PixPaymentResult, ProviderPaymentStatus,
} from './payment-provider'
import { PaymentProviderError } from './payment-provider'
import type { Env } from '../env'

const BASE = 'https://api.mercadopago.com'

/** centavos -> reais com 2 casas (MP usa decimal) */
function centsToReais(cents: number): number {
  return Math.round(cents) / 100
}

function mapStatus(mp: string): ProviderPaymentStatus['status'] {
  switch (mp) {
    case 'approved': return 'APPROVED'
    case 'rejected': return 'REJECTED'
    case 'cancelled': return 'CANCELLED'
    case 'refunded':
    case 'charged_back': return 'REFUNDED'
    case 'expired': return 'EXPIRED'
    default: return 'PENDING'
  }
}

export class MercadoPagoProvider implements PaymentProvider {
  constructor(private accessToken: string) {}

  private async request<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
    }
    const res = await fetch(`${BASE}${path}`, { ...init, headers })
    if (!res.ok) {
      throw new PaymentProviderError(`Gateway de pagamento indisponível (${res.status})`, 502)
    }
    return (await res.json()) as T
  }

  async createPixPayment(input: Parameters<PaymentProvider['createPixPayment']>[0]): Promise<PixPaymentResult> {
    type MpPayment = {
      id: number
      status: string
      point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } }
    }
    const body = {
      transaction_amount: centsToReais(input.amountCents),
      description: input.description,
      payment_method_id: 'pix',
      external_reference: input.orderId,
      date_of_expiration: input.expiresAt.toISOString(),
      ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
      payer: { email: input.payerEmail },
    }
    const mp = await this.request<MpPayment>('/v1/payments', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: `${input.orderId}-pix`,
    })
    const td = mp.point_of_interaction?.transaction_data
    if (!td?.qr_code || !td.qr_code_base64) throw new PaymentProviderError('Gateway não retornou QR do PIX', 502)
    return {
      providerPaymentId: String(mp.id),
      status: 'PENDING',
      qrCode: td.qr_code,
      qrCodeBase64: td.qr_code_base64,
      ticketUrl: td.ticket_url ?? null,
      expiresAt: input.expiresAt,
    }
  }

  async createCardPayment(input: Parameters<PaymentProvider['createCardPayment']>[0]): Promise<CardPaymentResult> {
    type MpPayment = { id: number; status: string; status_detail?: string }
    const body = {
      transaction_amount: centsToReais(input.amountCents),
      description: input.description,
      token: input.cardToken,
      payment_method_id: input.cardPaymentMethodId,
      installments: input.installments,
      external_reference: input.orderId,
      payer: { email: input.payerEmail },
    }
    const mp = await this.request<MpPayment>('/v1/payments', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: `${input.orderId}-card-${input.cardToken.slice(0, 12)}`,
    })
    const status = mapStatus(mp.status)
    return {
      providerPaymentId: String(mp.id),
      status: status === 'APPROVED' ? 'APPROVED' : status === 'REJECTED' ? 'REJECTED' : 'PENDING',
      statusDetail: mp.status_detail ?? mp.status,
    }
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    const mp = await this.request<{ id: number; status: string }>(`/v1/payments/${providerPaymentId}`)
    return { providerPaymentId: String(mp.id), status: mapStatus(mp.status) }
  }

  async refundPayment(providerPaymentId: string): Promise<void> {
    await this.request(`/v1/payments/${providerPaymentId}/refunds`, {
      method: 'POST',
      body: JSON.stringify({}),
      idempotencyKey: `refund-${providerPaymentId}`,
    })
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    try {
      await this.request(`/v1/payments/${providerPaymentId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'cancelled' }),
      })
    } catch {
      // best-effort: pagamento pode ja estar expirado/pago no gateway
    }
  }
}

/** Factory: null quando nao configurado (checkout online responde 503 nesse caso). */
export function createPaymentProvider(env: Env): PaymentProvider | null {
  if (!env.MP_ACCESS_TOKEN) return null
  return new MercadoPagoProvider(env.MP_ACCESS_TOKEN)
}

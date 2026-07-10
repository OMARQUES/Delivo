import { afterEach, describe, expect, it, vi } from 'vitest'
import { MercadoPagoProvider } from '../src/lib/mercadopago'

const provider = new MercadoPagoProvider('TEST-token-abc')

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('createPixPayment', () => {
  it('POSTs /v1/payments with pix method, idempotency key, amount in reais; maps QR fields', async () => {
    const fn = mockFetch(201, {
      id: 123456,
      status: 'pending',
      point_of_interaction: {
        transaction_data: { qr_code: 'copia-e-cola', qr_code_base64: 'b64==', ticket_url: 'https://mp/t' },
      },
    })
    const expiresAt = new Date('2026-07-10T12:15:00Z')
    const r = await provider.createPixPayment({
      orderId: 'order-1',
      amountCents: 6400,
      description: 'Pedido Pizzaria',
      payerEmail: 'a@b.com',
      expiresAt,
      notificationUrl: 'https://api/webhooks/mercadopago',
    })
    expect(r).toMatchObject({
      providerPaymentId: '123456',
      status: 'PENDING',
      qrCode: 'copia-e-cola',
      qrCodeBase64: 'b64==',
    })
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://api.mercadopago.com/v1/payments')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer TEST-token-abc')
    expect(headers['X-Idempotency-Key']).toBe('order-1-pix')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.transaction_amount).toBe(64)
    expect(body.payment_method_id).toBe('pix')
    expect(body.external_reference).toBe('order-1')
    expect(body.notification_url).toBe('https://api/webhooks/mercadopago')
    expect(String(body.date_of_expiration)).toContain('2026-07-10')
  })

  it('throws PaymentProviderError 502 on gateway failure', async () => {
    mockFetch(500, { message: 'boom' })
    await expect(provider.createPixPayment({
      orderId: 'o',
      amountCents: 100,
      description: 'x',
      payerEmail: 'a@b.com',
      expiresAt: new Date(),
      notificationUrl: null,
    })).rejects.toMatchObject({ status: 502 })
  })
})

describe('createCardPayment', () => {
  it('maps approved and rejected sync results', async () => {
    mockFetch(201, { id: 777, status: 'approved', status_detail: 'accredited' })
    const ok = await provider.createCardPayment({
      orderId: 'o1',
      amountCents: 5000,
      description: 'Pedido',
      payerEmail: 'a@b.com',
      cardToken: 'tok',
      cardPaymentMethodId: 'master',
      installments: 1,
    })
    expect(ok).toMatchObject({ providerPaymentId: '777', status: 'APPROVED' })

    mockFetch(201, { id: 778, status: 'rejected', status_detail: 'cc_rejected_insufficient_amount' })
    const bad = await provider.createCardPayment({
      orderId: 'o2',
      amountCents: 5000,
      description: 'Pedido',
      payerEmail: 'a@b.com',
      cardToken: 'tok2',
      cardPaymentMethodId: 'visa',
      installments: 1,
    })
    expect(bad).toMatchObject({ status: 'REJECTED', statusDetail: 'cc_rejected_insufficient_amount' })
  })
})

describe('getPayment / refund / cancel', () => {
  it('maps MP statuses to internal', async () => {
    mockFetch(200, { id: 123, status: 'approved' })
    expect((await provider.getPayment('123')).status).toBe('APPROVED')
    mockFetch(200, { id: 123, status: 'cancelled' })
    expect((await provider.getPayment('123')).status).toBe('CANCELLED')
    mockFetch(200, { id: 123, status: 'refunded' })
    expect((await provider.getPayment('123')).status).toBe('REFUNDED')
  })

  it('refund POSTs to /refunds with idempotency; cancel PUTs status cancelled', async () => {
    const fn = mockFetch(201, { id: 1 })
    await provider.refundPayment('999')
    const [refundUrl] = fn.mock.calls[0]! as unknown as [string, RequestInit]
    expect(refundUrl).toBe('https://api.mercadopago.com/v1/payments/999/refunds')
    const fn2 = mockFetch(200, { id: 999, status: 'cancelled' })
    await provider.cancelPayment('999')
    const [url, init] = fn2.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://api.mercadopago.com/v1/payments/999')
    expect(init.method).toBe('PUT')
  })

  it('refundPartial POSTs amount in reais with idempotency key', async () => {
    const fn = mockFetch(201, { id: 1 })
    await provider.refundPartial('999', 450)
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://api.mercadopago.com/v1/payments/999/refunds')
    expect(JSON.parse(String(init.body)).amount).toBe(4.5)
    expect((init.headers as Record<string, string>)['X-Idempotency-Key']).toBe('refund-999-450')
  })
})

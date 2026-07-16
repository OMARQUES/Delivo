import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MercadoPagoOrdersProvider, createPaymentProvider } from '../src/payments/mercadopago'
import { PaymentProviderError } from '../src/payments/provider'
import type { Env } from '../src/env'

const token = 'TEST-token-abc'
let provider: MercadoPagoOrdersProvider

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1', status: 'processed', status_detail: 'accredited',
    external_reference: 'order-1', total_amount: '64.00',
    processing_mode: 'automatic', country_code: 'BR', currency: 'BRL',
    integration_data: { application_id: 'app-test' }, user_id: 'account-test', live_mode: false,
    transactions: { payments: [{
      id: 'transaction-1', status: 'processed', status_detail: 'accredited',
      amount: '64.00', date_of_expiration: '2026-07-15T12:15:00Z',
      payment_method: { id: 'pix', type: 'bank_transfer', qr_code: 'copy-paste', qr_code_base64: 'base64', ticket_url: 'https://mp/t' },
    }] },
    ...overrides,
  }
}

function officialPixOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ORD_TEST_PIX', type: 'online', processing_mode: 'automatic',
    external_reference: 'order-1', total_amount: '64.00', country_code: 'BRA',
    status: 'action_required', status_detail: 'waiting_transfer',
    integration_data: { application_id: 'app-test' }, user_id: 'account-test', live_mode: false,
    last_updated_date: '2026-07-16T12:00:00.000Z',
    transactions: { payments: [{
      id: 'PAY_TEST_PIX', amount: '64.00', refunded_amount: '0.00',
      status: 'action_required', status_detail: 'waiting_transfer',
      date_of_expiration: '2026-07-16T12:30:00.000Z',
      payment_method: {
        id: 'pix', type: 'bank_transfer', ticket_url: 'https://example.invalid/ticket',
        qr_code: 'sanitized-copy-paste', qr_code_base64: 'sanitized-base64',
      },
    }] },
    ...overrides,
  }
}

function officialCardOrder(overrides: Record<string, unknown> = {}) {
  return officialPixOrder({
    id: 'ORD_TEST_CARD', country_code: 'BR', status: 'processed', status_detail: 'accredited',
    transactions: { payments: [{
      id: 'PAY_TEST_CARD', amount: '64.00', refunded_amount: '0.00',
      status: 'processed', status_detail: 'accredited',
      payment_method: { id: 'visa', type: 'credit_card' },
    }] },
    ...overrides,
  })
}

beforeEach(() => {
  provider = new MercadoPagoOrdersProvider(token, {
    applicationId: 'app-test', accountId: 'account-test', liveMode: false,
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('MercadoPagoOrdersProvider', () => {
  it('creates automatic PIX Order with canonical amount and no notification URL', async () => {
    const fetchMock = vi.fn(async () => response(snapshot(), 201))
    vi.stubGlobal('fetch', fetchMock)

    await provider.createOrder({ orderId: 'order-1', amountCents: 6400, payerEmail: 'payer@test.local', idempotencyKey: 'create-key', method: 'PIX', expiresAt: new Date('2026-07-15T12:15:00Z') })

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://api.mercadopago.com/v1/orders')
    expect((init.headers as Record<string, string>)['X-Idempotency-Key']).toBe('create-key')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toEqual({
      type: 'online',
      processing_mode: 'automatic',
      external_reference: 'order-1',
      total_amount: '64.00',
      payer: { email: 'payer@test.local' },
      transactions: { payments: [{
        amount: '64.00',
        payment_method: { id: 'pix', type: 'bank_transfer' },
        expiration_time: 'PT30M',
      }] },
    })
    expect(JSON.stringify(body)).not.toContain('notification_url')
  })

  it('maps PIX QR data and card token request without leaking token', async () => {
    const fetchMock = vi.fn(async () => response(snapshot(), 201))
    vi.stubGlobal('fetch', fetchMock)
    const pix = await provider.createOrder({ orderId: 'order-1', amountCents: 6400, payerEmail: 'payer@test.local', idempotencyKey: 'pix-key', method: 'PIX', expiresAt: new Date('2026-07-15T12:15:00Z') })
    expect(pix.pix).toMatchObject({ qrCode: 'copy-paste', qrCodeBase64: 'base64' })

    fetchMock.mockResolvedValueOnce(response(snapshot({ transactions: { payments: [{ id: 'tx-card', status: 'processed', status_detail: 'accredited', amount: '64.00', payment_method: { id: 'visa', type: 'credit_card' } }] } }), 201))
    const card = await provider.createOrder({ orderId: 'order-1', amountCents: 6400, payerEmail: 'payer@test.local', idempotencyKey: 'card-key', method: 'CARD', cardToken: 'card-token-secret', cardPaymentMethodId: 'visa', installments: 1 })
    expect(card.method).toBe('CARD')
    expect(JSON.stringify(card)).not.toContain('card-token-secret')
    const [, cardInit] = fetchMock.mock.calls[1]! as unknown as [string, RequestInit]
    expect(JSON.parse(String(cardInit.body))).toMatchObject({
      transactions: { payments: [{
        payment_method: {
          id: 'visa',
          type: 'credit_card',
          token: 'card-token-secret',
          installments: 1,
        },
      }] },
    })
  })

  it('normalizes official PIX fields and nested integration data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(officialPixOrder())))

    const result = await provider.getOrder('ORD_TEST_PIX')

    expect(result).toMatchObject({
      providerOrderId: 'ORD_TEST_PIX', providerTransactionId: 'PAY_TEST_PIX',
      countryCode: 'BR', currency: 'BRL', applicationId: 'app-test', accountId: 'account-test',
      updatedAt: new Date('2026-07-16T12:00:00.000Z'),
      pix: {
        qrCode: 'sanitized-copy-paste', qrCodeBase64: 'sanitized-base64',
        ticketUrl: 'https://example.invalid/ticket', expiresAt: new Date('2026-07-16T12:30:00.000Z'),
      },
    })
  })

  it('defaults absent currency to BRL and preserves explicit currency', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(officialCardOrder()))
      .mockResolvedValueOnce(response(officialCardOrder({ currency: 'USD' })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.getOrder('ORD_TEST_CARD')).resolves.toMatchObject({ method: 'CARD', currency: 'BRL', pix: null })
    await expect(provider.getOrder('ORD_TEST_CARD')).resolves.toMatchObject({ method: 'CARD', currency: 'USD', pix: null })
  })

  it('does not invent application or account identity from configuration', async () => {
    const missingIdentity = officialPixOrder({ integration_data: undefined, user_id: undefined, collector_id: undefined })
    const fetchMock = vi.fn(async () => response(missingIdentity))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.getOrder('ORD_TEST_PIX')).resolves.toMatchObject({ applicationId: null, accountId: null })

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(response({ id: 'account-test' }))
    fetchMock.mockResolvedValueOnce(response(missingIdentity))
    await expect(provider.getAccountId()).resolves.toBe('account-test')
    await expect(provider.getOrder('ORD_TEST_PIX')).resolves.toMatchObject({ applicationId: null, accountId: 'account-test' })
  })

  it('gets, searches exact external reference, cancels and refunds through Orders paths', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/search')) return response({ results: [snapshot()] })
      return response(snapshot(), 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    await provider.getOrder('order-1')
    expect(await provider.searchOrders('order with spaces')).toHaveLength(1)
    await provider.cancelOrder('order-1', 'cancel-key')
    await provider.refundOrder('order-1', 'refund-key')
    await provider.refundPartial('order-1', 'transaction-1', 1200, 'partial-key')
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[1]![0]).toContain('external_reference=order%20with%20spaces')
    expect(calls[2]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1/cancel')
    expect(calls[3]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1/refund')
    expect(calls[4]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1/refund')
    expect(JSON.parse(String(calls[3]![1].body))).toEqual({})
    expect(JSON.parse(String(calls[4]![1].body))).toEqual({ transactions: [{ id: 'transaction-1', amount: '12.00' }] })
  })

  it('gets credential-scoped account identity', async () => {
    const fetchMock = vi.fn(async () => response({ id: 'account-test' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider.getAccountId()).resolves.toBe('account-test')
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[0]![0]).toBe('https://api.mercadolibre.com/users/me')
  })

  it.each([
    [401, 'CREDENTIAL_OR_CONFIG'], [403, 'CREDENTIAL_OR_CONFIG'], [404, 'ORDER_NOT_FOUND'],
    [429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'],
  ] as const)('classifies HTTP %s as %s', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ secret: 'must-not-leak' }, status, { 'Retry-After': '7' })))
    await expect(provider.getOrder('order-1')).rejects.toMatchObject({ kind })
    try { await provider.getOrder('order-1') } catch (error) {
      expect(error).toBeInstanceOf(PaymentProviderError)
      expect(String(error)).not.toContain('must-not-leak')
      if (kind === 'RATE_LIMITED') expect(error).toMatchObject({ retryAfterSeconds: 7 })
    }
  })

  it('classifies timeout as transient uncertain', async () => {
    const timeoutProvider = new MercadoPagoOrdersProvider(token, { applicationId: 'app-test', accountId: 'account-test', liveMode: false }, 10)
    vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) => new Promise<never>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    await expect(timeoutProvider.getOrder('order-1')).rejects.toMatchObject({ kind: 'TRANSIENT_UNCERTAIN' })
  })

  it('rejects malformed snapshots and factory rejects incomplete config', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(snapshot({ transactions: { payments: [] } }), 200)))
    await expect(provider.getOrder('order-1')).rejects.toMatchObject({ kind: 'PROVIDER_RESPONSE_INVALID' })
    const env = { MP_ACCESS_TOKEN: token, MP_APPLICATION_ID: 'app-test', MP_ACCOUNT_ID: 'account-test', MP_LIVE_MODE: 'false' } as unknown as Env
    expect(createPaymentProvider(env)).toBeInstanceOf(MercadoPagoOrdersProvider)
    expect(createPaymentProvider({ ...env, MP_ACCOUNT_ID: undefined })).toBeNull()
    expect(createPaymentProvider({ ...env, MP_LIVE_MODE: 'wat' } as unknown as Env)).toBeNull()
  })
})

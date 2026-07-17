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

function pixWithoutQr(status: string, statusDetail: string) {
  return officialPixOrder({
    status,
    status_detail: statusDetail,
    transactions: { payments: [{
      id: 'PAY_TEST_PIX', amount: '64.00', refunded_amount: status === 'refunded' ? '64.00' : '0.00',
      status, status_detail: statusDetail,
      payment_method: { id: 'pix', type: 'bank_transfer' },
    }] },
  })
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
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const cardInput = {
  orderId: 'order-1', amountCents: 6400, payerEmail: 'payer@test.local',
  idempotencyKey: 'create-card-key', method: 'CARD' as const,
  cardToken: 'ephemeral-test-token', cardPaymentMethodId: 'master', installments: 1 as const,
}

function calls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
}

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
    const fetchMock = vi.fn(async () => response(officialPixOrder(), 201))
    vi.stubGlobal('fetch', fetchMock)
    const pix = await provider.createOrder({ orderId: 'order-1', amountCents: 6400, payerEmail: 'payer@test.local', idempotencyKey: 'pix-key', method: 'PIX', expiresAt: new Date('2026-07-15T12:15:00Z') })
    expect(pix.pix).toMatchObject({ qrCode: 'sanitized-copy-paste', qrCodeBase64: 'sanitized-base64' })

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

  it.each([
    ['canceled', 'canceled_transaction'],
    ['expired', 'expired'],
    ['rejected', 'rejected'],
    ['processed', 'accredited'],
    ['refunded', 'refunded'],
  ] as const)('normalizes terminal PIX %s without stale QR artifacts', async (status, detail) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(pixWithoutQr(status, detail))))

    await expect(provider.getOrder('ORD_TEST_PIX')).resolves.toMatchObject({
      orderStatus: status,
      transactionStatus: status,
      pix: null,
    })
  })

  it.each(['qr_code', 'qr_code_base64'] as const)(
    'rejects active PIX when %s is missing',
    async (missing) => {
      const paymentMethod: Record<string, unknown> = {
        id: 'pix', type: 'bank_transfer',
        qr_code: 'sanitized-copy-paste', qr_code_base64: 'sanitized-base64',
      }
      delete paymentMethod[missing]
      vi.stubGlobal('fetch', vi.fn(async () => response(officialPixOrder({
        transactions: { payments: [{
          id: 'PAY_TEST_PIX', amount: '64.00', refunded_amount: '0.00',
          status: 'action_required', status_detail: 'waiting_transfer',
          payment_method: paymentMethod,
        }] },
      }))))

      await expect(provider.getOrder('ORD_TEST_PIX')).rejects.toMatchObject({
        kind: 'PROVIDER_RESPONSE_INVALID',
      })
    },
  )

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

  it('searches current Orders endpoint with bounded dates and exact post-filtering', async () => {
    const wanted = officialPixOrder({ external_reference: 'order-1' })
    const other = officialPixOrder({ id: 'ORD_OTHER', external_reference: 'other-order' })
    const fetchMock = vi.fn<typeof fetch>(async () => response({ data: [wanted, other], paging: { total: 2 } }))
    vi.stubGlobal('fetch', fetchMock)

    const createdAt = new Date('2026-07-16T12:00:00.000Z')
    const now = new Date('2026-07-16T13:00:00.000Z')
    const matches = await provider.searchOrders('order-1', createdAt, now)

    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(`${url.origin}${url.pathname}`).toBe('https://api.mercadopago.com/v1/orders')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      begin_date: '2026-07-16T11:55:00.000Z',
      end_date: '2026-07-16T13:05:00.000Z',
      external_reference: 'order-1',
      type: 'online', page: '1', page_size: '10',
    })
    expect(matches.map((item) => item.externalReference)).toEqual(['order-1'])
  })

  it('parses documented search summaries without full-order country data', async () => {
    const summary = {
      id: 'ORD_SEARCH_CARD', type: 'online', processing_mode: 'automatic',
      external_reference: 'order-1', total_amount: '64.00', total_paid_amount: '0.00',
      user_id: 'account-test', status: 'failed', status_detail: 'failed', currency: 'BRL',
      created_date: '2026-07-16T12:00:00.000Z', last_updated_date: '2026-07-16T12:00:01.000Z',
      integration_data: { application_id: 'app-test' },
      transactions: { payments: [{
        id: 'PAY_SEARCH_CARD', amount: '64.00', paid_amount: '0.00',
        status: 'failed', status_detail: 'rejected_by_issuer',
        payment_method: { id: 'master', type: 'credit_card', installments: 1 },
      }] },
    }
    vi.stubGlobal('fetch', vi.fn(async () => response({ data: [summary], paging: { total: '1' } })))

    await expect(provider.searchOrders(
      'order-1',
      new Date('2026-07-16T12:00:00.000Z'),
      new Date('2026-07-16T12:01:00.000Z'),
    )).resolves.toEqual([{
      providerOrderId: 'ORD_SEARCH_CARD',
      externalReference: 'order-1',
    }])
  })

  it('caps search end date at 24 hours after creation', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await provider.searchOrders(
      'order-1',
      new Date('2026-07-16T12:00:00.000Z'),
      new Date('2026-07-17T12:01:00.000Z'),
    )

    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(url.searchParams.get('end_date')).toBe('2026-07-17T12:00:00.000Z')
  })

  it('rejects legacy search response envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ results: [] })))

    await expect(provider.searchOrders('order-1', new Date('2026-07-16T12:00:00.000Z'), new Date('2026-07-16T13:00:00.000Z'))).rejects.toMatchObject({ kind: 'PROVIDER_RESPONSE_INVALID' })
  })

  it('gets, searches exact external reference, cancels and refunds through Orders paths with authoritative reads', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/v1/orders?')) return response({ data: [snapshot({ external_reference: 'order with spaces' })] })
      return response(snapshot(), 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    await provider.getOrder('order-1')
    expect(await provider.searchOrders('order with spaces', new Date('2026-07-16T12:00:00.000Z'), new Date('2026-07-16T13:00:00.000Z'))).toHaveLength(1)
    await provider.cancelOrder('order-1', 'cancel-key')
    await provider.refundOrder('order-1', 'refund-key')
    await provider.refundPartial('order-1', 'transaction-1', 1200, 'partial-key')
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(new URL(calls[1]![0]).searchParams.get('external_reference')).toBe('order with spaces')
    expect(calls[2]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1/cancel')
    expect(calls[3]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1')
    expect(calls[4]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1/refund')
    expect(calls[5]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1')
    expect(calls[6]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1/refund')
    expect(calls[7]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1')
    expect(calls[2]![1].body).toBeUndefined()
    expect(calls[4]![1].body).toBeUndefined()
    expect(JSON.parse(String(calls[6]![1].body))).toEqual({ transactions: [{ id: 'transaction-1', amount: '12.00' }] })
  })

  it.each([
    [402, 'CREATE_REQUIRES_RECOVERY'],
    [409, 'CREATE_REQUIRES_RECOVERY'],
    [423, 'RESOURCE_LOCKED'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
  ] as const)('classifies create HTTP %s as %s', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ignored: true }, status)))
    await expect(provider.createOrder(cardInput)).rejects.toMatchObject({ kind, httpStatus: status })
  })

  it.each([
    [400, 'PROVIDER_RESPONSE_INVALID'],
    [401, 'CREDENTIAL_OR_CONFIG'],
    [403, 'CREDENTIAL_OR_CONFIG'],
  ] as const)('keeps deterministic create HTTP %s as %s', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ secret: 'must-not-leak' }, status)))
    await expect(provider.createOrder(cardInput)).rejects.toMatchObject({ kind, httpStatus: status })
  })

  it('parses Retry-After delta seconds and HTTP date', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 429, { 'Retry-After': '120' }))
      .mockResolvedValueOnce(response({}, 429, { 'Retry-After': 'Thu, 16 Jul 2026 12:03:00 GMT' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.getOrder('order-1')).rejects.toMatchObject({ kind: 'RATE_LIMITED', retryAfterSeconds: 120 })
    await expect(provider.getOrder('order-1')).rejects.toMatchObject({ kind: 'RATE_LIMITED', retryAfterSeconds: 180 })
  })

  it.each(['invalid', '-1', '999999999'])('ignores unsafe Retry-After %j', async (value) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({}, 429, { 'Retry-After': value })))
    await expect(provider.getOrder('order-1')).rejects.toMatchObject({ kind: 'RATE_LIMITED', retryAfterSeconds: undefined })
  })

  it.each([
    ['cancelOrder', 'cancel'],
    ['refundOrder', 'refund'],
  ] as const)('%s ignores mutation body and returns authoritative GET snapshot', async (method, suffix) => {
    const authoritative = suffix === 'cancel'
      ? snapshot({ status: 'canceled', status_detail: 'canceled' })
      : snapshot({ status: 'refunded', status_detail: 'refunded', refunded_amount: '64.00' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ acknowledgement_only: true }, 200))
      .mockResolvedValueOnce(response(authoritative, 200))
    vi.stubGlobal('fetch', fetchMock)

    await provider[method]('order-1', `${suffix}-key`)

    expect(calls(fetchMock)).toHaveLength(2)
    expect(calls(fetchMock)[0]![0]).toBe(`https://api.mercadopago.com/v1/orders/order-1/${suffix}`)
    expect(calls(fetchMock)[1]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1')
  })

  it('recovers mutation 409 through authoritative GET', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ignored: true }, 409))
      .mockResolvedValueOnce(response(snapshot({ status: 'canceled', status_detail: 'canceled' }), 200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.cancelOrder('order-1', 'cancel-key')).resolves.toMatchObject({ orderStatus: 'canceled' })
    expect(calls(fetchMock)).toHaveLength(2)
  })

  it('checks authoritative state after mutation 404 before requiring review', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(snapshot({ status: 'canceled', status_detail: 'canceled' }), 200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.cancelOrder('order-1', 'cancel-key')).resolves.toMatchObject({ orderStatus: 'canceled' })
    expect(calls(fetchMock)).toHaveLength(2)
  })

  it.each([423, 429, 500])('recovers uncertain mutation HTTP %s through authoritative GET', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, status, status === 429 ? { 'Retry-After': '7' } : undefined))
      .mockResolvedValueOnce(response(snapshot({ status: 'canceled', status_detail: 'canceled' }), 200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.cancelOrder('order-1', 'cancel-key')).resolves.toMatchObject({ orderStatus: 'canceled' })
    expect(calls(fetchMock)).toHaveLength(2)
  })

  it('recovers a mutation network failure through authoritative GET', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('sanitized network failure'))
      .mockResolvedValueOnce(response(snapshot({ status: 'canceled', status_detail: 'canceled' }), 200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.cancelOrder('order-1', 'cancel-key')).resolves.toMatchObject({ orderStatus: 'canceled' })
    expect(calls(fetchMock)).toHaveLength(2)
  })

  it('recovers a mutation timeout through authoritative GET', async () => {
    const timeoutProvider = new MercadoPagoOrdersProvider(token, { applicationId: 'app-test', accountId: 'account-test', liveMode: false }, 10)
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }
      return Promise.resolve(response(snapshot({ status: 'canceled', status_detail: 'canceled' }), 200))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(timeoutProvider.cancelOrder('order-1', 'cancel-key')).resolves.toMatchObject({ orderStatus: 'canceled' })
    expect(calls(fetchMock)).toHaveLength(2)
  })

  it('preserves original mutation outcome when authoritative GET also fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(response({}, 404))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.cancelOrder('order-1', 'cancel-key')).rejects.toMatchObject({ kind: 'MUTATION_REQUIRES_READ', httpStatus: 409 })
  })

  it('classifies unavailable readback after successful mutation as uncertain', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ acknowledgement_only: true }, 200))
      .mockResolvedValueOnce(response({}, 404))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.refundOrder('order-1', 'refund-key')).rejects.toMatchObject({ kind: 'MUTATION_REQUIRES_READ', httpStatus: 404 })
  })

  it.each([400, 401])('does not read back deterministic mutation HTTP %s', async (status) => {
    const fetchMock = vi.fn(async () => response({}, status))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.cancelOrder('order-1', 'cancel-key')).rejects.toBeInstanceOf(PaymentProviderError)
    expect(calls(fetchMock)).toHaveLength(1)
  })

  it.each(['', 'x'.repeat(65)])('rejects provider idempotency key length %j before fetch', async (key) => {
    const fetchMock = vi.fn<typeof fetch>(async () => response(snapshot(), 201))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.createOrder({ orderId: 'order-1', amountCents: 6400, payerEmail: 'payer@test.local', idempotencyKey: key, method: 'PIX', expiresAt: new Date('2026-07-15T12:15:00Z') })).rejects.toMatchObject({ kind: 'CREDENTIAL_OR_CONFIG' })
    await expect(provider.cancelOrder('order-1', key)).rejects.toMatchObject({ kind: 'CREDENTIAL_OR_CONFIG' })
    await expect(provider.refundOrder('order-1', key)).rejects.toMatchObject({ kind: 'CREDENTIAL_OR_CONFIG' })
    await expect(provider.refundPartial('order-1', 'transaction-1', 1200, key)).rejects.toMatchObject({ kind: 'CREDENTIAL_OR_CONFIG' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a 64-character provider idempotency key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response(snapshot(), 200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provider.cancelOrder('order-1', 'x'.repeat(64))).resolves.toMatchObject({ providerOrderId: 'order-1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

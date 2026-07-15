import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { paymentWebhookInbox } from '../src/db/schema'
import * as mp from '../src/payments/mercadopago'
import { enqueueWebhook, processWebhookInboxItem } from '../src/payments/webhook-inbox.service'
import { verifyMercadoPagoSignature } from '../src/payments/webhook-signature'
import type { PaymentProvider, ProviderOrderSnapshot } from '../src/payments/provider'

const SECRET = 'whsec-test'
const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'test-secret',
  RATE_LIMIT_HMAC_SECRET: 'rate-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  MP_WEBHOOK_SECRET: SECRET,
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

beforeAll(migrateTestDb)
beforeEach(async () => { await truncateAll(); vi.restoreAllMocks() })
afterAll(closeTestDb)

async function sign(dataId: string, requestId: string, timestamp: string) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function req(type: string, signature: string, dataId = 'order-1', requestId = 'req-1') {
  return app.request(`/webhooks/mercadopago?type=${type}&data.id=${dataId}`, {
    method: 'POST',
    headers: { 'x-signature': signature, 'x-request-id': requestId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { id: 'body-must-not-be-trusted' } }),
  }, env)
}

function provider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  const snapshot: ProviderOrderSnapshot = {
    providerOrderId: 'order-1', providerTransactionId: 'tx-1', orderStatus: 'created', orderStatusDetail: 'pending', transactionStatus: 'pending', transactionStatusDetail: 'pending', externalReference: 'missing-order', totalAmountCents: 100, refundedAmountCents: 0, countryCode: 'BR', currency: 'BRL', processingMode: 'aggregator', method: 'PIX', paymentMethodId: 'pix', applicationId: 'app', accountId: 'account', liveMode: false, transactionCount: 1, pix: null, updatedAt: new Date(),
  }
  return { createOrder: vi.fn(), getOrder: vi.fn(async () => snapshot), searchOrders: vi.fn(async () => []), cancelOrder: vi.fn(), refundOrder: vi.fn(), refundPartial: vi.fn(), getAccountId: vi.fn(async () => 'account'), ...overrides } as PaymentProvider
}

describe('Mercado Pago webhook signature', () => {
  it('accepts canonical signature, regardless timestamp age', async () => {
    const result = await verifyMercadoPagoSignature({ secret: SECRET, dataId: 'order-1', requestId: 'req-1', signature: `ts=1,v1=${await sign('order-1', 'req-1', '1')}` })
    expect(result).toEqual({ valid: true, timestamp: '1' })
  })

  it('rejects malformed, oversized, and invalid signatures', async () => {
    expect((await verifyMercadoPagoSignature({ secret: SECRET, dataId: 'bad id', requestId: 'req', signature: 'ts=1,v1=00' })).valid).toBe(false)
    expect((await verifyMercadoPagoSignature({ secret: SECRET, dataId: 'x'.repeat(257), requestId: 'req', signature: 'ts=1,v1=00' })).valid).toBe(false)
    expect((await verifyMercadoPagoSignature({ secret: SECRET, dataId: 'order', requestId: 'req', signature: 'ts=1,v1=deadbeef' })).valid).toBe(false)
  })
})

describe('POST /webhooks/mercadopago', () => {
  it('persists valid order notification, deduplicates, ignores body id', async () => {
    const signature = `ts=1,v1=${await sign('order-1', 'req-1', '1')}`
    const first = await req('order', signature)
    const second = await req('order', signature)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await testDb.select().from(paymentWebhookInbox)).length).toBe(1)
    expect((await testDb.select().from(paymentWebhookInbox))[0]!.resourceId).toBe('order-1')
  })

  it('invalid signature is 401; unsupported topic is harmless 200', async () => {
    expect((await req('order', 'ts=1,v1=deadbeef')).status).toBe(401)
    expect((await req('payment', '')).status).toBe(200)
  })

  it('missing secret is 503', async () => {
    const noSecret = await app.request('/webhooks/mercadopago?type=order&data.id=x', { method: 'POST' }, { ...env, MP_WEBHOOK_SECRET: undefined })
    expect(noSecret.status).toBe(503)
  })
})

describe('webhook inbox processor', () => {
  it('marks unknown provider Order for review', async () => {
    const now = new Date()
    const queued = await enqueueWebhook(testDb, { topic: 'order', resourceId: 'order-1', requestId: 'req-1', signatureTimestamp: '1' }, now)
    await processWebhookInboxItem(testDb, provider(), queued.id, 'lease-1', now)
    const [row] = await testDb.select().from(paymentWebhookInbox).where(eq(paymentWebhookInbox.id, queued.id))
    expect(row?.status).toBe('REVIEW_REQUIRED')
    expect(row?.failureClass).toBe('UNKNOWN_ORDER')
  })
})

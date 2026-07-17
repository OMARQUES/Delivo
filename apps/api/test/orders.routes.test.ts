import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { createActiveStoreTestFixture, type StoreFixtureInput, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { orders, payments, users } from '../src/db/schema'
import * as mp from '../src/payments/mercadopago'
import { PaymentProviderError as OrdersProviderError, type ProviderOrderSnapshot } from '../src/payments/provider'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct, replaceProductOptions } from '../src/services/catalog.service'
import { proposeAmendment } from '../src/services/amendment.service'
import { createOrder, listCustomerOrders } from '../src/services/order.service'
import { requestDriver, storeUpdateOrderStatus } from '../src/services/order-status.service'
import { updateStore } from '../src/services/store.service'
import { PostgresRateLimiter } from '../src/security/rate-limit'
import { POLICIES, type RateLimitPolicy } from '../src/security/rate-limit-policies'

const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'test-secret',
  RATE_LIMIT_HMAC_SECRET: 'rate-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
  MP_APPLICATION_ID: 'app-test',
  MP_ACCOUNT_ID: 'account-test',
  MP_LIVE_MODE: 'false' as const,
}

const storeInput: StoreFixtureInput = {
  name: 'Pizzaria',
  slug: 'pizzaria',
  category: 'PIZZARIA',
  phone: '4433334444',
  city: 'C',
  addressText: 'Rua A, 1',
  lat: -23.55,
  lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}
const ana = { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER' as const, acceptedTerms: true as const }

let storeId: string
let customerId: string
let customerToken: string
let addressId: string
let productId: string
let driverUserId: string
let groupIds: { varId: string; varG: string; adId: string; adBorda: string }

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createActiveStoreTestFixture(storeInput)
  storeId = store.id
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'DISTANCE',
    deliveryMinFeeCents: 400,
    deliveryPerKmCents: 200,
    deliveryMaxKm: 8,
    minOrderCents: 5000,
  })
  const customer = await createVerifiedTestAccount(testDb, ana, env.JWT_SECRET)
  customerId = customer.user.id
  customerToken = customer.accessToken!
  const driver = await createVerifiedTestAccount(testDb, { ...ana, name: 'Duda Motoboy', phone: '44911111111', role: 'DRIVER' }, env.JWT_SECRET)
  driverUserId = driver.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverUserId))
  const addr = await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })
  addressId = addr.id
  const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
  const prod = await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })
  productId = prod.id
  await replaceProductOptions(testDb, storeId, productId, [
    {
      name: 'Tamanho',
      type: 'VARIATION',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { name: 'P', priceCents: 3000, isAvailable: true },
        { name: 'G', priceCents: 5000, isAvailable: true },
      ],
    },
    {
      name: 'Extras',
      type: 'ADDON',
      minSelect: 0,
      maxSelect: 2,
      options: [{ name: 'Borda', priceCents: 800, isAvailable: true }],
    },
  ])
  const { getStoreCatalog } = await import('../src/services/catalog.service')
  const catalog = await getStoreCatalog(testDb, storeId)
  const groups = catalog[0]!.products[0]!.groups
  const v = groups.find((g) => g.type === 'VARIATION')!
  const a = groups.find((g) => g.type === 'ADDON')!
  groupIds = { varId: v.id, varG: v.options[1]!.id, adId: a.id, adBorda: a.options[0]!.id }
})
afterAll(closeTestDb)

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY' as const,
    addressId,
    paymentMethod: 'CASH' as const,
    changeForCents: 10000,
    items: [{
      productId,
      quantity: 2,
      selections: [
        { groupId: groupIds.varId, optionIds: [groupIds.varG] },
        { groupId: groupIds.adId, optionIds: [groupIds.adBorda] },
      ],
    }],
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  }
}

function req(path: string, init: RequestInit = {}, t = customerToken) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(init.headers as Record<string, string>) },
  }, env)
}

async function exhaust(policy: RateLimitPolicy, subject: string) {
  const limiter = new PostgresRateLimiter(testDb, env.RATE_LIMIT_HMAC_SECRET)
  for (let i = 0; i < policy.limit; i++) {
    await limiter.consume(policy, subject)
  }
}

async function createOtherCustomer(phone: string) {
  const other = await createVerifiedTestAccount(testDb, { ...ana, phone }, env.JWT_SECRET)
  const addr = await createAddress(testDb, other.user.id, { addressText: 'Rua C, 33', lat: -23.56, lng: -51.9 })
  return { token: other.accessToken!, addressId: addr.id }
}

function providerSnapshot(overrides: Partial<ProviderOrderSnapshot> = {}): ProviderOrderSnapshot {
  return {
    providerOrderId: 'mp-order-test',
    providerTransactionId: 'mp-tx-test',
    orderStatus: 'created',
    orderStatusDetail: 'pending',
    transactionStatus: 'pending',
    transactionStatusDetail: 'pending',
    externalReference: '',
    totalAmountCents: 12000,
    refundedAmountCents: 0,
    countryCode: 'BR',
    currency: 'BRL',
    processingMode: 'automatic',
    method: 'PIX',
    paymentMethodId: 'pix',
    applicationId: 'app-test',
    accountId: 'account-test',
    liveMode: false,
    transactionCount: 1,
    pix: { qrCode: 'copia', qrCodeBase64: 'b64', ticketUrl: null, expiresAt: new Date(Date.now() + 900000) },
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('POST /orders/quote + POST /orders', () => {
  it('quote returns totals; create returns 201 order; replay same key returns same id', async () => {
    const body = checkout()
    const q = await req('/orders/quote', { method: 'POST', body: JSON.stringify(body) })
    expect(q.status).toBe(200)
    expect(((await q.json()) as { totalCents: number }).totalCents).toBe(12000)
    const c1 = await req('/orders', { method: 'POST', body: JSON.stringify(body) })
    expect(c1.status).toBe(201)
    const o1 = (await c1.json()) as { order: { id: string } }
    const c2 = await req('/orders', { method: 'POST', body: JSON.stringify(body) })
    expect(c2.status).toBe(201)
    expect(((await c2.json()) as { order: { id: string } }).order.id).toBe(o1.order.id)
  })

  it('PIX_ONLINE: order born AWAITING_PAYMENT, response has QR; replay returns same QR', async () => {
    let providerExpiry: Date | null = null
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      getAccountId: async () => 'account-test',
      createOrder: async (i) => {
        if (i.method === 'PIX') providerExpiry = i.expiresAt
        return providerSnapshot({ providerOrderId: `mp-${i.orderId}`, providerTransactionId: `tx-${i.orderId}`, externalReference: i.orderId, method: 'PIX', pix: { qrCode: 'copia', qrCodeBase64: 'b64', ticketUrl: null, expiresAt: i.method === 'PIX' ? i.expiresAt : null } })
      },
      getOrder: async () => providerSnapshot(), searchOrders: async () => [], cancelOrder: async () => providerSnapshot(), refundOrder: async () => providerSnapshot(), refundPartial: async () => providerSnapshot(),
    })
    const body = checkout({ paymentMethod: 'PIX_ONLINE' })
    const res = await req('/orders', { method: 'POST', body: JSON.stringify(body) }, customerToken)
    expect(res.status).toBe(201)
    const r = (await res.json()) as { order: { id: string; status: string }; payment: { qrCode: string } }
    expect(r.order.status).toBe('AWAITING_PAYMENT')
    expect(r.payment.qrCode).toBe('copia')
    const [persisted] = await testDb.select().from(payments).where(eq(payments.orderId, r.order.id))
    expect(persisted!.expiresAt!.getTime() - persisted!.createdAt.getTime()).toBe(30 * 60_000)
    expect(providerExpiry).toEqual(persisted!.expiresAt)
    const detail = await req(`/orders/${r.order.id}`, {}, customerToken)
    expect(((await detail.json()) as { payment: { qrCode: string } }).payment.qrCode).toBe('copia')
    const replay = await req('/orders', { method: 'POST', body: JSON.stringify(body) }, customerToken)
    expect(((await replay.json()) as { payment: { qrCode: string } }).payment.qrCode).toBe('copia')
    vi.restoreAllMocks()
  })

  it('CARD_ONLINE approved -> order PENDING direct; rejected -> 402 + order CANCELLED', async () => {
    let rejectNext = false
    const approve = vi.fn(async (i: Parameters<NonNullable<ReturnType<typeof mp.createPaymentProvider>>['createOrder']>[0]) => rejectNext
      ? providerSnapshot({ providerOrderId: `mp-${i.orderId}`, providerTransactionId: `tx-${i.orderId}`, externalReference: i.orderId, method: 'CARD', paymentMethodId: 'master', orderStatus: 'rejected', orderStatusDetail: 'cc_rejected', transactionStatus: 'rejected', transactionStatusDetail: 'cc_rejected', pix: null })
      : providerSnapshot({ providerOrderId: `mp-${i.orderId}`, providerTransactionId: `tx-${i.orderId}`, externalReference: i.orderId, method: 'CARD', paymentMethodId: 'master', orderStatus: 'processed', orderStatusDetail: 'accredited', transactionStatus: 'processed', transactionStatusDetail: 'accredited', pix: null }))
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      getAccountId: async () => 'account-test',
      createOrder: approve,
      getOrder: async () => providerSnapshot(), searchOrders: async () => [], cancelOrder: async () => providerSnapshot(), refundOrder: async () => providerSnapshot(), refundPartial: async () => providerSnapshot(),
    })
    const ok = await req('/orders', {
      method: 'POST',
      body: JSON.stringify(checkout({
        paymentMethod: 'CARD_ONLINE',
        cardToken: 'tok_12345678',
        cardPaymentMethodId: 'master',
        installments: 1,
      })),
    }, customerToken)
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as { order: { status: string } }).order.status).toBe('PENDING')

    rejectNext = true
    const bad = await req('/orders', {
      method: 'POST',
      body: JSON.stringify(checkout({
        paymentMethod: 'CARD_ONLINE',
        cardToken: 'tok_87654321',
        cardPaymentMethodId: 'visa',
        installments: 1,
      })),
    }, customerToken)
    expect(bad.status).toBe(402)
    vi.restoreAllMocks()
  })

  it('replayed rejected card attempt returns 402 code without second provider create', async () => {
    const createOrder = vi.fn(async (i: Parameters<NonNullable<ReturnType<typeof mp.createPaymentProvider>>['createOrder']>[0]) => providerSnapshot({
      providerOrderId: `mp-${i.orderId}`,
      providerTransactionId: `tx-${i.orderId}`,
      externalReference: i.orderId,
      method: 'CARD',
      paymentMethodId: 'visa',
      orderStatus: 'rejected',
      orderStatusDetail: 'rejected',
      transactionStatus: 'rejected',
      transactionStatusDetail: 'rejected',
      pix: null,
    }))
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      getAccountId: async () => 'account-test',
      createOrder,
      getOrder: async () => providerSnapshot(), searchOrders: async () => [], cancelOrder: async () => providerSnapshot(), refundOrder: async () => providerSnapshot(), refundPartial: async () => providerSnapshot(),
    })
    const body = checkout({
      paymentMethod: 'CARD_ONLINE',
      cardToken: 'tok_rejected_replay',
      cardPaymentMethodId: 'visa',
      installments: 1,
    })

    const first = await req('/orders', { method: 'POST', body: JSON.stringify(body) })
    const replay = await req('/orders', { method: 'POST', body: JSON.stringify(body) })

    expect(first.status).toBe(402)
    expect(replay.status).toBe(402)
    expect(await first.json()).toMatchObject({ code: 'PAYMENT_REJECTED' })
    expect(await replay.json()).toMatchObject({ code: 'PAYMENT_REJECTED' })
    expect(createOrder).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('CARD_ONLINE persists a 30-minute payment deadline', async () => {
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      getAccountId: async () => 'account-test',
      createOrder: async (i) => providerSnapshot({ providerOrderId: `mp-${i.orderId}`, providerTransactionId: `tx-${i.orderId}`, externalReference: i.orderId, method: 'CARD', paymentMethodId: 'visa', orderStatus: 'processing', orderStatusDetail: 'in_process', transactionStatus: 'processing', transactionStatusDetail: 'in_process', pix: null }),
      getOrder: async () => providerSnapshot(), searchOrders: async () => [], cancelOrder: async () => providerSnapshot(), refundOrder: async () => providerSnapshot(), refundPartial: async () => providerSnapshot(),
    })
    const response = await req('/orders', {
      method: 'POST',
      body: JSON.stringify(checkout({ paymentMethod: 'CARD_ONLINE', cardToken: 'tok_deadline', cardPaymentMethodId: 'visa', installments: 1 })),
    }, customerToken)
    expect(response.status).toBe(201)
    const body = await response.json() as { order: { id: string } }
    const [payment] = await testDb.select().from(payments).where(eq(payments.orderId, body.order.id))
    expect(payment?.expiresAt).not.toBeNull()
    expect(payment!.expiresAt!.getTime() - payment!.createdAt.getTime()).toBe(30 * 60_000)
    vi.restoreAllMocks()
  })

  it('CARD_ONLINE create 402 recovers rejected_by_issuer and returns 402 instead of 503', async () => {
    let attemptedOrderId = ''
    const rejected = () => providerSnapshot({
      providerOrderId: 'provider-order-rejected',
      providerTransactionId: 'provider-transaction-rejected',
      externalReference: attemptedOrderId,
      method: 'CARD', paymentMethodId: 'master', pix: null,
      orderStatus: 'failed', orderStatusDetail: 'failed',
      transactionStatus: 'failed', transactionStatusDetail: 'rejected_by_issuer',
    })
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      getAccountId: async () => 'account-test',
      createOrder: async (input) => {
        attemptedOrderId = input.orderId
        throw new OrdersProviderError('CREATE_REQUIRES_RECOVERY', 402)
      },
      searchOrders: async () => [{
        providerOrderId: 'provider-order-rejected',
        externalReference: attemptedOrderId,
      }],
      getOrder: async () => rejected(),
      cancelOrder: async () => providerSnapshot(), refundOrder: async () => providerSnapshot(), refundPartial: async () => providerSnapshot(),
    })

    try {
      const res = await req('/orders', {
        method: 'POST',
        body: JSON.stringify(checkout({
          paymentMethod: 'CARD_ONLINE', cardToken: 'ephemeral-route-token',
          cardPaymentMethodId: 'master', installments: 1,
        })),
      }, customerToken)

      expect(res.status).toBe(402)
      expect((await res.json()) as { error: string; code: string }).toEqual({
        error: 'Pagamento recusado — revise os dados ou tente outro cartão',
        code: 'PAYMENT_REJECTED',
      })
      const [payment] = await testDb.select().from(payments).where(eq(payments.orderId, attemptedOrderId))
      expect(payment).toMatchObject({
        status: 'REJECTED', reconciliationState: 'HEALTHY', reconciliationFailure: null,
        providerOrderId: 'provider-order-rejected', providerTransactionId: 'provider-transaction-rejected',
      })
      expect((await testDb.select().from(orders).where(eq(orders.id, attemptedOrderId)))[0]!.status).toBe('CANCELLED')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('CARD_ONLINE provider failure stays generic and logs safe diagnostics', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      getAccountId: async () => 'account-test',
      createOrder: async () => { throw new OrdersProviderError('PROVIDER_RESPONSE_INVALID', 400) },
      getOrder: async () => providerSnapshot(), searchOrders: async () => [], cancelOrder: async () => providerSnapshot(), refundOrder: async () => providerSnapshot(), refundPartial: async () => providerSnapshot(),
    })
    const forbidden = ['tok_diagnostic_secret', 'ana@example.invalid', 'qr-content-marker', 'provider-body-marker', 'webhook-marker', 'env-secret-marker']

    try {
      const res = await req('/orders', {
        method: 'POST',
        body: JSON.stringify(checkout({
          paymentMethod: 'CARD_ONLINE', cardToken: forbidden[0], cardPaymentMethodId: 'visa', installments: 1,
        })),
      }, customerToken)
      expect(res.status).toBe(503)
      expect((await res.json()) as { error: string }).toEqual({
        error: 'Pagamento indisponível no momento — tente novamente ou use pagamento na entrega',
      })
      expect(logSpy).toHaveBeenCalledWith('payment_provider_failure', {
        failureClass: 'PROVIDER_RESPONSE_INVALID',
        upstreamStatus: 400,
        paymentMethod: 'CARD',
        requestId: res.headers.get('x-request-id'),
      })
      const output = JSON.stringify(logSpy.mock.calls)
      expect(forbidden.some((marker) => output.includes(marker))).toBe(false)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('PIX_ONLINE gateway uncertain -> 503 + order remains awaiting payment', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
      getAccountId: async () => 'account-test',
      createOrder: async () => { throw new OrdersProviderError('TRANSIENT_UNCERTAIN', 503) },
      getOrder: async () => providerSnapshot(), searchOrders: async () => [], cancelOrder: async () => providerSnapshot(), refundOrder: async () => providerSnapshot(), refundPartial: async () => providerSnapshot(),
    })
    try {
      const res = await req('/orders', { method: 'POST', body: JSON.stringify(checkout({ paymentMethod: 'PIX_ONLINE' })) }, customerToken)
      expect(res.status).toBe(503)
      expect(logSpy).toHaveBeenCalledWith('payment_provider_failure', {
        failureClass: 'TRANSIENT_UNCERTAIN',
        upstreamStatus: 503,
        paymentMethod: 'PIX',
        requestId: res.headers.get('x-request-id'),
      })
      const list = await listCustomerOrders(testDb, customerId)
      expect(list.length).toBe(1)
      expect(list[0]!.status).toBe('AWAITING_PAYMENT')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('online payment without provider configured -> 503', async () => {
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(null)
    const res = await req('/orders', { method: 'POST', body: JSON.stringify(checkout({ paymentMethod: 'PIX_ONLINE' })) }, customerToken)
    expect(res.status).toBe(503)
  })

  it('409 with problems; 401 anon', async () => {
    await updateStore(testDb, storeId, { isPaused: true })
    const r = await req('/orders', { method: 'POST', body: JSON.stringify(checkout()) })
    expect(r.status).toBe(409)
    expect((await app.request('/orders', { method: 'POST' }, env)).status).toBe(401)
  })

  it('quote user quota is independent per customer and runs before quote service', async () => {
    await exhaust(POLICIES.orderQuoteUserMinute, customerId)
    await updateStore(testDb, storeId, { isPaused: true })

    const limited = await req('/orders/quote', { method: 'POST', body: JSON.stringify(checkout()) })
    expect(limited.status).toBe(429)

    await updateStore(testDb, storeId, { isPaused: false })
    const other = await createOtherCustomer('44988887777')
    const otherQuote = await req('/orders/quote', {
      method: 'POST',
      body: JSON.stringify(checkout({ addressId: other.addressId })),
    }, other.token)
    expect(otherQuote.status).toBe(200)
  })

  it('quote IP quota is shared across customers', async () => {
    await exhaust(POLICIES.orderQuoteIpMinute, '127.0.0.1')
    const other = await createOtherCustomer('44988887777')

    const limited = await req('/orders/quote', {
      method: 'POST',
      body: JSON.stringify(checkout({ addressId: other.addressId })),
    }, other.token)

    expect(limited.status).toBe(429)
  })

  it('quote and create quotas are independent and create limit runs before payment provider', async () => {
    await exhaust(POLICIES.orderQuoteUserMinute, customerId)
    const created = await req('/orders', { method: 'POST', body: JSON.stringify(checkout()) })
    expect(created.status).toBe(201)

    await exhaust(POLICIES.orderCreateUserHour, customerId)
    const providerSpy = vi.spyOn(mp, 'createPaymentProvider')
    providerSpy.mockClear()

    const limited = await req('/orders', { method: 'POST', body: JSON.stringify(checkout({
      paymentMethod: 'PIX_ONLINE',
    })) })

    expect(limited.status).toBe(429)
    expect(providerSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('GET /orders + /orders/:id', () => {
  it('lists own orders; detail includes items/events; 404 others order', async () => {
    const { order: created } = await createOrder(testDb, customerId, checkout())
    const list = await req('/orders')
    expect(((await list.json()) as unknown[]).length).toBe(1)
    const detail = await req(`/orders/${created.id}`)
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { items: unknown[]; events: unknown[] }
    expect(body.items.length).toBe(1)
    const other = await createVerifiedTestAccount(testDb, { ...ana, phone: '44911112222' }, 'test-secret')
    expect((await req(`/orders/${created.id}`, {}, other.accessToken!)).status).toBe(404)
  })

  it('customer tracking shows driver first name once assigned', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    await storeUpdateOrderStatus(testDb, storeId, o.id, 'ACCEPTED', customerId)
    await requestDriver(testDb, storeId, o.id)
    const { acceptDelivery } = await import('../src/services/dispatch.service')
    await acceptDelivery(testDb, driverUserId, o.id)
    const detail = await req(`/orders/${o.id}`)
    expect(((await detail.json()) as { driverName: string | null }).driverName).toBe('Duda')
  })
})

describe('customer amendment routes', () => {
  it('approve applies new totals and clears the pending amendment', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    await storeUpdateOrderStatus(testDb, storeId, o.id, 'ACCEPTED', customerId)
    const detail = (await (await req(`/orders/${o.id}`)).json()) as { items: { id: string }[] }
    await proposeAmendment(testDb, storeId, customerId, o.id, {
      items: [{ orderItemId: detail.items[0]!.id, newQuantity: 1 }],
    })

    const res = await req(`/orders/${o.id}/amendments/current/approve`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('APPROVED')
    const after = (await (await req(`/orders/${o.id}`)).json()) as { totalCents: number; amendment: unknown | null }
    expect(after.totalCents).toBe(6200)
    expect(after.amendment).toBeNull()
  })

  it('reject cancels the order', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    await storeUpdateOrderStatus(testDb, storeId, o.id, 'ACCEPTED', customerId)
    const detail = (await (await req(`/orders/${o.id}`)).json()) as { items: { id: string }[] }
    await proposeAmendment(testDb, storeId, customerId, o.id, {
      items: [{ orderItemId: detail.items[0]!.id, newQuantity: 1 }],
    })

    const res = await req(`/orders/${o.id}/amendments/current/reject`, { method: 'POST' })
    expect(res.status).toBe(200)
    const after = (await (await req(`/orders/${o.id}`)).json()) as { status: string; cancelReason: string | null }
    expect(after.status).toBe('CANCELLED')
    expect(after.cancelReason).toBe('Cliente recusou a alteração proposta')
  })

  it('foreign customer cannot approve another order', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    await storeUpdateOrderStatus(testDb, storeId, o.id, 'ACCEPTED', customerId)
    const detail = (await (await req(`/orders/${o.id}`)).json()) as { items: { id: string }[] }
    await proposeAmendment(testDb, storeId, customerId, o.id, {
      items: [{ orderItemId: detail.items[0]!.id, newQuantity: 1 }],
    })
    const other = await createVerifiedTestAccount(testDb, { ...ana, phone: '44911112222' }, 'test-secret')

    const res = await req(`/orders/${o.id}/amendments/current/approve`, { method: 'POST' }, other.accessToken!)
    expect(res.status).toBe(404)
  })
})

describe('cancel flows', () => {
  it('AWAITING_PAYMENT: direct cancel commits immediately and returns safe payment resolution', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    await testDb.update(orders).set({ status: 'AWAITING_PAYMENT', paymentMethod: 'PIX_ONLINE' }).where(eq(orders.id, o.id))
    await testDb.insert(payments).values({
      orderId: o.id, providerOrderId: `mp-${o.id}`, providerTransactionId: `tx-${o.id}`, method: 'PIX',
      expectedAmountCents: o.totalCents, expectedCurrency: 'BRL', expectedCountry: 'BR', expectedApplicationId: 'app-test',
      expectedAccountId: 'account-test', expectedLiveMode: false, createIdempotencyKey: crypto.randomUUID(),
    })
    const res = await req(`/orders/${o.id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'CANCELLED', payment: null, paymentResolution: 'PROCESSING' })
  })

  it('PENDING: direct cancel 200; after ACCEPTED: cancel 409 but cancel-request 200', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    expect((await req(`/orders/${o.id}/cancel`, { method: 'POST' })).status).toBe(200)
    const { order: o2 } = await createOrder(testDb, customerId, checkout())
    await testDb.update(orders).set({ status: 'ACCEPTED' }).where(eq(orders.id, o2.id))
    expect((await req(`/orders/${o2.id}/cancel`, { method: 'POST' })).status).toBe(409)
    const cr = await req(`/orders/${o2.id}/cancel-request`, {
      method: 'POST',
      body: JSON.stringify({ note: 'mudei de ideia' }),
    })
    expect(cr.status).toBe(200)
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createActiveStoreTestFixture, createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb, type StoreFixtureInput } from './helpers/test-db'
import { createProduct, createCategory } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { updateStore } from '../src/services/store.service'
import { orderEvents, orders, paymentOperations, payments } from '../src/db/schema'
import { applyProviderSnapshot } from '../src/payments/transition.service'
import { providerSnapshot } from './helpers/payment-provider'
import { createOnlinePayment, recoverUncertainCreate } from '../src/payments/checkout.service'
import { fakePaymentProvider } from './helpers/payment-provider'
import { enqueueOrderPaymentDisposition } from '../src/services/payment.service'

const storeInput: StoreFixtureInput = { name: 'Pizzaria', slug: 'pizzaria', category: 'PIZZARIA', phone: '4433334444', city: 'C', addressText: 'Rua A, 1', lat: -23.55, lng: -51.9, owner: { name: 'João', email: 'joao@email.com', password: 'senha123' } }
const customerInput = { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER' as const, acceptedTerms: true as const }
let customerId: string
let productId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createActiveStoreTestFixture(storeInput)
  await updateStore(testDb, store.id, { openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })), deliveryFeeMode: 'FIXED', deliveryFixedFeeCents: 0, minOrderCents: 1000 })
  const customer = await createVerifiedTestAccount(testDb, customerInput, 'test-secret')
  customerId = customer.user.id
  const category = await createCategory(testDb, store.id, { name: 'Pizzas' })
  productId = (await createProduct(testDb, store.id, { categoryId: category.id, name: 'Pizza', basePriceCents: 6000, isAvailable: true })).id
})
afterAll(closeTestDb)

async function makePayment(status: 'AWAITING_PAYMENT' | 'CANCELLED' = 'AWAITING_PAYMENT') {
  const { order } = await createOrder(testDb, customerId, { storeSlug: 'pizzaria', fulfillment: 'PICKUP', paymentMethod: 'CASH', items: [{ productId, quantity: 1, selections: [] }], idempotencyKey: crypto.randomUUID() })
  await testDb.update(orders).set({ status, paymentMethod: 'PIX_ONLINE' }).where(eq(orders.id, order.id))
  const [payment] = await testDb.insert(payments).values({
    orderId: order.id, providerOrderId: `mp-order-${order.id}`, providerTransactionId: `mp-tx-${order.id}`, method: 'PIX', expectedAmountCents: order.totalCents,
    expectedCurrency: 'BRL', expectedCountry: 'BR', expectedApplicationId: 'app-test', expectedAccountId: 'account-test', expectedLiveMode: false,
    createIdempotencyKey: crypto.randomUUID(), qrCode: 'qr', qrCodeBase64: 'b64',
  }).returning()
  return { order, payment: payment! }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function snapshot(orderId: string, amountCents: number, patch: Partial<ReturnType<typeof providerSnapshot>> = {}) {
  return providerSnapshot({ providerOrderId: `mp-order-${orderId}`, providerTransactionId: `mp-tx-${orderId}`, externalReference: orderId, totalAmountCents: amountCents, ...patch })
}

describe('applyProviderSnapshot', () => {
  it('rolls back the business mutation when disposition key conflicts', async () => {
    const { order, payment } = await makePayment()
    const key = `cancel:${payment.id}:CUSTOMER_CANCELLED`
    await testDb.insert(paymentOperations).values({
      paymentId: payment.id, type: 'CANCEL', amountCents: null,
      businessKey: key, idempotencyKey: `other:${crypto.randomUUID()}`,
      status: 'SUCCEEDED', resultCode: 'CANCELLED', completedAt: new Date(),
    })
    await expect(testDb.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, order.id))
      await enqueueOrderPaymentDisposition(tx, order.id, 'CUSTOMER_CANCELLED', new Date())
    })).rejects.toThrow('payment operation business key conflict')
    expect((await testDb.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('AWAITING_PAYMENT')
  })

  it('approves once, releases order, writes one event; duplicate approval is no-op', async () => {
    const { order, payment } = await makePayment()
    const approved = snapshot(order.id, order.totalCents)
    const first = await applyProviderSnapshot(testDb, payment.id, approved, new Date())
    const second = await applyProviderSnapshot(testDb, payment.id, approved, new Date())
    expect(first).toMatchObject({ changed: true, decision: 'APPROVED', operationEnqueued: false })
    expect(second.changed).toBe(false)
    expect((await testDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('PENDING')
    expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]!.status).toBe('APPROVED')
    expect((await testDb.select().from(orderEvents).where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.note, 'pagamento confirmado')))).length).toBe(1)
  })

  it('serializes concurrent approvals', async () => {
    const { order, payment } = await makePayment()
    const approved = snapshot(order.id, order.totalCents)
    const [a, b] = await Promise.all([applyProviderSnapshot(testDb, payment.id, approved, new Date()), applyProviderSnapshot(testDb, payment.id, approved, new Date())])
    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1)
    expect((await testDb.select().from(orderEvents).where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.note, 'pagamento confirmado')))).length).toBe(1)
  })

  it('persists pending and rejection without releasing order', async () => {
    const { order, payment } = await makePayment()
    const now = new Date('2026-07-15T12:00:00.000Z')
    const pending = snapshot(order.id, order.totalCents, { orderStatus: 'waiting_transfer', orderStatusDetail: 'waiting_transfer', transactionStatus: 'waiting_transfer', transactionStatusDetail: 'waiting_transfer' })
    expect((await applyProviderSnapshot(testDb, payment.id, pending, now)).decision).toBe('PENDING')
    const persisted = (await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]!
    expect(persisted.lastReconciledAt).toEqual(now)
    expect(persisted.nextReconcileAt).toEqual(new Date(now.getTime() + 5 * 60_000))
    const rejected = snapshot(order.id, order.totalCents, { orderStatus: 'failed', orderStatusDetail: 'cc_rejected_other', transactionStatus: 'cc_rejected_other', transactionStatusDetail: 'cc_rejected_other' })
    expect((await applyProviderSnapshot(testDb, payment.id, rejected, new Date())).decision).toBe('REJECTED')
    expect((await testDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('CANCELLED')
  })

  it('marks mismatch review and never releases order', async () => {
    const { order, payment } = await makePayment()
    const result = await applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents, { countryCode: 'AR' }), new Date())
    expect(result).toMatchObject({ changed: true, decision: 'REVIEW_REQUIRED' })
    expect((await testDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('AWAITING_PAYMENT')
    expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]!.reconciliationState).toBe('REVIEW_REQUIRED')
  })

  it('late valid approval keeps cancelled order and queues one full refund', async () => {
    const { order, payment } = await makePayment('CANCELLED')
    const result = await applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents), new Date())
    expect(result).toMatchObject({ changed: true, decision: 'APPROVED', operationEnqueued: true })
    expect((await testDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('CANCELLED')
    const [operation] = await testDb.select().from(paymentOperations).where(eq(paymentOperations.businessKey, `refund-full:${payment.id}:LATE_APPROVAL`))
    expect(operation).toMatchObject({ businessKey: `refund-full:${payment.id}:LATE_APPROVAL`, idempotencyKey: `rf:la:${payment.id}` })
    expect(operation!.idempotencyKey).toMatch(/^[A-Za-z0-9:_-]{1,64}$/)
    const again = await applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents), new Date())
    expect(again.operationEnqueued).toBe(false)
  })

  it('advances APPROVED to REFUNDED and never regresses afterward', async () => {
    const { order, payment } = await makePayment()
    await testDb.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, payment.id))
    const refunded = snapshot(order.id, order.totalCents, {
      orderStatus: 'refunded',
      orderStatusDetail: 'refunded',
      transactionStatus: 'refunded',
      transactionStatusDetail: 'refunded',
      refundedAmountCents: order.totalCents,
    })

    await applyProviderSnapshot(testDb, payment.id, refunded, new Date())
    expect(await testDb.select({ status: payments.status, refundedAmountCents: payments.refundedAmountCents }).from(payments).where(eq(payments.id, payment.id))).toEqual([
      { status: 'REFUNDED', refundedAmountCents: order.totalCents },
    ])

    await applyProviderSnapshot(testDb, payment.id, {
      ...refunded,
      orderStatus: 'pending',
      orderStatusDetail: 'pending',
      transactionStatus: 'pending',
      transactionStatusDetail: 'pending',
      refundedAmountCents: 0,
    }, new Date())
    expect((await testDb.select({ status: payments.status, refundedAmountCents: payments.refundedAmountCents }).from(payments).where(eq(payments.id, payment.id)))[0]).toEqual({
      status: 'REFUNDED',
      refundedAmountCents: order.totalCents,
    })
  })

  it('keeps APPROVED while applying exact cumulative partial refund', async () => {
    const { order, payment } = await makePayment()
    await testDb.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, payment.id))
    const partial = snapshot(order.id, order.totalCents, {
      orderStatus: 'processed',
      orderStatusDetail: 'partially_refunded',
      transactionStatus: 'partially_refunded',
      transactionStatusDetail: 'partially_refunded',
      refundedAmountCents: 1000,
    })

    await applyProviderSnapshot(testDb, payment.id, partial, new Date())
    expect((await testDb.select({ status: payments.status, refundedAmountCents: payments.refundedAmountCents }).from(payments).where(eq(payments.id, payment.id)))[0]).toEqual({
      status: 'APPROVED',
      refundedAmountCents: 1000,
    })
  })

  it('moves contradictory snapshot to review without replacing confirmed financial fields', async () => {
    const { order, payment } = await makePayment()
    await testDb.update(payments).set({
      status: 'APPROVED',
      refundedAmountCents: 1200,
      providerOrderId: `confirmed-order-${order.id}`,
      providerTransactionId: `confirmed-tx-${order.id}`,
      qrCode: 'confirmed-qr',
      qrCodeBase64: 'confirmed-b64',
    }).where(eq(payments.id, payment.id))

    const result = await applyProviderSnapshot(testDb, payment.id, providerSnapshot({
      providerOrderId: `other-order-${order.id}`,
      providerTransactionId: `other-tx-${order.id}`,
      externalReference: order.id,
      totalAmountCents: order.totalCents,
      orderStatus: 'processed',
      orderStatusDetail: 'partially_refunded',
      transactionStatus: 'partially_refunded',
      transactionStatusDetail: 'partially_refunded',
      refundedAmountCents: 500,
      pix: null,
    }), new Date())

    expect(result.decision).toBe('REVIEW_REQUIRED')
    expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]).toMatchObject({
      status: 'APPROVED',
      refundedAmountCents: 1200,
      providerOrderId: `confirmed-order-${order.id}`,
      providerTransactionId: `confirmed-tx-${order.id}`,
      qrCode: 'confirmed-qr',
      qrCodeBase64: 'confirmed-b64',
      reconciliationState: 'REVIEW_REQUIRED',
      reconciliationFailure: 'MISMATCH_PROVIDER_IDS',
    })
  })

  it('never fabricates a full refund from refunded status with partial cents', async () => {
    const { order, payment } = await makePayment()
    await testDb.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, payment.id))
    await applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents, {
      orderStatus: 'refunded',
      orderStatusDetail: 'refunded',
      transactionStatus: 'refunded',
      transactionStatusDetail: 'refunded',
      refundedAmountCents: order.totalCents - 1,
    }), new Date())

    expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]).toMatchObject({
      status: 'APPROVED',
      refundedAmountCents: 0,
      reconciliationState: 'REVIEW_REQUIRED',
      reconciliationFailure: 'MISMATCH_REFUNDED_AMOUNT',
    })
  })
})

describe('Orders checkout orchestration', () => {
  it('does not overwrite a webhook result while uncertain search is in flight', async () => {
    const { order, payment } = await makePayment()
    await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null }).where(eq(payments.id, payment.id))
    const searchStarted = deferred<void>()
    const releaseSearch = deferred<Array<ReturnType<typeof providerSnapshot>>>()
    const recoveryProvider = fakePaymentProvider({
      searchOrders: vi.fn(async () => {
        searchStarted.resolve()
        return releaseSearch.promise
      }),
    })
    const recovery = recoverUncertainCreate(testDb, recoveryProvider, payment.id, new Date(), (email) => email ?? 'masked@test.local')
    await searchStarted.promise
    await applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents), new Date())
    releaseSearch.resolve([])
    await recovery
    expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]).toMatchObject({
      status: 'APPROVED',
      providerOrderId: `mp-order-${order.id}`,
      reconciliationState: 'HEALTHY',
      reconciliationFailure: null,
    })
  })

  it('does not expire an uncertain PIX that became identified during search', async () => {
    const { order, payment } = await makePayment()
    await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null, expiresAt: new Date('2026-07-15T11:00:00.000Z') }).where(eq(payments.id, payment.id))
    const searchStarted = deferred<void>()
    const releaseSearch = deferred<Array<ReturnType<typeof providerSnapshot>>>()
    const recoveryProvider = fakePaymentProvider({ searchOrders: vi.fn(async () => {
      searchStarted.resolve()
      return releaseSearch.promise
    }) })
    const recovery = recoverUncertainCreate(testDb, recoveryProvider, payment.id, new Date('2026-07-15T12:00:00.000Z'), (email) => email ?? 'masked@test.local')
    await searchStarted.promise
    await applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents, {
      orderStatus: 'pending', orderStatusDetail: 'pending', transactionStatus: 'pending', transactionStatusDetail: 'pending',
    }), new Date())
    releaseSearch.resolve([])
    await recovery
    expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]).toMatchObject({ status: 'PENDING', providerOrderId: `mp-order-${order.id}` })
  })

  it('persists attempt before provider call and returns PIX QR', async () => {
    const { order, payment } = await makePayment()
    await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null }).where(eq(payments.id, payment.id))
    const createOrderMock = vi.fn(async () => snapshot(order.id, order.totalCents))
    const provider = fakePaymentProvider({ getAccountId: vi.fn(async () => 'account-test'), createOrder: createOrderMock })
    const result = await createOnlinePayment(testDb, provider, { paymentId: payment.id, payerEmail: 'payer@test.local' })
    expect(result.kind).toBe('PIX')
    expect(createOrderMock).toHaveBeenCalledWith(expect.objectContaining({ orderId: order.id, idempotencyKey: expect.any(String) }))
    expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]!.reconciliationState).toBe('HEALTHY')
  })

  it('recovers one uncertain create, rejects multiple, requests retry for zero', async () => {
    const one = await makePayment()
    const now = new Date('2026-07-16T13:00:00.000Z')
    const oneSearch = vi.fn(async () => [snapshot(one.order.id, one.order.totalCents)])
    const oneProvider = fakePaymentProvider({ searchOrders: oneSearch })
    await expect(recoverUncertainCreate(testDb, oneProvider, one.payment.id, now, (email) => email ?? 'payer@test.local')).resolves.toBe('RECOVERED')
    expect(oneSearch).toHaveBeenCalledWith(one.order.id, one.payment.createdAt, now)
    const many = await makePayment()
    await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null }).where(eq(payments.id, many.payment.id))
    const manyProvider = fakePaymentProvider({ searchOrders: vi.fn(async () => [snapshot(many.order.id, many.order.totalCents), snapshot(many.order.id, many.order.totalCents)]) })
    await expect(recoverUncertainCreate(testDb, manyProvider, many.payment.id, new Date(), (email) => email ?? 'payer@test.local')).resolves.toBe('REVIEW_REQUIRED')
    const zero = await makePayment()
    const zeroProvider = fakePaymentProvider({ searchOrders: vi.fn(async () => []) })
    const createOrder = vi.fn(async () => snapshot(zero.order.id, zero.order.totalCents))
    zeroProvider.createOrder = createOrder
    await expect(recoverUncertainCreate(testDb, zeroProvider, zero.payment.id, new Date(), (email) => email ?? 'payer@test.local')).resolves.toBe('RECOVERED')
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: zero.payment.createIdempotencyKey, payerEmail: expect.any(String) }))
  })

  it('persists ambiguous and fresh-card decisions, expires uncertain PIX once', async () => {
    const many = await makePayment()
    await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null }).where(eq(payments.id, many.payment.id))
    const manyProvider = fakePaymentProvider({ searchOrders: vi.fn(async () => [snapshot(many.order.id, many.order.totalCents), snapshot(many.order.id, many.order.totalCents)]) })
    await expect(recoverUncertainCreate(testDb, manyProvider, many.payment.id, new Date(), (email) => email ?? 'payer@test.local')).resolves.toBe('REVIEW_REQUIRED')
    expect((await testDb.select().from(payments).where(eq(payments.id, many.payment.id)))[0]!.reconciliationFailure).toBe('AMBIGUOUS_PROVIDER_CREATE')

    const card = await makePayment()
    await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null, method: 'CARD', qrCode: null, qrCodeBase64: null }).where(eq(payments.id, card.payment.id))
    const cardProvider = fakePaymentProvider({ searchOrders: vi.fn(async () => []), createOrder: vi.fn() })
    await expect(recoverUncertainCreate(testDb, cardProvider, card.payment.id, new Date(), (email) => email ?? 'payer@test.local')).resolves.toBe('FRESH_CARD_REQUIRED')
    expect(cardProvider.createOrder).not.toHaveBeenCalled()

    const expired = await makePayment()
    const expiredAt = new Date('2026-07-15T11:00:00.000Z')
    await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null, expiresAt: expiredAt }).where(eq(payments.id, expired.payment.id))
    const expiredProvider = fakePaymentProvider({ searchOrders: vi.fn(async () => []) })
    await expect(recoverUncertainCreate(testDb, expiredProvider, expired.payment.id, new Date('2026-07-15T12:00:00.000Z'), (email) => email ?? 'payer@test.local')).resolves.toBe('RECOVERED')
    expect((await testDb.select().from(payments).where(eq(payments.id, expired.payment.id)))[0]!.status).toBe('EXPIRED')
    expect((await testDb.select().from(orderEvents).where(and(eq(orderEvents.orderId, expired.order.id), eq(orderEvents.note, 'pagamento não aprovado')))).length).toBe(1)
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { createActiveStoreTestFixture, createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb, type StoreFixtureInput } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { payments, paymentOperations, orders } from '../src/db/schema'
import { updateStore } from '../src/services/store.service'
import { claimDueOperations, enqueuePaymentOperation, propagateReviewedDependencies } from '../src/payments/operation-queue.service'
import { processPaymentOperation } from '../src/payments/operation.service'
import type { PaymentProvider, ProviderOrderSnapshot } from '../src/payments/provider'
import { PaymentProviderError } from '../src/payments/provider'

const storeInput: StoreFixtureInput = { name: 'Pizzaria', slug: 'pizzaria', category: 'PIZZARIA', phone: '4433334444', city: 'C', addressText: 'Rua A, 1', lat: -23.55, lng: -51.9, owner: { name: 'João', email: 'joao@email.com', password: 'senha123' } }
let customerId: string
let productId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createActiveStoreTestFixture(storeInput)
  await updateStore(testDb, store.id, { openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })), deliveryFeeMode: 'FIXED', deliveryFixedFeeCents: 0, minOrderCents: 1000 })
  customerId = (await createVerifiedTestAccount(testDb, { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true }, 'test-secret')).user.id
  const category = await createCategory(testDb, store.id, { name: 'Pizzas' })
  productId = (await createProduct(testDb, store.id, { categoryId: category.id, name: 'Pizza', basePriceCents: 6000, isAvailable: true })).id
})
afterAll(closeTestDb)

async function payment() {
  const { order } = await createOrder(testDb, customerId, { storeSlug: 'pizzaria', fulfillment: 'PICKUP', paymentMethod: 'CASH', items: [{ productId, quantity: 1, selections: [] }], idempotencyKey: crypto.randomUUID() })
  await testDb.update(orders).set({ status: 'CANCELLED', paymentMethod: 'PIX_ONLINE' }).where(eq(orders.id, order.id))
  const [row] = await testDb.insert(payments).values({ orderId: order.id, providerOrderId: `mp-${order.id}`, providerTransactionId: `tx-${order.id}`, method: 'PIX', expectedAmountCents: order.totalCents, expectedCurrency: 'BRL', expectedCountry: 'BR', expectedApplicationId: 'app-test', expectedAccountId: 'account-test', expectedLiveMode: false, createIdempotencyKey: crypto.randomUUID() }).returning()
  return row!
}

function snapshot(paymentId: string, amount: number, patch: Partial<ProviderOrderSnapshot> = {}): ProviderOrderSnapshot {
  return { providerOrderId: paymentId, providerTransactionId: `tx-${paymentId}`, orderStatus: 'refunded', orderStatusDetail: 'refunded', transactionStatus: 'refunded', transactionStatusDetail: 'refunded', externalReference: 'unused', totalAmountCents: amount, refundedAmountCents: amount, countryCode: 'BR', currency: 'BRL', processingMode: 'automatic', method: 'PIX', paymentMethodId: 'pix', applicationId: 'app-test', accountId: 'account-test', liveMode: false, transactionCount: 1, pix: null, updatedAt: new Date(), ...patch }
}

function provider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return { createOrder: vi.fn(), getOrder: vi.fn(async () => snapshot('x', 1)), searchOrders: vi.fn(async () => []), cancelOrder: vi.fn(async () => snapshot('x', 1)), refundOrder: vi.fn(async () => snapshot('x', 1)), refundPartial: vi.fn(async () => snapshot('x', 1)), getAccountId: vi.fn(async () => 'account-test'), ...overrides } as PaymentProvider
}

describe('durable payment operations', () => {
  it('deduplicates enqueue and claims only once', async () => {
    const row = await payment()
    const now = new Date()
    const input = { paymentId: row.id, type: 'REFUND_FULL' as const, amountCents: null, businessKey: `refund:${row.id}`, idempotencyKey: `idem:${row.id}` }
    await enqueuePaymentOperation(testDb, input, now)
    await enqueuePaymentOperation(testDb, input, now)
    expect((await testDb.select().from(paymentOperations)).length).toBe(1)
    expect((await claimDueOperations(testDb, now, 10, 'worker-a')).length).toBe(1)
    expect((await claimDueOperations(testDb, now, 10, 'worker-b')).length).toBe(0)
  })

  it('executes full refund with persisted idempotency key', async () => {
    const row = await payment()
    const now = new Date()
    await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'REFUND_FULL', amountCents: null, businessKey: `refund:${row.id}`, idempotencyKey: `idem:${row.id}` }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const refund = vi.fn(async (_id: string, key: string) => { expect(key).toBe(`idem:${row.id}`); return snapshot(row.providerOrderId!, row.expectedAmountCents, { providerTransactionId: row.providerTransactionId!, externalReference: row.orderId }) })
    await processPaymentOperation(testDb, provider({ refundOrder: refund }), operationId!, 'worker-a', now)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, operationId!)))[0]).toMatchObject({ status: 'SUCCEEDED', resultCode: 'REFUNDED', expectedRefundedAmountCents: row.expectedAmountCents })
  })

  it('does not complete full refund when provider remains APPROVED', async () => {
    const row = await payment()
    const now = new Date()
    await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'REFUND_FULL', amountCents: null, businessKey: `refund:${row.id}`, idempotencyKey: `idem:${row.id}` }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    await processPaymentOperation(testDb, provider({ refundOrder: vi.fn(async () => snapshot(row.providerOrderId!, row.expectedAmountCents, { providerTransactionId: row.providerTransactionId!, externalReference: row.orderId, orderStatus: 'processed', orderStatusDetail: 'accredited', transactionStatus: 'processed', transactionStatusDetail: 'accredited' })) }), operationId!, 'worker-a', now)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, operationId!)))[0]!.status).toBe('PENDING')
  })

  it('uncertain provider response retries when GET remains APPROVED', async () => {
    const row = await payment()
    const now = new Date()
    await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'REFUND_FULL', amountCents: null, businessKey: `refund:${row.id}`, idempotencyKey: `idem:${row.id}` }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const getOrder = vi.fn(async () => snapshot(row.providerOrderId!, row.expectedAmountCents, { providerTransactionId: row.providerTransactionId!, externalReference: row.orderId, orderStatus: 'processed', orderStatusDetail: 'accredited', transactionStatus: 'processed', transactionStatusDetail: 'accredited' }))
    await processPaymentOperation(testDb, provider({ refundOrder: vi.fn(async () => { throw new PaymentProviderError('TRANSIENT_UNCERTAIN') }), getOrder }), operationId!, 'worker-a', now)
    expect(getOrder).toHaveBeenCalledOnce()
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, operationId!)))[0]!.status).toBe('PENDING')
  })

  it.each(['CANCEL', 'REFUND_FULL', 'REFUND_PARTIAL'] as const)(
    '%s retries when mutation readback is still unavailable',
    async (type) => {
      const row = await payment()
      const now = new Date('2026-07-16T12:00:00.000Z')
      const queued = await enqueuePaymentOperation(testDb, {
        paymentId: row.id,
        type,
        amountCents: type === 'REFUND_PARTIAL' ? 1000 : null,
        businessKey: `readback:${type}:${row.id}`,
        idempotencyKey: `readback:${type}:${row.id}`,
      }, now)
      const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
      const unavailable = vi.fn(async () => { throw new PaymentProviderError('MUTATION_REQUIRES_READ', 409) })
      const getOrder = vi.fn(async () => { throw new PaymentProviderError('ORDER_NOT_FOUND', 404) })

      await processPaymentOperation(testDb, provider({
        cancelOrder: unavailable,
        refundOrder: unavailable,
        refundPartial: unavailable,
        getOrder,
      }), operationId!, 'worker-a', now)

      expect(getOrder).toHaveBeenCalledWith(row.providerOrderId)
      expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
        status: 'PENDING', failureClass: 'MUTATION_REQUIRES_READ',
        leaseOwner: null, leasedUntil: null,
      })
      expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]!.nextAttemptAt).not.toBeNull()
    },
  )

  it.each([
    ['RESOURCE_LOCKED', 423],
    ['RATE_LIMITED', 429],
  ] as const)('retries %s and honors a bounded provider delay', async (kind, status) => {
    const row = await payment()
    const now = new Date('2026-07-16T12:00:00.000Z')
    const queued = await enqueuePaymentOperation(testDb, {
      paymentId: row.id, type: 'CANCEL', amountCents: null,
      businessKey: `retry:${kind}:${row.id}`, idempotencyKey: `retry:${kind}:${row.id}`,
    }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const failure = vi.fn(async () => { throw new PaymentProviderError(kind, status, 60 * 60) })

    await processPaymentOperation(testDb, provider({
      cancelOrder: failure,
      getOrder: vi.fn(async () => { throw new PaymentProviderError('ORDER_NOT_FOUND', 404) }),
    }), operationId!, 'worker-a', now)

    const [stored] = await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id))
    expect(stored).toMatchObject({ status: 'PENDING', failureClass: kind, leaseOwner: null, leasedUntil: null })
    expect(stored!.nextAttemptAt).toEqual(new Date(now.getTime() + 60 * 60_000))
  })

  it('settles an already-canceled Order from mutation conflict readback', async () => {
    const row = await payment()
    const now = new Date()
    const queued = await enqueuePaymentOperation(testDb, {
      paymentId: row.id, type: 'CANCEL', amountCents: null,
      businessKey: `cancel-readback:${row.id}`, idempotencyKey: `cancel-readback:${row.id}`,
    }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const canceled = snapshot(row.providerOrderId!, row.expectedAmountCents, {
      providerTransactionId: row.providerTransactionId!, externalReference: row.orderId,
      orderStatus: 'canceled', orderStatusDetail: 'canceled',
      transactionStatus: 'canceled', transactionStatusDetail: 'canceled', refundedAmountCents: 0,
    })

    await processPaymentOperation(testDb, provider({
      cancelOrder: vi.fn(async () => { throw new PaymentProviderError('MUTATION_REQUIRES_READ', 409) }),
      getOrder: vi.fn(async () => canceled),
    }), operationId!, 'worker-a', now)

    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
      status: 'SUCCEEDED', resultCode: 'CANCELLED', failureClass: null,
    })
  })

  it('escalates an approved cancel conflict readback to full refund', async () => {
    const row = await payment()
    const now = new Date()
    const queued = await enqueuePaymentOperation(testDb, {
      paymentId: row.id, type: 'CANCEL', amountCents: null,
      businessKey: `cancel-approved-readback:${row.id}`, idempotencyKey: `cancel-approved-readback:${row.id}`,
    }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const approved = snapshot(row.providerOrderId!, row.expectedAmountCents, {
      providerTransactionId: row.providerTransactionId!, externalReference: row.orderId,
      orderStatus: 'processed', orderStatusDetail: 'accredited',
      transactionStatus: 'processed', transactionStatusDetail: 'accredited', refundedAmountCents: 0,
    })

    await processPaymentOperation(testDb, provider({
      cancelOrder: vi.fn(async () => { throw new PaymentProviderError('MUTATION_REQUIRES_READ', 409) }),
      getOrder: vi.fn(async () => approved),
    }), operationId!, 'worker-a', now)

    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
      status: 'SUCCEEDED', resultCode: 'ESCALATED_TO_REFUND',
    })
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.paymentId, row.id)))
      .filter((operation) => operation.type === 'REFUND_FULL')).toHaveLength(1)
  })

  it.each([
    ['REFUND_FULL', 6000, 'SUCCEEDED', null],
    ['REFUND_PARTIAL', 1000, 'SUCCEEDED', null],
    ['REFUND_PARTIAL', 500, 'PENDING', 'REFUND_NOT_COMPLETE'],
    ['REFUND_PARTIAL', 1500, 'REVIEW_REQUIRED', 'MISMATCH_REFUNDED_TARGET'],
  ] as const)('settles %s conflict readback at cumulative refund %s', async (type, refundedAmountCents, status, failureClass) => {
    const row = await payment()
    const now = new Date()
    const queued = await enqueuePaymentOperation(testDb, {
      paymentId: row.id, type, amountCents: type === 'REFUND_PARTIAL' ? 1000 : null,
      businessKey: `refund-readback:${type}:${refundedAmountCents}:${row.id}`,
      idempotencyKey: `rr:${row.id}`,
    }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const refunded = snapshot(row.providerOrderId!, row.expectedAmountCents, {
      providerTransactionId: row.providerTransactionId!, externalReference: row.orderId,
      orderStatus: type === 'REFUND_FULL' ? 'refunded' : 'processed',
      orderStatusDetail: type === 'REFUND_FULL' ? 'refunded' : 'partially_refunded',
      transactionStatus: type === 'REFUND_FULL' ? 'refunded' : 'partially_refunded',
      transactionStatusDetail: type === 'REFUND_FULL' ? 'refunded' : 'partially_refunded',
      refundedAmountCents,
    })
    const conflict = vi.fn(async () => { throw new PaymentProviderError('MUTATION_REQUIRES_READ', 409) })

    await processPaymentOperation(testDb, provider({
      refundOrder: conflict, refundPartial: conflict, getOrder: vi.fn(async () => refunded),
    }), operationId!, 'worker-a', now)

    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
      status, failureClass,
    })
  })

  it('moves deterministic invalid mutation input to review without readback', async () => {
    const row = await payment()
    const now = new Date()
    const queued = await enqueuePaymentOperation(testDb, {
      paymentId: row.id, type: 'CANCEL', amountCents: null,
      businessKey: `invalid:${row.id}`, idempotencyKey: `invalid:${row.id}`,
    }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const getOrder = vi.fn()

    await processPaymentOperation(testDb, provider({
      cancelOrder: vi.fn(async () => { throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID', 400) }),
      getOrder,
    }), operationId!, 'worker-a', now)

    expect(getOrder).not.toHaveBeenCalled()
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
      status: 'REVIEW_REQUIRED', failureClass: 'PROVIDER_RESPONSE_INVALID',
    })
  })

  it('serializes dependent operations and releases only after predecessor success', async () => {
    const row = await payment()
    const now = new Date()
    const first = await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'REFUND_FULL', amountCents: null, businessKey: `refund:first:${row.id}`, idempotencyKey: `idem:first:${row.id}` }, now)
    const second = await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'REFUND_FULL', amountCents: null, businessKey: `refund:second:${row.id}`, idempotencyKey: `idem:second:${row.id}` }, now)
    const secondRow = (await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, second.id)))[0]!
    expect(secondRow.dependsOnOperationId).toBe(first.id)
    const [claimsA, claimsB] = await Promise.all([
      claimDueOperations(testDb, now, 10, 'worker-a'),
      claimDueOperations(testDb, now, 10, 'worker-b'),
    ])
    expect([claimsA, claimsB].flat()).toEqual([first.id])
    await testDb.update(paymentOperations).set({ status: 'SUCCEEDED', resultCode: 'REFUNDED' }).where(eq(paymentOperations.id, first.id))
    expect(await claimDueOperations(testDb, now, 10, 'worker-b')).toEqual([second.id])
  })

  it('propagates predecessor review to dependent operations', async () => {
    const row = await payment()
    const now = new Date()
    const first = await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'REFUND_FULL', amountCents: null, businessKey: `refund:first:${row.id}`, idempotencyKey: `idem:first:${row.id}` }, now)
    const second = await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'REFUND_FULL', amountCents: null, businessKey: `refund:second:${row.id}`, idempotencyKey: `idem:second:${row.id}` }, now)
    await testDb.update(paymentOperations).set({ status: 'REVIEW_REQUIRED' }).where(eq(paymentOperations.id, first.id))
    expect(await propagateReviewedDependencies(testDb, now, 10)).toBe(1)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, second.id)))[0]).toMatchObject({ status: 'REVIEW_REQUIRED', failureClass: 'DEPENDENCY_REVIEW_REQUIRED' })
  })

  it('propagates review through a deep chain without recounting reviewed rows', async () => {
    const row = await payment()
    const now = new Date()
    const ids: string[] = []
    for (let index = 0; index < 5; index++) {
      const queued = await enqueuePaymentOperation(testDb, {
        paymentId: row.id,
        type: 'CANCEL',
        amountCents: null,
        businessKey: `chain:${row.id}:${index}`,
        idempotencyKey: `chain:${row.id}:${index}`,
      }, now)
      ids.push(queued.id)
    }
    await testDb.update(paymentOperations).set({ status: 'REVIEW_REQUIRED' }).where(eq(paymentOperations.id, ids[0]!))
    expect(await propagateReviewedDependencies(testDb, now, 10)).toBe(4)
    expect((await testDb.select().from(paymentOperations).where(inArray(paymentOperations.id, ids.slice(1))))
      .every((operation) => operation.status === 'REVIEW_REQUIRED')).toBe(true)
    expect(await propagateReviewedDependencies(testDb, now, 10)).toBe(0)
  })

  it('completes partial refund only at exact persisted cumulative target', async () => {
    const row = await payment()
    const now = new Date()
    await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'REFUND_PARTIAL', amountCents: 1000, businessKey: `partial:${row.id}`, idempotencyKey: `idem:${row.id}` }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    await processPaymentOperation(testDb, provider({ refundPartial: vi.fn(async () => snapshot(row.providerOrderId!, row.expectedAmountCents, { providerTransactionId: row.providerTransactionId!, externalReference: row.orderId, orderStatus: 'processed', orderStatusDetail: 'partially_refunded', transactionStatus: 'partially_refunded', transactionStatusDetail: 'partially_refunded', refundedAmountCents: 1000 })) }), operationId!, 'worker-a', now)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, operationId!)))[0]).toMatchObject({ status: 'SUCCEEDED', resultCode: 'PARTIALLY_REFUNDED', expectedRefundedAmountCents: 1000 })
  })

  it('retries partial refund below target and reviews above target', async () => {
    const below = await payment()
    const now = new Date()
    await enqueuePaymentOperation(testDb, { paymentId: below.id, type: 'REFUND_PARTIAL', amountCents: 1000, businessKey: `partial:${below.id}`, idempotencyKey: `idem:${below.id}` }, now)
    const [belowId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    await processPaymentOperation(testDb, provider({ refundPartial: vi.fn(async () => snapshot(below.providerOrderId!, below.expectedAmountCents, { providerTransactionId: below.providerTransactionId!, externalReference: below.orderId, orderStatus: 'processed', orderStatusDetail: 'partially_refunded', transactionStatus: 'partially_refunded', transactionStatusDetail: 'partially_refunded', refundedAmountCents: 500 })) }), belowId!, 'worker-a', now)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, belowId!)))[0]!.status).toBe('PENDING')

    const above = await payment()
    await enqueuePaymentOperation(testDb, { paymentId: above.id, type: 'REFUND_PARTIAL', amountCents: 1000, businessKey: `partial:${above.id}`, idempotencyKey: `idem:${above.id}` }, now)
    const [aboveId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    await processPaymentOperation(testDb, provider({ refundPartial: vi.fn(async () => snapshot(above.providerOrderId!, above.expectedAmountCents, { providerTransactionId: above.providerTransactionId!, externalReference: above.orderId, orderStatus: 'processed', orderStatusDetail: 'partially_refunded', transactionStatus: 'partially_refunded', transactionStatusDetail: 'partially_refunded', refundedAmountCents: 1500 })) }), aboveId!, 'worker-a', now)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, aboveId!)))[0]).toMatchObject({ status: 'REVIEW_REQUIRED', failureClass: 'MISMATCH_REFUNDED_TARGET' })
  })

  it('escalates approved cancel to one dependent full refund', async () => {
    const row = await payment()
    const now = new Date()
    await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'CANCEL', amountCents: null, businessKey: `cancel:${row.id}`, idempotencyKey: `idem:${row.id}` }, now)
    const [cancelId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    await processPaymentOperation(testDb, provider({ cancelOrder: vi.fn(async () => snapshot(row.providerOrderId!, row.expectedAmountCents, { providerTransactionId: row.providerTransactionId!, externalReference: row.orderId, orderStatus: 'processed', orderStatusDetail: 'accredited', transactionStatus: 'processed', transactionStatusDetail: 'accredited' })) }), cancelId!, 'worker-a', now)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, cancelId!)))[0]).toMatchObject({ status: 'SUCCEEDED', resultCode: 'ESCALATED_TO_REFUND' })
    const refunds = (await testDb.select().from(paymentOperations).where(eq(paymentOperations.paymentId, row.id))).filter((operation) => operation.type === 'REFUND_FULL')
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ businessKey: `refund-full:${row.id}:ESCALATED_CANCEL:${cancelId}` })
    expect(refunds[0]!.idempotencyKey).toMatch(/^[A-Za-z0-9:_-]{1,64}$/)
    expect(refunds[0]!.idempotencyKey).not.toContain('access-token')
    const replay = await enqueuePaymentOperation(testDb, {
      paymentId: row.id,
      type: 'REFUND_FULL',
      amountCents: null,
      businessKey: refunds[0]!.businessKey,
      idempotencyKey: refunds[0]!.idempotencyKey,
    }, now)
    expect(replay.inserted).toBe(false)
  })

  it('escalates expired PIX approval without reopening awaiting order', async () => {
    const row = await payment()
    const now = new Date()
    await testDb.update(orders).set({ status: 'AWAITING_PAYMENT' }).where(eq(orders.id, row.orderId))
    const cancel = await enqueuePaymentOperation(testDb, {
      paymentId: row.id,
      type: 'CANCEL',
      amountCents: null,
      businessKey: `cancel-expired:${row.id}`,
      idempotencyKey: `cancel-expired:${row.id}`,
    }, now)
    const [cancelId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const approved = snapshot(row.providerOrderId!, row.expectedAmountCents, {
      providerTransactionId: row.providerTransactionId!,
      externalReference: row.orderId,
      orderStatus: 'processed',
      orderStatusDetail: 'accredited',
      transactionStatus: 'processed',
      transactionStatusDetail: 'accredited',
    })
    await processPaymentOperation(testDb, provider({ cancelOrder: vi.fn(async () => approved) }), cancelId!, 'worker-a', now)

    const operations = await testDb.select().from(paymentOperations).where(eq(paymentOperations.paymentId, row.id))
    expect(operations.find((operation) => operation.id === cancel.id)).toMatchObject({
      status: 'SUCCEEDED',
      resultCode: 'ESCALATED_TO_REFUND',
    })
    expect(operations.find((operation) => operation.type === 'REFUND_FULL')).toMatchObject({
      status: 'PENDING',
      dependsOnOperationId: cancel.id,
      expectedRefundedAmountCents: row.expectedAmountCents,
    })
    expect((await testDb.select().from(orders).where(eq(orders.id, row.orderId)))[0]!.status).toBe('CANCELLED')
  })

  it('accepts final partial refund when provider reports full refund at exact target', async () => {
    const row = await payment()
    const now = new Date()
    await testDb.update(payments).set({
      status: 'APPROVED',
      refundedAmountCents: row.expectedAmountCents - 1000,
    }).where(eq(payments.id, row.id))
    await enqueuePaymentOperation(testDb, {
      paymentId: row.id,
      type: 'REFUND_PARTIAL',
      amountCents: 1000,
      businessKey: `partial-final:${row.id}`,
      idempotencyKey: `partial-final:${row.id}`,
    }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    await processPaymentOperation(testDb, provider({ refundPartial: vi.fn(async () => snapshot(
      row.providerOrderId!, row.expectedAmountCents, {
        providerTransactionId: row.providerTransactionId!,
        externalReference: row.orderId,
        orderStatus: 'refunded',
        orderStatusDetail: 'refunded',
        transactionStatus: 'refunded',
        transactionStatusDetail: 'refunded',
        refundedAmountCents: row.expectedAmountCents,
      },
    )) }), operationId!, 'worker-a', now)

    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, operationId!)))[0]).toMatchObject({
      status: 'SUCCEEDED',
      resultCode: 'PARTIALLY_REFUNDED',
      expectedRefundedAmountCents: row.expectedAmountCents,
    })
  })

  it.each(['CANCEL', 'REFUND_FULL', 'REFUND_PARTIAL'] as const)('moves direct retry result to review on attempt eight: %s', async (type) => {
    const row = await payment()
    const now = new Date()
    const amountCents = type === 'REFUND_PARTIAL' ? 1000 : null
    const queued = await enqueuePaymentOperation(testDb, {
      paymentId: row.id,
      type,
      amountCents,
      businessKey: `exhaust:${type}:${row.id}`,
      idempotencyKey: `exhaust:${type}:${row.id}`,
    }, now)
    await testDb.update(paymentOperations).set({ attemptCount: 7 }).where(eq(paymentOperations.id, queued.id))
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const pending = snapshot(row.providerOrderId!, row.expectedAmountCents, {
      providerTransactionId: row.providerTransactionId!,
      externalReference: row.orderId,
      orderStatus: type === 'REFUND_PARTIAL' ? 'processed' : 'pending',
      orderStatusDetail: type === 'REFUND_PARTIAL' ? 'partially_refunded' : 'pending',
      transactionStatus: type === 'REFUND_PARTIAL' ? 'partially_refunded' : 'pending',
      transactionStatusDetail: type === 'REFUND_PARTIAL' ? 'partially_refunded' : 'pending',
      refundedAmountCents: type === 'REFUND_PARTIAL' ? 500 : 0,
    })
    await processPaymentOperation(testDb, provider({
      cancelOrder: vi.fn(async () => pending),
      refundOrder: vi.fn(async () => pending),
      refundPartial: vi.fn(async () => pending),
    }), operationId!, 'worker-a', now)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
      status: 'REVIEW_REQUIRED',
      failureClass: 'RETRY_EXHAUSTED',
      leaseOwner: null,
      leasedUntil: null,
    })
  })

  it('rejects an identical full-refund key with a conflicting persisted target', async () => {
    const row = await payment()
    const key = `refund-full-conflict:${row.id}`
    await testDb.insert(paymentOperations).values({
      paymentId: row.id,
      type: 'REFUND_FULL',
      amountCents: null,
      expectedRefundedAmountCents: row.expectedAmountCents - 1,
      businessKey: key,
      idempotencyKey: key,
    })
    await expect(enqueuePaymentOperation(testDb, {
      paymentId: row.id,
      type: 'REFUND_FULL',
      amountCents: null,
      businessKey: key,
      idempotencyKey: key,
    }, new Date())).rejects.toThrow('payment operation business key conflict')
  })
})

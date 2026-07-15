import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createActiveStoreTestFixture, createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb, type StoreFixtureInput } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { payments, paymentOperations, orders } from '../src/db/schema'
import { updateStore } from '../src/services/store.service'
import { claimDueOperations, enqueuePaymentOperation, processPaymentOperation } from '../src/payments/operation.service'
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
  return { providerOrderId: paymentId, providerTransactionId: `tx-${paymentId}`, orderStatus: 'refunded', orderStatusDetail: 'refunded', transactionStatus: 'refunded', transactionStatusDetail: 'refunded', externalReference: 'unused', totalAmountCents: amount, refundedAmountCents: amount, countryCode: 'BR', currency: 'BRL', processingMode: 'aggregator', method: 'PIX', paymentMethodId: 'pix', applicationId: 'app-test', accountId: 'account-test', liveMode: false, transactionCount: 1, pix: null, updatedAt: new Date(), ...patch }
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
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, operationId!)))[0]!.status).toBe('SUCCEEDED')
  })

  it('uncertain provider response retries after GET; credentials move review', async () => {
    const row = await payment()
    const now = new Date()
    await enqueuePaymentOperation(testDb, { paymentId: row.id, type: 'CANCEL', amountCents: null, businessKey: `cancel:${row.id}`, idempotencyKey: `idem:${row.id}` }, now)
    const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
    const getOrder = vi.fn(async () => snapshot(row.providerOrderId!, row.expectedAmountCents, { providerTransactionId: row.providerTransactionId!, externalReference: row.orderId, orderStatus: 'canceled', orderStatusDetail: 'canceled', transactionStatus: 'canceled', transactionStatusDetail: 'canceled', refundedAmountCents: 0 }))
    await processPaymentOperation(testDb, provider({ cancelOrder: vi.fn(async () => { throw new PaymentProviderError('TRANSIENT_UNCERTAIN') }), getOrder }), operationId!, 'worker-a', now)
    expect(getOrder).toHaveBeenCalledOnce()
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, operationId!)))[0]!.status).toBe('SUCCEEDED')
  })
})

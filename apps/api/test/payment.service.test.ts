import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { createActiveStoreTestFixture, createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb, type StoreFixtureInput } from './helpers/test-db'
import { createProduct, createCategory } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { updateStore } from '../src/services/store.service'
import { orderEvents, orders, paymentOperations, payments } from '../src/db/schema'
import { applyProviderSnapshot } from '../src/payments/transition.service'
import { providerSnapshot } from './helpers/payment-provider'

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
    orderId: order.id, providerOrderId: 'mp-order', providerTransactionId: 'mp-tx', method: 'PIX', expectedAmountCents: order.totalCents,
    expectedCurrency: 'BRL', expectedCountry: 'BR', expectedApplicationId: 'app-test', expectedAccountId: 'account-test', expectedLiveMode: false,
    createIdempotencyKey: crypto.randomUUID(), qrCode: 'qr', qrCodeBase64: 'b64',
  }).returning()
  return { order, payment: payment! }
}

function snapshot(orderId: string, amountCents: number, patch: Partial<ReturnType<typeof providerSnapshot>> = {}) {
  return providerSnapshot({ providerOrderId: 'mp-order', providerTransactionId: 'mp-tx', externalReference: orderId, totalAmountCents: amountCents, ...patch })
}

describe('applyProviderSnapshot', () => {
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
    const pending = snapshot(order.id, order.totalCents, { orderStatus: 'waiting_transfer', orderStatusDetail: 'waiting_transfer', transactionStatus: 'waiting_transfer', transactionStatusDetail: 'waiting_transfer' })
    expect((await applyProviderSnapshot(testDb, payment.id, pending, new Date())).decision).toBe('PENDING')
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
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.businessKey, `late-refund:${payment.id}`))).length).toBe(1)
    const again = await applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents), new Date())
    expect(again.operationEnqueued).toBe(false)
  })
})

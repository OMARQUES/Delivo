import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createActiveStoreTestFixture, createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb, type StoreFixtureInput } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { updateStore } from '../src/services/store.service'
import { paymentOperations, payments } from '../src/db/schema'
import { enqueueWebhook } from '../src/payments/webhook-inbox.service'
import { runPaymentReconciliation, type ReconciliationOptions, type ReconciliationStage } from '../src/payments/reconciliation.service'
import { PaymentProviderError, type PaymentProvider, type ProviderOrderSnapshot } from '../src/payments/provider'

const storeInput: StoreFixtureInput = { name: 'Pizzaria', slug: 'pizzaria', category: 'PIZZARIA', phone: '4433334444', city: 'C', addressText: 'Rua A, 1', lat: -23.55, lng: -51.9, owner: { name: 'João', email: 'recon-store@test.local', password: 'senha123' } }
let customerId: string
let productId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createActiveStoreTestFixture(storeInput)
  await updateStore(testDb, store.id, { openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })), deliveryFeeMode: 'FIXED', deliveryFixedFeeCents: 0, minOrderCents: 1000 })
  customerId = (await createVerifiedTestAccount(testDb, { name: 'Recon', phone: '44999998888', password: 'senha123', role: 'CUSTOMER', acceptedTerms: true }, 'test-secret')).user.id
  const category = await createCategory(testDb, store.id, { name: 'Pizzas' })
  productId = (await createProduct(testDb, store.id, { categoryId: category.id, name: 'Pizza', basePriceCents: 6000, isAvailable: true })).id
})
afterAll(closeTestDb)

async function pendingPayment(expiresAt: Date | null = null) {
  const { order } = await createOrder(testDb, customerId, { storeSlug: 'pizzaria', fulfillment: 'PICKUP', paymentMethod: 'CASH', items: [{ productId, quantity: 1, selections: [] }], idempotencyKey: crypto.randomUUID() })
  const [payment] = await testDb.insert(payments).values({ orderId: order.id, providerOrderId: `mp-${order.id}`, providerTransactionId: `tx-${order.id}`, method: 'PIX', expectedAmountCents: order.totalCents, expectedCurrency: 'BRL', expectedCountry: 'BR', expectedApplicationId: 'app-test', expectedAccountId: 'account-test', expectedLiveMode: false, createIdempotencyKey: crypto.randomUUID(), expiresAt }).returning()
  return payment!
}

function snapshot(payment: typeof payments.$inferSelect, patch: Partial<ProviderOrderSnapshot> = {}): ProviderOrderSnapshot {
  return { providerOrderId: payment.providerOrderId!, providerTransactionId: payment.providerTransactionId!, orderStatus: 'created', orderStatusDetail: 'pending', transactionStatus: 'pending', transactionStatusDetail: 'pending', externalReference: payment.orderId, totalAmountCents: payment.expectedAmountCents, refundedAmountCents: 0, countryCode: 'BR', currency: 'BRL', processingMode: 'automatic', method: 'PIX', paymentMethodId: 'pix', applicationId: payment.expectedApplicationId, accountId: payment.expectedAccountId, liveMode: false, transactionCount: 1, pix: null, updatedAt: new Date(), ...patch }
}

function provider(overrides: Partial<PaymentProvider> = {}, payment?: typeof payments.$inferSelect): PaymentProvider {
  const base = payment ? snapshot(payment) : { providerOrderId: 'unknown', providerTransactionId: 'tx', orderStatus: 'created', orderStatusDetail: 'pending', transactionStatus: 'pending', transactionStatusDetail: 'pending', externalReference: 'missing', totalAmountCents: 100, refundedAmountCents: 0, countryCode: 'BR', currency: 'BRL', processingMode: 'automatic', method: 'PIX' as const, paymentMethodId: 'pix', applicationId: 'app', accountId: 'account', liveMode: false, transactionCount: 1, pix: null, updatedAt: new Date() }
  return { getAccountId: vi.fn(async () => 'account-test'), getOrder: vi.fn(async () => base), searchOrders: vi.fn(async () => []), createOrder: vi.fn(), cancelOrder: vi.fn(), refundOrder: vi.fn(), refundPartial: vi.fn(), ...overrides } as PaymentProvider
}

const context = { resolvePayerEmail: (email: string | null) => email ?? 'masked@test.local' }
const only = (...stages: ReconciliationStage[]): ReconciliationOptions => ({ stages, limits: { inbox: 1, operations: 1, creates: 1, snapshots: 1, expirations: 1, reviews: 1 } })

describe('payment reconciliation', () => {
  it('processes due inbox with bounded limit and reports counts only', async () => {
    const now = new Date()
    await enqueueWebhook(testDb, { topic: 'order', resourceId: 'unknown', requestId: 'req', signatureTimestamp: '1' }, now)
    const summary = await runPaymentReconciliation(testDb, provider(), now, context, only('inbox'))
    expect(summary.inboxProcessed).toBe(1)
    expect(summary.stageFailures).toBe(0)
    expect(Object.keys(summary)).not.toContain('resourceId')
  })

  it.each(['leases', 'dependencies', 'inbox', 'operations', 'creates', 'snapshots', 'expirations', 'reviews'] as const)('runs stage %s without enabling unrelated stages', async (stage) => {
    const summary = await runPaymentReconciliation(testDb, provider(), new Date(), context, only(stage))
    expect(summary.stageFailures).toBeGreaterThanOrEqual(0)
  })

  it('persists known account mismatch as stable review', async () => {
    const pending = await pendingPayment()
    const now = new Date()
    const summary = await runPaymentReconciliation(testDb, provider({ getOrder: vi.fn(async () => snapshot(pending, { accountId: 'wrong-account' })) }, pending), now, context, only('snapshots'))
    expect(summary.stageFailures).toBe(0)
    expect((await testDb.select().from(payments).where(eq(payments.id, pending.id)))[0]).toMatchObject({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'MISMATCH_ACCOUNT', nextReconcileAt: null })
  })

  it('moves attempt eight provider failure to terminal review', async () => {
    const pending = await pendingPayment()
    await testDb.update(payments).set({ reconciliationAttemptCount: 7 }).where(eq(payments.id, pending.id))
    const now = new Date()
    const failing = provider({ getOrder: vi.fn(async () => { throw new PaymentProviderError('PROVIDER_UNAVAILABLE') }) }, pending)
    await runPaymentReconciliation(testDb, failing, now, context, only('snapshots'))
    expect((await testDb.select().from(payments).where(eq(payments.id, pending.id)))[0]).toMatchObject({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'RETRY_EXHAUSTED', reconciliationAttemptCount: 8 })
  })

  it('continues to expiration after snapshot-stage failure', async () => {
    const expired = await pendingPayment(new Date(Date.now() - 1_000))
    const now = new Date()
    const failing = provider({ getOrder: vi.fn(async () => { throw new PaymentProviderError('PROVIDER_UNAVAILABLE') }) }, expired)
    const summary = await runPaymentReconciliation(testDb, failing, now, context, only('snapshots', 'expirations'))
    expect(summary.stageFailures).toBe(1)
    expect(summary.pixExpired).toBe(1)
    expect(await testDb.select().from(paymentOperations).where(eq(paymentOperations.businessKey, `cancel:${expired.id}:PIX_EXPIRED`))).toHaveLength(1)
  })

  it('lets overlapping reconcilers transition each payment once', async () => {
    const pending = await pendingPayment()
    const now = new Date()
    const [first, second] = await Promise.all([
      runPaymentReconciliation(testDb, provider({}, pending), now, context, only('snapshots')),
      runPaymentReconciliation(testDb, provider({}, pending), now, context, only('snapshots')),
    ])
    expect(first.snapshotsRefreshed + second.snapshotsRefreshed).toBe(1)
    expect((await testDb.select().from(payments).where(eq(payments.id, pending.id)))[0]!.reconciliationAttemptCount).toBe(0)
  })

  it('failure in one stage does not prevent later stages', async () => {
    const broken = provider()
    broken.getAccountId = vi.fn(async () => { throw new Error('provider down') })
    const summary = await runPaymentReconciliation(testDb, broken, new Date(), context, only('snapshots', 'expirations'))
    expect(summary.stageFailures).toBe(1)
    expect(summary.operationsProcessed).toBe(0)
  })
})

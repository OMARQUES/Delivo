import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createActiveStoreTestFixture, createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb, type StoreFixtureInput } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { updateStore } from '../src/services/store.service'
import { paymentOperations, paymentWebhookInbox, payments } from '../src/db/schema'
import { enqueueWebhook } from '../src/payments/webhook-inbox.service'
import { runPaymentReconciliation, type ReconciliationOptions, type ReconciliationStage } from '../src/payments/reconciliation.service'
import { PaymentProviderError, type PaymentProvider, type ProviderOrderSnapshot } from '../src/payments/provider'
import { enqueuePaymentOperation } from '../src/payments/operation-queue.service'

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

  it.each(['leases', 'dependencies', 'inbox', 'operations', 'creates', 'snapshots', 'expirations', 'reviews'] as const)('isolates reconciliation stage %s', async (stage) => {
    const now = new Date()
    const unrelatedNext = new Date(now.getTime() + 60 * 60_000)
    const unrelated = await pendingPayment(unrelatedNext)
    await testDb.update(payments).set({ nextReconcileAt: unrelatedNext }).where(eq(payments.id, unrelated.id))
    const stageProvider = provider()
    const expected: Record<string, number> = {}

    if (stage === 'leases') {
      const payment = await pendingPayment()
      const operation = await enqueuePaymentOperation(testDb, {
        paymentId: payment.id,
        type: 'CANCEL',
        amountCents: null,
        businessKey: `cancel:${payment.id}:lease-matrix`,
        idempotencyKey: `cancel:${payment.id}:lease-matrix`,
      }, now)
      await testDb.update(paymentOperations).set({ status: 'PROCESSING', leasedUntil: new Date(now.getTime() - 1_000) }).where(eq(paymentOperations.id, operation.id))
      const inbox = await enqueueWebhook(testDb, { topic: 'order', resourceId: 'lease-matrix', requestId: 'lease-matrix', signatureTimestamp: '1' }, now)
      await testDb.update(paymentWebhookInbox).set({ status: 'PROCESSING', leasedUntil: new Date(now.getTime() - 1_000) }).where(eq(paymentWebhookInbox.id, inbox.id))
      expected.leasesRecovered = 2
    }

    if (stage === 'dependencies') {
      const payment = await pendingPayment()
      const predecessor = await enqueuePaymentOperation(testDb, {
        paymentId: payment.id,
        type: 'CANCEL',
        amountCents: null,
        businessKey: `cancel:${payment.id}:dependency-predecessor`,
        idempotencyKey: `cancel:${payment.id}:dependency-predecessor`,
      }, now)
      await testDb.update(paymentOperations).set({ status: 'REVIEW_REQUIRED' }).where(eq(paymentOperations.id, predecessor.id))
      await testDb.insert(paymentOperations).values({
        paymentId: payment.id,
        type: 'CANCEL',
        businessKey: `cancel:${payment.id}:dependency-child`,
        idempotencyKey: `cancel:${payment.id}:dependency-child`,
        dependsOnOperationId: predecessor.id,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      expected.dependenciesReviewed = 1
    }

    if (stage === 'inbox') {
      await enqueueWebhook(testDb, { topic: 'order', resourceId: 'unknown-matrix', requestId: 'unknown-matrix', signatureTimestamp: '1' }, now)
      expected.inboxProcessed = 1
    }

    if (stage === 'operations') {
      const payment = await pendingPayment()
      await testDb.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, payment.id))
      const operation = await enqueuePaymentOperation(testDb, {
        paymentId: payment.id,
        type: 'CANCEL',
        amountCents: null,
        businessKey: `cancel:${payment.id}:operation-matrix`,
        idempotencyKey: `cancel:${payment.id}:operation-matrix`,
      }, now)
      stageProvider.cancelOrder = vi.fn(async () => snapshot(payment, { orderStatus: 'canceled', orderStatusDetail: 'canceled' }))
      expected.operationsReleased = 1
      expected.operationsProcessed = 1
      expect(operation.id).toBeTruthy()
    }

    if (stage === 'creates') {
      const payment = await pendingPayment()
      await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null }).where(eq(payments.id, payment.id))
      const recovered = snapshot({ ...payment, providerOrderId: 'recovered-order', providerTransactionId: 'recovered-transaction' }, { externalReference: payment.orderId })
      stageProvider.searchOrders = vi.fn(async () => [recovered])
      expected.createsRecovered = 1
    }

    if (stage === 'snapshots') {
      const payment = await pendingPayment()
      stageProvider.getOrder = vi.fn(async () => snapshot(payment))
      expected.snapshotsRefreshed = 1
    }

    if (stage === 'expirations') {
      await pendingPayment(new Date(now.getTime() - 1_000))
      expected.pixExpired = 1
    }

    if (stage === 'reviews') {
      const payment = await pendingPayment()
      await testDb.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'ORDER_NOT_FOUND', nextReconcileAt: now }).where(eq(payments.id, payment.id))
      stageProvider.getOrder = vi.fn(async () => snapshot(payment))
      expected.reviewsRechecked = 1
    }

    const summary = await runPaymentReconciliation(testDb, stageProvider, now, context, only(stage))
    expect(summary.stageFailures).toBe(0)
    for (const [key, value] of Object.entries(summary)) {
      expect(value).toBe(expected[key as keyof typeof expected] ?? 0)
    }

    const [unrelatedAfter] = await testDb.select().from(payments).where(eq(payments.id, unrelated.id))
    expect(unrelatedAfter).toMatchObject({ status: 'PENDING', reconciliationState: 'PENDING', reconciliationAttemptCount: 0, nextReconcileAt: unrelatedNext })

    const calls = {
      getAccountId: stageProvider.getAccountId,
      getOrder: stageProvider.getOrder,
      searchOrders: stageProvider.searchOrders,
      createOrder: stageProvider.createOrder,
      cancelOrder: stageProvider.cancelOrder,
      refundOrder: stageProvider.refundOrder,
      refundPartial: stageProvider.refundPartial,
    }
    const allowed = stage === 'inbox' || stage === 'snapshots' ? ['getAccountId', 'getOrder'] : stage === 'operations' ? ['cancelOrder'] : stage === 'creates' ? ['searchOrders'] : stage === 'reviews' ? ['getOrder'] : []
    for (const [name, spy] of Object.entries(calls)) {
      if (!allowed.includes(name)) expect(spy).not.toHaveBeenCalled()
    }
  })

  it('keeps reconciliation summaries, logs, and errors sanitized', async () => {
    const forbidden = ['provider-body-9f4a', 'access-token-9f4a', 'webhook-secret-9f4a', 'signature-9f4a', 'payer@example.invalid', 'qr-content-9f4a', 'postgresql://forbidden.invalid/db']
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const leakingProvider = provider({ getAccountId: vi.fn(async () => { throw new Error(forbidden.join('|')) }) })
      const summary = await runPaymentReconciliation(testDb, leakingProvider, new Date(), context, only('snapshots'))
      const output = JSON.stringify(summary) + [...logs.mock.calls, ...errors.mock.calls].flat().join(' ')
      expect(forbidden.some((marker) => output.includes(marker))).toBe(false)
    } finally {
      logs.mockRestore()
      errors.mockRestore()
    }
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

  it('counts each overlapping inbox, operation, and snapshot claim once', async () => {
    const operationPayment = await pendingPayment()
    const snapshotPayment = await pendingPayment()
    const now = new Date()
    await testDb.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, operationPayment.id))
    const cancelKey = `cancel:${operationPayment.id}:overlap`
    const queuedOperation = await enqueuePaymentOperation(testDb, {
      paymentId: operationPayment.id,
      type: 'CANCEL',
      amountCents: null,
      businessKey: cancelKey,
      idempotencyKey: cancelKey,
    }, now)
    const queuedInbox = await enqueueWebhook(testDb, {
      topic: 'order',
      resourceId: 'inbox-overlap-resource',
      requestId: 'inbox-overlap-request',
      signatureTimestamp: '1',
    }, now)
    const operationSnapshot = snapshot(operationPayment, { orderStatus: 'canceled', orderStatusDetail: 'canceled' })
    const inboxSnapshot = snapshot(snapshotPayment, {
      providerOrderId: 'inbox-only-order',
      providerTransactionId: 'inbox-only-transaction',
      externalReference: 'missing-order',
    })
    const sharedProvider = provider({
      getOrder: vi.fn(async (providerOrderId: string) => providerOrderId === 'inbox-overlap-resource' ? inboxSnapshot : snapshot(snapshotPayment)),
      cancelOrder: vi.fn(async () => operationSnapshot),
    }, snapshotPayment)

    const [first, second] = await Promise.all([
      runPaymentReconciliation(testDb, sharedProvider, now, context, only('inbox', 'operations', 'snapshots')),
      runPaymentReconciliation(testDb, sharedProvider, now, context, only('inbox', 'operations', 'snapshots')),
    ])

    expect(first.inboxProcessed + second.inboxProcessed).toBe(1)
    expect(first.operationsReleased + second.operationsReleased).toBe(1)
    expect(first.operationsProcessed + second.operationsProcessed).toBe(1)
    expect(first.snapshotsRefreshed + second.snapshotsRefreshed).toBe(1)
    expect((await testDb.select().from(paymentWebhookInbox).where(eq(paymentWebhookInbox.id, queuedInbox.id)))[0]?.attemptCount).toBe(1)
    expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queuedOperation.id)))[0]?.attemptCount).toBe(1)
    expect(sharedProvider.cancelOrder).toHaveBeenCalledTimes(1)
  })

  it('failure in one stage does not prevent later stages', async () => {
    const broken = provider()
    broken.getAccountId = vi.fn(async () => { throw new Error('provider down') })
    const summary = await runPaymentReconciliation(testDb, broken, new Date(), context, only('snapshots', 'expirations'))
    expect(summary.stageFailures).toBe(1)
    expect(summary.operationsProcessed).toBe(0)
  })
})

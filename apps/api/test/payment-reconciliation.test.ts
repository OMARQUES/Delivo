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
const stages = ['leases', 'dependencies', 'inbox', 'operations', 'creates', 'snapshots', 'expirations', 'reviews'] as const

type IsolationState = {
  leases: { inboxStatus: string; inboxAttemptCount: number; operationStatus: string; operationAttemptCount: number }
  dependencies: { childStatus: string; childFailureClass: string | null }
  inbox: { status: string; attemptCount: number; failureClass: string | null }
  operations: { status: string; attemptCount: number; resultCode: string | null; paymentStatus: string }
  creates: { providerOrderId: string | null; providerTransactionId: string | null; reconciliationState: string }
  snapshots: { reconciliationState: string; reconciliationAttemptCount: number; providerStatus: string | null; nextReconcileAt: Date | null }
  expirations: { cancelOperationCount: number }
  reviews: { reconciliationState: string; reconciliationFailure: string | null; reconciliationAttemptCount: number; nextReconcileAt: Date | null }
}

type IsolationFixture = {
  provider: PaymentProvider
  before: IsolationState
  selectedAfter: IsolationState
  readState: () => Promise<IsolationState>
}

async function createIsolationFixture(now: Date): Promise<IsolationFixture> {
  const operationAt = new Date(now.getTime() - 5 * 60_000)
  const createAt = new Date(now.getTime() - 4 * 60_000)
  const snapshotAt = new Date(now.getTime() - 3 * 60_000)
  const reviewAt = new Date(now.getTime() - 2 * 60_000)
  const leaseAt = new Date(now.getTime() - 60_000)
  const expiredAt = new Date(now.getTime() - 1_000)
  const futureAt = new Date(now.getTime() + 60 * 60_000)
  const retryAt = new Date(now.getTime() + 5 * 60_000)

  const operationPayment = await pendingPayment()
  await testDb.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, operationPayment.id))
  const operationKey = 'cancel:' + operationPayment.id + ':isolation-operation'
  const operation = await enqueuePaymentOperation(testDb, {
    paymentId: operationPayment.id,
    type: 'CANCEL',
    amountCents: null,
    businessKey: operationKey,
    idempotencyKey: operationKey,
  }, operationAt)

  const leasePayment = await pendingPayment()
  await testDb.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, leasePayment.id))
  const leaseOperationKey = 'cancel:' + leasePayment.id + ':isolation-lease'
  const leaseOperation = await enqueuePaymentOperation(testDb, {
    paymentId: leasePayment.id,
    type: 'CANCEL',
    amountCents: null,
    businessKey: leaseOperationKey,
    idempotencyKey: leaseOperationKey,
  }, leaseAt)
  await testDb.update(paymentOperations).set({ status: 'PROCESSING', leaseOwner: 'expired-lease', leasedUntil: expiredAt }).where(eq(paymentOperations.id, leaseOperation.id))
  const leaseInbox = await enqueueWebhook(testDb, { topic: 'order', resourceId: 'lease-isolation-resource', requestId: crypto.randomUUID(), signatureTimestamp: '1' }, leaseAt)
  await testDb.update(paymentWebhookInbox).set({ status: 'PROCESSING', leaseOwner: 'expired-lease', leasedUntil: expiredAt }).where(eq(paymentWebhookInbox.id, leaseInbox.id))

  const dependencyPayment = await pendingPayment()
  await testDb.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, dependencyPayment.id))
  const predecessorKey = 'cancel:' + dependencyPayment.id + ':isolation-predecessor'
  const predecessor = await enqueuePaymentOperation(testDb, {
    paymentId: dependencyPayment.id,
    type: 'CANCEL',
    amountCents: null,
    businessKey: predecessorKey,
    idempotencyKey: predecessorKey,
  }, now)
  await testDb.update(paymentOperations).set({ status: 'REVIEW_REQUIRED' }).where(eq(paymentOperations.id, predecessor.id))
  const [dependencyChild] = await testDb.insert(paymentOperations).values({
    paymentId: dependencyPayment.id,
    type: 'CANCEL',
    amountCents: null,
    expectedRefundedAmountCents: null,
    businessKey: 'cancel:' + dependencyPayment.id + ':isolation-child',
    idempotencyKey: 'cancel:' + dependencyPayment.id + ':isolation-child',
    dependsOnOperationId: predecessor.id,
    status: 'PENDING',
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning()

  const inboxResourceId = 'unknown-isolation-' + crypto.randomUUID()
  const inbox = await enqueueWebhook(testDb, { topic: 'order', resourceId: inboxResourceId, requestId: crypto.randomUUID(), signatureTimestamp: '1' }, now)

  const createPayment = await pendingPayment()
  await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null, nextReconcileAt: createAt }).where(eq(payments.id, createPayment.id))
  const recoveredOrderId = 'recovered-' + createPayment.id
  const recoveredTransactionId = 'recovered-tx-' + createPayment.id
  const recoveredCreateSnapshot = snapshot(createPayment, { providerOrderId: recoveredOrderId, providerTransactionId: recoveredTransactionId })

  const snapshotPayment = await pendingPayment()
  await testDb.update(payments).set({ nextReconcileAt: snapshotAt }).where(eq(payments.id, snapshotPayment.id))

  const expirationPayment = await pendingPayment(expiredAt)
  await testDb.update(payments).set({ nextReconcileAt: futureAt }).where(eq(payments.id, expirationPayment.id))
  const expirationKey = 'cancel:' + expirationPayment.id + ':PIX_EXPIRED'

  const reviewPayment = await pendingPayment()
  await testDb.update(payments).set({ reconciliationState: 'REVIEW_REQUIRED', reconciliationFailure: 'ORDER_NOT_FOUND', nextReconcileAt: reviewAt }).where(eq(payments.id, reviewPayment.id))

  const inboxUnknownSnapshot = snapshot(snapshotPayment, {
    providerOrderId: 'unknown-order-' + snapshotPayment.id,
    providerTransactionId: 'unknown-tx-' + snapshotPayment.id,
    externalReference: 'missing-order',
  })
  const cancelledOperationSnapshot = snapshot(operationPayment, {
    orderStatus: 'canceled',
    orderStatusDetail: 'canceled',
    transactionStatus: 'canceled',
    transactionStatusDetail: 'canceled',
  })
  const stageProvider = provider({
    getOrder: vi.fn(async (providerOrderId: string) => {
      if (providerOrderId === inboxResourceId) return inboxUnknownSnapshot
      if (providerOrderId === snapshotPayment.providerOrderId) return snapshot(snapshotPayment)
      if (providerOrderId === reviewPayment.providerOrderId) return snapshot(reviewPayment)
      throw new Error('unexpected getOrder target')
    }),
    searchOrders: vi.fn(async (orderId: string) => {
      if (orderId === createPayment.orderId) return [recoveredCreateSnapshot]
      throw new Error('unexpected searchOrders target')
    }),
    cancelOrder: vi.fn(async (providerOrderId: string) => {
      if (providerOrderId === operationPayment.providerOrderId) return cancelledOperationSnapshot
      throw new Error('unexpected cancelOrder target')
    }),
  })

  const readState = async (): Promise<IsolationState> => {
    const [leaseInboxRow] = await testDb.select().from(paymentWebhookInbox).where(eq(paymentWebhookInbox.id, leaseInbox.id))
    const [leaseOperationRow] = await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, leaseOperation.id))
    const [dependencyChildRow] = await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, dependencyChild!.id))
    const [inboxRow] = await testDb.select().from(paymentWebhookInbox).where(eq(paymentWebhookInbox.id, inbox.id))
    const [operationRow] = await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id))
    const [operationPaymentRow] = await testDb.select().from(payments).where(eq(payments.id, operationPayment.id))
    const [createPaymentRow] = await testDb.select().from(payments).where(eq(payments.id, createPayment.id))
    const [snapshotPaymentRow] = await testDb.select().from(payments).where(eq(payments.id, snapshotPayment.id))
    const expirationOperations = await testDb.select({ id: paymentOperations.id }).from(paymentOperations).where(eq(paymentOperations.businessKey, expirationKey))
    const [reviewPaymentRow] = await testDb.select().from(payments).where(eq(payments.id, reviewPayment.id))

    return {
      leases: { inboxStatus: leaseInboxRow!.status, inboxAttemptCount: leaseInboxRow!.attemptCount, operationStatus: leaseOperationRow!.status, operationAttemptCount: leaseOperationRow!.attemptCount },
      dependencies: { childStatus: dependencyChildRow!.status, childFailureClass: dependencyChildRow!.failureClass },
      inbox: { status: inboxRow!.status, attemptCount: inboxRow!.attemptCount, failureClass: inboxRow!.failureClass },
      operations: { status: operationRow!.status, attemptCount: operationRow!.attemptCount, resultCode: operationRow!.resultCode, paymentStatus: operationPaymentRow!.status },
      creates: { providerOrderId: createPaymentRow!.providerOrderId, providerTransactionId: createPaymentRow!.providerTransactionId, reconciliationState: createPaymentRow!.reconciliationState },
      snapshots: { reconciliationState: snapshotPaymentRow!.reconciliationState, reconciliationAttemptCount: snapshotPaymentRow!.reconciliationAttemptCount, providerStatus: snapshotPaymentRow!.providerStatus, nextReconcileAt: snapshotPaymentRow!.nextReconcileAt },
      expirations: { cancelOperationCount: expirationOperations.length },
      reviews: { reconciliationState: reviewPaymentRow!.reconciliationState, reconciliationFailure: reviewPaymentRow!.reconciliationFailure, reconciliationAttemptCount: reviewPaymentRow!.reconciliationAttemptCount, nextReconcileAt: reviewPaymentRow!.nextReconcileAt },
    }
  }

  const before = await readState()
  const selectedAfter: IsolationState = {
    leases: { inboxStatus: 'PENDING', inboxAttemptCount: 0, operationStatus: 'PENDING', operationAttemptCount: 0 },
    dependencies: { childStatus: 'REVIEW_REQUIRED', childFailureClass: 'DEPENDENCY_REVIEW_REQUIRED' },
    inbox: { status: 'REVIEW_REQUIRED', attemptCount: 1, failureClass: 'UNKNOWN_ORDER' },
    operations: { status: 'SUCCEEDED', attemptCount: 1, resultCode: 'CANCELLED', paymentStatus: 'APPROVED' },
    creates: { providerOrderId: recoveredOrderId, providerTransactionId: recoveredTransactionId, reconciliationState: 'HEALTHY' },
    snapshots: { reconciliationState: 'HEALTHY', reconciliationAttemptCount: 0, providerStatus: 'created', nextReconcileAt: retryAt },
    expirations: { cancelOperationCount: 1 },
    reviews: { reconciliationState: 'HEALTHY', reconciliationFailure: null, reconciliationAttemptCount: 0, nextReconcileAt: retryAt },
  }

  return { provider: stageProvider, before, selectedAfter, readState }
}

describe('payment reconciliation', () => {
  it('processes due inbox with bounded limit and reports counts only', async () => {
    const now = new Date()
    await enqueueWebhook(testDb, { topic: 'order', resourceId: 'unknown', requestId: 'req', signatureTimestamp: '1' }, now)
    const summary = await runPaymentReconciliation(testDb, provider(), now, context, only('inbox'))
    expect(summary.inboxProcessed).toBe(1)
    expect(summary.stageFailures).toBe(0)
    expect(Object.keys(summary)).not.toContain('resourceId')
  })

  it.each(stages)('isolates reconciliation stage %s', async (stage) => {
    const now = new Date()
    const fixture = await createIsolationFixture(now)
    const summary = await runPaymentReconciliation(testDb, fixture.provider, now, context, only(stage))
    const after = await fixture.readState()

    for (const unrelatedStage of stages.filter((candidate) => candidate !== stage)) {
      expect(after[unrelatedStage]).toEqual(fixture.before[unrelatedStage])
    }
    expect(after[stage]).toEqual(fixture.selectedAfter[stage])

    const expectedSummary = {
      leasesRecovered: 0,
      dependenciesReviewed: 0,
      operationsReleased: 0,
      inboxProcessed: 0,
      operationsProcessed: 0,
      createsRecovered: 0,
      snapshotsRefreshed: 0,
      pixExpired: 0,
      reviewsRechecked: 0,
      stageFailures: 0,
    }
    if (stage === 'leases') expectedSummary.leasesRecovered = 2
    if (stage === 'dependencies') expectedSummary.dependenciesReviewed = 1
    if (stage === 'inbox') expectedSummary.inboxProcessed = 1
    if (stage === 'operations') {
      expectedSummary.operationsReleased = 1
      expectedSummary.operationsProcessed = 1
    }
    if (stage === 'creates') expectedSummary.createsRecovered = 1
    if (stage === 'snapshots') expectedSummary.snapshotsRefreshed = 1
    if (stage === 'expirations') expectedSummary.pixExpired = 1
    if (stage === 'reviews') expectedSummary.reviewsRechecked = 1
    expect(summary).toEqual(expectedSummary)

    const calls = {
      getAccountId: fixture.provider.getAccountId,
      getOrder: fixture.provider.getOrder,
      searchOrders: fixture.provider.searchOrders,
      createOrder: fixture.provider.createOrder,
      cancelOrder: fixture.provider.cancelOrder,
      refundOrder: fixture.provider.refundOrder,
      refundPartial: fixture.provider.refundPartial,
    }
    const expectedCalls: Record<ReconciliationStage, Partial<Record<keyof typeof calls, number>>> = {
      leases: {},
      dependencies: {},
      inbox: { getAccountId: 1, getOrder: 1 },
      operations: { cancelOrder: 1 },
      creates: { searchOrders: 1 },
      snapshots: { getOrder: 1 },
      expirations: {},
      reviews: { getOrder: 1 },
    }
    for (const [name, spy] of Object.entries(calls)) {
      expect(spy).toHaveBeenCalledTimes(expectedCalls[stage][name as keyof typeof calls] ?? 0)
    }
  })

  it('keeps reconciliation summaries, logs, and errors sanitized', async () => {
    const forbidden = ['provider-body-9f4a', 'access-token-9f4a', 'webhook-secret-9f4a', 'signature-9f4a', 'payer@example.invalid', 'qr-content-9f4a', 'postgresql://forbidden.invalid/db']
    const pending = await pendingPayment()
    const providerError = new Error(forbidden.join('|'))
    const getOrder = vi.fn(async () => { throw providerError })
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let result: Awaited<ReturnType<typeof runPaymentReconciliation>> | undefined
    let thrownText = ''

    try {
      try {
        result = await runPaymentReconciliation(
          testDb,
          provider({ getOrder }, pending),
          new Date(),
          context,
          only('snapshots'),
        )
      } catch (error) {
        thrownText = error instanceof Error ? error.message : String(error)
      }

      expect(getOrder).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ snapshotsRefreshed: 0, stageFailures: 1 })
      const [persisted] = await testDb.select().from(payments).where(eq(payments.id, pending.id))
      expect(persisted).toMatchObject({
        reconciliationState: 'PENDING',
        reconciliationFailure: 'UNEXPECTED',
        reconciliationAttemptCount: 1,
      })
      expect(persisted?.nextReconcileAt).not.toBeNull()

      const output = JSON.stringify(result) + thrownText + [...logs.mock.calls, ...errors.mock.calls].flat().join(' ')
      expect(forbidden.some((marker) => output.includes(marker))).toBe(false)
    } finally {
      logs.mockRestore()
      errors.mockRestore()
    }
  })

  it('persists known account mismatch as stable review', async () => {
    const pending = await pendingPayment()
    const now = new Date()
    const accountSpy = vi.fn(async () => { throw new Error('account lookup must not run') })
    const mismatchProvider = provider({
      getAccountId: accountSpy,
      getOrder: vi.fn(async () => snapshot(pending, { accountId: 'wrong-account' })),
    }, pending)
    const summary = await runPaymentReconciliation(testDb, mismatchProvider, now, context, only('snapshots'))
    expect(summary.stageFailures).toBe(0)
    expect(accountSpy).not.toHaveBeenCalled()
    expect((await testDb.select().from(payments).where(eq(payments.id, pending.id)))[0]).toMatchObject({
      providerOrderId: pending.providerOrderId,
      providerTransactionId: pending.providerTransactionId,
      status: pending.status,
      reconciliationState: 'REVIEW_REQUIRED',
      reconciliationFailure: 'MISMATCH_ACCOUNT',
      nextReconcileAt: null,
    })
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
    await pendingPayment()
    broken.getOrder = vi.fn(async () => { throw new Error('provider down') })
    const summary = await runPaymentReconciliation(testDb, broken, new Date(), context, only('snapshots', 'expirations'))
    expect(summary.stageFailures).toBe(1)
    expect(summary.operationsProcessed).toBe(0)
  })
})

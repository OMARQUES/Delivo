import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import { enqueueWebhook } from '../src/payments/webhook-inbox.service'
import { runPaymentReconciliation } from '../src/payments/reconciliation.service'
import type { PaymentProvider, ProviderOrderSnapshot } from '../src/payments/provider'

beforeAll(migrateTestDb)
beforeEach(() => truncateAll())
afterAll(closeTestDb)

function provider(): PaymentProvider {
  const snapshot: ProviderOrderSnapshot = {
    providerOrderId: 'unknown', providerTransactionId: 'tx', orderStatus: 'created', orderStatusDetail: 'pending', transactionStatus: 'pending', transactionStatusDetail: 'pending', externalReference: 'missing', totalAmountCents: 100, refundedAmountCents: 0, countryCode: 'BR', currency: 'BRL', processingMode: 'aggregator', method: 'PIX', paymentMethodId: 'pix', applicationId: 'app', accountId: 'account', liveMode: false, transactionCount: 1, pix: null, updatedAt: new Date(),
  }
  return { getAccountId: vi.fn(async () => 'account'), getOrder: vi.fn(async () => snapshot), searchOrders: vi.fn(async () => []), createOrder: vi.fn(), cancelOrder: vi.fn(), refundOrder: vi.fn(), refundPartial: vi.fn() } as PaymentProvider
}

describe('payment reconciliation', () => {
  it('processes due inbox with bounded limit and reports counts only', async () => {
    const now = new Date()
    await enqueueWebhook(testDb, { topic: 'order', resourceId: 'unknown', requestId: 'req', signatureTimestamp: '1' }, now)
    const summary = await runPaymentReconciliation(testDb, provider(), now, { inbox: 1, operations: 0, creates: 0, snapshots: 0, expirations: 0, reviews: 0 })
    expect(summary.inboxProcessed).toBe(1)
    expect(summary.stageFailures).toBe(0)
    expect(Object.keys(summary)).not.toContain('resourceId')
  })

  it('failure in one stage does not prevent summary return', async () => {
    const broken = provider()
    broken.getAccountId = vi.fn(async () => { throw new Error('provider down') })
    const summary = await runPaymentReconciliation(testDb, broken, new Date(), { inbox: 1 })
    expect(summary.stageFailures).toBe(1)
    expect(summary.operationsProcessed).toBe(0)
  })
})

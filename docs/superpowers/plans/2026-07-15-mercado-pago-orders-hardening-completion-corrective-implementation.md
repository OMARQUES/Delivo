# Mercado Pago Orders Completion Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution remains inline; do not dispatch subagents unless the user explicitly changes that preference.

**Goal:** Close the remaining financial-integrity, concurrency, reconciliation, and regression-coverage gaps so the Mercado Pago Orders branch is safe for local merge review and manual sandbox testing.

**Architecture:** Keep PostgreSQL as the durable source of truth. Make snapshot validation and operation completion prove exact financial totals, protect all post-provider writes with row locks and compare-and-set predicates, and give every durable payment work item a bounded retry lifecycle. Reconciliation stays stage-isolated and bounded; authenticated webhooks use a dedicated background database client after durable inbox insertion.

**Tech Stack:** TypeScript 6, Hono 4, Vitest 4, Drizzle ORM, PostgreSQL 17, Mercado Pago Orders API, Cloudflare Workers/Wrangler 4.

## Global Constraints

- Work only in `feat/mercado-pago-orders-hardening`; no push and no merge until Task 18 final review passes and the user explicitly authorizes local merge.
- Follow local TDD for each task: add focused RED tests, run and inspect the expected failure, implement minimally, run focused and package tests, review the diff, then commit.
- Do not restore `/v1/payments`, `providerPaymentId`, `src/lib/payment-provider.ts`, `src/lib/mercadopago.ts`, or compatibility aliases.
- Provider calls stay outside PostgreSQL transactions. Transactions may contain locks, validation, local state transitions, events, leases, retry schedules, and durable operation intents only.
- Never print, log, persist in new tables, or commit access tokens, webhook secrets, card tokens, payer emails, QR contents, provider bodies, signatures, database URLs, passwords, or credentials.
- `REFUNDED` is valid only when authoritative cumulative refunded cents equal the expected payment amount.
- Established provider IDs, `APPROVED`/`REFUNDED` status, and authoritative cumulative refund totals never regress because of contradictory snapshots.
- Business decisions and their required financial intents commit together or both roll back.
- Provider operations, webhook inbox items, and payment reconciliation attempts stop automatic retries after attempt eight and enter `REVIEW_REQUIRED`.
- Background work never reuses a request-owned PostgreSQL client.
- Batch sizes are clamped to 1–100 in production code; tests use explicit stage selection rather than zero limits.
- This plan authorizes local code, migration, documentation, and tests only. It does not authorize staging migration, provider activation, external webhook smoke, real charges, deployment, or production.

---

### Task 16: Enforce exact financial outcomes

**Files:**
- Create: `apps/api/test/snapshot-validation.test.ts`
- Modify: `apps/api/src/payments/snapshot-validation.ts`
- Modify: `apps/api/src/payments/transition.service.ts`
- Modify: `apps/api/src/payments/retry.ts`
- Modify: `apps/api/src/payments/operation-queue.service.ts`
- Modify: `apps/api/src/payments/operation.service.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/api/test/payment-operation.service.test.ts`
- Modify: `apps/api/test/helpers/payment-provider.ts`

**Interfaces:**
- Produces:

```ts
export type RetryDisposition =
  | { kind: 'RETRY'; nextAttemptAt: Date }
  | { kind: 'REVIEW_REQUIRED' }

export function retryDisposition(
  now: Date,
  attemptCount: number,
  jitterFraction: number,
  retryAfterSeconds?: number,
): RetryDisposition
```

- `validateSnapshot(snapshot, expected)` additionally enforces `processingMode === 'automatic'` and exact refunded totals.
- `applyProviderSnapshotInTransaction` accepts `{ releaseOrderOnApproval?: boolean; enqueueLateRefund?: boolean }`; both default to `true`.
- `operation.service.ts` owns cancel-to-refund escalation and persists the dependent full-refund operation before completing the cancel operation.
- `enqueuePaymentOperation` keeps its public signature, but locks the payment before accepting a duplicate and compares the persisted cumulative target in every deterministic full-refund/race path.

- [x] **Step 1: Add RED pure snapshot-validation tests**

Create `apps/api/test/snapshot-validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateSnapshot } from '../src/payments/snapshot-validation'
import type { ExpectedPayment } from '../src/payments/provider'
import { providerSnapshot } from './helpers/payment-provider'

const expected: ExpectedPayment = {
  paymentId: '00000000-0000-4000-8000-000000000001',
  orderId: '00000000-0000-4000-8000-000000000002',
  amountCents: 6400,
  currency: 'BRL',
  countryCode: 'BR',
  method: 'PIX',
  applicationId: 'app-test',
  accountId: 'account-test',
  liveMode: false,
}

function refunded(refundedAmountCents: number) {
  return providerSnapshot({
    externalReference: expected.orderId,
    totalAmountCents: expected.amountCents,
    orderStatus: 'refunded',
    orderStatusDetail: 'refunded',
    transactionStatus: 'refunded',
    transactionStatusDetail: 'refunded',
    refundedAmountCents,
  })
}

describe('validateSnapshot financial invariants', () => {
  it('rejects every processing mode except automatic', () => {
    expect(validateSnapshot(providerSnapshot({
      externalReference: expected.orderId,
      processingMode: 'aggregator',
    }), expected)).toEqual({
      kind: 'REVIEW_REQUIRED',
      failureCode: 'UNSUPPORTED_PROCESSING_MODE',
    })
  })

  it.each([0, 1, 6399])('rejects refunded state below the exact total: %s', (amount) => {
    expect(validateSnapshot(refunded(amount), expected)).toEqual({
      kind: 'REVIEW_REQUIRED',
      failureCode: 'MISMATCH_REFUNDED_AMOUNT',
    })
  })

  it('accepts refunded state only at the exact total', () => {
    expect(validateSnapshot(refunded(6400), expected)).toEqual({ kind: 'REFUNDED' })
  })

  it('rejects refunded amount above total before classifying status', () => {
    expect(validateSnapshot(refunded(6401), expected)).toEqual({
      kind: 'REVIEW_REQUIRED',
      failureCode: 'MISMATCH_REFUNDED_AMOUNT',
    })
  })
})
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/snapshot-validation.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because `aggregator` and refunded totals below 6400 are currently accepted.

- [x] **Step 2: Add RED transition tests that preserve authoritative local state**

Extend `apps/api/test/payment.service.test.ts` inside `describe('applyProviderSnapshot')`:

```ts
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
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because review currently spreads conflicting provider fields and refunded status forces the expected total.

- [x] **Step 3: Add RED exact operation, escalation, retry-exhaustion, and dedupe tests**

Extend `apps/api/test/payment-operation.service.test.ts` with these cases:

```ts
it('accepts a partial operation reaching its exact target with provider REFUNDED', async () => {
  const row = await payment()
  const now = new Date()
  await testDb.update(payments).set({ refundedAmountCents: row.expectedAmountCents - 1000 }).where(eq(payments.id, row.id))
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

it('persists dependent full refund before completing approved cancel', async () => {
  const row = await payment()
  const now = new Date()
  await testDb.update(orders).set({ status: 'AWAITING_PAYMENT' }).where(eq(orders.id, row.orderId))
  await enqueuePaymentOperation(testDb, {
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
  expect(operations.find((operation) => operation.id === cancelId)).toMatchObject({
    status: 'SUCCEEDED',
    resultCode: 'ESCALATED_TO_REFUND',
  })
  expect(operations.find((operation) => operation.type === 'REFUND_FULL')).toMatchObject({
    status: 'PENDING',
    dependsOnOperationId: cancelId,
    expectedRefundedAmountCents: row.expectedAmountCents,
  })
  expect((await testDb.select().from(orders).where(eq(orders.id, row.orderId)))[0]!.status).toBe('CANCELLED')
})

it.each(['CANCEL', 'REFUND_FULL', 'REFUND_PARTIAL'] as const)(
  'moves direct retry result to review on attempt eight: %s',
  async (type) => {
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
  },
)

it('rejects an identical full-refund business key with a conflicting persisted target', async () => {
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
```

Add `orders` to the existing schema import. Ensure the local `snapshot` helper defaults `processingMode` to `automatic`.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment-operation.service.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL for final partial `REFUNDED`, retry exhaustion, cancel order preservation, or target comparison.

- [x] **Step 4: Implement fail-closed snapshot validation and safe review persistence**

In `snapshot-validation.ts`, insert processing-mode validation before financial-state classification and require the exact total for refunded status:

```ts
if (snapshot.processingMode !== 'automatic') return review('UNSUPPORTED_PROCESSING_MODE')

// Keep the existing safe-integer/range check before status handling.
if (orderStatus === 'refunded') {
  return snapshot.refundedAmountCents === expected.amountCents
    ? { kind: 'REFUNDED' }
    : review('MISMATCH_REFUNDED_AMOUNT')
}
```

In `transition.service.ts`, split observational and authoritative fields:

```ts
const observationFields = {
  providerStatus: snapshot.orderStatus,
  providerStatusDetail: snapshot.orderStatusDetail,
  lastReconciledAt: now,
  updatedAt: now,
}

```

The `REVIEW_REQUIRED` update must use only `observationFields`, `reconciliationState`, `reconciliationFailure`, and `nextReconcileAt`. Do not change either provider ID in the review branch; a later valid authoritative snapshot may attach a previously null ID after uniqueness validation. Do not include `refundedAmountCents`, QR fields, expiry, or conflicting IDs.

For valid authoritative updates, retain the provider/PIX fields but persist refund totals exactly from the validated snapshot. Remove the fallback that substitutes `payment.expectedAmountCents` for provider cents.

Add `releaseOrderOnApproval?: boolean` to transition options. Default it with:

```ts
const releaseOrderOnApproval = options.releaseOrderOnApproval !== false
```

Gate the `AWAITING_PAYMENT → PENDING` transition with `releaseOrderOnApproval`.

- [x] **Step 5: Centralize retry disposition and make operation settlement atomic**

Extend `retry.ts`:

```ts
export type RetryDisposition =
  | { kind: 'RETRY'; nextAttemptAt: Date }
  | { kind: 'REVIEW_REQUIRED' }

export function retryDisposition(
  now: Date,
  attemptCount: number,
  jitterFraction: number,
  retryAfterSeconds?: number,
): RetryDisposition {
  if (attemptCount >= MAX_PAYMENT_OPERATION_ATTEMPTS) {
    return { kind: 'REVIEW_REQUIRED' }
  }
  return {
    kind: 'RETRY',
    nextAttemptAt: nextAttemptAt(now, attemptCount, jitterFraction, retryAfterSeconds),
  }
}
```

In `operation.service.ts`:

1. allow `REFUND_PARTIAL` success for decision `PARTIALLY_REFUNDED` or `REFUNDED` when cents equal the persisted target;
2. use `retryDisposition` for every `OperationOutcome.kind === 'RETRY'` and every transient catch;
3. on exhausted retry, persist `REVIEW_REQUIRED/RETRY_EXHAUSTED` in the same settlement transaction;
4. call `applyProviderSnapshotInTransaction` with `releaseOrderOnApproval: operation.type !== 'CANCEL'`;
5. when the cancel evaluator returns `ESCALATE_TO_REFUND`, update `AWAITING_PAYMENT` to `CANCELLED`, enqueue the deterministic dependent full refund, then mark cancel succeeded, all in the current transaction;
6. use this deterministic escalation key:

```ts
const key = `refund-full:${operation.paymentId}:ESCALATED_CANCEL:${operation.id}`
```

7. if enqueue throws, allow the transaction to roll back so the cancel operation remains claimable after lease recovery.

For an already fully refunded cancel result, require both decision `REFUNDED` and exact cents equal to `operation.expectedRefundedAmountCents ?? payment.expectedAmountCents` before success.

- [x] **Step 6: Verify operation identity after locking the payment**

In `operation-queue.service.ts`, move the initial business-key lookup below the payment `FOR UPDATE`. Compute the canonical target before returning an existing row. For a partial replay, use the predecessor target while it is active; after successful completion, validate the stored target against the persisted payment total and requested delta:

```ts
async function canonicalTargetForIntent(
  tx: Db | DbTransaction,
  payment: typeof payments.$inferSelect,
  input: PaymentOperationIntent,
  existing: typeof paymentOperations.$inferSelect | undefined,
): Promise<number | null> {
  if (input.type === 'CANCEL') return null
  if (input.type === 'REFUND_FULL') return payment.expectedAmountCents

  if (existing?.status === 'SUCCEEDED') {
    const target = existing.expectedRefundedAmountCents
    if (!Number.isSafeInteger(target)
      || target === null
      || target < input.amountCents!
      || target > payment.expectedAmountCents
      || payment.refundedAmountCents < target) {
      throw new Error('payment operation business key conflict')
    }
    return target
  }

  const predecessor = existing?.dependsOnOperationId
    ? (await tx.select({ target: paymentOperations.expectedRefundedAmountCents })
        .from(paymentOperations)
        .where(eq(paymentOperations.id, existing.dependsOnOperationId))
        .limit(1))[0]
    : undefined
  const otherTargets = await tx.select({ target: paymentOperations.expectedRefundedAmountCents })
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.paymentId, input.paymentId),
      inArray(paymentOperations.type, ['REFUND_FULL', 'REFUND_PARTIAL']),
      existing ? ne(paymentOperations.id, existing.id) : undefined,
    ))
  const base = Math.max(
    payment.refundedAmountCents,
    predecessor?.target ?? 0,
    ...otherTargets.map((row) => row.target ?? 0),
  )
  const target = base + input.amountCents!
  if (target > payment.expectedAmountCents) throw new Error('refund target exceeds payment amount')
  return target
}

function sameIntent(
  row: typeof paymentOperations.$inferSelect,
  input: PaymentOperationIntent,
  expectedRefundedAmountCents: number | null,
) {
  return row.paymentId === input.paymentId
    && row.type === input.type
    && row.amountCents === input.amountCents
    && row.expectedRefundedAmountCents === expectedRefundedAmountCents
    && row.idempotencyKey === input.idempotencyKey
}
```

Use `sameIntent` for both a pre-existing row and the `onConflictDoNothing` race result. For a previously completed partial operation, its stored target remains authoritative; validate that it is a safe integer, does not exceed the payment total, and equals the stored cumulative completion before accepting the identical replay. Do not increment attempts or create another dependency on reuse.

- [x] **Step 7: Run Task 16 focused and package gates**

```bash
pnpm --filter @delivery/api exec vitest run test/snapshot-validation.test.ts test/payment.service.test.ts test/payment-operation.service.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api test
pnpm --filter @delivery/api typecheck
git diff --check
git status --short
```

Expected: every command PASS. Review the diff and prove no provider call was moved inside a database transaction.

- [x] **Step 8: Commit Task 16**

```bash
git add apps/api/src/payments apps/api/test/snapshot-validation.test.ts apps/api/test/payment.service.test.ts apps/api/test/payment-operation.service.test.ts apps/api/test/helpers/payment-provider.ts
git commit -m "fix(payments): enforce exact provider outcomes"
```

---

### Task 17: Make recovery and business transitions concurrency-safe

**Files:**
- Modify: `apps/api/src/payments/checkout.service.ts`
- Modify: `apps/api/src/services/amendment.service.ts`
- Modify: `apps/api/src/services/dispatch.service.ts`
- Modify: `apps/api/src/services/order-status.service.ts`
- Modify: `apps/api/src/services/payment.service.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/api/test/amendment.service.test.ts`
- Modify: `apps/api/test/dispatch.service.test.ts`
- Modify: `apps/api/test/cron.test.ts`

**Interfaces:**
- Produces:

```ts
export async function cancelStalePendingOrders(
  db: Db,
  olderThanMinutes?: number,
  limit?: number,
): Promise<number>
```

- `recoverUncertainCreate` keeps its current public signature and return union, but every post-provider persistence uses a locked still-uncertain compare-and-set.
- `approveAmendment` and `rejectAmendment` load and validate their authoritative rows only inside their transaction.
- `failDelivery` becomes repair-idempotent: an already failed delivery verifies or recreates its deterministic financial intent.
- Removes `expireStaleAwaitingPayment`; there is no compatibility wrapper.

- [x] **Step 1: Add RED uncertain-create race tests**

Add this helper near the top of `payment.service.test.ts`:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
```

Add tests inside `describe('Orders checkout orchestration')`:

```ts
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
  await testDb.update(payments).set({
    providerOrderId: null,
    providerTransactionId: null,
    expiresAt: new Date('2026-07-15T11:00:00.000Z'),
  }).where(eq(payments.id, payment.id))
  const searchStarted = deferred<void>()
  const releaseSearch = deferred<Array<ReturnType<typeof providerSnapshot>>>()
  const recoveryProvider = fakePaymentProvider({ searchOrders: vi.fn(async () => {
    searchStarted.resolve()
    return releaseSearch.promise
  }) })
  const recovery = recoverUncertainCreate(testDb, recoveryProvider, payment.id, new Date('2026-07-15T12:00:00.000Z'), (email) => email ?? 'masked@test.local')
  await searchStarted.promise
  await applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents, {
    orderStatus: 'pending',
    orderStatusDetail: 'pending',
    transactionStatus: 'pending',
    transactionStatusDetail: 'pending',
  }), new Date())
  releaseSearch.resolve([])
  await recovery
  expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]).toMatchObject({
    status: 'PENDING',
    providerOrderId: `mp-order-${order.id}`,
  })
})
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because stale recovery writes currently use only payment ID.

- [x] **Step 2: Add RED amendment atomicity tests**

Extend `amendment.service.test.ts`:

```ts
it('rolls back rejection and financial intent when the order is no longer eligible', async () => {
  const { orderId, cocaItemId } = await makeAcceptedPaidOrder()
  const amendment = await proposeAmendment(testDb, storeId, ownerUserId, orderId, {
    items: [{ orderItemId: cocaItemId, newQuantity: 0 }],
  })
  await testDb.update(orders).set({ status: 'OUT_FOR_DELIVERY' }).where(eq(orders.id, orderId))

  await expect(rejectAmendment(testDb, customerId, orderId)).rejects.toMatchObject({ status: 409 })
  expect((await testDb.select().from(orderAmendments).where(eq(orderAmendments.id, amendment.id)))[0]!.status).toBe('PROPOSED')
  expect(await testDb.select().from(paymentOperations)).toHaveLength(0)
})

it('allows only one concurrent amendment decision and persists one financial intent', async () => {
  const { orderId, cocaItemId } = await makeAcceptedPaidOrder()
  await proposeAmendment(testDb, storeId, ownerUserId, orderId, {
    items: [{ orderItemId: cocaItemId, newQuantity: 0 }],
  })
  const results = await Promise.allSettled([
    approveAmendment(testDb, customerId, orderId),
    rejectAmendment(testDb, customerId, orderId),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect((await testDb.select().from(paymentOperations)).length).toBeLessThanOrEqual(1)
  expect((await testDb.select().from(orderAmendments))[0]!.status).not.toBe('PROPOSED')
})
```

Import `orderAmendments`, `orders`, `paymentOperations`, and `eq` if not already present.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/amendment.service.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: the ineligible rejection test FAILS because the amendment is currently resolved even when order cancellation updates zero rows.

- [x] **Step 3: Add RED failed-delivery repair and bounded stale-order tests**

Extend `dispatch.service.test.ts` with an online approved-payment fixture for an order already moved to `OUT_FOR_DELIVERY`, then add:

```ts
async function makeOutForDeliveryOnlineOrder() {
  const order = await makeRequestedOrder()
  await acceptDelivery(testDb, driver1, order.id)
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'PREPARING', customerId)
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'READY', customerId)
  await collectDelivery(testDb, driver1, order.id)
  await testDb.update(orders).set({ paymentMethod: 'CARD_ONLINE' }).where(eq(orders.id, order.id))
  const [payment] = await testDb.insert(payments).values({
    orderId: order.id,
    providerOrderId: `provider-order-${order.id}`,
    providerTransactionId: `provider-tx-${order.id}`,
    status: 'APPROVED',
    method: 'CARD',
    expectedAmountCents: order.totalCents,
    expectedCurrency: 'BRL',
    expectedCountry: 'BR',
    expectedApplicationId: 'app-test',
    expectedAccountId: 'account-test',
    expectedLiveMode: false,
    createIdempotencyKey: `create-${order.id}`,
  }).returning()
  return { orderId: order.id, driverId: driver1, paymentId: payment!.id }
}

it('repairs a missing financial intent on idempotent delivery failure retry', async () => {
  const { orderId, driverId, paymentId } = await makeOutForDeliveryOnlineOrder()
  await failDelivery(testDb, driverId, orderId, { reason: 'NO_ANSWER' })
  const key = `refund-full:${paymentId}:DELIVERY_FAILED`
  await testDb.delete(paymentOperations).where(eq(paymentOperations.businessKey, key))

  await failDelivery(testDb, driverId, orderId, { reason: 'NO_ANSWER' })
  expect(await testDb.select().from(paymentOperations).where(eq(paymentOperations.businessKey, key))).toHaveLength(1)
})
```

Add `orders`, `payments`, and `paymentOperations` from `../src/db/schema` plus `eq` from `drizzle-orm` to the test imports.

Extend `cron.test.ts`:

```ts
it('claims stale pending orders in bounded batches without duplicate dispositions', async () => {
  const stale = await Promise.all(Array.from({ length: 3 }, async () => {
    const { order } = await createOrder(testDb, customerId, checkout())
    await testDb.execute(sql`update orders set created_at = now() - interval '31 minutes' where id = ${order.id}`)
    return order
  }))

  expect(await cancelStalePendingOrders(testDb, 30, 2)).toBe(2)
  expect(await cancelStalePendingOrders(testDb, 30, 2)).toBe(1)
  expect((await Promise.all(stale.map((order) => getCustomerOrder(testDb, customerId, order.id))))
    .filter((order) => order?.status === 'CANCELLED')).toHaveLength(3)
})
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/dispatch.service.test.ts test/cron.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because idempotent delivery failure does not inspect its operation and stale selection has no limit.

- [x] **Step 4: Implement locked still-uncertain persistence**

In `checkout.service.ts`, add a single transaction helper:

```ts
type StillUncertainMutation<T> = (
  tx: DbTransaction,
  payment: typeof payments.$inferSelect,
) => Promise<T>

async function whileStillUncertain<T>(
  db: Db,
  paymentId: string,
  mutation: StillUncertainMutation<T>,
): Promise<{ applied: true; value: T } | { applied: false }> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(payments)
      .where(eq(payments.id, paymentId)).for('update')
    if (!current || current.status !== 'PENDING' || current.providerOrderId !== null) {
      return { applied: false as const }
    }
    return { applied: true as const, value: await mutation(tx, current) }
  })
}
```

Use it for every update after `searchOrders`, `getAccountId`, or `createOrder`: transient schedule, ambiguous review, fresh-card review, no-payer review, uncertain PIX expiry, recovered snapshot, and recreated PIX result.

If it returns `{ applied: false }`, reload the payment. Return `RECOVERED` when it now has a provider ID or terminal/approved status; return `REVIEW_REQUIRED` only when its current persisted state already requires review. Never apply a stale classification.

For a returned snapshot, use one transaction that first confirms still-uncertain and then calls `applyProviderSnapshotInTransaction` with the same transaction.

- [x] **Step 5: Lock and revalidate amendments inside their decision transaction**

In both amendment decision functions:

1. remove the pre-transaction order and pending-amendment reads;
2. select the customer order `FOR UPDATE` inside the transaction;
3. require the order status to remain `ACCEPTED` or `PREPARING`, matching `PROPOSABLE`;
4. select the `PROPOSED` amendment and its items after acquiring the order lock;
5. perform item/order mutation, amendment resolution, event, and payment operation before commit.

For rejection, make zero-row cancellation fatal:

```ts
if (cancelled.length !== 1) {
  throw new AmendmentError('Pedido mudou — recarregue', 409)
}
```

Do not enqueue disposition or resolve the amendment after a failed order compare-and-set.

- [x] **Step 6: Repair failed-delivery intent and bound stale cancellations**

In `failDelivery`, wrap both the first transition and already-failed idempotent path in a transaction. Lock the order and call:

```ts
await enqueueOrderPaymentDisposition(tx, orderId, 'DELIVERY_FAILED', now)
```

for an existing `DELIVERY_FAILED` row with `returnPendingAt`. The deterministic business key makes a correct operation a no-op, repairs a missing operation, and rejects a conflicting row.

Change `cancelStalePendingOrders` to default `limit = 100`, clamp it to 1–100, and select IDs inside a transaction with:

```ts
.orderBy(orders.createdAt)
.limit(Math.max(1, Math.min(100, Math.floor(limit))))
.for('update', { skipLocked: true })
```

Within the same transaction, cancel each locked row and persist its event, amendment expiry, and payment disposition. Concurrent calls must not observe the same candidate.

Delete `expireStaleAwaitingPayment` and remove now-unused `PIX_EXPIRATION_MINUTES`, `and`, `lt`, and `orders` imports from `payment.service.ts`. Verify no imports remain:

```bash
! rg -n "expireStaleAwaitingPayment" apps/api/src apps/api/test
```

- [x] **Step 7: Run Task 17 focused and package gates**

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts test/amendment.service.test.ts test/dispatch.service.test.ts test/cron.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api test
pnpm --filter @delivery/api typecheck
git diff --check
git status --short
```

Expected: every command PASS. Review that all provider calls remain outside transactions and every financial intent shares the business-decision transaction.

- [x] **Step 8: Commit Task 17**

```bash
git add apps/api/src/payments/checkout.service.ts apps/api/src/services/amendment.service.ts apps/api/src/services/dispatch.service.ts apps/api/src/services/order-status.service.ts apps/api/src/services/payment.service.ts apps/api/test/payment.service.test.ts apps/api/test/amendment.service.test.ts apps/api/test/dispatch.service.test.ts apps/api/test/cron.test.ts
git commit -m "fix(payments): serialize recovery decisions"
```

---

### Task 18: Bound reconciliation and complete the final regression gate

**Files:**
- Modify: `apps/api/src/db/schema/payments.ts`
- Generate: `apps/api/drizzle/0029_payment_reconciliation_attempts.sql`
- Generate: `apps/api/drizzle/meta/0029_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: `apps/api/src/payments/retry.ts`
- Modify: `apps/api/src/payments/operation-queue.service.ts`
- Modify: `apps/api/src/payments/webhook-inbox.service.ts`
- Modify: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/src/payments/transition.service.ts`
- Modify: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/test/payment.schema.test.ts`
- Modify: `apps/api/test/payment-operation.service.test.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`
- Modify: `apps/api/test/webhooks.routes.test.ts`
- Modify: `docs/security/runbooks/mercado-pago-orders.md`
- Modify: `docs/security/2026-07-11-backend-security-review.md`

**Interfaces:**
- Produces:

```ts
export type ReconciliationStage =
  | 'leases'
  | 'dependencies'
  | 'inbox'
  | 'operations'
  | 'creates'
  | 'snapshots'
  | 'expirations'
  | 'reviews'

export type ReconciliationOptions = {
  limits?: Partial<Record<Exclude<ReconciliationStage, 'leases' | 'dependencies'>, number>>
  stages?: readonly ReconciliationStage[]
}

export async function processWebhookInBackground(
  env: Env,
  inboxId: string,
  now: Date,
): Promise<void>
```

- Adds `payments.reconciliationAttemptCount: integer NOT NULL DEFAULT 0` with a non-negative check.
- `propagateReviewedDependencies(db, now, totalBudget)` now converges through deep chains within the given total budget.
- `runPaymentReconciliation` replaces its fifth `Limits` argument with `ReconciliationOptions`; production callers omit it.
- Webhook inbox and payment reconciliation use `retryDisposition` and enter review after attempt eight.

- [x] **Step 1: Add RED schema test for durable reconciliation attempts**

Extend `payment.schema.test.ts`:

```ts
expect(paymentColumns.map((row) => row.column_name)).toContain('reconciliation_attempt_count')

const paymentChecks = await testDb.execute<{ constraint_name: string }>(sql`
  select constraint_name
  from information_schema.table_constraints
  where table_schema = 'public'
    and table_name = 'payments'
    and constraint_type = 'CHECK'
`)
expect(paymentChecks.map((row) => row.constraint_name))
  .toContain('payments_reconciliation_attempt_count_valid')
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.schema.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because migration `0029` and the column do not exist.

- [x] **Step 2: Add RED dependency convergence and inbox exhaustion tests**

Extend `payment-operation.service.test.ts`:

```ts
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
```

Extend `webhooks.routes.test.ts`:

```ts
it('moves the inbox to review instead of scheduling attempt nine', async () => {
  const now = new Date()
  const queued = await enqueueWebhook(testDb, {
    topic: 'order', resourceId: 'order-1', requestId: 'attempt-eight', signatureTimestamp: '1',
  }, now)
  await testDb.update(paymentWebhookInbox).set({ attemptCount: 7 }).where(eq(paymentWebhookInbox.id, queued.id))
  const failing = provider({ getOrder: vi.fn(async () => { throw new PaymentProviderError('PROVIDER_UNAVAILABLE') }) })
  await expect(processWebhookInboxItem(testDb, failing, queued.id, 'worker-a', now)).resolves.toBeUndefined()
  expect((await testDb.select().from(paymentWebhookInbox).where(eq(paymentWebhookInbox.id, queued.id)))[0]).toMatchObject({
    status: 'REVIEW_REQUIRED',
    attemptCount: 8,
    failureClass: 'RETRY_EXHAUSTED',
    leaseOwner: null,
    leasedUntil: null,
  })
})
```

Import `inArray` and `PaymentProviderError`.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment-operation.service.test.ts test/webhooks.routes.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because propagation recounts reviewed rows and inbox retry has no terminal attempt guard.

- [x] **Step 3: Replace the minimal reconciliation tests with the complete RED stage matrix**

In `payment-reconciliation.test.ts`, change provider snapshots to `processingMode: 'automatic'`. Add an explicit stage helper:

```ts
const context = { resolvePayerEmail: (email: string | null) => email ?? 'masked@test.local' }
const only = (...stages: ReconciliationStage[]): ReconciliationOptions => ({ stages, limits: {
  inbox: 1, operations: 1, creates: 1, snapshots: 1, expirations: 1, reviews: 1,
} })
```

Add the stage-selection test:

```ts
it.each([
  'leases', 'dependencies', 'inbox', 'operations',
  'creates', 'snapshots', 'expirations', 'reviews',
] as const)('runs stage %s without enabling unrelated stages', async (stage) => {
  const summary = await runPaymentReconciliation(testDb, provider(), new Date(), context, only(stage))
  expect(summary.stageFailures).toBeGreaterThanOrEqual(0)
})
```

Add a known account mismatch case using a real pending payment fixture named `pendingPayment`, run only the snapshot stage, reload that fixture by ID, and assert:

```ts
expect(persisted).toMatchObject({
  reconciliationState: 'REVIEW_REQUIRED',
  reconciliationFailure: 'MISMATCH_ACCOUNT',
  nextReconcileAt: null,
})
```

Add an attempt-eight provider failure case by setting `reconciliationAttemptCount: 7` on `pendingPayment`, making `provider.getOrder` throw `PaymentProviderError('PROVIDER_UNAVAILABLE')`, running only the snapshot stage, and asserting:

```ts
expect(persisted).toMatchObject({
  reconciliationState: 'REVIEW_REQUIRED',
  reconciliationFailure: 'RETRY_EXHAUSTED',
  reconciliationAttemptCount: 8,
})
```

Add these named cases with explicit terminal assertions:

```ts
it('continues to expiration after snapshot-stage failure', async () => {
  const summary = await runPaymentReconciliation(testDb, failingSnapshotProvider, now, context, only('snapshots', 'expirations'))
  expect(summary.stageFailures).toBe(1)
  expect(summary.pixExpired).toBe(1)
  expect(await testDb.select().from(paymentOperations)
    .where(eq(paymentOperations.businessKey, `cancel:${expiredPayment.id}:PIX_EXPIRED`)))
    .toHaveLength(1)
})

it('lets overlapping reconcilers transition each durable item once', async () => {
  const [first, second] = await Promise.all([
    runPaymentReconciliation(testDb, provider(), now, context, only('inbox', 'operations', 'snapshots')),
    runPaymentReconciliation(testDb, provider(), now, context, only('inbox', 'operations', 'snapshots')),
  ])
  expect(first.inboxProcessed + second.inboxProcessed).toBe(1)
  expect(first.operationsProcessed + second.operationsProcessed).toBe(1)
  expect((await testDb.select().from(paymentWebhookInbox))[0]!.attemptCount).toBe(1)
  expect((await testDb.select().from(paymentOperations))[0]!.attemptCount).toBe(1)
})

it('keeps reconciliation summaries and logs free of payer and provider material', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const summary = await runPaymentReconciliation(testDb, provider(), now, context, only('creates'))
  const text = JSON.stringify([summary, log.mock.calls, error.mock.calls])
  expect(text).not.toContain('payer-fixture@example.test')
  expect(text).not.toMatch(/qrCode|cardToken|authorization|providerBody/i)
})
```

Create `pendingPayment`, `expiredPayment`, `failingSnapshotProvider`, and the one due inbox/operation in `beforeEach`; use only synthetic identifiers and the existing PostgreSQL fixture builders. Do not place raw provider responses in the fixtures.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because zero limits currently disable stages, account mismatch is not persisted, payment attempts are absent, and stage coverage is incomplete.

- [x] **Step 4: Add RED dedicated-background-client lifecycle test**

In `webhooks.routes.test.ts`, change the `createDb` mock to expose separate request/background clients:

```ts
const dbMockState = vi.hoisted(() => ({ clientEnds: [] as string[], clientNumber: 0 }))

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return {
    ...actual,
    createDb: () => {
      const id = `client-${++dbMockState.clientNumber}`
      return { db: testDb, client: { end: async () => { dbMockState.clientEnds.push(id) } } }
    },
  }
})
```

Use a test `ExecutionContext` that records promises passed to `waitUntil`, send one authenticated webhook, await all recorded promises, and assert two distinct clients were created and both were closed exactly once. Also assert the background processor does not receive the request's `db` object as an argument.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/webhooks.routes.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: FAIL because the route currently passes `c.get('db')` into background work while request cleanup closes the same client.

- [x] **Step 5: Add schema field and generate migration `0029`**

In `payments.ts`, add:

```ts
reconciliationAttemptCount: integer('reconciliation_attempt_count').notNull().default(0),
```

and the table check:

```ts
check('payments_reconciliation_attempt_count_valid', sql`${t.reconciliationAttemptCount} >= 0`),
```

Generate and inspect the migration:

```bash
pnpm --filter @delivery/api db:generate
```

Expected generated files:

```text
apps/api/drizzle/0029_payment_reconciliation_attempts.sql
apps/api/drizzle/meta/0029_snapshot.json
apps/api/drizzle/meta/_journal.json
```

If Drizzle generates a different descriptive suffix, rename only the SQL file and matching `_journal.json` tag to `0029_payment_reconciliation_attempts`; do not hand-edit the snapshot.

The SQL must add one non-null integer column with default zero and one non-negative check. It must not drop or recreate payment data.

- [x] **Step 6: Implement bounded dependency, inbox, and payment retry lifecycles**

Change dependency propagation to select only actionable children:

```ts
inArray(paymentOperations.status, ['PENDING', 'PROCESSING'])
```

Loop bounded batches while `remainingBudget > 0`. Each query limit is `Math.min(100, remainingBudget)`. Stop on zero updated rows and return the total newly reviewed count.

In `webhook-inbox.service.ts`, use `retryDisposition(now, claimed.attemptCount, 0.1, retryAfterSeconds)`. When exhausted, call `markReview(db, inboxId, 'RETRY_EXHAUSTED', now)` and return without throwing. On retry, clear the lease and persist the calculated `nextAttemptAt`.

In reconciliation, increment `payments.reconciliationAttemptCount` when claiming or processing a due payment. Successful authoritative transition resets it to zero. A retryable provider failure uses `retryDisposition`; exhaustion stores `REVIEW_REQUIRED/RETRY_EXHAUSTED`, clears `nextReconcileAt`, and stops automatic selection.

- [x] **Step 7: Refactor reconciliation options and persist known failures**

Implement the exact exported types from this task's Interfaces block. Replace zero-limit stage disabling with:

```ts
const enabled = new Set(options.stages ?? ALL_RECONCILIATION_STAGES)
const capBy = (key: keyof typeof DEFAULT_RECONCILIATION_LIMITS) =>
  Math.max(1, Math.min(100, Math.floor(options.limits?.[key] ?? DEFAULT_RECONCILIATION_LIMITS[key])))
```

Wrap each stage with `if (enabled.has(stage))`. Production `src/index.ts` continues omitting options and therefore runs all stages.

Remove the manual `snapshot.accountId !== account` throw from the snapshot stage. Call `applyProviderSnapshot` so the standard validator persists `MISMATCH_ACCOUNT`.

Use one helper for retryable payment reconciliation failures; it records only the stable failure class, attempt count, last/next timestamps, and review state. Never include provider messages or response bodies.

- [x] **Step 8: Give webhook background processing its own database client**

In `webhook-inbox.service.ts`, add:

```ts
import { createDb } from '../db/client'
import type { Env } from '../env'
import { createPaymentProvider } from './mercadopago'

export async function processWebhookInBackground(env: Env, inboxId: string, now: Date): Promise<void> {
  const provider = createPaymentProvider(env)
  if (!provider) return
  const { db, client } = createDb(env)
  try {
    await processWebhookInboxItem(db, provider, inboxId, crypto.randomUUID(), now)
  } finally {
    await client.end()
  }
}
```

In `routes/webhooks.ts`, remove the request-scoped provider and DB arguments from `waitUntil`:

```ts
if (queued.inserted) {
  c.executionCtx.waitUntil(
    processWebhookInBackground(c.env, queued.id, now).catch(() => undefined),
  )
}
```

Durable insertion still completes before the `200` response. Background failure remains recoverable by cron.

- [x] **Step 9: Run focused tests and prove migrations from zero**

```bash
pnpm --filter @delivery/api exec vitest run test/payment.schema.test.ts test/payment-operation.service.test.ts test/payment-reconciliation.test.ts test/webhooks.routes.test.ts --no-file-parallelism --maxWorkers=1
docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE IF EXISTS delivery_test WITH (FORCE)'
docker compose exec -T postgres psql -U postgres -c 'CREATE DATABASE delivery_test'
pnpm --filter @delivery/api exec vitest run test/payment.schema.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api test
pnpm --filter @delivery/api typecheck
git diff --check
```

If the IDE terminal is Flatpak and cannot access Docker, run the two Docker commands through:

```bash
flatpak-spawn --host sh -lc "cd '$PWD' && docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE IF EXISTS delivery_test WITH (FORCE)' && docker compose exec -T postgres psql -U postgres -c 'CREATE DATABASE delivery_test'"
```

Expected: migrations `0000` through `0029` apply to an empty test database and every focused/API test passes.

- [x] **Step 10: Update sanitized operational documentation**

Update `docs/security/runbooks/mercado-pago-orders.md` with:

- exact full/partial refund completion rules;
- `ESCALATED_TO_REFUND` meaning and dependent-operation inspection;
- attempt-eight review behavior for operations, inbox, and payment reconciliation;
- deep dependency propagation;
- dedicated webhook background DB ownership;
- external sandbox/live/webhook smoke still pending.

Update SEC-08 in `docs/security/2026-07-11-backend-security-review.md` only after all automated gates pass. State that code remediation is validated locally while external credentials, sandbox/live, webhook delivery, staging, and production remain pending. Do not claim external validation.

- [x] **Step 11: Use verification-before-completion and run the full repository gate**

Invoke `superpowers:verification-before-completion`, then run fresh:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @delivery/web build:staging
pnpm --filter @delivery/driver build:staging
pnpm --dir apps/api exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-api-orders-completion-dry
pnpm --dir apps/web exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-web-orders-completion-dry
pnpm --dir apps/driver exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-driver-orders-completion-dry
git diff --check
git status --short
```

Expected: every command PASS. Status contains only intentional Task 18 files before commit.

- [x] **Step 12: Prove Orders-only code and tracked-file secret safety**

```bash
! rg -n "/v1/payments|providerPaymentId|createPixPayment|createCardPayment|getPayment|refundPayment|cancelPayment|src/lib/payment-provider|lib/payment-provider|src/lib/mercadopago|lib/mercadopago" apps/api/src apps/api/test
! rg -n "PaymentProvider|createPaymentProvider\(c\.env\)" apps/api/src/services/order-status.service.ts apps/api/src/services/amendment.service.ts apps/api/src/services/dispatch.service.ts apps/api/src/routes/store-orders.ts apps/api/src/routes/driver.ts
! git grep -n -E 'postgresql://[^ ]+@|APP_USR-[A-Za-z0-9_-]+|(^|[^A-Za-z])re_[A-Za-z0-9_-]{20,}|npg_[A-Za-z0-9]+' -- ':!pnpm-lock.yaml'
rg -n '"binding": "BUCKET"|"bucket_name": "delivo-media-staging"|"binding": "HYPERDRIVE"|ee44ff9aa75d4b57826982d04a569c1d' apps/api/wrangler.jsonc
```

Expected: legacy/provider-coupling and secret scans have no matches. Wrangler output contains the existing staging `BUCKET`, R2 bucket, `HYPERDRIVE`, and Hyperdrive ID in `env.staging` without changes.

- [x] **Step 13: Commit Task 18**

```bash
git add apps/api/src/db/schema/payments.ts apps/api/drizzle apps/api/src/payments apps/api/src/routes/webhooks.ts apps/api/test/payment.schema.test.ts apps/api/test/payment-operation.service.test.ts apps/api/test/payment-reconciliation.test.ts apps/api/test/webhooks.routes.test.ts docs/security/runbooks/mercado-pago-orders.md docs/security/2026-07-11-backend-security-review.md
git commit -m "fix(payments): bound reconciliation recovery"
```

- [x] **Step 14: Perform final inline review before integration**

Invoke `superpowers:requesting-code-review` without dispatching subagents. Review `main...HEAD` and manually trace these exact scenarios:

1. false refunded status with partial cents;
2. contradictory provider IDs after local approval;
3. final partial refund reaching 100 percent;
4. expired PIX cancel returning approved and creating one dependent full refund;
5. direct retry result on attempt eight;
6. deep dependency chain with already-reviewed rows;
7. uncertain create losing a race to webhook;
8. amendment rejection losing its order compare-and-set;
9. repeated failed delivery with missing operation;
10. one reconciliation stage failing while later stages continue;
11. webhook request client closing while its dedicated background client completes;
12. logs and summary containing no payer or provider material.

Correct every Critical or Important finding, rerun Steps 9, 11, and 12, and do not merge until the user explicitly requests local merge.

## Completion Boundary

Completion means Tasks 16–18 pass focused tests, migration-from-zero, API tests, the full repository gate, Orders-only scans, tracked-secret scans, and final inline review. Exact provider totals control financial completion; contradictory snapshots preserve established state; provider operations and reconciliation stop after eight attempts; business decisions remain atomic; concurrent recovery cannot overwrite newer state; and webhook background processing owns a dedicated database client.

Completion makes the branch eligible for user-authorized local merge and a separate manual sandbox test guide. It does not authorize staging migration, external webhook exposure, provider credential changes, real charges, deployment, public beta, or production.

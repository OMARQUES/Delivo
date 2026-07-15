# Mercado Pago Orders Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution remains inline; do not dispatch subagents unless the user explicitly changes that preference.

**Goal:** Correct the financial-state, atomicity, serialization, and reconciliation defects found after Tasks 1–12 so Mercado Pago Orders work is safe to merge and ready for local functional testing.

**Architecture:** Keep PostgreSQL as the durable source of truth. Serialize provider mutations per payment through explicit operation dependencies, persist the exact cumulative refund target before any provider call, validate completion according to operation type, and make every business transition plus financial intent one local transaction. Split reconciliation into isolated bounded stages and persist due/last-reconciled timestamps.

**Tech Stack:** TypeScript 6, Hono 4, Vitest 4, Drizzle ORM, PostgreSQL 17, Mercado Pago Orders API, Cloudflare Workers/Wrangler 4.

## Global Constraints

- Work in `feat/mercado-pago-orders-hardening`; no push and no merge until Task 15 final review passes.
- Preserve the clean Orders-only cutover. Never restore `src/lib/payment-provider.ts`, `src/lib/mercadopago.ts`, `/v1/payments`, or compatibility aliases.
- Use local TDD: write focused RED tests, verify the expected failure, implement minimally, run focused tests, review the diff, then commit each task.
- Never print, log, persist in new tables, or commit access tokens, webhook secrets, card tokens, payer emails, QR contents, provider bodies, signatures, database URLs, or credentials.
- External provider calls remain outside PostgreSQL transactions. Transactions persist intent, dependencies, expected totals, and local state only.
- Every cancellation/refund intent must exist durably in the same transaction as the business decision requiring it.
- Mutating provider calls remain idempotent and use the already persisted idempotency key.
- `REFUND_PARTIAL` succeeds only when authoritative cumulative refunded cents equal its persisted target. A greater or contradictory amount requires review.
- `REFUND_FULL` succeeds only when status is `REFUNDED` and authoritative refunded cents equal the expected payment amount.
- `CANCEL` succeeds only for `CANCELLED`/`EXPIRED`, an already fully refunded payment, or `ESCALATED_TO_REFUND` after an approved snapshot creates one durable full-refund intent.
- Operations for one payment execute serially. A dependent operation is never claimed before its predecessor is `SUCCEEDED`.
- A dependency entering `REVIEW_REQUIRED` moves its dependent chain to `REVIEW_REQUIRED`; it must not remain silently pending.
- Local payment status `REFUNDED` never regresses. `APPROVED` may advance to `REFUNDED` or update an exact partial-refund total, but may not regress to pending/rejected/cancelled/expired.
- The staging/production Mercado Pago activation boundary remains unchanged. This plan authorizes local code, migration, and test work only.

---

### Task 13: Serialize payment operations and verify exact financial outcomes

**Files:**
- Modify: `apps/api/src/db/schema/payments.ts`
- Generate: `apps/api/drizzle/0028_payment_operation_serialization.sql`
- Generate: `apps/api/drizzle/meta/0028_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/src/payments/operation-queue.service.ts`
- Modify: `apps/api/src/payments/operation.service.ts`
- Modify: `apps/api/src/payments/transition.service.ts`
- Modify: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/test/payment.schema.test.ts`
- Modify: `apps/api/test/payment-operation.service.test.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/api/test/helpers/payment-provider.ts`

**Interfaces:**
- Produces:

```ts
export type PaymentOperationResultCode =
  | 'CANCELLED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'ESCALATED_TO_REFUND'

export type PaymentOperationIntent = {
  paymentId: string
  type: 'CANCEL' | 'REFUND_FULL' | 'REFUND_PARTIAL'
  amountCents: number | null
  businessKey: string
  idempotencyKey: string
}

export async function enqueuePaymentOperation(
  tx: Db | DbTransaction,
  input: PaymentOperationIntent,
  now: Date,
): Promise<{ id: string; inserted: boolean }>

export async function claimDueOperations(
  db: Db,
  now: Date,
  limit: number,
  leaseOwner: string,
): Promise<string[]>
```

- `operation-queue.service.ts` owns enqueue, refund-target calculation, dependency creation, and claims.
- `operation.service.ts` owns provider execution, authoritative requery, operation-specific outcome validation, retries, escalation, and final status.
- `transition.service.ts` owns payment/order/event transitions and may enqueue a late full refund through `operation-queue.service.ts` without importing the processor.

- [ ] **Step 1: Add RED schema assertions for serialized operations**

Extend `payment.schema.test.ts` to require these columns:

```ts
expect(operationColumns.map((row) => row.column_name)).toEqual(expect.arrayContaining([
  'expected_refunded_amount_cents',
  'depends_on_operation_id',
  'result_code',
]))
```

Assert:

```ts
expect(operationResultEnum).toEqual([
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'ESCALATED_TO_REFUND',
])
expect(indexNames).toContain('payment_operations_dependency_idx')
expect(foreignKeys).toContain('payment_operations_depends_on_operation_id_payment_operations_id_fk')
```

Run:

```bash
pnpm --filter @delivery/api test -- payment.schema.test.ts
```

Expected: FAIL because migration `0028` and columns do not exist.

- [ ] **Step 2: Add RED transition tests for full and partial refunds**

In `payment.service.test.ts`, add PostgreSQL-backed cases:

```ts
it('advances APPROVED to REFUNDED and never regresses afterward', async () => {
  const fixture = await approvedPaymentFixture()
  const refunded = providerSnapshot({
    providerOrderId: fixture.payment.providerOrderId!,
    providerTransactionId: fixture.payment.providerTransactionId!,
    externalReference: fixture.order.id,
    totalAmountCents: fixture.payment.expectedAmountCents,
    refundedAmountCents: fixture.payment.expectedAmountCents,
    orderStatus: 'refunded',
    orderStatusDetail: 'refunded',
    transactionStatus: 'refunded',
    transactionStatusDetail: 'refunded',
  })

  await applyProviderSnapshot(testDb, fixture.payment.id, refunded, new Date())
  expect(await paymentStatus(fixture.payment.id)).toMatchObject({
    status: 'REFUNDED',
    refundedAmountCents: fixture.payment.expectedAmountCents,
  })

  await applyProviderSnapshot(testDb, fixture.payment.id, providerSnapshot({
    ...refunded,
    refundedAmountCents: 0,
    orderStatus: 'pending',
    orderStatusDetail: 'pending',
    transactionStatus: 'pending',
    transactionStatusDetail: 'pending',
  }), new Date())
  expect((await paymentStatus(fixture.payment.id)).status).toBe('REFUNDED')
})
```

Add a partial-refund case asserting `APPROVED` remains, `refundedAmountCents` advances exactly, and a later smaller/greater contradictory snapshot cannot overwrite the authoritative total silently.

Run:

```bash
pnpm --filter @delivery/api test -- payment.service.test.ts
```

Expected: FAIL because the current terminal guard blocks `APPROVED → REFUNDED`.

- [ ] **Step 3: Add RED operation-outcome and dependency tests**

Extend `payment-operation.service.test.ts` with all cases below:

1. `REFUND_FULL` returned snapshot `APPROVED` remains `PROCESSING/PENDING`, never `SUCCEEDED`.
2. transient `REFUND_FULL` followed by GET `APPROVED` schedules retry.
3. `REFUND_FULL` succeeds only with `REFUNDED` and exact full amount.
4. `REFUND_PARTIAL` succeeds only when refunded cents equal `expectedRefundedAmountCents`.
5. partial result below target retries; above target moves review with `MISMATCH_REFUNDED_TARGET`.
6. `CANCEL` GET `PENDING` retries.
7. `CANCEL` GET `APPROVED` creates one dependent `REFUND_FULL`, then records `ESCALATED_TO_REFUND`.
8. second operation for the same payment depends on the first.
9. a dependent operation is not claimed while predecessor is `PENDING` or `PROCESSING`.
10. predecessor `SUCCEEDED` releases exactly one dependent operation.
11. predecessor `REVIEW_REQUIRED` moves descendants to review.
12. two workers cannot claim operations from the same dependency chain concurrently.

Use assertions shaped like:

```ts
expect(await operationState(cancelId)).toMatchObject({
  status: 'SUCCEEDED',
  resultCode: 'ESCALATED_TO_REFUND',
})
expect(await operationState(refundId)).toMatchObject({
  status: 'PENDING',
  dependsOnOperationId: cancelId,
  expectedRefundedAmountCents: payment.expectedAmountCents,
})
```

Run:

```bash
pnpm --filter @delivery/api test -- payment-operation.service.test.ts
```

Expected: FAIL because current operations have no target/dependency/result fields and accept every non-review snapshot as success.

- [ ] **Step 4: Extend schema and generate migration `0028`**

Add the result enum and columns to `payments.ts`:

```ts
import { type AnyPgColumn, boolean, check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const paymentOperationResultCode = pgEnum('payment_operation_result_code', [
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'ESCALATED_TO_REFUND',
])

expectedRefundedAmountCents: integer('expected_refunded_amount_cents'),
dependsOnOperationId: uuid('depends_on_operation_id')
  .references((): AnyPgColumn => paymentOperations.id, { onDelete: 'restrict' }),
resultCode: paymentOperationResultCode('result_code'),
```

Add:

```ts
index('payment_operations_dependency_idx').on(t.dependsOnOperationId, t.status),
check('payment_operations_expected_refund_valid', sql`
  (${t.type} = 'CANCEL' and ${t.expectedRefundedAmountCents} is null)
  or
  (${t.type} in ('REFUND_FULL', 'REFUND_PARTIAL') and ${t.expectedRefundedAmountCents} > 0)
`),
```

Generate:

```bash
pnpm --filter @delivery/api db:generate -- --name payment_operation_serialization
```

Expected: `0028_payment_operation_serialization.sql`, snapshot, and journal entry generated. Review SQL: additive only; no payment/order table drop and no destructive data rewrite.

- [ ] **Step 5: Implement dependency-aware enqueue and claim**

Create `operation-queue.service.ts`. Enqueue must:

1. lock the payment row with `FOR UPDATE`;
2. reject new automatic work if an existing operation in that payment chain is `REVIEW_REQUIRED`;
3. find the latest `PENDING`/`PROCESSING` predecessor for the payment;
4. reject partial enqueue when a nonterminal full refund exists;
5. calculate the base cumulative refund as the maximum of payment `refundedAmountCents` and existing refund-operation targets;
6. set partial target to `base + amountCents` and fail if it exceeds expected amount;
7. set full target to `expectedAmountCents`;
8. make a new operation depend on the latest active predecessor;
9. insert with conflict handling only on the deterministic business key;
10. when that business key already exists, verify payment, type, amount, target, and idempotency key are identical before returning it; otherwise throw a conflict;
11. return the inserted or identical existing row ID without changing attempts/history.

Claim only rows whose dependency is absent or `SUCCEEDED`. Keep `FOR UPDATE SKIP LOCKED`, five-minute leases, 1–100 batch bounds, and attempt increment at claim time.

Move `enqueuePaymentOperation` and `claimDueOperations` out of `operation.service.ts`; update imports without compatibility re-exports.

- [ ] **Step 6: Correct authoritative payment transitions**

Replace the broad terminal guard in `transition.service.ts` with explicit monotonic rules:

```ts
if (payment.status === 'REFUNDED') {
  return { changed: false, decision: decision.kind, operationEnqueued: false }
}

if (payment.status === 'APPROVED' && [
  'PENDING', 'REJECTED', 'CANCELLED', 'EXPIRED',
].includes(decision.kind)) {
  return { changed: false, decision: decision.kind, operationEnqueued: false }
}
```

Handle `REFUNDED` before rejection/cancellation branches and persist:

```ts
status: 'REFUNDED',
refundedAmountCents: payment.expectedAmountCents,
reconciliationState: 'HEALTHY',
reconciliationFailure: null,
```

For exact partial refund, keep `APPROVED` and update cumulative refunded cents. For late approval on a cancelled order, call the queue service with:

```ts
businessKey: `refund-full:${payment.id}:LATE_APPROVAL`,
idempotencyKey: `refund-full:${payment.id}:LATE_APPROVAL`,
```

Do not reopen the order.

- [ ] **Step 7: Implement operation-specific completion**

In `operation.service.ts`, add a pure evaluator:

```ts
type OperationOutcome =
  | { kind: 'SUCCEEDED'; resultCode: PaymentOperationResultCode }
  | { kind: 'ESCALATE_TO_REFUND' }
  | { kind: 'RETRY'; failureClass: string }
  | { kind: 'REVIEW_REQUIRED'; failureClass: string }
```

Rules:

- `CANCEL` + `CANCELLED`/`EXPIRED` → `SUCCEEDED/CANCELLED`.
- `CANCEL` + exact `REFUNDED` → `SUCCEEDED/REFUNDED`.
- `CANCEL` + `APPROVED`/`PARTIALLY_REFUNDED` → apply snapshot, require one durable full-refund operation, then `SUCCEEDED/ESCALATED_TO_REFUND`.
- `CANCEL` + `PENDING` → retry.
- `REFUND_FULL` → success only for `REFUNDED` and exact expected amount.
- `REFUND_PARTIAL` → success only for exact persisted target; below target retries; above target reviews.
- Every provider mismatch/review result → review.
- The same evaluator is used for direct mutation responses and GET after transient/uncertain errors.

Never set `SUCCEEDED` merely because `applyProviderSnapshot` returned a non-review decision.

For `ESCALATE_TO_REFUND`, perform the authoritative local snapshot transition, dependent `REFUND_FULL` enqueue, cancellation result-code update, lease clearing, and completion timestamp in one PostgreSQL transaction. The provider mutation/GET stays outside that transaction. If local refund-intent persistence fails, the `CANCEL` operation remains retryable and must not become `SUCCEEDED`.

- [ ] **Step 8: Propagate dependency review safely**

Add a bounded function in `operation-queue.service.ts`:

```ts
export async function propagateReviewedDependencies(
  db: Db,
  now: Date,
  limit: number,
): Promise<number>
```

Move direct children of a `REVIEW_REQUIRED` predecessor to `REVIEW_REQUIRED` with `failureClass='DEPENDENCY_REVIEW_REQUIRED'`, clear leases, and repeat in bounded batches during reconciliation until no newly eligible child exists. Never mutate `SUCCEEDED` rows.

- [ ] **Step 9: Run focused and API tests**

```bash
pnpm --filter @delivery/api test -- payment.schema.test.ts payment-operation.service.test.ts payment.service.test.ts
pnpm --filter @delivery/api test
pnpm --filter @delivery/api exec tsc --noEmit
git diff --check
```

Expected: all PASS; full refund updates local state, contradictory snapshots never produce false success, and dependency claims serialize per payment.

- [ ] **Step 10: Commit Task 13**

```bash
git add apps/api/src/db/schema/payments.ts apps/api/drizzle apps/api/src/payments apps/api/test/payment.schema.test.ts apps/api/test/payment-operation.service.test.ts apps/api/test/payment.service.test.ts apps/api/test/helpers/payment-provider.ts
git commit -m "fix(payments): verify serialized operation outcomes"
```

---

### Task 14: Make business decisions, events, and financial intents atomic

**Files:**
- Modify: `apps/api/src/payments/operation-queue.service.ts`
- Modify: `apps/api/src/services/payment.service.ts`
- Modify: `apps/api/src/services/order-status.service.ts`
- Modify: `apps/api/src/services/dispatch.service.ts`
- Modify: `apps/api/src/services/amendment.service.ts`
- Modify: `apps/api/src/routes/orders.ts`
- Modify: `apps/api/src/routes/store-orders.ts`
- Modify: `apps/api/src/routes/driver.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/api/test/amendment.service.test.ts`
- Modify: `apps/api/test/store-orders.routes.test.ts`
- Modify: `apps/api/test/returns.service.test.ts`
- Modify: `apps/api/test/dispatch.service.test.ts`
- Modify: `apps/api/test/orders.routes.test.ts`

**Interfaces:**
- Produces:

```ts
export type OrderPaymentTransition =
  | 'CUSTOMER_CANCELLED'
  | 'STORE_CANCELLED'
  | 'STORE_CANCEL_REQUEST_APPROVED'
  | 'STALE_PENDING'
  | 'DELIVERY_FAILED'
  | 'AMENDMENT_REJECTED'
  | 'PIX_EXPIRED'

export async function enqueueOrderPaymentDisposition(
  tx: Db | DbTransaction,
  orderId: string,
  transition: OrderPaymentTransition,
  now: Date,
): Promise<{ operationId: string | null; type: 'CANCEL' | 'REFUND_FULL' | null }>
```

- Business services no longer accept `PaymentProvider`.
- Routes no longer construct a provider for cancellation, amendment, or delivery-failure actions.
- Only checkout, webhook processing, operation processing, and scheduled reconciliation may depend on `PaymentProvider`.

- [ ] **Step 1: Add RED rollback tests for every cancellation family**

Add a test helper that reserves the exact future idempotency key with a different business key:

```ts
async function forceOperationKeyConflict(paymentId: string, idempotencyKey: string) {
  await testDb.insert(paymentOperations).values({
    paymentId,
    type: 'CANCEL',
    amountCents: null,
    expectedRefundedAmountCents: null,
    businessKey: `test-conflict:${crypto.randomUUID()}`,
    idempotencyKey,
    status: 'SUCCEEDED',
    resultCode: 'CANCELLED',
    completedAt: new Date(),
  })
}
```

For customer cancel, direct store cancel, approved store cancel request, stale pending cancellation, and failed delivery:

1. create an online order/payment;
2. reserve the exact intended idempotency key;
3. capture order status, event count, amendment status, and operation count;
4. invoke the business action and expect unique-key rejection;
5. assert every captured business value is unchanged.

Run:

```bash
pnpm --filter @delivery/api test -- store-orders.routes.test.ts returns.service.test.ts dispatch.service.test.ts orders.routes.test.ts
```

Expected: FAIL because current order/event changes commit before operation insertion.

- [ ] **Step 2: Add RED amendment atomicity tests**

For approval, propose an amendment on an approved online payment, reserve:

```ts
const key = `refund-partial:${payment.id}:amendment:${amendment.id}`
```

Invoke approval and assert rollback preserves:

- amendment `PROPOSED`;
- original item quantities and totals;
- original order totals;
- original event count;
- no new operation.

For rejection, reserve:

```ts
const key = `refund-full:${payment.id}:AMENDMENT_REJECTED`
```

Assert order remains uncancelled, amendment remains `PROPOSED`, event count is unchanged, and no new operation exists.

Run:

```bash
pnpm --filter @delivery/api test -- amendment.service.test.ts
```

Expected: FAIL because amendment events and some disposition work occur outside the transaction.

- [ ] **Step 3: Centralize exact operation-key construction**

In `payment.service.ts`, make `enqueueOrderPaymentDisposition`:

1. select the latest payment for the order with `FOR UPDATE`;
2. return no operation for cash/no payment;
3. choose `REFUND_FULL` for `APPROVED`, `CANCEL` for `PENDING`, and no new work for already `REFUNDED`;
4. construct exact keys:

```ts
const prefix = type === 'REFUND_FULL' ? 'refund-full' : 'cancel'
const key = `${prefix}:${payment.id}:${transition}`
```

5. enqueue through `operation-queue.service.ts` using the caller's transaction;
6. return the operation ID/type for assertions and events.

Delete provider parameters from `enqueueOrderPaymentDisposition`, `refundOrderPaymentIfAny`, and `expireStaleAwaitingPayment`; rename or remove obsolete wrappers instead of retaining compatibility signatures.

- [ ] **Step 4: Refactor customer and store cancellations into one transaction per order**

For each of `customerCancelOrder`, `storeUpdateOrderStatus(..., 'CANCELLED')`, and `storeResolveCancelRequest(..., true)`:

```ts
return db.transaction(async (tx) => {
  const order = await selectAndLockEligibleOrder(tx, ...)
  const updated = await updateOrderWithCompareAndSet(tx, ...)
  await expirePendingAmendment(tx, order.id)
  await enqueueOrderPaymentDisposition(tx, order.id, transition, now)
  await addEvent(tx, order.id, 'CANCELLED', actorRole, actorId, note)
  return updated
})
```

Move event insertion inside the transaction. Preserve current authorization, status guards, reason text, response shape, and compare-and-set behavior.

For `cancelStalePendingOrders`, select a bounded list of candidate IDs, then process each candidate in its own transaction with row lock, event, amendment expiry, and disposition. One order is the atomic unit; never bulk-update all orders before intents exist.

- [ ] **Step 5: Refactor failed delivery atomically**

Inside the existing `failDelivery` transaction, after the order update and event:

```ts
await enqueueOrderPaymentDisposition(
  tx,
  orderId,
  'DELIVERY_FAILED',
  now,
)
```

Remove the post-transaction refund call and provider argument. Existing idempotent retry of an already `DELIVERY_FAILED` order must verify the durable operation exists without duplicating it.

- [ ] **Step 6: Refactor amendment approval/rejection atomically**

Change signatures:

```ts
approveAmendment(db: Db, customerId: string, orderId: string)
rejectAmendment(db: Db, customerId: string, orderId: string)
```

Approval transaction must contain:

- amendment claim;
- item changes;
- order totals;
- partial-refund intent with exact target/dependency;
- SYSTEM refund-pending event when applicable;
- CUSTOMER adjusted-order event.

Rejection transaction must contain:

- amendment claim;
- order cancellation;
- full-refund/cancel intent;
- cancellation event.

No event or financial intent may be written after commit.

- [ ] **Step 7: Remove provider coupling from routes and services**

Delete `PaymentProvider` imports and parameters from business services. Remove `createPaymentProvider(c.env)` from:

- customer amendment approve/reject;
- customer cancel;
- store cancel/status actions;
- driver delivery failure.

Prove only approved boundaries construct providers:

```bash
rg -n "createPaymentProvider\(c\.env\)|PaymentProvider" apps/api/src/routes apps/api/src/services
```

Expected remaining runtime consumers: online checkout context, webhook route, operation/reconciliation modules, and Worker cron. No order-status/amendment/dispatch consumer.

- [ ] **Step 8: Add refund-conflict tests**

Cover:

- two partial refunds chain targets without exceeding total;
- enqueue above remaining total fails and rolls back amendment approval;
- active full refund prevents a new partial refund;
- full refund created after partial work depends on the last partial operation;
- same business transition remains idempotent;
- different payment attempts never collide because every key contains `paymentId`.

Run:

```bash
pnpm --filter @delivery/api test -- amendment.service.test.ts payment-operation.service.test.ts payment.service.test.ts
```

Expected: PASS only when conflict checks and dependency construction are transactional.

- [ ] **Step 9: Run affected and full API gates**

```bash
pnpm --filter @delivery/api test -- amendment.service.test.ts payment.service.test.ts payment-operation.service.test.ts store-orders.routes.test.ts returns.service.test.ts dispatch.service.test.ts orders.routes.test.ts
pnpm --filter @delivery/api test
pnpm --filter @delivery/api exec tsc --noEmit
pnpm lint
git diff --check
```

Expected: all PASS; forced operation persistence failures roll back every related business mutation.

- [ ] **Step 10: Commit Task 14**

```bash
git add apps/api/src/payments apps/api/src/services apps/api/src/routes apps/api/test
git commit -m "fix(payments): persist disposition atomically"
```

---

### Task 15: Complete uncertain recovery, isolate reconciliation, and run final gate

**Files:**
- Modify: `apps/api/src/payments/checkout.service.ts`
- Modify: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/src/payments/transition.service.ts`
- Modify: `apps/api/src/payments/operation-queue.service.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/api/test/payment-operation.service.test.ts`
- Modify: `docs/security/runbooks/mercado-pago-orders.md`
- Modify: `docs/security/2026-07-11-backend-security-review.md`

**Interfaces:**
- Produces:

```ts
export type ReconciliationContext = {
  resolvePayerEmail: (userEmail: string | null, userId: string) => string
}

export async function runPaymentReconciliation(
  db: Db,
  provider: PaymentProvider,
  now: Date,
  context: ReconciliationContext,
  limits?: Limits,
): Promise<ReconciliationSummary>
```

- Scheduled stages remain bounded and independently fail-safe.
- `recoverUncertainCreate` persists every outcome; it never returns a decision that leaves an unchanged perpetual `PENDING` row.

- [ ] **Step 1: Add RED uncertain-create recovery tests**

Extend `payment.service.test.ts` and `payment-reconciliation.test.ts`:

1. one exact search result applies snapshot and records `lastReconciledAt`;
2. multiple results set `REVIEW_REQUIRED/AMBIGUOUS_PROVIDER_CREATE`;
3. zero card results set `REVIEW_REQUIRED/FRESH_CARD_REQUIRED` without replaying card token;
4. zero PIX results retry `createOrder` using the original idempotency key and resolved payer email;
5. expired zero-result PIX becomes locally `EXPIRED`, cancels only an `AWAITING_PAYMENT` order, and records one event;
6. transient PIX retry schedules `nextReconcileAt` without changing order/payment to rejection;
7. no raw payer email appears in logs or reconciliation summary.

Run:

```bash
pnpm --filter @delivery/api test -- payment.service.test.ts payment-reconciliation.test.ts
```

Expected: FAIL because current reconciler ignores `RETRY_PIX`, `FRESH_CARD_REQUIRED`, and multi-match persistence.

- [ ] **Step 2: Add RED stage-isolation and scheduling tests**

Cover each stage independently:

- lease recovery;
- dependency-review propagation;
- inbox;
- operations;
- uncertain creates;
- pending snapshots;
- PIX expiration;
- safe review recheck.

Force each stage query/provider call to fail one at a time and assert later stages still execute. Add overlapping-worker tests proving batch limits and lease ownership. Assert summary contains counts only.

Add scheduling assertions:

```ts
expect(updated.lastReconciledAt).toEqual(now)
expect(updated.nextReconcileAt).toEqual(new Date(now.getTime() + 5 * 60_000))
```

Terminal or manual-review states must have `nextReconcileAt=null` unless explicitly eligible for bounded safe recheck.

Run:

```bash
pnpm --filter @delivery/api test -- payment-reconciliation.test.ts
```

Expected: FAIL because current outer `try` aborts later categories and timestamps are not maintained.

- [ ] **Step 3: Persist all uncertain-create decisions**

Update `recoverUncertainCreate`:

- unique result → apply snapshot;
- multiple results → set review and clear next due time;
- zero card → set `FRESH_CARD_REQUIRED` review; never call `createOrder`;
- zero nonexpired PIX → call `createOrder` with original create idempotency key, original amount/expiry, and resolved payer email, then apply snapshot;
- zero expired PIX → atomically mark payment `EXPIRED`, cancel only `AWAITING_PAYMENT`, and write `pagamento não aprovado` once;
- transient errors → retain `PENDING` and schedule retry.

Resolve payer identity by joining payment → order → customer user. The reconciler receives a resolver; Worker cron supplies:

```ts
resolvePayerEmail: (email, userId) => resolvePayerEmail(env, email, userId)
```

Never store a new payer-email copy in `payments` or `payment_operations`.

Keep expiration ownership unambiguous:

- expired PIX without `providerOrderId` is resolved by uncertain-create recovery and may expire locally only after an exact provider search returns zero matches;
- expired PIX with `providerOrderId` is handled by the expiration stage through a durable `CANCEL` operation;
- neither path may create both a local expiration and a provider cancellation for the same observation.

- [ ] **Step 4: Split reconciliation into isolated bounded stages**

Replace the single outer block with explicit stage execution:

```ts
async function runStage(
  summary: ReconciliationSummary,
  action: () => Promise<void>,
) {
  try {
    await action()
  } catch {
    summary.stageFailures++
  }
}
```

Call one `runStage` per category. Each stage owns its query and per-row error isolation. `getAccountId()` failure may fail account-preflight/snapshot validation, but must not prevent lease recovery, dependency propagation, or independent operation/inbox attempts from recording their own credential failures.

Clamp every configured limit to `1..100`. Order due records deterministically by due/created timestamp.

- [ ] **Step 5: Maintain reconciliation timestamps**

When an authoritative snapshot is applied:

```ts
lastReconciledAt: now,
nextReconcileAt: decision.kind === 'PENDING'
  ? new Date(now.getTime() + 5 * 60_000)
  : null,
```

Select nonterminal refresh rows only when `nextReconcileAt IS NULL OR nextReconcileAt <= now`. Schedule uncertain transient creates for one minute. Keep safe review rechecks at fifteen-minute intervals and only for the documented transient failure classes.

- [ ] **Step 6: Process dependencies before outbound work**

Run `propagateReviewedDependencies` after lease recovery and before claims. Claims automatically release rows whose predecessor is `SUCCEEDED`. Add summary fields:

```ts
dependenciesReviewed: number
operationsReleased: number
```

These remain counts only. Never include operation IDs, provider IDs, keys, emails, or failure bodies.

- [ ] **Step 7: Update runbook and remediation status accurately**

Update `mercado-pago-orders.md` with:

- result-code meanings;
- dependency-chain inspection using sanitized count/age only;
- exact partial/full target rules;
- `ESCALATED_TO_REFUND` semantics;
- dependency review handling;
- warning that `SUCCEEDED/CANCELLED` escalation is not financial completion until dependent refund succeeds.

Update SEC-08 status only after final gates pass. Keep external webhook, credentials, sandbox/live, staging, and production validation pending.

- [ ] **Step 8: Prove clean migration from zero**

```bash
docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE IF EXISTS delivery_test WITH (FORCE)'
docker compose exec -T postgres psql -U postgres -c 'CREATE DATABASE delivery_test'
pnpm --filter @delivery/api test -- payment.schema.test.ts
```

If running inside Flatpak and `docker` is absent there, use the host command explicitly:

```bash
flatpak-spawn --host sh -lc "cd '$PWD' && docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE IF EXISTS delivery_test WITH (FORCE)' && docker compose exec -T postgres psql -U postgres -c 'CREATE DATABASE delivery_test'"
pnpm --filter @delivery/api test -- payment.schema.test.ts
```

Expected: migrations `0000` through `0028` apply to a fresh DB and schema suite passes.

- [ ] **Step 9: Prove Orders-only and atomicity boundaries**

```bash
! rg -n "/v1/payments|providerPaymentId|createPixPayment|createCardPayment|getPayment|refundPayment|cancelPayment|src/lib/payment-provider|lib/payment-provider|src/lib/mercadopago|lib/mercadopago" apps/api/src apps/api/test
! rg -n "PaymentProvider|createPaymentProvider\(c\.env\)" apps/api/src/services/order-status.service.ts apps/api/src/services/amendment.service.ts apps/api/src/services/dispatch.service.ts apps/api/src/routes/store-orders.ts apps/api/src/routes/driver.ts
git diff --check
```

Expected: no legacy/provider-coupled business paths.

- [ ] **Step 10: Use verification-before-completion and run the full repository gate**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --dir apps/api exec wrangler deploy --dry-run --outdir /tmp/delivery-api-orders-corrective-dry
git diff --check
git status --short
```

Expected: every command PASS; status contains only intentional Task 15 files before commit.

- [ ] **Step 11: Run tracked-file secret scan with boundary-safe Resend pattern**

```bash
! git grep -n -E 'postgresql://[^ ]+@|APP_USR-[A-Za-z0-9_-]+|(^|[^A-Za-z])re_[A-Za-z0-9_-]{20,}|npg_[A-Za-z0-9]+' -- ':!pnpm-lock.yaml'
```

Expected: no matches. Do not scan ignored `.env`, `.dev.vars`, staging-local files, or provider outputs.

- [ ] **Step 12: Commit Task 15**

```bash
git add apps/api/src/payments apps/api/src/index.ts apps/api/test docs/security
git commit -m "fix(payments): complete reconciliation recovery"
```

- [ ] **Step 13: Inline review before integration**

Review `main...HEAD` against every Global Constraint and the original Orders design. At minimum, manually trace:

1. approved full refund;
2. partial refund exact target;
3. cancel timeout followed by approved GET and refund escalation;
4. business rollback when operation insert fails;
5. two queued refunds for one payment;
6. predecessor review propagation;
7. zero-result uncertain PIX/card recovery;
8. one reconciler stage failing while later stages continue.

Correct every Critical/Important finding, rerun Steps 8–11, and do not merge until the user explicitly authorizes local merge.

## Completion Boundary

Completion means Tasks 13–15 pass migration-from-zero and the full repository gate; provider operations are serialized; operation success proves the requested financial outcome; `APPROVED → REFUNDED` works without regression; every product cancellation/amendment/failure and its financial intent/event commit atomically; uncertain creates reach a persisted actionable state; and reconciler stages fail independently.

Completion still does not enable Mercado Pago in staging or production. External webhook reachability, Cloudflare Access ingress design, test-user/provider smoke, staging secrets, remote disposable-DB migration, and production activation remain separate reviewed work.

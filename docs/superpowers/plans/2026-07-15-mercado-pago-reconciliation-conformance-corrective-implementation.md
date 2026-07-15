# Mercado Pago Reconciliation Conformance Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close remaining Task 18 gaps in concurrent inbox accounting, reconciliation test isolation/sanitization, and single-source snapshot validation.

**Architecture:** Keep PostgreSQL row locks, leases, retry policy, and provider calls unchanged. Add explicit inbox claim result so summaries count only durable claims; expand integration tests around all eight bounded stages; route pending snapshots through `applyProviderSnapshot`, which owns `validateSnapshot`.

**Tech Stack:** TypeScript, Hono Workers, Drizzle PostgreSQL, Vitest, Mercado Pago Orders provider.

## Global Constraints

- Work inline; do not dispatch subagents.
- Work only in existing `feat/mercado-pago-orders-hardening` worktree.
- No schema, migration, route, secret, provider-activation, staging, deployment, or production changes.
- PostgreSQL remains durable source of truth.
- Provider calls remain outside PostgreSQL transactions.
- Preserve existing locks, leases, compare-and-set predicates, retry limits, and idempotency keys.
- No before/after counting query and no second claim implementation.
- Summaries/logs/errors/fixtures never expose provider payloads, tokens, secrets, signatures, payer data, QR data, database URLs, or credentials.
- TDD: failing test → RED → minimal code → GREEN → refactor only while green.
- Commit each task independently after focused tests and diff review.

---

### Task 20: Complete stage isolation and sanitization matrix

**Files:**
- Modify: `apps/api/test/payment-reconciliation.test.ts`

**Interfaces:**
- Consumes: `runPaymentReconciliation`, `ReconciliationStage`, existing fixtures/provider factory.
- Produces: deterministic tests proving one enabled stage does not execute unrelated stages.
- Produces: sanitization regression test for summary, logs, and errors.

- [x] **Step 1: Replace vacuous stage test**

Use exact stage list:

```ts
const stages = ['leases', 'dependencies', 'inbox', 'operations', 'creates', 'snapshots', 'expirations', 'reviews'] as const
```

Each table case creates an eligible selected-stage sentinel plus unrelated sentinels that would change if another stage ran. Enable exactly one stage, assert selected durable transition, assert unrelated rows unchanged, assert unrelated provider spies have zero calls, and assert exact summary deltas. For intentional provider-failure cases, assert exact `stageFailures` and retry/review state; never use only `toBeGreaterThanOrEqual(0)`.

- [x] **Step 2: Add sanitization test before implementation changes**

Add focused test with unique forbidden markers for provider body, access token, webhook secret, signature, payer email, QR content, and database URL. Serialize returned summary and capture `console.log`/`console.error`; assert no marker occurs in summary, log arguments, or thrown error text. Restore spies in `finally`. Do not add production logging.

- [x] **Step 3: Run focused tests and verify RED**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1`.

Expected: isolation matrix fails on current vacuous assertions. Sanitization test must fail only if existing behavior leaks a forbidden marker.

- [x] **Step 4: Implement only test/fixture corrections**

Strengthen fixtures and assertions until every selected stage is observable and unrelated stages are provably untouched. Do not alter reconciliation behavior in this task. If a test reveals production behavior violation, stop and report blocker; do not weaken assertion.

- [x] **Step 5: Run focused and API tests**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1` and `pnpm --filter @delivery/api test`.

Expected: all stage cases pass with exact counters, provider-call assertions, unchanged sentinels, and sanitized output.

- [x] **Step 6: Review and commit Task 20**

Run `git diff --check`, inspect test diff, then execute:

```bash
git add apps/api/test/payment-reconciliation.test.ts
git commit -m "test(payments): cover reconciliation isolation"
```

---

### Task 21: Route all snapshots through standard validation

**Files:**
- Modify: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`

**Interfaces:**
- Consumes: `applyProviderSnapshot` and persisted immutable payment expectations.
- Produces: pending snapshot reconciliation with no manual account comparison or `getAccountId` dependency.

- [x] **Step 1: Strengthen account-mismatch test**

Use provider whose account lookup throws:

```ts
const accountSpy = vi.fn(async () => { throw new Error('account lookup must not run') })
const mismatchProvider = provider({
  getAccountId: accountSpy,
  getOrder: vi.fn(async () => snapshot(pending, { accountId: 'wrong-account' })),
}, pending)
const summary = await runPaymentReconciliation(testDb, mismatchProvider, now, context, only('snapshots'))
expect(summary.stageFailures).toBe(0)
expect(accountSpy).not.toHaveBeenCalled()
```

Keep assertions for `REVIEW_REQUIRED`, `MISMATCH_ACCOUNT`, `nextReconcileAt: null`, and preservation of established provider IDs/status fields.

- [x] **Step 2: Run focused test and verify RED**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1`.

Expected: failure because snapshots currently call `provider.getAccountId()` and pass account into `refreshPendingSnapshot`.

- [x] **Step 3: Remove duplicate account validation**

In `reconciliation.service.ts`:

1. Delete `persistMismatch`.
2. Change `refreshPendingSnapshot` signature to `(db, provider, paymentId, now)`.
3. Delete manual `snapshot.accountId !== account` branch.
4. Keep `await applyProviderSnapshot(db, payment.id, snapshot, now)` as sole snapshot transition call.
5. Delete `const account = await provider.getAccountId()` from snapshots stage and call `refreshPendingSnapshot(db, provider, row.id, now)`.

Do not change retry handling, claim predicates, limits, or summary semantics.

- [x] **Step 4: Run focused and API tests**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts test/payment-operation.service.test.ts test/webhooks.routes.test.ts --no-file-parallelism --maxWorkers=1` and `pnpm --filter @delivery/api test`.

Expected: account mismatch persists through `validateSnapshot`; retry, operation, webhook, and reconciliation tests pass.

- [x] **Step 5: Run final repository gate**

Run each command separately:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @delivery/web build:staging
pnpm --filter @delivery/driver build:staging
pnpm --dir apps/api exec wrangler deploy --env staging --dry-run
pnpm --dir apps/web exec wrangler deploy --env staging --dry-run
pnpm --dir apps/driver exec wrangler deploy --env staging --dry-run
git diff --check
git status --short
```

Expected: all pass; status contains only intentional plan/spec changes before final commit.

- [x] **Step 6: Review and commit Task 21**

Run `git diff --check`, inspect production/test diff, then execute:

```bash
git add apps/api/src/payments/reconciliation.service.ts apps/api/test/payment-reconciliation.test.ts
git commit -m "fix(payments): use standard snapshot validation"
```

### Task 19: Make inbox claim accounting exact

**Files:**
- Modify: `apps/api/src/payments/webhook-inbox.service.ts`
- Modify: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`
- Modify: `apps/api/test/webhooks.routes.test.ts`

**Interfaces:**
- Consumes: existing `processWebhookInboxItem(db, provider, inboxId, leaseOwner, now)` locking flow.
- Produces: `WebhookInboxProcessResult = 'CLAIMED' | 'NOT_CLAIMED'`.
- Produces: `runPaymentReconciliation` increments `inboxProcessed` only for `CLAIMED`.

- [x] **Step 1: Add failing overlap test**

Extend test imports:

```ts
import { paymentOperations, paymentWebhookInbox, payments } from '../src/db/schema'
import { enqueuePaymentOperation } from '../src/payments/operation-queue.service'
```

Add one test using one pending payment, one due `CANCEL` operation, and one unrelated due inbox row. Run two reconcilers concurrently with `only('inbox', 'operations', 'snapshots')`. Assert:

```ts
expect(first.inboxProcessed + second.inboxProcessed).toBe(1)
expect(first.operationsReleased + second.operationsReleased).toBe(1)
expect(first.operationsProcessed + second.operationsProcessed).toBe(1)
expect(first.snapshotsRefreshed + second.snapshotsRefreshed).toBe(1)
expect(inbox.attemptCount).toBe(1)
expect(operation.attemptCount).toBe(1)
expect(provider.cancelOrder).toHaveBeenCalledTimes(1)
```

Provider fixture must return `CANCELLED` for `cancelOrder`, an unknown-order snapshot for the inbox resource, and the normal pending snapshot for the payment snapshot stage.

- [x] **Step 2: Run focused test and verify RED**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1`.

Expected: new test fails because concurrent inbox runs can both increment `inboxProcessed` after one loses claim.

- [x] **Step 3: Add explicit result type and return values**

In `webhook-inbox.service.ts`, add:

```ts
export type WebhookInboxProcessResult = 'CLAIMED' | 'NOT_CLAIMED'
```

Change `processWebhookInboxItem` return type to `Promise<WebhookInboxProcessResult>`. Return `NOT_CLAIMED` when locking transaction finds no eligible row. Return `CLAIMED` after successful `PROCESSED` or `REVIEW_REQUIRED` completion. Keep transient retry persistence and thrown provider errors unchanged.

In `reconciliation.service.ts`, replace unconditional increment with:

```ts
const result = await processWebhookInboxItem(db, provider, row.id, crypto.randomUUID(), now)
if (result === 'CLAIMED') summary.inboxProcessed++
```

- [x] **Step 4: Run focused and API tests**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts test/webhooks.routes.test.ts --no-file-parallelism --maxWorkers=1` and `pnpm --filter @delivery/api test`.

Expected: focused tests and full API suite pass; direct webhook callers continue working while ignoring returned result.

- [x] **Step 5: Review and commit Task 19**

Run `git diff --check`, inspect changed files, then execute:

```bash
git add apps/api/src/payments/webhook-inbox.service.ts apps/api/src/payments/reconciliation.service.ts apps/api/test/payment-reconciliation.test.ts
git commit -m "fix(payments): count inbox claims exactly"
```

---

### Task 22: Prove reconciliation isolation, sanitization, and final conformance

**Files:**
- Modify: `apps/api/test/payment-reconciliation.test.ts`
- Modify: `docs/superpowers/plans/2026-07-15-mercado-pago-reconciliation-conformance-corrective-implementation.md`

**Interfaces:**
- Consumes: `runPaymentReconciliation(db, provider, now, context, options)`, the eight `ReconciliationStage` values, existing PostgreSQL fixtures, and the provider spy factory.
- Produces: a non-vacuous eight-stage isolation matrix in which every stage has an eligible durable sentinel during every table case.
- Produces: a sanitization regression that proves a marker-bearing `getOrder` error entered the snapshots path without reaching summaries, logs, or thrown output.
- Produces: fresh migration-from-zero, Orders-only, tracked-secret, build, test, and Worker dry-run evidence.

Production files are out of scope. If a strengthened test reveals a production violation, stop, leave the test failing, and report the exact mismatch; do not weaken the assertion or modify production under Task 22.

- [ ] **Step 1: Replace the incomplete isolation fixture with eight simultaneously eligible sentinels**

Keep the exact stage list:

```ts
const stages = ['leases', 'dependencies', 'inbox', 'operations', 'creates', 'snapshots', 'expirations', 'reviews'] as const
```

Add a state projection that contains only deterministic durable fields:

```ts
type IsolationState = {
  leases: {
    inboxStatus: string
    inboxAttemptCount: number
    operationStatus: string
    operationAttemptCount: number
  }
  dependencies: { childStatus: string; childFailureClass: string | null }
  inbox: { status: string; attemptCount: number; failureClass: string | null }
  operations: {
    status: string
    attemptCount: number
    resultCode: string | null
    paymentStatus: string
  }
  creates: {
    providerOrderId: string | null
    providerTransactionId: string | null
    reconciliationState: string
  }
  snapshots: {
    reconciliationState: string
    reconciliationAttemptCount: number
    providerStatus: string | null
    nextReconcileAt: Date | null
  }
  expirations: { cancelOperationCount: number }
  reviews: {
    reconciliationState: string
    reconciliationFailure: string | null
    reconciliationAttemptCount: number
    nextReconcileAt: Date | null
  }
}
```

Create one `createIsolationFixture(now)` helper. Every invocation must insert all sentinels below before the selected stage runs:

| Stage | Eligible sentinel | Ordering/isolation control |
|---|---|---|
| `leases` | one `PROCESSING` inbox row and one `PROCESSING` operation with `leasedUntil = now - 1s` | operation uses an `APPROVED` payment and `createdAt = now - 1m` |
| `dependencies` | one `PENDING` child whose predecessor is `REVIEW_REQUIRED` | payment is `APPROVED`, so snapshots cannot claim it |
| `inbox` | one due `PENDING` inbox row with a unique unknown resource | provider returns an unknown-order snapshot, producing durable `REVIEW_REQUIRED` |
| `operations` | one due `CANCEL` operation for an `APPROVED` payment | `createdAt = now - 5m`, earlier than the expired lease operation, so limit one claims this operation |
| `creates` | one `PENDING` PIX payment with both provider IDs `null` | `nextReconcileAt = now - 4m`; provider search returns exactly one matching recovered snapshot |
| `snapshots` | one normal `PENDING` PIX payment with provider IDs | `nextReconcileAt = now - 3m`, before the review sentinel |
| `expirations` | one `PENDING` PIX payment with `expiresAt = now - 1s` | `nextReconcileAt = now + 1h`, so it remains eligible only for expiration |
| `reviews` | one payment in `REVIEW_REQUIRED/ORDER_NOT_FOUND` | `nextReconcileAt = now - 2m`, after the normal snapshot sentinel |

The helper must return the provider, the pre-run state, and `readState()`:

```ts
type IsolationFixture = {
  provider: PaymentProvider
  before: IsolationState
  readState: () => Promise<IsolationState>
}
```

Provider methods must reject unexpected identifiers instead of returning a generic snapshot. Configure exact successful paths:

```ts
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
```

Replace the current future-only `unrelated` payment. Run exactly `only(stage)`, capture `after`, and assert every unselected state is byte-for-byte equal to its pre-run projection:

```ts
const fixture = await createIsolationFixture(now)
const summary = await runPaymentReconciliation(testDb, fixture.provider, now, context, only(stage))
const after = await fixture.readState()

for (const unrelatedStage of stages.filter((candidate) => candidate !== stage)) {
  expect(after[unrelatedStage]).toEqual(fixture.before[unrelatedStage])
}
```

Assert these exact selected durable outcomes:

| Stage | Required selected outcome |
|---|---|
| `leases` | inbox and operation become `PENDING`; attempt counts stay zero |
| `dependencies` | child becomes `REVIEW_REQUIRED/DEPENDENCY_REVIEW_REQUIRED` |
| `inbox` | row becomes `REVIEW_REQUIRED/UNKNOWN_ORDER` with attempt count one |
| `operations` | operation becomes `SUCCEEDED/CANCELLED`, attempt count one, payment becomes `CANCELLED` |
| `creates` | recovered provider IDs persist and reconciliation becomes `HEALTHY` |
| `snapshots` | reconciliation becomes `HEALTHY`, attempt count resets to zero, provider status becomes `created`, next reconciliation is `now + 5m` |
| `expirations` | exactly one `cancel:<paymentId>:PIX_EXPIRED` operation exists |
| `reviews` | reconciliation becomes `HEALTHY`, failure clears, attempt count resets to zero, next reconciliation is `now + 5m` |

Use an exact summary object with every public counter. Expected non-zero values are: `leasesRecovered: 2`; both operation counters equal one for `operations`; the selected stage counter equals one for every other stage; all remaining counters and `stageFailures` equal zero.

- [ ] **Step 2: Enforce exact provider-call isolation, including snapshots without account lookup**

Replace the permissive `allowed` array with exact call counts:

```ts
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
```

`snapshots` must expect zero `getAccountId` calls. Do not allow a method merely because another stage uses it.

- [ ] **Step 3: Make the sanitization test execute a marker-bearing provider failure**

Replace the unused `getAccountId` failure with an eligible payment and a failing `getOrder` spy:

```ts
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
      result = await runPaymentReconciliation(testDb, provider({ getOrder }, pending), new Date(), context, only('snapshots'))
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
```

The `getOrder` call-count and persisted retry assertions are mandatory: they prove the forbidden markers entered the reconciliation failure path. Do not serialize `providerError` directly into the inspected output.

- [ ] **Step 4: Prove the new isolation test is sensitive, then restore the correct selected-stage call**

First run the focused file with the correct `only(stage)` call:

```bash
pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: all reconciliation tests pass unless the stricter matrix reveals a production violation. If a production violation appears, stop and report it.

To prove the matrix is not vacuous, temporarily change only this test line:

```ts
const summary = await runPaymentReconciliation(testDb, fixture.provider, now, context, only(...stages))
```

Run the same focused command. Expected: the isolation matrix fails because unrelated counters, durable states, or provider call counts change. Restore `only(stage)` immediately with `apply_patch`, rerun the focused command, and require PASS. Never commit the temporary mutation.

- [ ] **Step 5: Run focused, API, and migration-from-zero verification**

Run each command separately:

```bash
pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts test/payment-operation.service.test.ts test/webhooks.routes.test.ts --no-file-parallelism --maxWorkers=1
docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE IF EXISTS delivery_test WITH (FORCE)'
docker compose exec -T postgres psql -U postgres -c 'CREATE DATABASE delivery_test'
pnpm --filter @delivery/api exec vitest run test/payment.schema.test.ts --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api test
pnpm --filter @delivery/api typecheck
git diff --check
```

The Docker commands target only the disposable local `delivery_test` database inside the repository's Compose PostgreSQL service. They must not use `DATABASE_URL`, Neon, Hyperdrive, staging, or any remote hostname. Expected: migrations `0000` through `0029`, focused tests, 75 API files/744 or more tests, typecheck, and diff check all pass.

- [ ] **Step 6: Run the full repository and Worker dry-run gate**

Run fresh, one command at a time:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @delivery/web build:staging
pnpm --filter @delivery/driver build:staging
pnpm --dir apps/api exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-api-orders-task22-dry
pnpm --dir apps/web exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-web-orders-task22-dry
pnpm --dir apps/driver exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-driver-orders-task22-dry
git diff --check
git status --short
```

Expected: every command exits zero. Before commit, status contains only `apps/api/test/payment-reconciliation.test.ts` and this plan file. Dry-runs must not deploy or mutate remote Workers.

- [ ] **Step 7: Prove Orders-only code and tracked-file secret safety**

Run exactly:

```bash
! rg -n "/v1/payments|providerPaymentId|createPixPayment|createCardPayment|getPayment|refundPayment|cancelPayment|src/lib/payment-provider|lib/payment-provider|src/lib/mercadopago|lib/mercadopago" apps/api/src apps/api/test
! rg -n "PaymentProvider|createPaymentProvider\(c\.env\)" apps/api/src/services/order-status.service.ts apps/api/src/services/amendment.service.ts apps/api/src/services/dispatch.service.ts apps/api/src/routes/store-orders.ts apps/api/src/routes/driver.ts
! git grep -n -E 'postgresql://[^ ]+@|APP_USR-[A-Za-z0-9_-]+|(^|[^A-Za-z])re_[A-Za-z0-9_-]{20,}|npg_[A-Za-z0-9]+' -- ':!pnpm-lock.yaml'
rg -n '"binding": "BUCKET"|"bucket_name": "delivo-media-staging"|"binding": "HYPERDRIVE"|ee44ff9aa75d4b57826982d04a569c1d' apps/api/wrangler.jsonc
```

Expected: the first three commands return no matches and exit zero because of `!`; the Wrangler scan finds the existing local/staging `BUCKET`, `delivo-media-staging`, `HYPERDRIVE`, and exact Hyperdrive ID. Never print environment files or secret values.

- [ ] **Step 8: Review and commit Task 22**

Review `git diff --check`, the complete test diff, and the plan checkbox diff. Confirm no production, schema, migration, Wrangler, secret, or environment file changed. Then execute:

```bash
git add apps/api/test/payment-reconciliation.test.ts docs/superpowers/plans/2026-07-15-mercado-pago-reconciliation-conformance-corrective-implementation.md
git commit -m "test(payments): prove reconciliation conformance"
git status --short
```

Expected: commit succeeds and final status is empty.

After Task 22, use `superpowers:requesting-code-review`, rerun the required verification on the committed branch, and use `superpowers:finishing-a-development-branch`. Merge locally only after a clean review and explicit user selection; never push or deploy as part of this plan.

---

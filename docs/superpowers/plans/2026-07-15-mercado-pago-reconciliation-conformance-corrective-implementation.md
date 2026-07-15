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

- [ ] **Step 1: Replace vacuous stage test**

Use exact stage list:

```ts
const stages = ['leases', 'dependencies', 'inbox', 'operations', 'creates', 'snapshots', 'expirations', 'reviews'] as const
```

Each table case creates an eligible selected-stage sentinel plus unrelated sentinels that would change if another stage ran. Enable exactly one stage, assert selected durable transition, assert unrelated rows unchanged, assert unrelated provider spies have zero calls, and assert exact summary deltas. For intentional provider-failure cases, assert exact `stageFailures` and retry/review state; never use only `toBeGreaterThanOrEqual(0)`.

- [ ] **Step 2: Add sanitization test before implementation changes**

Add focused test with unique forbidden markers for provider body, access token, webhook secret, signature, payer email, QR content, and database URL. Serialize returned summary and capture `console.log`/`console.error`; assert no marker occurs in summary, log arguments, or thrown error text. Restore spies in `finally`. Do not add production logging.

- [ ] **Step 3: Run focused tests and verify RED**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1`.

Expected: isolation matrix fails on current vacuous assertions. Sanitization test must fail only if existing behavior leaks a forbidden marker.

- [ ] **Step 4: Implement only test/fixture corrections**

Strengthen fixtures and assertions until every selected stage is observable and unrelated stages are provably untouched. Do not alter reconciliation behavior in this task. If a test reveals production behavior violation, stop and report blocker; do not weaken assertion.

- [ ] **Step 5: Run focused and API tests**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1` and `pnpm --filter @delivery/api test`.

Expected: all stage cases pass with exact counters, provider-call assertions, unchanged sentinels, and sanitized output.

- [ ] **Step 6: Review and commit Task 20**

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

- [ ] **Step 1: Strengthen account-mismatch test**

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

- [ ] **Step 2: Run focused test and verify RED**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts --no-file-parallelism --maxWorkers=1`.

Expected: failure because snapshots currently call `provider.getAccountId()` and pass account into `refreshPendingSnapshot`.

- [ ] **Step 3: Remove duplicate account validation**

In `reconciliation.service.ts`:

1. Delete `persistMismatch`.
2. Change `refreshPendingSnapshot` signature to `(db, provider, paymentId, now)`.
3. Delete manual `snapshot.accountId !== account` branch.
4. Keep `await applyProviderSnapshot(db, payment.id, snapshot, now)` as sole snapshot transition call.
5. Delete `const account = await provider.getAccountId()` from snapshots stage and call `refreshPendingSnapshot(db, provider, row.id, now)`.

Do not change retry handling, claim predicates, limits, or summary semantics.

- [ ] **Step 4: Run focused and API tests**

Run `pnpm --filter @delivery/api exec vitest run test/payment-reconciliation.test.ts test/payment-operation.service.test.ts test/webhooks.routes.test.ts --no-file-parallelism --maxWorkers=1` and `pnpm --filter @delivery/api test`.

Expected: account mismatch persists through `validateSnapshot`; retry, operation, webhook, and reconciliation tests pass.

- [ ] **Step 5: Run final repository gate**

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

- [ ] **Step 6: Review and commit Task 21**

Run `git diff --check`, inspect production/test diff, then execute:

```bash
git add apps/api/src/payments/reconciliation.service.ts apps/api/test/payment-reconciliation.test.ts
git commit -m "fix(payments): use standard snapshot validation"
```

After Task 21, use `superpowers:requesting-code-review` and `superpowers:finishing-a-development-branch`. Do not merge or deploy without explicit user selection.

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

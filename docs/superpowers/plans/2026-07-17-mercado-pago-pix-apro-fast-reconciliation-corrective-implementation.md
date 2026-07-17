# Mercado Pago PIX APRO Fast Reconciliation Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute inline; do not dispatch subagents unless the user explicitly changes the current no-subagent preference. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the official Mercado Pago PIX `APRO` sandbox fixture reach the store promptly during local testing without fabricating approval, increasing production polling, or weakening financial validation.

**Architecture:** Keep the provider response authoritative: the initial `action_required/waiting_transfer` response continues exposing the PIX QR and keeping the order in `AWAITING_PAYMENT`. When and only when the runtime is `APP_ENV=local`, `MP_LIVE_MODE=false`, and `MP_TEST_PIX_SCENARIO=APRO`, the existing reconciler may refresh recent identified pending PIX payments every 10 seconds for at most 60 seconds; after that window it returns to the existing five-minute fallback. The same locked snapshot transition remains solely responsible for validating the provider identity and releasing the order exactly once.

**Tech Stack:** TypeScript 6, Hono 4, Vitest 4, Drizzle ORM, PostgreSQL 17, Cloudflare Workers scheduled handlers, Mercado Pago Orders API.

## Global Constraints

- Do not remove the initial QR, countdown, or `AWAITING_PAYMENT` state: the official `APRO` fixture initially returns `action_required/waiting_transfer` and approves asynchronously.
- Never infer approval from `MP_TEST_PIX_SCENARIO`; only an authoritative Mercado Pago `GET /v1/orders/{id}` snapshot may produce local `APPROVED` and release the order.
- Fast refresh is enabled only for the exact triple `APP_ENV=local`, `MP_LIVE_MODE=false`, and trimmed `MP_TEST_PIX_SCENARIO=APRO`.
- Staging, production, live mode, normal pending PIX, cards, expired payments, review rows, create recovery, webhook processing, cancellation, and refunds retain their existing schedules and behavior.
- Fast refresh targets only identified `PIX` payments with `status=PENDING` and `provider_order_id IS NOT NULL`.
- Fast refresh requires `reconciliation_state=PENDING` and no recorded reconciliation failure; rate limits, provider errors, review states, and retry-after schedules must never be bypassed.
- Fast refresh interval is exactly 10 seconds and its window is exactly 60 seconds from local payment creation. Successful pending reads inside the window must update the claim timestamp so overlapping cron executions and subsequent ticks cannot poll faster than the interval.
- After the 60-second window, unresolved PIX returns to the existing `next_reconcile_at` five-minute fallback; do not poll indefinitely.
- Concurrent cron executions must claim a payment once per eligible interval and must create at most one `pagamento confirmado` event.
- Cancellation during the approval race remains unchanged: a later authoritative approval creates exactly one canonical `REFUND_FULL`; a never-approved PIX settles as not charged.
- Do not add a migration, table, column, queue, Durable Object, sleep inside a request, frontend provider call, or local fake approval.
- Do not read, print, log, commit, or copy access tokens, webhook secrets, payer emails, PIX payloads, provider response bodies, full provider identifiers, database URLs, passwords, or card tokens.
- Do not reset a database, create a real sandbox Order, configure a webhook/tunnel, deploy, push, or mutate staging/production while implementing this plan.
- Preserve the current user-owned changes in `apps/web/.env.development` and `apps/driver/.env.development`.
- Work in an isolated worktree, review the complete diff, run focused tests, then the full gate, and commit before offering local merge.
- Official reference: `https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix`.
- Official status reference: `https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/order-status`.

---

### Task 1: Add bounded local-only PIX APRO snapshot refresh

**Files:**
- Modify: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`
- Modify: `apps/api/test/cron.test.ts`
- Modify: `docs/security/runbooks/mercado-pago-orders.md`

**Interfaces:**
- Consumes: persisted `payments.createdAt`, `payments.updatedAt`, `payments.nextReconcileAt`, `payments.providerOrderId`, `payments.method`, `payments.status`, and the existing atomic `applyProviderSnapshot` transition.
- Produces: `ReconciliationOptions.eagerPendingPix?: boolean`.
- Produces: `shouldEagerlyRefreshPendingPix(env): boolean`, a pure exact-environment predicate used by the scheduled handler.
- Keeps: `runPaymentReconciliation(db, provider, now, context, options): Promise<ReconciliationSummary>` and all existing summary fields unchanged.

- [ ] **Step 1: Create the isolated implementation worktree**

From the repository root, use `superpowers:using-git-worktrees` and create:

```bash
git worktree add .worktrees/mp-pix-apro-fast-reconciliation -b feat/mp-pix-apro-fast-reconciliation
cd .worktrees/mp-pix-apro-fast-reconciliation
pnpm install --frozen-lockfile
```

Expected: the worktree is on `feat/mp-pix-apro-fast-reconciliation`; the main worktree's ignored env files and user-owned `.env.development` edits are not copied, staged, or modified.

- [ ] **Step 2: Add failing environment-boundary tests**

In `apps/api/test/cron.test.ts`, import the pure predicate from `../src/index` alongside the default Worker export:

```ts
import worker, { shouldEagerlyRefreshPendingPix } from '../src/index'
```

Add this test without calling the provider:

```ts
describe('local PIX APRO reconciliation configuration', () => {
  it('enables eager refresh only for exact local sandbox APRO', () => {
    expect(shouldEagerlyRefreshPendingPix(cronEnv({
      APP_ENV: 'local',
      MP_LIVE_MODE: 'false',
      MP_TEST_PIX_SCENARIO: 'APRO',
    }))).toBe(true)

    expect(shouldEagerlyRefreshPendingPix(cronEnv({
      APP_ENV: 'local',
      MP_LIVE_MODE: 'false',
    }))).toBe(false)
    expect(shouldEagerlyRefreshPendingPix(cronEnv({
      APP_ENV: 'staging',
      MP_LIVE_MODE: 'false',
      MP_TEST_PIX_SCENARIO: 'APRO',
    }))).toBe(false)
    expect(shouldEagerlyRefreshPendingPix(cronEnv({
      APP_ENV: 'local',
      MP_LIVE_MODE: 'true',
      MP_TEST_PIX_SCENARIO: 'APRO',
    }))).toBe(false)
  })
})
```

This test fixes the boundary in one place. Do not inspect token contents or perform provider I/O.

- [ ] **Step 3: Add failing reconciliation tests for prompt authoritative approval**

In `apps/api/test/payment-reconciliation.test.ts`, extend the Drizzle import with `and` only if required by the final assertions; continue using the existing `pendingPayment`, `snapshot`, `provider`, `context`, and `only` helpers.

Add a test proving a future normal deadline does not block the local APRO fast path:

```ts
it('eagerly refreshes a recent identified pending PIX and releases it once', async () => {
  const createdAt = new Date('2026-07-17T12:00:00.000Z')
  const now = new Date(createdAt.getTime() + 10_000)
  const payment = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  await testDb.update(payments).set({
    createdAt,
    updatedAt: createdAt,
    lastReconciledAt: createdAt,
    nextReconcileAt: new Date(createdAt.getTime() + 5 * 60_000),
  }).where(eq(payments.id, payment.id))

  const approved = snapshot(payment, {
    orderStatus: 'processed',
    orderStatusDetail: 'accredited',
    transactionStatus: 'processed',
    transactionStatusDetail: 'accredited',
    pix: null,
  })
  const getOrder = vi.fn(async () => approved)
  const options = { ...only('snapshots'), eagerPendingPix: true }

  const first = await runPaymentReconciliation(
    testDb,
    provider({ getOrder }, payment),
    now,
    context,
    options,
  )
  const second = await runPaymentReconciliation(
    testDb,
    provider({ getOrder }, payment),
    new Date(now.getTime() + 10_000),
    context,
    options,
  )

  expect(first.snapshotsRefreshed).toBe(1)
  expect(second.snapshotsRefreshed).toBe(0)
  expect(getOrder).toHaveBeenCalledTimes(1)
  expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]).toMatchObject({
    status: 'APPROVED',
    reconciliationState: 'HEALTHY',
    reconciliationFailure: null,
  })
  expect((await testDb.select().from(orders).where(eq(orders.id, payment.orderId)))[0]?.status).toBe('PENDING')
  const events = await testDb.select().from(orderEvents).where(eq(orderEvents.orderId, payment.orderId))
  expect(events.filter((event) => event.note === 'pagamento confirmado')).toHaveLength(1)
})
```

Add `orderEvents` to the existing schema import in this test file.

- [ ] **Step 4: Add failing tests for interval, window, method, and normal-mode isolation**

Add a helper local to the test file:

```ts
async function configureFastRefreshCandidate(paymentId: string, createdAt: Date, updatedAt: Date) {
  await testDb.update(payments).set({
    createdAt,
    updatedAt,
    lastReconciledAt: updatedAt,
    nextReconcileAt: new Date(createdAt.getTime() + 5 * 60_000),
  }).where(eq(payments.id, paymentId))
}
```

Add the isolation matrix:

```ts
it('does not eagerly refresh before 10 seconds, after 60 seconds, or for CARD', async () => {
  const createdAt = new Date('2026-07-17T12:00:00.000Z')
  const now = new Date(createdAt.getTime() + 10_000)

  const tooSoon = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  await configureFastRefreshCandidate(tooSoon.id, createdAt, new Date(now.getTime() - 5_000))

  const tooOld = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  await configureFastRefreshCandidate(tooOld.id, new Date(now.getTime() - 61_000), new Date(now.getTime() - 11_000))

  const card = await pendingPayment(null, 'CARD', 'AWAITING_PAYMENT')
  await configureFastRefreshCandidate(card.id, createdAt, createdAt)

  const getOrder = vi.fn()
  const fake = provider({ getOrder })

  await runPaymentReconciliation(testDb, fake, now, context, {
    ...only('snapshots'),
    eagerPendingPix: true,
    limits: { ...only('snapshots').limits, snapshots: 10 },
  })

  expect(getOrder).not.toHaveBeenCalled()
})

it('keeps a recent PIX on the normal five-minute schedule without the eager option', async () => {
  const createdAt = new Date('2026-07-17T12:00:00.000Z')
  const now = new Date(createdAt.getTime() + 20_000)
  const payment = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  await configureFastRefreshCandidate(payment.id, createdAt, createdAt)
  const getOrder = vi.fn()

  await runPaymentReconciliation(testDb, provider({ getOrder }), now, context, {
    ...only('snapshots'),
    eagerPendingPix: false,
  })

  expect(getOrder).not.toHaveBeenCalled()
})
```

Keep every candidate's `nextReconcileAt` in the future. Separate the normal-mode case from the eager environment because `MP_TEST_PIX_SCENARIO` is a process-wide setting: mixing one "normal" recent PIX into an eager run would be an invalid test fixture.

Add a batch-starvation regression proving a recent review row cannot consume the snapshot limit ahead of an actionable row:

```ts
it('does not let an eager review row consume the bounded snapshot batch', async () => {
  const createdAt = new Date('2026-07-17T12:00:00.000Z')
  const now = new Date(createdAt.getTime() + 10_000)
  const reviewed = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  const actionable = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  await configureFastRefreshCandidate(reviewed.id, createdAt, createdAt)
  await configureFastRefreshCandidate(actionable.id, createdAt, createdAt)
  await testDb.update(payments).set({
    reconciliationState: 'REVIEW_REQUIRED',
    reconciliationFailure: 'MISMATCH_ACCOUNT',
    nextReconcileAt: null,
  }).where(eq(payments.id, reviewed.id))
  const getOrder = vi.fn(async () => snapshot(actionable))

  const summary = await runPaymentReconciliation(
    testDb,
    provider({ getOrder }, actionable),
    now,
    context,
    { ...only('snapshots'), eagerPendingPix: true },
  )

  expect(summary.snapshotsRefreshed).toBe(1)
  expect(getOrder).toHaveBeenCalledWith(actionable.providerOrderId)
})
```

- [ ] **Step 5: Add a failing bounded-window test**

Add a test where the provider remains `action_required/waiting_transfer`:

```ts
it('polls a local APRO PIX at most once per interval and stops the eager path after 60 seconds', async () => {
  const createdAt = new Date('2026-07-17T12:00:00.000Z')
  const payment = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  await configureFastRefreshCandidate(payment.id, createdAt, createdAt)
  const pending = snapshot(payment, {
    orderStatus: 'action_required',
    orderStatusDetail: 'waiting_transfer',
    transactionStatus: 'action_required',
    transactionStatusDetail: 'waiting_transfer',
    pix: {
      qrCode: 'sanitized-test-marker',
      qrCodeBase64: null,
      ticketUrl: null,
      expiresAt: new Date(createdAt.getTime() + 30 * 60_000),
    },
  })
  const getOrder = vi.fn(async () => pending)
  const options = { ...only('snapshots'), eagerPendingPix: true }

  for (const seconds of [10, 20, 30, 40, 50, 60]) {
    await runPaymentReconciliation(
      testDb,
      provider({ getOrder }, payment),
      new Date(createdAt.getTime() + seconds * 1_000),
      context,
      options,
    )
  }
  await runPaymentReconciliation(
    testDb,
    provider({ getOrder }, payment),
    new Date(createdAt.getTime() + 70_000),
    context,
    options,
  )

  expect(getOrder).toHaveBeenCalledTimes(6)
  expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]).toMatchObject({
    status: 'PENDING',
    reconciliationState: 'HEALTHY',
    reconciliationAttemptCount: 0,
  })
})
```

The test marker must remain only inside test data and must never be logged. The seventh run at 70 seconds must not call the provider because the eager window has closed and the normal five-minute deadline is still in the future.

- [ ] **Step 6: Add a failing overlapping-cron claim test**

Add a concurrency regression test:

```ts
it('claims one eager PIX refresh once across overlapping reconcilers', async () => {
  const createdAt = new Date('2026-07-17T12:00:00.000Z')
  const now = new Date(createdAt.getTime() + 10_000)
  const payment = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  await configureFastRefreshCandidate(payment.id, createdAt, createdAt)
  const getOrder = vi.fn(async () => snapshot(payment, {
    orderStatus: 'action_required',
    orderStatusDetail: 'waiting_transfer',
    transactionStatus: 'action_required',
    transactionStatusDetail: 'waiting_transfer',
    pix: {
      qrCode: 'sanitized-test-marker',
      qrCodeBase64: null,
      ticketUrl: null,
      expiresAt: new Date(createdAt.getTime() + 30 * 60_000),
    },
  }))
  const fake = provider({ getOrder }, payment)
  const options = { ...only('snapshots'), eagerPendingPix: true }

  const [first, second] = await Promise.all([
    runPaymentReconciliation(testDb, fake, now, context, options),
    runPaymentReconciliation(testDb, fake, now, context, options),
  ])

  expect(first.snapshotsRefreshed + second.snapshotsRefreshed).toBe(1)
  expect(getOrder).toHaveBeenCalledTimes(1)
})
```

This must fail before implementation if the eager selector is absent, and must also detect an unsafe implementation that selects eagerly but does not atomically move `updatedAt` during claim.

Add a retry-schedule regression:

```ts
it('does not let eager polling bypass a provider failure backoff', async () => {
  const createdAt = new Date('2026-07-17T12:00:00.000Z')
  const firstNow = new Date(createdAt.getTime() + 10_000)
  const payment = await pendingPayment(null, 'PIX', 'AWAITING_PAYMENT')
  await configureFastRefreshCandidate(payment.id, createdAt, createdAt)
  const getOrder = vi.fn(async () => {
    throw new PaymentProviderError('RATE_LIMITED', 429, 120)
  })
  const fake = provider({ getOrder }, payment)
  const options = { ...only('snapshots'), eagerPendingPix: true }

  await runPaymentReconciliation(testDb, fake, firstNow, context, options)
  await runPaymentReconciliation(
    testDb,
    fake,
    new Date(firstNow.getTime() + 10_000),
    context,
    options,
  )

  expect(getOrder).toHaveBeenCalledTimes(1)
  expect((await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]).toMatchObject({
    reconciliationState: 'PENDING',
    reconciliationFailure: 'RATE_LIMITED',
    reconciliationAttemptCount: 1,
  })
})
```

- [ ] **Step 7: Run focused tests and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/delivery_test \
pnpm --filter @delivery/api exec vitest run \
  test/payment-reconciliation.test.ts \
  test/cron.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: compilation/tests fail because `shouldEagerlyRefreshPendingPix` and `ReconciliationOptions.eagerPendingPix` do not exist, or because future `nextReconcileAt` rows are not selected. Existing tests must remain green up to the new assertions.

- [ ] **Step 8: Implement the exact local environment predicate and scheduled wiring**

In `apps/api/src/index.ts`, export:

```ts
export function shouldEagerlyRefreshPendingPix(env: Env): boolean {
  return env.APP_ENV === 'local'
    && env.MP_LIVE_MODE === 'false'
    && env.MP_TEST_PIX_SCENARIO?.trim() === 'APRO'
}
```

Pass it only as reconciler scheduling policy:

```ts
const reconciliation = await runPaymentReconciliation(db, provider, now, {
  resolvePayerEmail: (email, userId) => resolvePayerEmail(env, email, userId),
}, {
  eagerPendingPix: shouldEagerlyRefreshPendingPix(env),
})
```

Do not pass this flag to snapshot validation and do not use it to choose a local payment status. If provider creation is disabled because configuration is invalid, the existing `if (provider)` boundary continues preventing reconciliation.

- [ ] **Step 9: Implement the bounded eager selector and atomic claim**

In `apps/api/src/payments/reconciliation.service.ts`, import `gte` from `drizzle-orm` and add fixed private constants:

```ts
const LOCAL_APRO_PIX_REFRESH_INTERVAL_MS = 10_000
const LOCAL_APRO_PIX_REFRESH_WINDOW_MS = 60_000
```

Extend options:

```ts
export type ReconciliationOptions = {
  limits?: Partial<Record<BoundedStage, number>>
  stages?: readonly ReconciliationStage[]
  eagerPendingPix?: boolean
}
```

Keep `duePayment(now)` unchanged for creates, reviews, and every existing caller. Add a snapshot-only predicate:

```ts
function snapshotDue(now: Date, eagerPendingPix: boolean) {
  const normallyDue = duePayment(now)
  if (!eagerPendingPix) return normallyDue

  return or(
    normallyDue,
    and(
      eq(payments.method, 'PIX'),
      eq(payments.reconciliationState, 'PENDING'),
      isNull(payments.reconciliationFailure),
      gte(payments.createdAt, new Date(now.getTime() - LOCAL_APRO_PIX_REFRESH_WINDOW_MS)),
      lte(payments.updatedAt, new Date(now.getTime() - LOCAL_APRO_PIX_REFRESH_INTERVAL_MS)),
    ),
  )
}
```

Change `claimPayment` so snapshot claims can use the same predicate atomically while all other stages remain normal:

```ts
async function claimPayment(
  db: Db,
  paymentId: string,
  now: Date,
  state: 'PENDING' | 'REVIEW_REQUIRED',
  eagerPendingPix = false,
) {
  const eligibility = state === 'PENDING'
    ? snapshotDue(now, eagerPendingPix)
    : duePayment(now)
  const [claimed] = await db.update(payments).set({
    reconciliationAttemptCount: sql`${payments.reconciliationAttemptCount} + 1`,
    nextReconcileAt: new Date(now.getTime() + 5 * 60_000),
    updatedAt: now,
  }).where(and(
    eq(payments.id, paymentId),
    eq(payments.reconciliationState, state),
    eligibility,
  )).returning()
  return claimed
}
```

Pass the option only through snapshot refresh:

```ts
async function refreshPendingSnapshot(
  db: Db,
  provider: PaymentProvider,
  paymentId: string,
  now: Date,
  eagerPendingPix: boolean,
): Promise<'REFRESHED' | 'FAILED'> {
  const payment = await claimPayment(db, paymentId, now, 'PENDING', eagerPendingPix)
  if (!payment) return 'FAILED'
  try {
    const snapshot = await provider.getOrder(payment.providerOrderId!)
    await applyProviderSnapshot(db, payment.id, snapshot, now)
    return 'REFRESHED'
  } catch (error) {
    await retryPayment(db, payment.id, payment.reconciliationAttemptCount, now, error, 'PENDING')
    throw error
  }
}
```

Update the snapshot-stage selector and call:

```ts
const eagerPendingPix = options.eagerPendingPix === true
const pending = await db.select({ id: payments.id }).from(payments).where(and(
  eq(payments.status, 'PENDING'),
  eq(payments.reconciliationState, 'PENDING'),
  isNotNull(payments.providerOrderId),
  snapshotDue(now, eagerPendingPix),
)).orderBy(asc(payments.nextReconcileAt), asc(payments.createdAt)).limit(capBy('snapshots'))

for (const row of pending) {
  try {
    if (await refreshPendingSnapshot(db, provider, row.id, now, eagerPendingPix) === 'REFRESHED') {
      summary.snapshotsRefreshed++
    }
  } catch {
    summary.stageFailures++
  }
}
```

Why `updatedAt` is part of the predicate: the existing atomic claim writes `updatedAt=now`, so a concurrent reconciler immediately stops matching the ten-second cutoff. Do not replace this with an unlocked pre-read or a process-local timer.

- [ ] **Step 10: Run focused tests and verify GREEN**

Run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/delivery_test \
pnpm --filter @delivery/api exec vitest run \
  test/payment-reconciliation.test.ts \
  test/cron.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: all focused tests pass; eager polling is limited to recent identified pending PIX, exact local APRO configuration, ten-second spacing, and the sixty-second window.

- [ ] **Step 11: Run payment non-regression suites**

Run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/delivery_test \
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment-reconciliation.test.ts \
  test/payment-operation.service.test.ts \
  test/payment.service.test.ts \
  test/orders.routes.test.ts \
  test/webhooks.routes.test.ts \
  test/cron.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: all pass. In particular:

- official `payer.first_name=APRO` fixture remains exact;
- initial PIX `action_required` still returns QR/copy code;
- normal PIX remains pending;
- CARD selection and retry are unchanged;
- webhook approval and cron approval converge once;
- cancel-before-approval still cancels externally when possible;
- approval concurrent with cancellation still creates exactly one full refund;
- no raw provider data appears in logs or errors.

- [ ] **Step 12: Update the runbook with the accurate local contract**

In `docs/security/runbooks/mercado-pago-orders.md`, replace the ambiguous implication of immediate approval under `## Cenários PIX locais` with:

```markdown
- `MP_TEST_PIX_SCENARIO=APRO` usa a fixture oficial de aprovação automática do Mercado Pago.
- A resposta inicial oficial continua sendo `action_required/waiting_transfer`, com QR/copia-e-cola; mostrar QR e prazo nesse instante é correto.
- Em local sandbox APRO, o cron faz GET autoritativo a cada 10 segundos por no máximo 60 segundos. Ao observar `processed/accredited`, libera o pedido uma vez para a loja.
- Se a aprovação não chegar nessa janela, a reconciliação volta ao fallback normal de cinco minutos; nunca simula aprovação.
- Cancelar antes da observação local consulta o provider: PIX já aprovado converge para um único estorno integral; PIX nunca aprovado converge para nenhuma cobrança concluída.
```

Keep the existing warning to restart `pnpm dev:api` after changing the ignored `.dev.vars`. Do not document credentials, emails, QR values, provider identifiers, or webhook secrets.

- [ ] **Step 13: Run the full repository gate**

Use `superpowers:verification-before-completion`, then run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/delivery_test pnpm typecheck
pnpm lint
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/delivery_test pnpm test
pnpm build
git diff --check
git status --short
```

Expected: all commands pass. Status contains only the five intended tracked files from this task; ignored secrets and environment files remain absent.

- [ ] **Step 14: Review the complete implementation against the failure evidence**

Use `superpowers:requesting-code-review` inline, without dispatching subagents. Review `main...HEAD` and manually trace:

1. initial official APRO response remains QR-bearing and pending;
2. direct create and recovered create both become eligible after ten seconds because selection depends on persisted payment state, not the checkout response path;
3. `updatedAt` changes atomically during claim, preventing overlapping cron duplication;
4. pending authoritative reads remain `PENDING/HEALTHY` and do not consume the failure retry budget;
5. provider failures, retry-after, and `REVIEW_REQUIRED` rows cannot enter or starve the eager batch;
6. `processed/accredited` passes existing snapshot invariants before releasing the order;
7. release creates one `pagamento confirmado` event;
8. the fast path stops after sixty seconds and the five-minute fallback remains scheduled;
9. normal PIX, cards, staging, production, and live mode never use the fast selector;
10. cancellation racing approval still settles as one refund or no charge, never both;
11. logs and summaries expose counts only.

Stop and correct any verified finding before committing.

- [ ] **Step 15: Commit the corrective implementation**

```bash
git add \
  apps/api/src/payments/reconciliation.service.ts \
  apps/api/src/index.ts \
  apps/api/test/payment-reconciliation.test.ts \
  apps/api/test/cron.test.ts \
  docs/security/runbooks/mercado-pago-orders.md
git commit -m "fix(payments): promptly reconcile sandbox PIX"
```

Expected: one focused commit; no env, credentials, generated provider data, or unrelated user files are staged.

- [ ] **Step 16: Prepare the manual sandbox validation handoff**

Do not perform external calls automatically. After user-authorized local merge, instruct the user to:

1. set `MP_TEST_PIX_SCENARIO=APRO` in ignored `apps/api/.dev.vars`;
2. confirm `APP_ENV=local` and `MP_LIVE_MODE=false` without exposing credential values;
3. restart `pnpm dev:api` and keep `pnpm dev:cron` running;
4. create one fresh PIX order and observe the expected initial QR/countdown;
5. do not cancel it during the first 70 seconds;
6. confirm a cron tick reports one sanitized snapshot refresh after the provider approves;
7. confirm the customer order becomes `PENDING` and appears once for the store;
8. repeat with cancellation during the race and confirm exactly one of `NOT_CHARGED` or `REFUNDED`, based on the authoritative provider state;
9. restore `MP_TEST_PIX_SCENARIO=` for normal pending/expiration tests.

## Completion Boundary

Completion means local sandbox `APRO` retains the official initial QR flow, observes asynchronous approval through bounded authoritative GETs within a short test window, releases the order exactly once, and preserves the existing safe cancellation/refund race. It does not change production polling frequency, require webhook ingress, fake provider state, configure external resources, deploy, or authorize live payments.

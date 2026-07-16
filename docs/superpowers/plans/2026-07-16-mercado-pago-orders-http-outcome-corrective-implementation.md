# Mercado Pago Orders HTTP Outcome Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan step-by-step. This plan intentionally contains one task with internal RED/GREEN checkpoints. Execute inline; do not dispatch subagents unless the user explicitly changes the current no-subagent preference.

**Goal:** Make declined Mercado Pago Orders card payments, idempotency conflicts, temporary locks, rate limits, uncertain creates, cancellations, and refunds resolve through safe authoritative provider reads instead of collapsing into generic `503` failures.

**Architecture:** Keep the existing Orders-only adapter, PostgreSQL financial source of truth, snapshot validator, operation queue, and reconciliation stages. Add semantic HTTP outcomes at the provider boundary; recover create outcomes through bounded exact-reference search plus `GET`; make every cancel/refund result authoritative through `GET Order`; broaden documented state normalization; and reuse the existing retry budget with bounded `Retry-After` handling. No schema change is planned.

**Tech Stack:** TypeScript 6, Hono 4, Vitest 4, PostgreSQL 17, Drizzle ORM, Mercado Pago Orders API, Cloudflare Workers.

**Approved Design:** [Mercado Pago Orders HTTP Outcome Corrective Design](../specs/2026-07-16-mercado-pago-orders-http-outcome-corrective-design.md)

## Global Constraints

- Execute as one task and produce one implementation commit after all RED/GREEN checkpoints and the final gate pass.
- Use `superpowers:using-git-worktrees` before implementation. Create branch `fix/mercado-pago-orders-http-outcomes` in an isolated worktree from the plan commit.
- Work inline without subagents.
- Use `apply_patch` for source, test, and documentation edits.
- Do not read, print, copy, stage, or modify `.env`, `.dev.vars`, `.demo-accounts.md`, or either frontend `.env.development` file.
- The existing local modifications to `apps/web/.env.development` and `apps/driver/.env.development` belong to the user and must remain untouched and uncommitted.
- Do not reset a database, configure the Mercado Pago dashboard, replace credentials/webhook secrets, run a sandbox payment, deploy, push, or modify staging/production.
- Do not add a migration or modify schema unless an unexpected need is proven and separately approved by the user.
- Do not reintroduce `/v1/payments`, a Payments API fallback, or dual integration paths.
- Provider calls remain outside database transactions.
- Never persist or replay card tokens.
- Never log raw Mercado Pago request/response bodies, payer email, card data/token, PIX QR data, access token, webhook secret/signature, provider identifiers in full, or database URLs.
- Preserve the existing public generic provider-outage response. Only a confirmed declined payment returns the existing `402 PAYMENT_REJECTED` application result.
- Treat unknown, contradictory, chargeback, identity, amount, currency, account, application, environment, or refund-target states as review-required.
- Keep the existing maximum of eight payment/reconciliation attempts and the existing six-hour maximum retry delay.

## File and Interface Map

### Production files

- Modify `apps/api/src/payments/provider.ts`
  - add semantic provider failure kinds for create recovery, mutation readback, and resource lock;
  - retain sanitized `httpStatus` and bounded `retryAfterSeconds`.
- Modify `apps/api/src/payments/mercadopago.ts`
  - classify responses by endpoint intent;
  - parse both documented `Retry-After` forms;
  - ignore heterogeneous mutation bodies;
  - perform authoritative `GET Order` after mutation acknowledgement/conflict/uncertainty.
- Modify `apps/api/src/payments/retry.ts`
  - cap provider retry hints at the existing six-hour maximum.
- Modify `apps/api/src/payments/snapshot-validation.ts`
  - accept documented pending/waiting aliases;
  - classify any fully validated `failed` Order/transaction as rejected regardless of evolving `status_detail`;
  - retain chargeback/capture/unknown fail-closed behavior.
- Modify `apps/api/src/payments/checkout.service.ts`
  - recover create `402`/`409` and uncertain outcomes immediately through search/get;
  - keep zero-result card creates pending during bounded reconciliation;
  - translate recovered rejection to `PAYMENT_REJECTED`.
- Modify `apps/api/src/payments/reconciliation.service.ts`
  - claim uncertain creates with the existing attempt counter before provider work;
  - enforce bounded create recovery and `RETRY_EXHAUSTED`.
- Modify `apps/api/src/payments/operation.service.ts`
  - recognize resource-lock and mutation-readback outcomes as retryable when authoritative readback is not yet possible.
- Modify `docs/security/runbooks/mercado-pago-orders.md`
  - document the response matrix and post-implementation manual smoke.

### Test files

- Modify `apps/api/test/mercadopago.test.ts`.
- Modify `apps/api/test/payment-retry.test.ts`.
- Modify `apps/api/test/payment-snapshot-validation.test.ts`.
- Modify `apps/api/test/payment.service.test.ts`.
- Modify `apps/api/test/orders.routes.test.ts`.
- Modify `apps/api/test/payment-reconciliation.test.ts`.
- Modify `apps/api/test/payment-operation.service.test.ts`.
- Run `apps/api/test/webhooks.routes.test.ts` unchanged as a boundary regression unless implementation legitimately changes a shared fake.

---

### Task 1: Correct the complete Orders HTTP outcome boundary

#### Step 1: Create the isolated implementation worktree and prove the baseline

From the repository root, inspect status without printing ignored files:

```bash
git status --short
git log -1 --oneline
```

Expected before isolation:

- the plan commit is `HEAD`;
- only the user's two frontend `.env.development` files may be modified;
- no payment source/test file is dirty.

Use `superpowers:using-git-worktrees` to create:

```text
branch: fix/mercado-pago-orders-http-outcomes
worktree: .worktrees/mercado-pago-orders-http-outcomes
```

In the new worktree, install without changing the lockfile and run the focused baseline:

```bash
pnpm install --frozen-lockfile
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment-retry.test.ts \
  test/payment-snapshot-validation.test.ts \
  test/payment.service.test.ts \
  test/orders.routes.test.ts \
  test/payment-reconciliation.test.ts \
  test/payment-operation.service.test.ts \
  test/webhooks.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
```

Expected: baseline passes. Stop and report if it fails before any source edit.

#### Step 2: Write RED adapter tests for the official HTTP outcome matrix

In `apps/api/test/mercadopago.test.ts`, add helpers that return sanitized provider responses without raw real-world identifiers:

```ts
function failedCardOrder(overrides: Record<string, unknown> = {}) {
  return snapshot({
    status: 'failed',
    status_detail: 'failed',
    transactions: {
      payments: [{
        id: 'transaction-rejected',
        status: 'failed',
        status_detail: 'rejected_by_issuer',
        amount: '64.00',
        payment_method: { id: 'master', type: 'credit_card' },
      }],
    },
    ...overrides,
  })
}

function calls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
}
```

Add table-driven request classification tests. The exact semantic names produced by `provider.ts` must be:

```ts
it.each([
  [402, 'CREATE_REQUIRES_RECOVERY'],
  [409, 'CREATE_REQUIRES_RECOVERY'],
  [423, 'RESOURCE_LOCKED'],
  [429, 'RATE_LIMITED'],
  [500, 'PROVIDER_UNAVAILABLE'],
] as const)('classifies create HTTP %s as %s', async (status, kind) => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ ignored: true }, status)))

  await expect(provider.createOrder({
    orderId: 'order-1',
    amountCents: 6400,
    payerEmail: 'payer@test.local',
    idempotencyKey: 'create-card-key',
    method: 'CARD',
    cardToken: 'ephemeral-test-token',
    cardPaymentMethodId: 'master',
    installments: 1,
  })).rejects.toMatchObject({ kind, httpStatus: status })
})
```

Keep separate assertions proving:

- create `400` remains `PROVIDER_RESPONSE_INVALID`;
- create `401`/`403` remains `CREDENTIAL_OR_CONFIG`;
- get `404` remains `ORDER_NOT_FOUND`;
- get/search `429` and `5xx` retain their retryable classifications;
- an unsupported non-2xx response never exposes the response body in `String(error)`.

Add `Retry-After` tests using a fixed clock:

```ts
it('parses Retry-After delta seconds and HTTP date without leaking headers', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'))
  // First response: Retry-After: 120
  // Second response: Retry-After: Thu, 16 Jul 2026 12:03:00 GMT
  // Expect retryAfterSeconds 120 and 180 respectively.
})

it.each(['invalid', '-1', '999999999'])('ignores unsafe Retry-After %j', async (value) => {
  // Expect retryAfterSeconds to be undefined.
})
```

Add mutation tests with sequential POST/GET responses:

```ts
it.each([
  ['cancelOrder', 'cancel'],
  ['refundOrder', 'refund'],
] as const)('%s ignores mutation body and returns authoritative GET snapshot', async (method, suffix) => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(response({ acknowledgement_only: true }, 200))
    .mockResolvedValueOnce(response(snapshot({ status: suffix === 'cancel' ? 'canceled' : 'refunded' }), 200))
  vi.stubGlobal('fetch', fetchMock)

  await provider[method]('order-1', `${suffix}-key`)

  expect(calls(fetchMock)).toHaveLength(2)
  expect(calls(fetchMock)[0]![0]).toBe(`https://api.mercadopago.com/v1/orders/order-1/${suffix}`)
  expect(calls(fetchMock)[1]![0]).toBe('https://api.mercadopago.com/v1/orders/order-1')
})
```

Also assert:

- mutation `409` followed by a valid `GET` returns the `GET` snapshot;
- mutation `423`, `429`, `5xx`, timeout, and network failure each attempt one authoritative `GET`;
- if that `GET` succeeds, the adapter returns its snapshot;
- if that `GET` fails, the original mutation error is rethrown so its HTTP status/retry hint is preserved;
- mutation `2xx` followed by `GET 404` becomes `MUTATION_REQUIRES_READ`, because an accepted mutation with temporarily unavailable readback is still uncertain;
- mutation `400` and `401` do not attempt a `GET`;
- partial refund uses the same authoritative readback;
- a malformed or partial mutation success body is never normalized as an Order.

Run RED:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected failures:

- create `402`/`409` currently become `PROVIDER_RESPONSE_INVALID`;
- `423` currently becomes `PROVIDER_RESPONSE_INVALID`;
- HTTP-date `Retry-After` is not parsed;
- mutation methods currently normalize the POST response and do not always call `GET`.

#### Step 3: Implement semantic HTTP classification and authoritative mutation readback

In `apps/api/src/payments/provider.ts`, extend `ProviderFailureKind` exactly with:

```ts
  | 'CREATE_REQUIRES_RECOVERY'
  | 'MUTATION_REQUIRES_READ'
  | 'RESOURCE_LOCKED'
```

Do not add provider body/error text to `PaymentProviderError`.

In `apps/api/src/payments/mercadopago.ts`, make request classification aware of intent:

```ts
type RequestIntent = 'READ' | 'CREATE' | 'MUTATION'
type ResponseMode = 'JSON' | 'IGNORE'

type RequestOptions = {
  intent?: RequestIntent
  responseMode?: ResponseMode
  idempotencyKey?: string
}
```

The classification order must be deterministic:

```ts
function failureKind(status: number, intent: RequestIntent): ProviderFailureKind {
  if (status === 401 || status === 403) return 'CREDENTIAL_OR_CONFIG'
  if (intent === 'CREATE' && (status === 402 || status === 409)) return 'CREATE_REQUIRES_RECOVERY'
  if (intent === 'MUTATION' && status === 409) return 'MUTATION_REQUIRES_READ'
  if (status === 423) return 'RESOURCE_LOCKED'
  if (status === 404) return 'ORDER_NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_RESPONSE_INVALID'
}
```

Parse `Retry-After` without returning or logging its raw value:

```ts
const MAX_RETRY_AFTER_SECONDS = 6 * 60 * 60

function retryAfterSeconds(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined
  const delta = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - nowMs) / 1000)
  return Number.isFinite(delta) && delta >= 0 && delta <= MAX_RETRY_AFTER_SECONDS
    ? delta
    : undefined
}
```

Required request behavior:

- `createOrder` uses intent `CREATE` and JSON mode;
- `getOrder`, search, and account preflight use intent `READ` and JSON mode;
- mutation POSTs use intent `MUTATION` and `IGNORE` mode;
- ignored mode does not call `response.text()` or parse mutation payloads;
- JSON mode continues rejecting empty or malformed required JSON.

Refactor `mutation()` so it:

1. validates the idempotency key before fetch;
2. posts the mutation and ignores the body;
3. on `2xx`, calls `getOrder(providerOrderId)`;
4. on `MUTATION_REQUIRES_READ`, `RESOURCE_LOCKED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, or `TRANSIENT_UNCERTAIN`, attempts `getOrder(providerOrderId)` once;
5. returns a successful readback snapshot;
6. rethrows the original mutation error if readback fails after an original `409`/uncertain mutation response, preserving its HTTP status and retry hint;
7. after a successful mutation POST, converts an unavailable/non-authoritative readback into `MUTATION_REQUIRES_READ` while preserving a sanitized retry hint; credential/configuration failure still remains credential/configuration failure;
8. does not read back after deterministic `400`, credential failure, or malformed local input.

Use a small helper so successful and exceptional POST paths share one rule:

```ts
async function authoritativeMutationRead(
  providerOrderId: string,
  original?: PaymentProviderError,
): Promise<ProviderOrderSnapshot> {
  try {
    return await this.getOrder(providerOrderId)
  } catch (readError) {
    if (original) throw original
    if (readError instanceof PaymentProviderError
      && readError.kind === 'CREDENTIAL_OR_CONFIG') throw readError
    throw new PaymentProviderError(
      'MUTATION_REQUIRES_READ',
      readError instanceof PaymentProviderError ? readError.httpStatus : undefined,
      readError instanceof PaymentProviderError ? readError.retryAfterSeconds : undefined,
    )
  }
}
```

In `apps/api/src/payments/retry.ts`, defend against any caller-provided excessive hint:

```ts
const retryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds !== undefined
  ? Math.min(MAX_DELAY_MS, Math.max(0, retryAfterSeconds) * 1000)
  : 0
```

Add to `apps/api/test/payment-retry.test.ts`:

```ts
it('caps excessive provider Retry-After at six hours', () => {
  expect(nextAttemptAt(now, 1, 0, 999_999).getTime() - now.getTime())
    .toBe(6 * 60 * 60_000)
})
```

Run GREEN for the boundary:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment-retry.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
git diff --check
```

Expected: all pass.

#### Step 4: Write RED tests for failed-state normalization

In `apps/api/test/payment-snapshot-validation.test.ts`, replace any rule that requires `cc_rejected*` for an Order already marked `failed`. Add a table using otherwise fully valid snapshots:

```ts
it.each([
  'bad_filled_card_data',
  'invalid_card_token',
  'high_risk',
  'rejected_by_issuer',
  'required_call_for_authorize',
  'max_attempts_exceeded',
  'card_disabled',
  'insufficient_amount',
  'card_insufficient_amount',
  'amount_limit_exceeded',
  'processing_error',
  'invalid_installments',
  '3ds_challenge_expired',
  'new_future_decline_detail',
])('maps validated failed transaction detail %s to REJECTED', (detail) => {
  expect(validateSnapshot({
    ...valid,
    orderStatus: 'failed',
    orderStatusDetail: 'failed',
    transactionStatus: 'failed',
    transactionStatusDetail: detail,
  }, expected)).toEqual({ kind: 'REJECTED' })
})
```

Add documented pending aliases:

```ts
it.each([
  ['created', 'created'],
  ['processing', 'in_process'],
  ['action_required', 'waiting_payment'],
  ['action_required', 'waiting_capture'],
  ['action_required', 'waiting_transfer'],
])('maps %s/%s to PENDING', (orderStatus, detail) => {
  expect(validateSnapshot({
    ...valid,
    orderStatus,
    orderStatusDetail: detail,
    transactionStatus: orderStatus,
    transactionStatusDetail: detail,
  }, expected)).toMatchObject({ kind: 'PENDING' })
})
```

Retain or add explicit fail-closed assertions for:

- chargeback;
- capture/challenge states that are not merely a failed detail;
- unknown top-level state;
- application/account/environment/reference/amount/currency/method mismatch;
- refund amount mismatch;
- approved payment non-regression in transition tests.

Run RED:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment-snapshot-validation.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: `rejected_by_issuer` and other non-legacy details currently produce `UNSUPPORTED_REJECTION`; waiting aliases may produce `UNSUPPORTED_PROVIDER_STATE`.

#### Step 5: Implement documented state normalization

In `apps/api/src/payments/snapshot-validation.ts`:

- normalize order status, transaction status, order detail, and transaction detail once;
- check chargeback and unsupported active capture/challenge top-level states before ordinary rejection;
- keep refund validation before generic terminal mapping;
- return `REJECTED` whenever the validated Order status or transaction status is `failed` or `rejected`;
- do not require a known decline detail;
- include documented waiting states/details in the pending mapping;
- keep unknown top-level states review-required.

The core precedence should read like:

```ts
if (hasChargeback) return review('UNSUPPORTED_CHARGEBACK')
if (hasUnsupportedActiveCaptureFlow) return review('UNSUPPORTED_CAPTURE')
if (isPartialRefund) return validatedPartialRefund(...)
if (isFullRefund) return validatedFullRefund(...)
if (orderStatus === 'failed' || orderStatus === 'rejected'
  || transactionStatus === 'failed' || transactionStatus === 'rejected') {
  return { kind: 'REJECTED' }
}
if (isCanceled) return { kind: 'CANCELLED' }
if (isExpired) return { kind: 'EXPIRED' }
if (isApproved) return { kind: 'APPROVED' }
if (isDocumentedPending) return { kind: 'PENDING', qrAvailable: snapshot.pix !== null }
return review('UNSUPPORTED_PROVIDER_STATE')
```

`hasUnsupportedActiveCaptureFlow` must inspect active provider states, not a decline detail attached to a `failed` transaction. Therefore `transactionStatus: 'failed'` plus `transactionStatusDetail: '3ds_challenge_expired'` maps to `REJECTED`, while an actual unsupported capture/challenge state remains review-required.

Do not store or log `status_detail`; it remains only the already-sanitized snapshot vocabulary.

Run GREEN:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment-snapshot-validation.test.ts \
  test/payment.service.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
git diff --check
```

Expected: all pass and existing transition safety remains green.

#### Step 6: Write RED service/route tests reproducing create HTTP recovery

In `apps/api/test/payment.service.test.ts`, add focused recovery tests using the existing disposable PostgreSQL helpers.

Create a CARD payment with no provider ID, then make the provider behave as follows:

1. `createOrder` throws `new PaymentProviderError('CREATE_REQUIRES_RECOVERY', 402)`;
2. `searchOrders` returns exactly one sanitized failed-card snapshot;
3. `getOrder` returns the same authoritative snapshot.

Assert:

```ts
await expect(createOnlinePayment(testDb, provider, {
  paymentId: payment.id,
  payerEmail: 'payer@test.local',
  card: { token: 'ephemeral-test-token', methodId: 'master' },
})).rejects.toMatchObject({ code: 'PAYMENT_REJECTED', status: 402 })

expect(provider.searchOrders).toHaveBeenCalledOnce()
expect(provider.getOrder).toHaveBeenCalledWith('provider-order-rejected')
expect(provider.createOrder).toHaveBeenCalledOnce()
```

Query payment/order and assert:

```ts
expect(storedPayment).toMatchObject({
  status: 'REJECTED',
  reconciliationState: 'HEALTHY',
  reconciliationFailure: null,
  providerOrderId: 'provider-order-rejected',
  providerTransactionId: 'provider-transaction-rejected',
})
expect(storedOrder.status).toBe('CANCELLED')
```

Add zero-result behavior:

- create throws `CREATE_REQUIRES_RECOVERY`;
- search returns `[]`;
- `createOnlinePayment` returns/throws `PAYMENT_UNCERTAIN` with HTTP `503`;
- CARD payment stays `PENDING`, provider IDs stay null, order stays `AWAITING_PAYMENT`;
- `reconciliationState` stays `PENDING`;
- `nextReconcileAt` is set;
- no second `createOrder` occurs and the card token is not retained by any fake/call after the initial invocation.

Add multiple-result behavior:

- two exact results produce `PAYMENT_REVIEW_REQUIRED`;
- payment becomes `REVIEW_REQUIRED/AMBIGUOUS_PROVIDER_CREATE`;
- no snapshot is applied.

Add create `409` behavior identical to `402` recovery and one test proving a retryable create error (`RESOURCE_LOCKED`, `RATE_LIMITED`, or `PROVIDER_UNAVAILABLE`) follows the same search-first path.

In `apps/api/test/orders.routes.test.ts`, add the real regression boundary. Do not fake a rejected snapshot directly from `createOrder`. Fake:

- `createOrder` throwing `CREATE_REQUIRES_RECOVERY` with `httpStatus: 402`;
- search returning one failed Order with `rejected_by_issuer`;
- get returning that Order.

Assert:

- route HTTP `402`;
- existing stable application error/message;
- payment `REJECTED/HEALTHY` with provider identifiers;
- order `CANCELLED`;
- sanitized diagnostic does not contain payer email, card token, provider body, QR marker, or secrets.

Run RED:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment.service.test.ts \
  test/orders.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: `createOnlinePayment` currently rethrows the provider error, and zero-result card recovery currently becomes `FRESH_CARD_REQUIRED` immediately.

#### Step 7: Implement immediate create recovery and bounded zero-result reconciliation

In `apps/api/src/payments/checkout.service.ts`, define reusable predicates instead of duplicating string arrays:

```ts
const CREATE_RECOVERY_KINDS = new Set<ProviderFailureKind>([
  'CREATE_REQUIRES_RECOVERY',
  'RESOURCE_LOCKED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TRANSIENT_UNCERTAIN',
])
```

Extend `recoverUncertainCreate` with an optional sanitized trigger so retry hints survive the initial create failure:

```ts
type CreateRecoveryOptions = {
  trigger?: PaymentProviderError
}
```

Only `kind`, `httpStatus`, and `retryAfterSeconds` may be consumed; never retain the Error instance or any provider body after the call. Immediate checkout passes the caught provider error. Scheduled reconciliation omits it and uses any new search/create error it observes.

Add a helper that reads the stored payment after recovery and maps it to the existing checkout result/error. It must:

- return PIX artifacts when present;
- return approved/pending when appropriate;
- throw `PAYMENT_REJECTED` for `REJECTED`, `CANCELLED`, or `EXPIRED`;
- throw `PAYMENT_REVIEW_REQUIRED` for review;
- throw `PAYMENT_UNCERTAIN` when no authoritative result exists.

In `createOnlinePayment`:

1. keep the first provider create call unchanged;
2. catch only the create-recovery kinds;
3. call `recoverUncertainCreate` immediately outside a database transaction with `{ trigger: error }`;
4. map `RECOVERED` from freshly persisted state;
5. map retry outcomes to `PAYMENT_UNCERTAIN` and preserve the original sanitized provider error;
6. map review to `PAYMENT_REVIEW_REQUIRED`;
7. leave deterministic configuration/provider-response failures on the existing generic route path.

Change the recovery result type to make CARD retry explicit:

```ts
type CreateRecoveryOutcome =
  | 'RECOVERED'
  | 'RETRY_PIX'
  | 'RETRY_CARD'
  | 'REVIEW_REQUIRED'
```

Remove the immediate `FRESH_CARD_REQUIRED` path. For zero CARD results:

- use `retryDisposition(now, payment.reconciliationAttemptCount, 0.1, options.trigger?.retryAfterSeconds)` for an immediate zero result, or the newly observed provider error's hint when search/retry itself fails;
- while attempts remain, persist `PENDING`, a sanitized failure such as `CREATE_NOT_VISIBLE`, and the calculated `nextReconcileAt`;
- return `RETRY_CARD`;
- at attempt exhaustion, persist `REVIEW_REQUIRED/RETRY_EXHAUSTED` and return `REVIEW_REQUIRED`.

For one exact search result, do not apply the search payload directly. Call:

```ts
const authoritative = await provider.getOrder(matches[0]!.providerOrderId)
```

Then pass only `authoritative` to `applyProviderSnapshotInTransaction`.

For zero PIX results, preserve the existing same-idempotency-key retry, but apply the same attempt budget. Never replay a CARD create or token.

In `apps/api/src/payments/reconciliation.service.ts`, claim each due uncertain create before network work using the existing `claimPayment` behavior:

```ts
const claimed = await claimPayment(db, row.id, now, 'PENDING')
if (!claimed || claimed.providerOrderId !== null) continue
const result = await recoverUncertainCreate(...)
```

This increments `reconciliationAttemptCount` and moves `nextReconcileAt` before provider I/O, preventing an immediately repeated due selection. Do not hold the transaction during search/get/create.

Update `apps/api/test/payment-reconciliation.test.ts` to prove:

- a zero-result CARD remains pending before attempt eight;
- each due run increments the attempt count once;
- no CARD `createOrder` call occurs;
- a later search/get result is applied;
- attempt eight becomes `REVIEW_REQUIRED/RETRY_EXHAUSTED`;
- a zero-result PIX still uses the same idempotency key and never exceeds the budget;
- multiple results still become `AMBIGUOUS_PROVIDER_CREATE` immediately.

Run GREEN:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment.service.test.ts \
  test/orders.routes.test.ts \
  test/payment-reconciliation.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
git diff --check
```

Expected: all pass.

#### Step 8: Write RED operation tests for authoritative cancel/refund settlement

The adapter now performs readback, but operation tests must prove queue behavior when readback is delayed or conflicted.

In `apps/api/test/payment-operation.service.test.ts`, add cases for each operation type:

```ts
it.each(['CANCEL', 'REFUND_FULL', 'REFUND_PARTIAL'] as const)(
  '%s retries when mutation requires readback but authoritative GET is unavailable',
  async (type) => {
    // Corresponding provider mutation throws MUTATION_REQUIRES_READ (409).
    // getOrder throws ORDER_NOT_FOUND or PROVIDER_UNAVAILABLE.
    // Expect operation PENDING, failureClass MUTATION_REQUIRES_READ,
    // nextAttemptAt set, lease cleared, no success result.
  },
)
```

Add tests proving:

- `RESOURCE_LOCKED` schedules retry;
- `RATE_LIMITED` preserves bounded retry timing;
- when a mutation conflict/readback returns an already-canceled Order, CANCEL succeeds idempotently;
- when it returns an approved Order, CANCEL follows the existing escalation-to-full-refund path;
- already-refunded full refund succeeds only at the exact expected amount;
- partial refund succeeds only at the cumulative expected target;
- a lower amount remains pending/retryable;
- a higher amount becomes `REVIEW_REQUIRED/MISMATCH_REFUNDED_TARGET`;
- deterministic `PROVIDER_RESPONSE_INVALID` remains review-required and is not retried.

Run RED:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment-operation.service.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: new semantic mutation/resource-lock failures are not yet recognized by `retryable()`.

#### Step 9: Complete operation retry classification and verify mutation safety

In `apps/api/src/payments/operation.service.ts`, extend only the retryable semantic set:

```ts
const OPERATION_RETRYABLE_KINDS = new Set<ProviderFailureKind>([
  'TRANSIENT_UNCERTAIN',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'RESOURCE_LOCKED',
  'MUTATION_REQUIRES_READ',
])
```

Keep the current sequence:

1. adapter mutation attempts its own immediate authoritative read;
2. if it still throws a retryable outcome, operation service attempts one readback;
3. a valid snapshot is settled through `settleSnapshot`;
4. unresolved outcome schedules retry with cleared lease;
5. attempt exhaustion becomes review;
6. deterministic provider errors become review without blind retry.

Do not weaken `evaluateOperation`, refund target checks, late-approval refund escalation, or snapshot validation.

Run GREEN:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment-operation.service.test.ts \
  test/payment-reconciliation.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
git diff --check
```

Expected: all pass.

#### Step 10: Strengthen diagnostics and run webhook non-regression

Review `apps/api/src/payments/provider-diagnostics.ts` and `apps/api/src/routes/orders.ts`. Modify only if the new semantic kinds are not already accepted generically.

Diagnostics may include:

```text
failureClass
upstreamStatus
paymentMethod
requestId
```

If recovery-decision logging is necessary, add only a fixed enum value and booleans for provider-ID presence. Do not add error messages, URLs, bodies, reference IDs, payer email, or token values.

Add/adjust `apps/api/test/payment-provider-diagnostics.test.ts` only if production diagnostics change. Assert all new failure kinds serialize as allowlisted fields and representative secret markers remain absent.

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment-provider-diagnostics.test.ts \
  test/orders.routes.test.ts \
  test/webhooks.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected:

- diagnostics pass;
- signed Order webhook tests remain unchanged and green;
- no webhook body is trusted as financial state;
- no webhook configuration is changed.

#### Step 11: Update the operational runbook

Update `docs/security/runbooks/mercado-pago-orders.md` without secrets or real identifiers.

Add a section `## HTTP outcome recovery` containing this sanitized matrix:

```markdown
| Outcome | Recovery |
| --- | --- |
| create 402/409 | exact-reference search, authoritative GET, then validate |
| create 423/429/5xx/network | search-first bounded reconciliation |
| mutation 2xx/409/uncertain | authoritative GET before settlement |
| deterministic 400/401/403 | configuration/review; no unchanged retry |
| unknown/contradictory snapshot | fail closed in REVIEW_REQUIRED |
```

Document:

- CARD tokens are never replayed;
- zero-result creates remain pending until bounded recovery exhausts;
- `Retry-After` is bounded to six hours;
- declined card acceptance is `REJECTED/HEALTHY`, provider IDs present, order `CANCELLED`;
- no raw provider body belongs in logs/evidence.

Add the post-merge manual sequence, but do not execute it in this task:

1. approved card;
2. `OTHE/rejected_by_issuer` declined card;
3. PIX QR creation;
4. signed webhook using the real sandbox Order ID;
5. cancellation;
6. full/partial refund where the sandbox account permits;
7. `apps/api/scripts/payment-work-status.sql` inspection;
8. sanitized log inspection.

Run:

```bash
git diff --check
```

#### Step 12: Review the entire one-task diff

Review only tracked changes:

```bash
git status --short
git diff --stat
git diff -- \
  apps/api/src/payments/provider.ts \
  apps/api/src/payments/mercadopago.ts \
  apps/api/src/payments/retry.ts \
  apps/api/src/payments/snapshot-validation.ts \
  apps/api/src/payments/checkout.service.ts \
  apps/api/src/payments/reconciliation.service.ts \
  apps/api/src/payments/operation.service.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/test/payment-retry.test.ts \
  apps/api/test/payment-snapshot-validation.test.ts \
  apps/api/test/payment.service.test.ts \
  apps/api/test/orders.routes.test.ts \
  apps/api/test/payment-reconciliation.test.ts \
  apps/api/test/payment-operation.service.test.ts \
  apps/api/test/payment-provider-diagnostics.test.ts \
  docs/security/runbooks/mercado-pago-orders.md
```

Review checklist:

- no schema/migration change;
- no environment file touched;
- no secret-shaped or real provider value added;
- no card token persisted or replayed;
- no provider call inside a database transaction;
- create `402`/`409` search then authoritative get;
- zero-result CARD remains bounded pending, not immediate review;
- mutation bodies ignored and authoritative get required;
- deterministic errors do not retry unchanged input;
- retry hints capped;
- failed state does not depend on a fixed detail allowlist;
- chargeback/unknown/mismatch still fail closed;
- approved/refunded non-regression remains intact;
- webhook behavior unchanged.

Use `superpowers:verification-before-completion` before making any completion claim.

#### Step 13: Run the final focused and repository-wide gates

Run the payment gate first:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment-retry.test.ts \
  test/payment-snapshot-validation.test.ts \
  test/payment-provider-diagnostics.test.ts \
  test/payment.service.test.ts \
  test/orders.routes.test.ts \
  test/payment-reconciliation.test.ts \
  test/payment-operation.service.test.ts \
  test/webhooks.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
```

Then run the repository gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
git status --short
```

Expected:

- every command exits `0`;
- only the intended payment source/tests/runbook files are modified;
- no `.env*`, `.dev.vars*`, demo-account, migration, schema, lockfile, generated secret, or unrelated file appears.

If any gate fails, fix the demonstrated issue, rerun its focused test, then rerun the complete gate. Do not commit a partial result.

#### Step 14: Commit the single task

Stage only reviewed files that actually changed:

```bash
git add \
  apps/api/src/payments/provider.ts \
  apps/api/src/payments/mercadopago.ts \
  apps/api/src/payments/retry.ts \
  apps/api/src/payments/snapshot-validation.ts \
  apps/api/src/payments/checkout.service.ts \
  apps/api/src/payments/reconciliation.service.ts \
  apps/api/src/payments/operation.service.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/test/payment-retry.test.ts \
  apps/api/test/payment-snapshot-validation.test.ts \
  apps/api/test/payment.service.test.ts \
  apps/api/test/orders.routes.test.ts \
  apps/api/test/payment-reconciliation.test.ts \
  apps/api/test/payment-operation.service.test.ts \
  apps/api/test/payment-provider-diagnostics.test.ts \
  docs/security/runbooks/mercado-pago-orders.md
git diff --cached --check
git diff --cached --stat
git commit -m "fix(payments): handle Orders API outcomes"
```

If an optional diagnostics file did not change, omit it from `git add` rather than creating a meaningless edit.

After commit:

```bash
git status --short
git log -1 --oneline
```

Expected: clean implementation worktree and one task commit.

Do not merge automatically. Report:

- commit ID;
- focused and full gate results;
- changed-file summary;
- confirmation that no schema/env/webhook configuration changed;
- remaining post-merge manual sandbox boundary.

## Post-Implementation Boundary

After code review and explicit user selection, use `superpowers:finishing-a-development-branch` to merge locally. Do not push.

Only after local merge should the operator repeat sandbox tests with local ignored credentials:

- approved card must remain `APPROVED/HEALTHY`;
- `OTHE` must become `REJECTED/HEALTHY`, not `503`;
- PIX must remain `PENDING/HEALTHY` with QR artifacts;
- webhook simulation must use the matching test application and a real sandbox Order ID;
- work-status queries and logs must contain no secret/PII.

Production, live credentials, public webhook ingress, automated chargebacks/disputes, and deployment remain out of scope.

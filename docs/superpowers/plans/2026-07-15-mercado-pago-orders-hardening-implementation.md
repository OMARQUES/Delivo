# Mercado Pago Orders Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents unless the user explicitly changes the current no-subagent preference.

**Goal:** Replace the legacy Mercado Pago Payments API with a fail-closed Orders API integration whose checkout, webhook, cancellation, refund, and reconciliation flows are durable and locally atomic.

**Architecture:** Introduce a focused `src/payments` module with a strict provider contract, Orders API adapter, invariant validator, atomic transition service, PostgreSQL webhook inbox, durable outbound operations, and reconciler. External calls always happen outside database transactions; persisted idempotency keys and leases bridge provider/local uncertainty. Existing order routes remain the public boundary while payment internals migrate cleanly with no legacy compatibility.

**Tech Stack:** TypeScript 6, Hono 4, Vitest 4, PostgreSQL 17, Drizzle ORM/Kit, Cloudflare Workers scheduled events, Mercado Pago Orders API.

## Global Constraints

- Work in an isolated worktree created with `superpowers:using-git-worktrees`; branch name `feat/mercado-pago-orders-hardening`.
- Work task-by-task: review each diff, run the focused tests, then commit before continuing.
- No subagents, push, deploy, remote database reset, staging secret change, or external Mercado Pago smoke.
- Never read, print, commit, or log `.env`, `.dev.vars`, access tokens, webhook secrets, card tokens, payer emails, raw QR content, signatures, or provider bodies.
- Existing payment data is disposable. Implement no backfill, dual-read, dual-write, or legacy compatibility.
- Orders API `automatic` mode supports only PIX and one-installment credit card; cash and card-machine behavior is unchanged.
- One Mercado Pago Order contains exactly one transaction.
- Use integer cents locally; parse provider decimal strings without floating point.
- Persist idempotency keys before every provider mutation. Never derive a key from a card token.
- Never perform provider HTTP inside a database transaction.
- Payment, application order, and order-event transitions commit atomically.
- Mismatches fail closed as `REVIEW_REQUIRED`; they never release the order or trigger an ambiguous automatic refund.
- Only an unequivocally matched late payment on a cancelled local order queues an automatic total refund.
- Keep the existing five-minute cron. Do not add Cloudflare Queues, Workflows, public admin routes, or a payment admin UI.
- Do not configure `notification_url`; external webhook configuration belongs to the later staging spec.
- Use TDD: every behavior change begins with a failing test and an observed RED result.

---

## File and Interface Map

New focused units:

- `apps/api/src/payments/provider.ts`: normalized provider types, adapter interface, and classified errors.
- `apps/api/src/payments/money.ts`: strict provider decimal/cents conversion.
- `apps/api/src/payments/mercadopago.ts`: Orders API HTTP adapter and environment factory.
- `apps/api/src/payments/snapshot-validation.ts`: financial/integration invariant validation and conservative status mapping.
- `apps/api/src/payments/transition.service.ts`: atomic application of validated provider snapshots.
- `apps/api/src/payments/checkout.service.ts`: local payment-attempt preparation and provider create/recovery orchestration.
- `apps/api/src/payments/webhook-signature.ts`: bounded parsing and constant-time HMAC validation.
- `apps/api/src/payments/webhook-inbox.service.ts`: durable notification ingestion and processing.
- `apps/api/src/payments/operation.service.ts`: durable cancellation/refund intent and execution.
- `apps/api/src/payments/reconciliation.service.ts`: lease recovery, uncertain-create lookup, nonterminal refresh, and bounded scheduled work.
- `apps/api/src/payments/retry.ts`: retry classification and deterministic backoff calculation.
- `apps/api/src/db/schema/payments.ts`: rebuilt payment attempts plus inbox and operation tables.
- `apps/api/test/helpers/payment-provider.ts`: complete normalized snapshots and fake provider shared by payment tests.

Existing integration points remain in order/amendment/dispatch services and routes. The old `apps/api/src/lib/payment-provider.ts`, `apps/api/src/lib/mercadopago.ts`, and non-atomic functions in `apps/api/src/services/payment.service.ts` are removed only after all consumers migrate.

### Task 1: Define normalized provider contracts and strict money parsing

**Files:**
- Create: `apps/api/src/payments/provider.ts`
- Create: `apps/api/src/payments/money.ts`
- Create: `apps/api/test/helpers/payment-provider.ts`
- Create: `apps/api/test/payment-provider-contract.test.ts`

**Interfaces:**
- Produces: `ProviderOrderSnapshot`, `ExpectedPayment`, `PaymentProvider`, `PaymentProviderError`, `parseProviderAmount`, and `formatProviderAmount`.
- Consumes: no payment implementation code.

- [ ] **Step 1: Write failing contract tests**

Cover exact decimal parsing, overflow/negative rejection, stable formatting, and compile-time provider shapes:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest'
import { formatProviderAmount, parseProviderAmount } from '../src/payments/money'
import type { PaymentProvider, ProviderOrderSnapshot } from '../src/payments/provider'

describe('provider money', () => {
  it.each([['0.01', 1], ['64.00', 6400], ['64', 6400]])('parses %s', (raw, cents) => {
    expect(parseProviderAmount(raw)).toBe(cents)
  })
  it.each(['', '1.001', '1e2', '-1.00', '90071992547410.00'])('rejects %s', (raw) => {
    expect(() => parseProviderAmount(raw)).toThrow(/amount/i)
  })
  it('formats cents without floating point', () => {
    expect(formatProviderAmount(450)).toBe('4.50')
  })
  it('locks the normalized contract', () => {
    expectTypeOf<ProviderOrderSnapshot>().toHaveProperty('providerOrderId')
    expectTypeOf<PaymentProvider>().toHaveProperty('createOrder')
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @delivery/api test -- payment-provider-contract.test.ts`

Expected: FAIL because `src/payments/money.ts` and `src/payments/provider.ts` do not exist.

- [ ] **Step 3: Implement the strict types and conversion**

Define this stable contract in `provider.ts`:

```ts
export type OnlinePaymentMethod = 'PIX' | 'CARD'
export type ProviderFailureKind =
  | 'TRANSIENT_UNCERTAIN' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE'
  | 'CREDENTIAL_OR_CONFIG' | 'ORDER_NOT_FOUND' | 'PROVIDER_RESPONSE_INVALID'

export type ProviderOrderSnapshot = {
  providerOrderId: string
  providerTransactionId: string
  orderStatus: string
  orderStatusDetail: string
  transactionStatus: string | null
  transactionStatusDetail: string | null
  externalReference: string
  totalAmountCents: number
  refundedAmountCents: number
  countryCode: string
  currency: string | null
  processingMode: string
  method: OnlinePaymentMethod | 'UNKNOWN'
  paymentMethodId: string
  applicationId: string | null
  accountId: string | null
  liveMode: boolean
  transactionCount: number
  pix: { qrCode: string; qrCodeBase64: string; ticketUrl: string | null; expiresAt: Date | null } | null
  updatedAt: Date | null
}

export type ExpectedPayment = {
  paymentId: string
  orderId: string
  amountCents: number
  currency: 'BRL'
  countryCode: 'BR'
  method: OnlinePaymentMethod
  applicationId: string
  accountId: string
  liveMode: boolean
}

type CreateOrderBase = {
  orderId: string
  amountCents: number
  payerEmail: string
  idempotencyKey: string
}

export type CreateOrderInput =
  | (CreateOrderBase & { method: 'PIX'; expiresAt: Date })
  | (CreateOrderBase & {
      method: 'CARD'
      cardToken: string
      cardPaymentMethodId: string
      installments: 1
    })

export interface PaymentProvider {
  createOrder(input: CreateOrderInput): Promise<ProviderOrderSnapshot>
  getOrder(providerOrderId: string): Promise<ProviderOrderSnapshot>
  searchOrders(externalReference: string): Promise<ProviderOrderSnapshot[]>
  cancelOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrderSnapshot>
  refundOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrderSnapshot>
  refundPartial(providerOrderId: string, providerTransactionId: string, amountCents: number, idempotencyKey: string): Promise<ProviderOrderSnapshot>
  getAccountId(): Promise<string>
}

export class PaymentProviderError extends Error {
  constructor(
    public readonly kind: ProviderFailureKind,
    public readonly httpStatus?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Payment provider failure: ${kind}`)
  }
}
```

Implement `parseProviderAmount` with `/^(0|[1-9]\d*)(\.\d{1,2})?$/`, string padding, and `Number.isSafeInteger`; implement `formatProviderAmount` with integer division and two-digit remainder.

- [ ] **Step 4: Add complete test builders**

Export these helpers so later tests never use incomplete type casts:

```ts
export function providerSnapshot(overrides: Partial<ProviderOrderSnapshot> = {}): ProviderOrderSnapshot
export function fakePaymentProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider
```

The baseline is one automatic, non-live, Brazilian PIX transaction for application/account `app-test`/`account-test`, `BRL 64.00`, and `processed/accredited`. Every provider method is a Vitest mock returning a complete snapshot; overrides replace individual methods or fields.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @delivery/api test -- payment-provider-contract.test.ts
pnpm --filter @delivery/api typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/payments/provider.ts apps/api/src/payments/money.ts apps/api/test/helpers/payment-provider.ts apps/api/test/payment-provider-contract.test.ts
git commit -m "feat(payments): define Orders provider contract"
```

### Task 2: Rebuild payment persistence and durable work tables

**Files:**
- Modify: `apps/api/src/db/schema/payments.ts`
- Modify: `apps/api/test/payment.schema.test.ts`
- Modify: `apps/api/test/helpers/test-db.ts`
- Generate: `apps/api/drizzle/0026_mercado_pago_orders.sql`
- Generate/Modify: `apps/api/drizzle/meta/0026_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `payments`, `paymentWebhookInbox`, `paymentOperations` and their enum types.
- Consumes: status and method names from Task 1.

- [ ] **Step 1: Replace the schema test with the new contract**

Assert exact required columns and constraints:

```ts
expect(paymentColumns).toEqual(expect.arrayContaining([
  'provider_order_id', 'provider_transaction_id', 'expected_amount_cents',
  'expected_currency', 'expected_country', 'create_idempotency_key',
  'provider_status', 'provider_status_detail', 'reconciliation_state',
  'reconciliation_failure', 'refunded_amount_cents', 'next_reconcile_at',
]))
expect(tableNames).toEqual(expect.arrayContaining([
  'payments', 'payment_webhook_inbox', 'payment_operations',
]))
expect(uniqueIndexes).toEqual(expect.arrayContaining([
  'payments_create_idempotency_unique',
  'payments_provider_order_unique',
  'payments_provider_transaction_unique',
  'payment_webhook_inbox_dedupe_unique',
  'payment_operations_business_key_unique',
]))
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `pnpm --filter @delivery/api test -- payment.schema.test.ts`

Expected: FAIL because the new columns/tables do not exist.

- [ ] **Step 3: Define the Drizzle schema**

Add enums:

```ts
export const paymentReconciliationState = pgEnum('payment_reconciliation_state', ['PENDING', 'HEALTHY', 'REVIEW_REQUIRED'])
export const paymentWebhookStatus = pgEnum('payment_webhook_status', ['PENDING', 'PROCESSING', 'PROCESSED', 'REVIEW_REQUIRED'])
export const paymentOperationStatus = pgEnum('payment_operation_status', ['PENDING', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED'])
export const paymentOperationType = pgEnum('payment_operation_type', ['CANCEL', 'REFUND_FULL', 'REFUND_PARTIAL'])
```

Rebuild `payments` with the spec fields and partial unique indexes using `.where(sql\`... is not null\`)`. Add check constraints for positive expected amount, refunded range, and PIX-only QR data. Add inbox and operation tables with attempt count, `nextAttemptAt`, `leaseOwner`, `leasedUntil`, bounded failure code, and timestamps. Give operations a `businessKey` unique column and require partial amount only for `REFUND_PARTIAL`.

- [ ] **Step 4: Update test truncation order**

Make the beginning of `truncateAll()`:

```sql
TRUNCATE TABLE payment_operations, payment_webhook_inbox, payments, email_outbox, ... CASCADE
```

- [ ] **Step 5: Generate and inspect migration 0026**

Run:

```bash
pnpm --filter @delivery/api exec drizzle-kit generate --name mercado_pago_orders
rg -n "DROP TABLE.*payments|CREATE TABLE.*payments|payment_webhook_inbox|payment_operations" apps/api/drizzle/0026_mercado_pago_orders.sql
```

Expected: one clean payment-table replacement plus both durable tables; no data-copy SQL.

- [ ] **Step 6: Enforce the clean-cutover SQL**

Inspect the generated file and replace any attempted legacy column/data conversion with a clean `DROP TABLE "payments";` followed by the generated new table definition. Preserve the existing `payment_status` and `payment_gateway_method` enums, create the new reconciliation/work enums, and do not add `INSERT ... SELECT`, compatibility views, or legacy columns. Confirm the Drizzle snapshot and journal still describe the final schema.

- [ ] **Step 7: Apply from an empty local test database and verify GREEN**

Run:

```bash
docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE IF EXISTS delivery_test WITH (FORCE)'
docker compose exec -T postgres psql -U postgres -c 'CREATE DATABASE delivery_test'
pnpm --filter @delivery/api test -- payment.schema.test.ts
pnpm --filter @delivery/api typecheck
```

Expected: schema test and typecheck PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema/payments.ts apps/api/test/payment.schema.test.ts apps/api/test/helpers/test-db.ts apps/api/drizzle
git commit -m "feat(payments): add durable Orders persistence"
```

### Task 3: Implement the Orders API HTTP adapter

**Files:**
- Create: `apps/api/src/payments/mercadopago.ts`
- Rewrite: `apps/api/test/mercadopago.test.ts`
- Modify: `apps/api/src/env.ts`

**Interfaces:**
- Consumes: Task 1 `PaymentProvider`, `ProviderOrderSnapshot`, money helpers.
- Produces: `MercadoPagoOrdersProvider` and `createPaymentProvider(env)`.

- [ ] **Step 1: Write failing request/response contract tests**

Test:

```ts
expect(url).toBe('https://api.mercadopago.com/v1/orders')
expect(headers['X-Idempotency-Key']).toBe('create-key')
expect(body).toMatchObject({
  type: 'online', processing_mode: 'automatic', external_reference: 'order-1',
  total_amount: '64.00', transactions: { payments: [{ amount: '64.00' }] },
})
expect(JSON.stringify(body)).not.toContain('notification_url')
```

Add cases for PIX QR mapping, card token request without token in result/error, GET, exact-reference search, cancel path, total-refund empty body, partial-refund transaction body, `/users/me`, malformed snapshot, timeout, `401`, `404`, `429 Retry-After`, and `5xx`. Assert all URLs avoid `/v1/payments`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @delivery/api test -- mercadopago.test.ts`

Expected: FAIL because the Orders adapter does not exist.

- [ ] **Step 3: Implement bounded HTTP transport**

Implement one private request method that:

```ts
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 8_000)
try {
  const response = await fetch(url, { ...init, signal: controller.signal, headers })
  // classify status; parse only successful JSON; never include response body in errors
} finally {
  clearTimeout(timeout)
}
```

Classify aborted/network errors as `TRANSIENT_UNCERTAIN`, `429` as `RATE_LIMITED`, `5xx` as `PROVIDER_UNAVAILABLE`, `401/403` as `CREDENTIAL_OR_CONFIG`, and `404` as `ORDER_NOT_FOUND`.

- [ ] **Step 4: Implement all Orders operations and strict normalization**

Use the exact endpoints from the spec. Require one payment transaction. Convert all provider amounts with `parseProviderAmount`. Map PIX transaction data without logging it. Require the create idempotency key for every mutation. `getAccountId()` calls the authenticated `/users/me` endpoint and records the verified identity on that provider instance; normalized Order snapshots use a raw provider account field when present and otherwise the identity already verified on that instance. Normalization before account verification fails as `CREDENTIAL_OR_CONFIG`. For partial refund send:

```ts
{ transactions: [{ id: providerTransactionId, amount: formatProviderAmount(amountCents) }] }
```

For total refund send an empty JSON object. Search must URL-encode the exact external reference and return a normalized array.

- [ ] **Step 5: Add environment fields and factory validation**

Add to `Env`:

```ts
MP_APPLICATION_ID?: string
MP_ACCOUNT_ID?: string
MP_LIVE_MODE?: 'true' | 'false'
```

The factory returns `null` unless all four runtime inputs (`MP_ACCESS_TOKEN`, application ID, account ID, live mode) are present and valid. Keep `MP_TEST_PAYER_EMAIL`; stop consuming `PUBLIC_API_URL` for payments.

- [ ] **Step 6: Run focused suite, secret regression scan, and typecheck**

```bash
pnpm --filter @delivery/api test -- mercadopago.test.ts payment-provider-contract.test.ts
pnpm --filter @delivery/api typecheck
! rg -n "cardToken|Authorization" apps/api/test/__snapshots__ 2>/dev/null
```

Expected: all PASS; scan returns no matches/files.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/payments/mercadopago.ts apps/api/src/env.ts apps/api/test/mercadopago.test.ts
git commit -m "feat(payments): implement Mercado Pago Orders adapter"
```

### Task 4: Validate snapshots and map statuses fail-closed

**Files:**
- Create: `apps/api/src/payments/snapshot-validation.ts`
- Create: `apps/api/test/payment-snapshot-validation.test.ts`

**Interfaces:**
- Consumes: `ProviderOrderSnapshot`, `ExpectedPayment`.
- Produces: `validateSnapshot(snapshot, expected): SnapshotDecision`.

- [ ] **Step 1: Write the table-driven RED matrix**

Define a valid baseline and mutate one field per case:

```ts
it.each([
  ['MISMATCH_EXTERNAL_REFERENCE', { externalReference: 'other' }],
  ['MISMATCH_AMOUNT', { totalAmountCents: 999 }],
  ['MISMATCH_COUNTRY', { countryCode: 'AR' }],
  ['MISMATCH_CURRENCY', { currency: 'USD' }],
  ['MISMATCH_METHOD', { method: 'CARD' }],
  ['MISMATCH_APPLICATION', { applicationId: 'other' }],
  ['MISMATCH_ACCOUNT', { accountId: 'other' }],
  ['MISMATCH_ENVIRONMENT', { liveMode: true }],
  ['MISMATCH_TRANSACTION_COUNT', { transactionCount: 2 }],
])('%s fails closed', (failureCode, patch) => {
  expect(validateSnapshot({ ...valid, ...patch }, expected)).toEqual({ kind: 'REVIEW_REQUIRED', failureCode })
})
```

Add accepted cases for PIX waiting transfer, processing, accredited, rejection, cancelled, expired, partially refunded, and refunded. Add review cases for chargeback, capture/challenge, unknown status, conflicting provider IDs, and refunded amount overflow.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @delivery/api test -- payment-snapshot-validation.test.ts`

Expected: FAIL because validator is missing.

- [ ] **Step 3: Implement a discriminated decision**

```ts
export type SnapshotDecision =
  | { kind: 'PENDING'; qrAvailable: boolean }
  | { kind: 'APPROVED' }
  | { kind: 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED' }
  | { kind: 'PARTIALLY_REFUNDED'; refundedAmountCents: number }
  | { kind: 'REVIEW_REQUIRED'; failureCode: `MISMATCH_${string}` | `UNSUPPORTED_${string}` }
```

Validate identity/financial fields before status mapping. A missing required application/account identity is a mismatch, not an implicit match. Unknown or unsupported states never become approved.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
pnpm --filter @delivery/api test -- payment-snapshot-validation.test.ts
pnpm --filter @delivery/api typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/payments/snapshot-validation.ts apps/api/test/payment-snapshot-validation.test.ts
git commit -m "feat(payments): validate provider snapshots"
```

### Task 5: Apply provider state with one atomic local transition

**Files:**
- Create: `apps/api/src/payments/transition.service.ts`
- Rewrite: `apps/api/test/payment.service.test.ts`

**Interfaces:**
- Consumes: `SnapshotDecision`, `payments`, `orders`, `orderEvents`, `paymentOperations`.
- Produces: `applyProviderSnapshot(db, paymentId, snapshot, now): Promise<TransitionResult>`.

```ts
export type TransitionResult = {
  changed: boolean
  decision: SnapshotDecision['kind']
  operationEnqueued: boolean
}
```

- [ ] **Step 1: Write PostgreSQL RED tests for atomicity and races**

Test approved transition, pending persistence, rejection, review, partial/full refund, stale state, duplicate approval, late payment, and rollback. For the race:

```ts
const [a, b] = await Promise.all([
  applyProviderSnapshot(testDb, payment.id, approved, now),
  applyProviderSnapshot(testDb, payment.id, approved, now),
])
expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1)
expect(await approvalEventCount(order.id)).toBe(1)
```

Force an event insert failure inside the transaction and assert payment/order remain unchanged. For a cancelled local order plus fully matched approval, assert exactly one pending `REFUND_FULL` operation and no reopening.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @delivery/api test -- payment.service.test.ts`

Expected: FAIL because atomic transition service is missing.

- [ ] **Step 3: Implement lock, validation, and transition**

Inside `db.transaction`:

```ts
const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).for('update')
const decision = validateSnapshot(snapshot, expectedFrom(payment))
```

Persist provider IDs only if unique and nonconflicting. Update payment, order, and one event in the same transaction. The payment row lock and terminal-state guard suppress duplicate events; use exact SYSTEM notes `pagamento confirmado`, `pagamento em revisão`, and `pagamento tardio: estorno pendente`. For a valid late approval, keep the order cancelled and insert `payment_operations.business_key = late-refund:<paymentId>`.

- [ ] **Step 4: Prove no provider dependency exists in the transaction unit**

Run: `! rg -n "PaymentProvider|fetch\(" apps/api/src/payments/transition.service.ts`

Expected: command succeeds with no matches.

- [ ] **Step 5: Run focused and API tests**

```bash
pnpm --filter @delivery/api test -- payment.service.test.ts payment-snapshot-validation.test.ts
pnpm --filter @delivery/api test
```

Expected: PASS after migrating affected test fixtures to the new payment rows.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/payments/transition.service.ts apps/api/test/payment.service.test.ts
git commit -m "feat(payments): make provider transitions atomic"
```

### Task 6: Migrate checkout creation and uncertain-create recovery

**Files:**
- Create: `apps/api/src/payments/checkout.service.ts`
- Modify: `apps/api/src/services/order.service.ts`
- Modify: `apps/api/src/routes/orders.ts`
- Rewrite: `apps/api/test/order.service.test.ts`
- Modify: `apps/api/test/orders.routes.test.ts`

**Interfaces:**
- Consumes: provider adapter, validator, transition service.
- Produces: `createPaymentAttempt`, `createOnlinePayment`, `recoverUncertainCreate`.

```ts
export function createPaymentAttempt(tx: Db, input: {
  orderId: string; method: 'PIX' | 'CARD'; amountCents: number; now: Date
}): Promise<typeof payments.$inferSelect>
export function createOnlinePayment(db: Db, provider: PaymentProvider, input: {
  paymentId: string; payerEmail: string; card?: { token: string; methodId: string }
}): Promise<{ kind: 'PIX'; qrCode: string; qrCodeBase64: string; expiresAt: string } | { kind: 'APPROVED' | 'PENDING' }>
export function recoverUncertainCreate(db: Db, provider: PaymentProvider, paymentId: string, now: Date): Promise<'RECOVERED' | 'RETRY_PIX' | 'FRESH_CARD_REQUIRED' | 'REVIEW_REQUIRED'>
```

- [ ] **Step 1: Add RED checkout lifecycle tests**

Cover PIX QR, immediate PIX approval, approved/rejected/processing card, mismatch, provider timeout, exact-reference recovery with zero/one/multiple results, and card retry requiring a fresh token. Assert the attempt/idempotency key exists before provider invocation.

```ts
expect(provider.createOrder).toHaveBeenCalledWith(expect.objectContaining({
  orderId: order.id, idempotencyKey: expect.any(String), installments: 1,
}))
expect(await getOrderPayment(testDb, order.id)).toMatchObject({ reconciliationState: 'HEALTHY' })
```

- [ ] **Step 2: Run focused suites and verify RED**

```bash
pnpm --filter @delivery/api test -- order.service.test.ts orders.routes.test.ts
```

Expected: FAIL against the legacy provider interface.

- [ ] **Step 3: Create the local attempt in the existing order transaction**

When `paymentMethod` is online, insert the payment attempt in the same transaction that creates `AWAITING_PAYMENT` order/items/event. Use `crypto.randomUUID()` as persisted create idempotency key. Return the attempt from the transaction for post-commit orchestration.

- [ ] **Step 4: Implement provider creation outside the transaction**

`createOnlinePayment` first calls `getAccountId()` and compares it to the payment attempt's expected account, then calls `createOrder` and `applyProviderSnapshot`. Return PIX fields only for the authenticated order response. Map definitive rejection to the existing generic `402`; map processing/uncertain to a generic pending response without cancelling the local order; map review/config failure to generic `503` without releasing it.

For `TRANSIENT_UNCERTAIN`, call `searchOrders(orderId)` before any retry. One result is reconciled; multiple results require review; zero PIX results may reuse the same idempotency key; zero card results require a fresh client token/new attempt.

- [ ] **Step 5: Remove `publicApiUrl` and notification URL plumbing**

Change route payment context to:

```ts
{ provider: createPaymentProvider(c.env), payerEmail }
```

Do not read `PUBLIC_API_URL` in checkout.

- [ ] **Step 6: Run focused and API regression suites**

```bash
pnpm --filter @delivery/api test -- order.service.test.ts orders.routes.test.ts payment.service.test.ts
pnpm --filter @delivery/api test
pnpm --filter @delivery/api typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/payments/checkout.service.ts apps/api/src/services/order.service.ts apps/api/src/routes/orders.ts apps/api/test
git commit -m "feat(payments): migrate checkout to Orders API"
```

### Task 7: Authenticate and persist Order webhooks before acknowledgment

**Files:**
- Create: `apps/api/src/payments/webhook-signature.ts`
- Create: `apps/api/src/payments/webhook-inbox.service.ts`
- Rewrite: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/security/rate-limit-policies.ts`
- Rewrite: `apps/api/test/webhooks.routes.test.ts`

**Interfaces:**
- Produces: `verifyMercadoPagoSignature`, `enqueueWebhook`, `processWebhookInboxItem`.
- Consumes: payment inbox schema and provider `getOrder`.

```ts
export function verifyMercadoPagoSignature(input: {
  secret: string; dataId: string; requestId: string; signature: string
}): Promise<{ valid: true; timestamp: string } | { valid: false }>
export function enqueueWebhook(db: Db, input: {
  topic: 'order'; resourceId: string; requestId: string; signatureTimestamp: string
}, now: Date): Promise<{ id: string; inserted: boolean }>
export function processWebhookInboxItem(db: Db, provider: PaymentProvider, inboxId: string, leaseOwner: string, now: Date): Promise<void>
```

- [ ] **Step 1: Write RED signature and ingress tests**

Cover canonical `type=order`, `data.id`, `x-request-id`, `ts`, and `v1`; malformed/oversized inputs; valid delayed signature; invalid signature `401`; repeated invalid traffic `429`; valid signed traffic bypassing the invalid-signature quota; valid insert `200`; duplicate `200`; unsupported topic `200`; DB insert failure `500`; and provider latency not delaying acknowledgment.

```ts
expect(await inboxCount()).toBe(1)
expect(await webhookReq({ body: { data: { id: 'different' } } })).toHaveProperty('status', 200)
expect(provider.getOrder).not.toHaveBeenCalledBefore(acknowledged)
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @delivery/api test -- webhooks.routes.test.ts`

Expected: FAIL because legacy route expects `type=payment` and performs synchronous fetch.

- [ ] **Step 3: Implement bounded HMAC validation**

Accept only bounded ASCII resource/request IDs, numeric timestamp, and a 64-hex `v1`. Compute:

```ts
const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`
const expected = await hmacSha256Hex(secret, manifest)
return timingSafeEqualHex(expected, signatureV1.toLowerCase())
```

Do not impose a short freshness window.

- [ ] **Step 4: Bound invalid-signature abuse without treating IP as authentication**

Add `paymentWebhookInvalidIpMinute` with limit 120/minute and one-hour retention. Consume it only after signature verification fails, using `cf-connecting-ip` or `unknown` as an opaque subject. Valid signed notifications never consume or consult this quota, so an authentic provider delivery cannot be discarded by it.

- [ ] **Step 5: Implement durable ingress**

Insert minimal metadata with `onConflictDoNothing`. Never store raw body/signature. Return `200` only after insert/duplicate succeeds. After persistence, use `c.executionCtx.waitUntil(...)` when execution context is available; failure to schedule immediate work must not remove the durable row.

- [ ] **Step 6: Implement one inbox processor path**

Claim one due row, verify `getAccountId()` on the provider instance, call `getOrder(resourceId)` outside the claim transaction, resolve a unique payment by provider Order ID or exact external reference, and call `applyProviderSnapshot`. Unknown/ambiguous resources become review required.

- [ ] **Step 7: Run tests and commit**

```bash
pnpm --filter @delivery/api test -- webhooks.routes.test.ts payment.service.test.ts
pnpm --filter @delivery/api typecheck
git add apps/api/src/payments/webhook-signature.ts apps/api/src/payments/webhook-inbox.service.ts apps/api/src/routes/webhooks.ts apps/api/src/security/rate-limit-policies.ts apps/api/test/webhooks.routes.test.ts
git commit -m "feat(payments): persist authenticated Order webhooks"
```

### Task 8: Add leases, retry policy, and durable outbound operations

**Files:**
- Create: `apps/api/src/payments/retry.ts`
- Create: `apps/api/src/payments/operation.service.ts`
- Create: `apps/api/test/payment-retry.test.ts`
- Create: `apps/api/test/payment-operation.service.test.ts`

**Interfaces:**
- Produces: `nextAttemptAt`, `enqueuePaymentOperation`, `claimDueOperations`, `processPaymentOperation`.
- Consumes: provider cancel/refund methods and transition service.

```ts
export function nextAttemptAt(now: Date, attempt: number, jitterFraction: number, retryAfterSeconds?: number): Date
export type PaymentOperationInput = {
  paymentId: string
  type: 'CANCEL' | 'REFUND_FULL' | 'REFUND_PARTIAL'
  amountCents: number | null
  businessKey: string
  idempotencyKey: string
}
export function enqueuePaymentOperation(tx: Db, input: PaymentOperationInput, now: Date): Promise<void>
export function claimDueOperations(db: Db, now: Date, limit: number, leaseOwner: string): Promise<string[]>
export function processPaymentOperation(db: Db, provider: PaymentProvider, operationId: string, leaseOwner: string, now: Date): Promise<void>
```

- [ ] **Step 1: Write RED retry tests**

```ts
expect(nextAttemptAt(now, 1, 0).toISOString()).toBe('2026-07-15T00:00:30.000Z')
expect(nextAttemptAt(now, 20, 0).getTime() - now.getTime()).toBe(6 * 60 * 60_000)
expect(nextAttemptAt(now, 1, 0, 120).getTime() - now.getTime()).toBe(120_000)
```

Also assert jitter stays in 0–25% and attempt eight exhausts.

- [ ] **Step 2: Write PostgreSQL RED operation tests**

Cover deduplicated enqueue, two-worker claim, expired lease recovery, cancel, total refund, partial refund, already-terminal success, uncertain response followed by GET, `429`, credential review, retry exhaustion, and refund total bounds.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm --filter @delivery/api test -- payment-retry.test.ts payment-operation.service.test.ts
```

Expected: FAIL because services are missing.

- [ ] **Step 4: Implement deterministic retry calculation**

Use `min(30_000 * 2 ** (attempt - 1), 21_600_000)`, add `floor(base * jitterFraction)` where production supplies `Math.random() * 0.25`, and use the greater of calculated delay and valid Retry-After.

- [ ] **Step 5: Implement operation enqueue/claim/process**

Claim bounded batches using `FOR UPDATE SKIP LOCKED`, set a UUID lease owner and five-minute lease, then commit before provider HTTP. Execute exact operation method with persisted idempotency key. Apply the returned/current snapshot afterward. Treat equivalent already-completed provider state as success. Move credentials/malformed/mismatch directly to review; retry transient cases to eight attempts.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm --filter @delivery/api test -- payment-retry.test.ts payment-operation.service.test.ts
pnpm --filter @delivery/api typecheck
git add apps/api/src/payments/retry.ts apps/api/src/payments/operation.service.ts apps/api/test/payment-retry.test.ts apps/api/test/payment-operation.service.test.ts
git commit -m "feat(payments): add durable financial operations"
```

### Task 9: Make cancellations and amendment refunds durable

**Files:**
- Modify: `apps/api/src/services/payment.service.ts`
- Modify: `apps/api/src/services/order-status.service.ts`
- Modify: `apps/api/src/services/amendment.service.ts`
- Modify: `apps/api/src/services/dispatch.service.ts`
- Modify: `apps/api/src/routes/orders.ts`
- Modify: `apps/api/src/routes/store-orders.ts`
- Modify: `apps/api/src/routes/driver.ts`
- Modify: `apps/api/test/amendment.service.test.ts`
- Modify: `apps/api/test/store-orders.routes.test.ts`
- Modify: `apps/api/test/returns.service.test.ts`

**Interfaces:**
- Consumes: `enqueuePaymentOperation`.
- Produces: `enqueueOrderPaymentDisposition` replacing direct provider side effects.

```ts
export type PaymentDispositionReason =
  | { kind: 'ORDER_CANCELLED'; businessKey: string }
  | { kind: 'PIX_EXPIRED'; businessKey: string }
  | { kind: 'AMENDMENT_REFUND'; businessKey: string; amendmentId: string; amountCents: number }

export function enqueueOrderPaymentDisposition(
  tx: Db,
  orderId: string,
  reason: PaymentDispositionReason,
  now: Date,
): Promise<boolean>
```

- [ ] **Step 1: Write RED cancellation/amendment tests**

Assert customer/store/timeout/failed-delivery cancellation writes the order/event and one appropriate operation in the same transaction. For amendment approval assert item totals, order total, amendment status, event, and `REFUND_PARTIAL` intent commit together. Force operation insert failure and assert the business mutation rolls back.

- [ ] **Step 2: Run affected suites and verify RED**

```bash
pnpm --filter @delivery/api test -- amendment.service.test.ts store-orders.routes.test.ts returns.service.test.ts
```

Expected: FAIL because current code performs direct provider calls after commits.

- [ ] **Step 3: Replace direct side effects with durable intent**

For an approved payment enqueue `REFUND_FULL`; for a pending provider Order enqueue `CANCEL`; for an approved amendment enqueue `REFUND_PARTIAL` with exact cents and transaction ID. Build deterministic business keys:

```ts
cancel:<paymentId>:<orderTransition>
refund-full:<paymentId>:<orderTransition>
refund-partial:<paymentId>:amendment:<amendmentId>
```

Move existing order events into the same transactions. Remove provider arguments from business services and their routes after all calls use durable operations.

- [ ] **Step 4: Run all affected and API tests**

```bash
pnpm --filter @delivery/api test -- amendment.service.test.ts payment.service.test.ts store-orders.routes.test.ts returns.service.test.ts orders.routes.test.ts
pnpm --filter @delivery/api test
```

Expected: PASS; mocked provider methods are no longer called directly by business services.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services apps/api/src/routes apps/api/test
git commit -m "fix(payments): persist cancel and refund intent"
```

### Task 10: Implement scheduled reconciliation and bounded batch processing

**Files:**
- Create: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/src/payments/webhook-inbox.service.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/test/payment-reconciliation.test.ts`

**Interfaces:**
- Produces: `runPaymentReconciliation(db, provider, now, limits): Promise<ReconciliationSummary>`.
- Consumes: inbox processor, operation processor, provider search/get, transition service.

```ts
export type ReconciliationSummary = {
  leasesRecovered: number
  inboxProcessed: number
  operationsProcessed: number
  createsRecovered: number
  snapshotsRefreshed: number
  pixExpired: number
  reviewsRechecked: number
  stageFailures: number
}
```

- [ ] **Step 1: Write RED reconciler tests**

Cover expired lease reset, due inbox, due operation, uncertain create, nonterminal refresh, expired PIX, safe review recheck, batch limit, overlapping workers, and failure isolation. Assert one failed category does not stop later categories and summary contains counts only.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @delivery/api test -- payment-reconciliation.test.ts`

Expected: FAIL because reconciler is missing.

- [ ] **Step 3: Implement ordered bounded stages**

Run stages in the spec order with explicit defaults:

```ts
const DEFAULT_LIMITS = { inbox: 25, operations: 25, creates: 20, snapshots: 50, expirations: 50, reviews: 10 }
```

Verify `getAccountId()` once before processing a reconciliation run and stop payment work as a credential/configuration failure when it differs from the configured expected account. Each stage then catches and classifies its own top-level failure. Uncertain creates search exact external reference; zero PIX may retry same key, zero card remains pending for a fresh client attempt, one match reconciles, multiple require review. Automated review rechecks are limited to `ORDER_NOT_FOUND`, `PROVIDER_UNAVAILABLE`, and `TRANSIENT_UNCERTAIN`; financial `MISMATCH_*`, credential, chargeback, and unsupported-state reviews require explicit operator requeue.

- [ ] **Step 4: Replace legacy cron payment calls**

In `scheduled`, construct the new provider and call `runPaymentReconciliation`. Log only nonzero summary counts. Remove direct `expireStaleAwaitingPayment(db, provider)` and direct provider use from stale-order cancellation.

- [ ] **Step 5: Run cron/reconciliation and full API tests**

```bash
pnpm --filter @delivery/api test -- payment-reconciliation.test.ts payment-operation.service.test.ts webhooks.routes.test.ts
pnpm --filter @delivery/api test
pnpm --filter @delivery/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/payments/reconciliation.service.ts apps/api/src/payments/webhook-inbox.service.ts apps/api/src/index.ts apps/api/test/payment-reconciliation.test.ts
git commit -m "feat(payments): reconcile durable payment work"
```

### Task 11: Add safe operations documentation and configuration templates

**Files:**
- Modify: `apps/api/.dev.vars.example`
- Modify: `apps/api/wrangler.jsonc`
- Create: `apps/api/scripts/payment-work-status.sql`
- Create: `apps/api/scripts/requeue-payment-work.sql`
- Create: `docs/security/runbooks/mercado-pago-orders.md`
- Modify: `docs/carry-forwards.md`
- Modify: `docs/security/2026-07-11-backend-security-review.md`

**Interfaces:**
- Produces: non-secret config names, sanitized inspection queries, parameterized requeue procedure, and operational runbook.

- [ ] **Step 1: Add non-secret configuration names only**

Templates/config declare blank/local-safe values for `MP_APPLICATION_ID`, `MP_ACCOUNT_ID`, and `MP_LIVE_MODE=false`. Do not add `MP_ACCESS_TOKEN` or `MP_WEBHOOK_SECRET` to tracked Wrangler vars.

- [ ] **Step 2: Add sanitized status SQL**

The read-only script outputs only status/count/age/failure class:

```sql
select status, failure_class, count(*) as items,
  extract(epoch from now() - min(created_at))::int as oldest_age_seconds
from payment_webhook_inbox group by status, failure_class order by status, failure_class;
```

Repeat for operations and reconciliation state without provider bodies, emails, QR data, or secret-bearing fields.

- [ ] **Step 3: Add parameterized safe requeue SQL**

Require psql variables `work_type` and `work_id`; update only `REVIEW_REQUIRED`, preserve idempotency/business keys and attempt history fields, clear lease/failure, and set next attempt to now. Fail when no eligible row changes.

- [ ] **Step 4: Write the runbook**

Use sections: architecture, non-secret configuration, credential preflight, local verification, sanitized status, requeue, failure classes, alert thresholds, rollback, and staging boundary. State explicitly that external webhook smoke is not authorized by this plan.

- [ ] **Step 5: Update remediation records accurately**

Mark SEC-08 code remediation complete only after tests pass; keep external staging/prod validation pending. Remove resolved legacy Payments API and non-durable partial-refund carry-forwards, replacing them with the remaining staging ingress follow-up.

- [ ] **Step 6: Verify docs/config and commit**

```bash
git diff --check
! rg -n "APP_USR-|TEST-|postgresql://|npg_|re_[A-Za-z0-9]" apps/api/.dev.vars.example apps/api/wrangler.jsonc apps/api/scripts docs/security/runbooks/mercado-pago-orders.md
git add apps/api/.dev.vars.example apps/api/wrangler.jsonc apps/api/scripts docs/carry-forwards.md docs/security
git commit -m "docs(payments): add Orders operations runbook"
```

Expected: checks PASS and only names/placeholders, never real values, are tracked.

### Task 12: Remove legacy integration and run the final local gate

**Files:**
- Delete: `apps/api/src/lib/payment-provider.ts`
- Delete: `apps/api/src/lib/mercadopago.ts`
- Modify: all remaining imports found by `rg` in `apps/api/src` and `apps/api/test`
- Modify: `apps/api/worker-configuration.d.ts` only if regenerated non-secret binding types differ

**Interfaces:**
- Consumes: all new payment modules.
- Produces: no legacy Payments API path or old provider contract.

- [ ] **Step 1: Prove legacy references remain before cleanup**

Run:

```bash
rg -n "src/lib/payment-provider|lib/payment-provider|src/lib/mercadopago|lib/mercadopago|/v1/payments|providerPaymentId" apps/api/src apps/api/test
```

Expected: remaining references identify the exact cleanup set.

- [ ] **Step 2: Delete old modules and migrate remaining tests/imports**

All runtime imports use `src/payments/provider.ts` and `src/payments/mercadopago.ts`. Replace legacy fake providers with a shared test builder returning complete `ProviderOrderSnapshot` objects. Do not add compatibility aliases.

- [ ] **Step 3: Prove the clean cutover**

Run:

```bash
! rg -n "/v1/payments|providerPaymentId|createPixPayment|createCardPayment|getPayment|refundPayment|cancelPayment" apps/api/src apps/api/test
```

Expected: no matches.

- [ ] **Step 4: Run migration-from-zero verification**

```bash
docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE IF EXISTS delivery_test WITH (FORCE)'
docker compose exec -T postgres psql -U postgres -c 'CREATE DATABASE delivery_test'
pnpm --filter @delivery/api test -- payment.schema.test.ts
pnpm --filter @delivery/api test
```

Expected: fresh migrations through `0026` and API suite PASS.

- [ ] **Step 5: Use `superpowers:verification-before-completion` and run the repository gate**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --dir apps/api exec wrangler deploy --dry-run --outdir /tmp/delivery-api-orders-dry
git diff --check
git status --short
```

Expected: every command PASS; status contains only intentional final cleanup changes.

- [ ] **Step 6: Run a tracked-file secret scan**

```bash
git grep -n -E 'postgresql://[^ ]+@|APP_USR-[A-Za-z0-9_-]+|re_[A-Za-z0-9_-]{20,}|npg_[A-Za-z0-9]+' -- ':!pnpm-lock.yaml'
```

Expected: no matches. Do not scan or print ignored local environment files.

- [ ] **Step 7: Commit cleanup**

```bash
git add -A apps/api packages/shared docs
git commit -m "refactor(payments): remove legacy Payments API"
```

- [ ] **Step 8: Review before integration**

Use `superpowers:requesting-code-review`, correct verified findings, rerun Steps 3–6, then use `superpowers:finishing-a-development-branch`. Merge locally only after the user selects merge. Do not push.

## Completion Boundary

Completion means the local repository uses only Mercado Pago Orders API for PIX/card, validates every provider snapshot before release, persists authenticated webhook work, makes financial transitions atomic, retries cancellation/refund intent durably, reconciles uncertainty through PostgreSQL, and passes the full local gate.

Completion does not mean Mercado Pago is enabled in staging or production. External webhook reachability, test-user smoke, staging credential setup, remote database reset, and production activation remain separate reviewed work.

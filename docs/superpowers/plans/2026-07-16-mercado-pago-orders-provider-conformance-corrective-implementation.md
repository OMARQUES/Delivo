# Mercado Pago Orders Provider Conformance Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline and do not dispatch subagents unless the user explicitly changes the current no-subagent preference.

**Goal:** Restore local PIX and card checkout by making the Mercado Pago Orders adapter conform to the current provider request, response, search, mutation, and idempotency contracts without weakening the existing PostgreSQL financial safeguards.

**Architecture:** Keep Orders API as the only online-payment integration and PostgreSQL as the durable source of truth. Correct the HTTP adapter at its boundary, reuse one 30-minute PIX deadline across local persistence and provider requests, pass a bounded creation window into uncertain-create search, retain descriptive internal business keys while generating compact provider keys, and add sanitized diagnostics at the authenticated order route. Webhook authentication and financial transitions remain unchanged; only their official-shaped regression fixtures are strengthened.

**Tech Stack:** TypeScript 6, Hono 4, Vitest 4, PostgreSQL 17, Drizzle ORM, Mercado Pago Orders API, Cloudflare Workers.

**Approved Design:** [Mercado Pago Orders Provider Conformance Corrective Design](../specs/2026-07-16-mercado-pago-orders-provider-conformance-corrective-design.md)

## Global Constraints

- Start from `main` after this plan commit and use `superpowers:using-git-worktrees` to create branch `fix/mercado-pago-orders-provider-conformance` in an isolated worktree.
- Execute inline, task-by-task. Do not dispatch subagents.
- For each task: write the failing test, observe the intended RED, implement the minimum correction, rerun focused tests, inspect the diff, run `git diff --check`, then commit before continuing.
- Preserve the existing unrelated local change in `apps/driver/.env.development`; never stage, overwrite, print, or move it.
- Never read, print, commit, or log `.env`, `.dev.vars`, access tokens, webhook secrets, card tokens, payer emails, QR content, signatures, raw provider bodies, database URLs, or credential-bearing URLs.
- Do not change schema, migrations, frontend behavior, public response text, PostgreSQL leases/queues/retry budgets, snapshot transition policy, or financial source-of-truth ownership.
- Do not reintroduce Payments API, dual paths, compatibility fallback, `notification_url`, or provider calls inside database transactions.
- Do not configure the Mercado Pago dashboard, replace the webhook URL/secret, execute the external webhook simulation, deploy, reset a database, or perform real sandbox payments in this plan.
- PIX and card sandbox checkout, followed by webhook dashboard reconfiguration, remain explicit post-merge manual verification.
- Public checkout errors remain generic. Diagnostics contain only the allowlisted fields defined in Task 5.
- The adapter must not infer conflicting provider identity. Missing application identity remains review-required through existing snapshot validation.
- All provider idempotency keys use the conservative shared bound of 1–64 characters, even though Order creation currently permits a larger maximum.

## File and Interface Map

- Create `apps/api/src/payments/constants.ts`: shared `PIX_EXPIRATION_MS` and `PIX_EXPIRATION_DURATION` values.
- Modify `apps/api/src/payments/provider.ts`: bounded uncertain-create search inputs plus provider idempotency helpers.
- Modify `apps/api/src/payments/mercadopago.ts`: corrected Orders request, normalization, search, cancel, and refund contracts.
- Modify `apps/api/src/payments/checkout.service.ts`: reuse 30-minute fallback and pass persisted creation bounds to search.
- Modify `apps/api/src/services/order.service.ts`: persist PIX expiry from the same timestamp used to create the payment attempt.
- Modify `apps/api/src/services/payment.service.ts`, `apps/api/src/services/amendment.service.ts`, `apps/api/src/payments/transition.service.ts`, `apps/api/src/payments/reconciliation.service.ts`, and `apps/api/src/payments/operation.service.ts`: retain business keys and generate compact stable provider keys.
- Create `apps/api/src/payments/provider-diagnostics.ts`: allowlisted provider-failure diagnostic.
- Modify `apps/api/src/routes/orders.ts`: attach payment method and local request ID to sanitized provider diagnostics while preserving the generic response.
- Modify focused payment and webhook tests only where their public interfaces or fixtures change.

---

### Task 1: Correct Order creation requests and unify the 30-minute PIX deadline

**Files:**
- Create: `apps/api/src/payments/constants.ts`
- Modify: `apps/api/src/payments/mercadopago.ts`
- Modify: `apps/api/src/payments/checkout.service.ts`
- Modify: `apps/api/src/services/order.service.ts`
- Modify: `apps/api/test/mercadopago.test.ts`
- Modify: `apps/api/test/orders.routes.test.ts`

**Interfaces:**
- Produces: `PIX_EXPIRATION_MS = 30 * 60_000`.
- Produces: `PIX_EXPIRATION_DURATION = 'PT30M'`.
- PIX request produces `payment_method: { id: 'pix', type: 'bank_transfer' }` and `expiration_time: 'PT30M'`.
- Card request produces `payment_method: { id, type: 'credit_card', token, installments: 1 }`.
- Local `payments.expiresAt` and the provider duration describe the same 30-minute deadline.

- [ ] **Step 1: Replace the optimistic creation assertions with exact failing request contracts**

In `apps/api/test/mercadopago.test.ts`, split the current combined creation test into exact PIX and card tests. Keep sanitized values and inspect the parsed request body rather than string fragments:

```ts
it('creates PIX with the documented bank-transfer shape and PT30M', async () => {
  const fetchMock = vi.fn(async () => response(snapshot(), 201))
  vi.stubGlobal('fetch', fetchMock)

  await provider.createOrder({
    orderId: 'order-1',
    amountCents: 6400,
    payerEmail: 'payer@test.local',
    idempotencyKey: 'create-pix-key',
    method: 'PIX',
    expiresAt: new Date('2026-07-16T12:30:00.000Z'),
  })

  const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
  expect(url).toBe('https://api.mercadopago.com/v1/orders')
  expect(JSON.parse(String(init.body))).toEqual({
    type: 'online',
    processing_mode: 'automatic',
    external_reference: 'order-1',
    total_amount: '64.00',
    payer: { email: 'payer@test.local' },
    transactions: { payments: [{
      amount: '64.00',
      payment_method: { id: 'pix', type: 'bank_transfer' },
      expiration_time: 'PT30M',
    }] },
  })
})

it('creates a one-installment card Order with explicit credit-card type', async () => {
  const fetchMock = vi.fn(async () => response(snapshot({
    transactions: { payments: [{
      id: 'transaction-card',
      status: 'processed',
      status_detail: 'accredited',
      amount: '64.00',
      payment_method: { id: 'visa', type: 'credit_card' },
    }] },
  }), 201))
  vi.stubGlobal('fetch', fetchMock)

  await provider.createOrder({
    orderId: 'order-1',
    amountCents: 6400,
    payerEmail: 'payer@test.local',
    idempotencyKey: 'create-card-key',
    method: 'CARD',
    cardToken: 'ephemeral-card-token',
    cardPaymentMethodId: 'visa',
    installments: 1,
  })

  const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
  const body = JSON.parse(String(init.body)) as {
    transactions: { payments: Array<{ payment_method: Record<string, unknown> }> }
  }
  expect(body.transactions.payments[0]!.payment_method).toEqual({
    id: 'visa',
    type: 'credit_card',
    token: 'ephemeral-card-token',
    installments: 1,
  })
})
```

Keep the current sanitized response helper only for Task 1 so request serialization is isolated from response normalization. Task 2 replaces it completely with official-shaped response fixtures.

- [ ] **Step 2: Add a failing route-level persistence assertion for 30 minutes**

In the existing `PIX_ONLINE` route test, import `payments`, capture the PIX input passed to `createOrder`, and assert persisted timestamps use the same deadline:

```ts
let providerExpiry: Date | null = null
if (input.method === 'PIX') providerExpiry = input.expiresAt

const [persisted] = await testDb.select().from(payments)
  .where(eq(payments.orderId, result.order.id))
expect(persisted!.expiresAt!.getTime() - persisted!.createdAt.getTime())
  .toBe(30 * 60_000)
expect(providerExpiry).toEqual(persisted!.expiresAt)
```

Keep QR/replay assertions intact.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/orders.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: creation tests fail because payment-method `type` is missing and PIX sends an absolute timestamp; the route test fails because local expiry is 15 minutes.

- [ ] **Step 4: Add the shared expiry constants and use one local timestamp**

Create `apps/api/src/payments/constants.ts`:

```ts
export const PIX_EXPIRATION_MS = 30 * 60_000
export const PIX_EXPIRATION_DURATION = 'PT30M'
```

In `order.service.ts`, compute a single timestamp immediately before `createPaymentAttempt`:

```ts
const paymentNow = new Date()
paymentAttempt = await createPaymentAttempt(tx, {
  orderId: order.id,
  method: input.paymentMethod === 'PIX_ONLINE' ? 'PIX' : 'CARD',
  amountCents: order.totalCents,
  applicationId: paymentCtx!.applicationId,
  accountId: paymentCtx!.accountId,
  liveMode: paymentCtx!.liveMode,
  expiresAt: input.paymentMethod === 'PIX_ONLINE'
    ? new Date(paymentNow.getTime() + PIX_EXPIRATION_MS)
    : undefined,
  now: paymentNow,
})
```

Import `PIX_EXPIRATION_MS`. Do not change transaction boundaries or non-online order creation.

In `checkout.service.ts`, replace both `15 * 60_000` fallbacks with `PIX_EXPIRATION_MS`. The persisted `payment.expiresAt` remains preferred.

- [ ] **Step 5: Correct the two provider payment objects**

Import `PIX_EXPIRATION_DURATION` in `mercadopago.ts` and build:

```ts
const payment = input.method === 'PIX'
  ? {
      amount: amountText,
      payment_method: { id: 'pix', type: 'bank_transfer' },
      expiration_time: PIX_EXPIRATION_DURATION,
    }
  : {
      amount: amountText,
      payment_method: {
        id: input.cardPaymentMethodId,
        type: 'credit_card',
        token: input.cardToken,
        installments: 1,
      },
    }
```

Do not add `notification_url` or persist/log the card token.

- [ ] **Step 6: Run focused tests and API typecheck**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/orders.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
```

Expected: all pass.

- [ ] **Step 7: Review and commit Task 1**

Run `git diff --check`, inspect every changed line, confirm no fixture contains a real credential/token/email/QR value, then commit:

```bash
git add \
  apps/api/src/payments/constants.ts \
  apps/api/src/payments/mercadopago.ts \
  apps/api/src/payments/checkout.service.ts \
  apps/api/src/services/order.service.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/test/orders.routes.test.ts
git commit -m "fix(payments): conform Orders create requests"
```

---

### Task 2: Normalize official Order responses without weakening snapshot validation

**Files:**
- Modify: `apps/api/src/payments/mercadopago.ts`
- Modify: `apps/api/test/mercadopago.test.ts`
- Modify: `apps/api/test/payment-snapshot-validation.test.ts`

**Interfaces:**
- Consumes: official `transactions.payments[0].payment_method` artifacts and `integration_data.application_id`.
- Produces: normalized `BR`, fixed absent-currency `BRL`, optional documented dates, and verified-account fallback.
- Preserves: explicit conflicting country/currency/application/account/environment values for fail-closed validation.

- [ ] **Step 1: Replace provider fixtures with sanitized official-shaped fixtures**

Make the PIX fixture structurally equivalent to the current documented response:

```ts
function officialPixOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ORD_TEST_PIX',
    type: 'online',
    processing_mode: 'automatic',
    external_reference: 'order-1',
    total_amount: '64.00',
    country_code: 'BRA',
    status: 'action_required',
    status_detail: 'waiting_transfer',
    integration_data: { application_id: 'app-test' },
    user_id: 'account-test',
    live_mode: false,
    last_updated_date: '2026-07-16T12:00:00.000Z',
    transactions: { payments: [{
      id: 'PAY_TEST_PIX',
      amount: '64.00',
      refunded_amount: '0.00',
      status: 'action_required',
      status_detail: 'waiting_transfer',
      date_of_expiration: '2026-07-16T12:30:00.000Z',
      payment_method: {
        id: 'pix',
        type: 'bank_transfer',
        ticket_url: 'https://example.invalid/ticket',
        qr_code: 'sanitized-copy-paste',
        qr_code_base64: 'sanitized-base64',
      },
    }] },
    ...overrides,
  }
}
```

Create a card fixture with `country_code: 'BR'`, nested application identity, no PIX artifacts, and no `currency` field. Use only invalid/example domains and obvious test markers.

- [ ] **Step 2: Add failing normalization cases**

Cover all boundaries explicitly:

```ts
it('normalizes official PIX fields, BRA and documented dates', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(officialPixOrder(), 200)))
  const result = await provider.getOrder('ORD_TEST_PIX')
  expect(result).toMatchObject({
    countryCode: 'BR',
    currency: 'BRL',
    applicationId: 'app-test',
    accountId: 'account-test',
    method: 'PIX',
    pix: {
      qrCode: 'sanitized-copy-paste',
      qrCodeBase64: 'sanitized-base64',
      ticketUrl: 'https://example.invalid/ticket',
      expiresAt: new Date('2026-07-16T12:30:00.000Z'),
    },
    updatedAt: new Date('2026-07-16T12:00:00.000Z'),
  })
})
```

Add three separate tests with complete fetch sequences: absent currency returns `BRL` while explicit `USD` remains `USD`; absent `integration_data` returns `applicationId: null`; an Order without `user_id`/`collector_id` returns `accountId: null` before `getAccountId()` and `account-test` after a successful credential-scoped lookup. Recreate the provider in `beforeEach` so verified account state never leaks between tests.

In `payment-snapshot-validation.test.ts`, assert an adapter snapshot with `applicationId: null` yields `MISMATCH_APPLICATION`, and explicit `currency: 'USD'` yields `MISMATCH_CURRENCY`. Keep existing status-policy assertions unchanged.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment-snapshot-validation.test.ts
```

Expected: failures show the current root application field, old PIX path, raw `BRA`, nullable absent currency, and old date names.

- [ ] **Step 4: Implement strict documented extraction**

Add a numeric/string identifier helper:

```ts
function optionalIdentifier(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function normalizeCountry(value: unknown): string {
  const country = requiredString(value).toUpperCase()
  return country === 'BRA' ? 'BR' : country
}
```

In `normalize`:

```ts
const integrationData = asObject(order.integration_data)
const pix = method === 'PIX'
  ? {
      qrCode: requiredString(paymentMethod.qr_code),
      qrCodeBase64: requiredString(paymentMethod.qr_code_base64),
      ticketUrl: optionalString(paymentMethod.ticket_url),
      expiresAt: dateOrNull(transaction.date_of_expiration ?? order.date_of_expiration),
    }
  : null

// Returned fields:
countryCode: normalizeCountry(order.country_code),
currency: optionalString(order.currency) ?? 'BRL',
applicationId: optionalIdentifier(integrationData.application_id),
accountId: optionalIdentifier(order.user_id ?? order.collector_id) ?? this.verifiedAccountId,
updatedAt: dateOrNull(order.last_updated_date),
```

Do not fall back from missing application ID to `this.config.applicationId`. Keep explicit non-`BRL` and non-Brazil values unchanged so `validateSnapshot` rejects them.

- [ ] **Step 5: Run focused payment tests and typecheck**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment-snapshot-validation.test.ts \
  test/payment.service.test.ts
pnpm --filter @delivery/api typecheck
```

Expected: all pass.

- [ ] **Step 6: Review and commit Task 2**

Run `git diff --check`, verify missing application identity still fails closed, then commit:

```bash
git add \
  apps/api/src/payments/mercadopago.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/test/payment-snapshot-validation.test.ts
git commit -m "fix(payments): normalize Orders responses"
```

---

### Task 3: Use bounded current-contract search for uncertain Order creation

**Files:**
- Modify: `apps/api/src/payments/provider.ts`
- Modify: `apps/api/src/payments/mercadopago.ts`
- Modify: `apps/api/src/payments/checkout.service.ts`
- Modify: `apps/api/test/mercadopago.test.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`

**Interfaces:**
- Changes: `searchOrders(externalReference, createdAt, now)`.
- Produces: `GET /v1/orders` with required RFC 3339 bounds, `type=online`, `page=1`, and `page_size=10`.
- Consumes: response envelope `{ data: [...] }`.
- Preserves: zero/one/multiple exact-match recovery semantics.

- [ ] **Step 1: Add the exact failing adapter search contract**

In `mercadopago.test.ts`:

```ts
it('searches current Orders endpoint with bounded dates and exact post-filtering', async () => {
  const wanted = officialPixOrder({ external_reference: 'order-1' })
  const other = officialPixOrder({ id: 'ORD_OTHER', external_reference: 'other-order' })
  const fetchMock = vi.fn(async () => response({ data: [wanted, other], paging: { total: 2 } }))
  vi.stubGlobal('fetch', fetchMock)

  const createdAt = new Date('2026-07-16T12:00:00.000Z')
  const now = new Date('2026-07-16T13:00:00.000Z')
  const matches = await provider.searchOrders('order-1', createdAt, now)

  const url = new URL(String(fetchMock.mock.calls[0]![0]))
  expect(`${url.origin}${url.pathname}`).toBe('https://api.mercadopago.com/v1/orders')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    begin_date: '2026-07-16T11:55:00.000Z',
    end_date: '2026-07-16T13:05:00.000Z',
    external_reference: 'order-1',
    type: 'online',
    page: '1',
    page_size: '10',
  })
  expect(matches.map((item) => item.externalReference)).toEqual(['order-1'])
})
```

Add a second case where `now + 5 minutes` exceeds `createdAt + 24 hours`; expected `end_date` is exactly creation plus 24 hours. Add malformed `{ results: [] }` coverage that yields `PROVIDER_RESPONSE_INVALID`.

- [ ] **Step 2: Add a failing service propagation assertion**

In the existing uncertain-create recovery test in `payment.service.test.ts`, make `searchOrders` a spy and assert:

```ts
expect(searchOrders).toHaveBeenCalledWith(payment.orderId, payment.createdAt, now)
```

Update the targeted `payment-reconciliation.test.ts` search spy to accept the same three parameters and assert the persisted creation time and reconciliation `now` rather than only the order ID.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment.service.test.ts \
  test/payment-reconciliation.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: compile/runtime failures show the old one-argument interface, `/search`, missing dates, and `results` envelope.

- [ ] **Step 4: Change the provider interface and recovery call**

In `provider.ts`:

```ts
searchOrders(
  externalReference: string,
  createdAt: Date,
  now: Date,
): Promise<ProviderOrderSnapshot[]>
```

In `recoverUncertainCreate`:

```ts
matches = await provider.searchOrders(payment.orderId, payment.createdAt, now)
```

No database query or recovery outcome changes.

- [ ] **Step 5: Implement bounded search and exact post-filtering**

In `mercadopago.ts`:

```ts
async searchOrders(
  externalReference: string,
  createdAt: Date,
  now: Date,
): Promise<ProviderOrderSnapshot[]> {
  const beginDate = new Date(createdAt.getTime() - 5 * 60_000)
  const maximumEnd = new Date(createdAt.getTime() + 24 * 60 * 60_000)
  const reconciliationEnd = new Date(now.getTime() + 5 * 60_000)
  const endDate = reconciliationEnd < maximumEnd ? reconciliationEnd : maximumEnd
  if (endDate <= beginDate) throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')

  const query = new URLSearchParams({
    begin_date: beginDate.toISOString(),
    end_date: endDate.toISOString(),
    external_reference: externalReference,
    type: 'online',
    page: '1',
    page_size: '10',
  })
  const raw = await this.request<Json>(`${ORDERS_BASE}?${query.toString()}`)
  const data = asObject(raw).data
  if (!Array.isArray(data)) throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID')
  return data
    .map((item) => this.normalize(item))
    .filter((item) => item.externalReference === externalReference)
}
```

Do not scan additional pages or widen the 24-hour window in this corrective task.

- [ ] **Step 6: Run all interface consumers and typecheck**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment.service.test.ts \
  test/payment-reconciliation.test.ts \
  test/payment-operation.service.test.ts \
  test/webhooks.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
```

Expected: all pass. If a typed fake provider fails, update only its method signature; do not change fake behavior.

- [ ] **Step 7: Review and commit Task 3**

Run `rg -n 'searchOrders' apps/api/src apps/api/test`, confirm every real call supplies all bounds, run `git diff --check`, then commit:

```bash
git add \
  apps/api/src/payments/provider.ts \
  apps/api/src/payments/mercadopago.ts \
  apps/api/src/payments/checkout.service.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/test/payment.service.test.ts \
  apps/api/test/payment-reconciliation.test.ts
git commit -m "fix(payments): bound uncertain Order search"
```

---

### Task 4: Correct mutation bodies and bound every provider idempotency key

**Files:**
- Modify: `apps/api/src/payments/provider.ts`
- Modify: `apps/api/src/payments/mercadopago.ts`
- Modify: `apps/api/src/services/payment.service.ts`
- Modify: `apps/api/src/services/amendment.service.ts`
- Modify: `apps/api/src/payments/transition.service.ts`
- Modify: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/src/payments/operation.service.ts`
- Modify: `apps/api/test/mercadopago.test.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/api/test/amendment.service.test.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`
- Modify: `apps/api/test/payment-operation.service.test.ts`

**Interfaces:**
- Produces: `assertProviderIdempotencyKey(value)` and `providerIdempotencyKey(scope, stableId)`.
- Cancel and full refund send no body.
- Partial refund sends one transaction with provider transaction ID and canonical amount.
- Descriptive `businessKey` values remain unchanged; compact provider keys are deterministic and at most 64 characters.

- [ ] **Step 1: Add failing adapter mutation and key-bound tests**

In `mercadopago.test.ts`, assert exact mutation calls:

```ts
expect(cancelInit.body).toBeUndefined()
expect(fullRefundInit.body).toBeUndefined()
expect(JSON.parse(String(partialRefundInit.body))).toEqual({
  transactions: [{ id: 'PAY_TEST_PIX', amount: '12.00' }],
})
```

Add table coverage for empty and 65-character keys across create/cancel/refund, proving fetch is never called and the error is classified `CREDENTIAL_OR_CONFIG`. Add a 64-character key acceptance case.

- [ ] **Step 2: Add failing persistence tests for every generated provider-key family**

Extend existing tests rather than creating database fixtures from scratch:

- `payment.service.test.ts`: after a disposition and late approval, assert the unchanged descriptive business key and `idempotencyKey.length <= 64`.
- `amendment.service.test.ts`: after approved partial-refund amendment, assert business key still contains payment/amendment identities while provider key is compact, stable, and `<= 64`.
- `payment-reconciliation.test.ts`: after PIX expiration enqueue, assert business key remains `cancel:{paymentId}:PIX_EXPIRED` and provider key is `<= 64`.
- `payment-operation.service.test.ts`: after cancel escalation, assert business key remains descriptive, provider key is `<= 64`, and replay creates no duplicate.

Also assert each provider key matches `/^[A-Za-z0-9:_-]{1,64}$/` and does not contain an access/card test marker.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment.service.test.ts \
  test/amendment.service.test.ts \
  test/payment-reconciliation.test.ts \
  test/payment-operation.service.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: cancel/full-refund body assertions fail, invalid keys reach fetch, and amendment/escalation provider keys exceed 64 characters.

- [ ] **Step 4: Add reusable strict provider-key helpers**

After `PaymentProviderError` in `provider.ts`:

```ts
const PROVIDER_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{1,64}$/

export function assertProviderIdempotencyKey(value: string): string {
  if (!PROVIDER_IDEMPOTENCY_KEY_RE.test(value)) {
    throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')
  }
  return value
}

export function providerIdempotencyKey(scope: string, stableId: string): string {
  return assertProviderIdempotencyKey(`${scope}:${stableId}`)
}
```

At the start of `MercadoPagoOrdersProvider.request`, validate any supplied idempotency key before constructing headers or calling `fetch`.

- [ ] **Step 5: Make request bodies optional for mutations**

Change the helper to:

```ts
private async mutation(
  path: string,
  key: string,
  body?: Json,
): Promise<ProviderOrderSnapshot> {
  const raw = await this.request<Json>(`${ORDERS_BASE}/${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, key)
  if (!raw) return this.getOrder(path.split('/')[0]!)
  return this.normalize(raw)
}
```

Call it without a body from `cancelOrder` and `refundOrder`; keep the current one-transaction body for `refundPartial`.

- [ ] **Step 6: Replace every potentially long provider operation key**

Import `providerIdempotencyKey` and use these stable scope codes while retaining each existing `businessKey` exactly:

| Flow | Provider key |
|---|---|
| Customer/order disposition cancel | `c:{transitionCode}:{paymentId}` |
| Customer/order disposition full refund | `rf:{transitionCode}:{paymentId}` |
| Amendment partial refund | `rp:am:{amendmentId}` |
| Late approval full refund | `rf:la:{paymentId}` |
| PIX expiry cancel | `c:px:{paymentId}` |
| Escalated cancel full refund | `rf:ec:{predecessorOperationId}` |

In `payment.service.ts`, add a complete code map:

```ts
const TRANSITION_CODE: Record<OrderPaymentTransition, string> = {
  CUSTOMER_CANCELLED: 'cc',
  STORE_CANCELLED: 'sc',
  STORE_CANCEL_REQUEST_APPROVED: 'sca',
  STALE_PENDING: 'sp',
  DELIVERY_FAILED: 'df',
  AMENDMENT_REJECTED: 'ar',
  PIX_EXPIRED: 'px',
}
```

Generate the provider key with the operation prefix plus mapped code and the stable UUID. Do not replace descriptive business keys and do not derive keys from timestamps, card data, provider responses, or random values generated at retry time.

- [ ] **Step 7: Run focused tests, API suite, and typecheck**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment.service.test.ts \
  test/amendment.service.test.ts \
  test/payment-reconciliation.test.ts \
  test/payment-operation.service.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api test
pnpm --filter @delivery/api typecheck
```

Expected: all pass.

- [ ] **Step 8: Audit all outbound key producers and commit Task 4**

Run:

```bash
rg -n 'idempotencyKey:' apps/api/src/services apps/api/src/payments
git diff --check
```

For every value that can reach `PaymentProvider`, prove from construction/tests that it is stable and 1–64 characters. Then commit:

```bash
git add \
  apps/api/src/payments/provider.ts \
  apps/api/src/payments/mercadopago.ts \
  apps/api/src/services/payment.service.ts \
  apps/api/src/services/amendment.service.ts \
  apps/api/src/payments/transition.service.ts \
  apps/api/src/payments/reconciliation.service.ts \
  apps/api/src/payments/operation.service.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/test/payment.service.test.ts \
  apps/api/test/amendment.service.test.ts \
  apps/api/test/payment-reconciliation.test.ts \
  apps/api/test/payment-operation.service.test.ts
git commit -m "fix(payments): bound Orders mutation keys"
```

---

### Task 5: Add sanitized provider diagnostics while preserving the generic API error

**Files:**
- Create: `apps/api/src/payments/provider-diagnostics.ts`
- Create: `apps/api/test/payment-provider-diagnostics.test.ts`
- Modify: `apps/api/src/payments/checkout.service.ts`
- Modify: `apps/api/src/routes/orders.ts`
- Modify: `apps/api/test/orders.routes.test.ts`

**Interfaces:**
- Consumes: `PaymentProviderError`, `OnlinePaymentMethod`, and `c.get('requestId')`.
- Produces exactly: event name, failure class, optional upstream status, payment method, local request ID.
- Preserves the original classified `TRANSIENT_UNCERTAIN` error inside `CheckoutError` only long enough for route diagnostics.
- Preserves: customer-facing status/message and unexpected-error behavior.

- [ ] **Step 1: Write a failing allowlist-only logger test**

Create `payment-provider-diagnostics.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { logPaymentProviderFailure } from '../src/payments/provider-diagnostics'
import { PaymentProviderError } from '../src/payments/provider'

describe('logPaymentProviderFailure', () => {
  it('emits only the diagnostic allowlist', () => {
    const logger = { error: vi.fn() }
    logPaymentProviderFailure(
      new PaymentProviderError('PROVIDER_RESPONSE_INVALID', 400),
      { paymentMethod: 'PIX', requestId: '00000000-0000-4000-8000-000000000001' },
      logger,
    )

    expect(logger.error).toHaveBeenCalledWith('payment_provider_failure', {
      failureClass: 'PROVIDER_RESPONSE_INVALID',
      upstreamStatus: 400,
      paymentMethod: 'PIX',
      requestId: '00000000-0000-4000-8000-000000000001',
    })
    expect(Object.keys(logger.error.mock.calls[0]![1]).sort()).toEqual([
      'failureClass', 'paymentMethod', 'requestId', 'upstreamStatus',
    ])
  })
})
```

Add a no-status case expecting `upstreamStatus: null`.

- [ ] **Step 2: Strengthen the route failure test before implementation**

In `orders.routes.test.ts`, spy on `console.error` inside `try/finally`, make the card fake provider throw `new OrdersProviderError('PROVIDER_RESPONSE_INVALID', 400)`, and assert:

```ts
expect(res.status).toBe(503)
expect((await res.json()) as { error: string }).toEqual({
  error: 'Pagamento indisponível no momento — tente novamente ou use pagamento na entrega',
})
expect(logSpy).toHaveBeenCalledWith('payment_provider_failure', {
  failureClass: 'PROVIDER_RESPONSE_INVALID',
  upstreamStatus: 400,
  paymentMethod: 'CARD',
  requestId: res.headers.get('x-request-id'),
})
```

Serialize captured log arguments and assert they do not contain the test card token, customer email, QR markers, provider body marker, webhook marker, or environment-secret marker. Keep the existing uncertain-order persistence assertion.

Extend the existing PIX uncertain test: its provider throws `TRANSIENT_UNCERTAIN`, the response remains generic `503`, the order remains `AWAITING_PAYMENT`, and the diagnostic records `failureClass: 'TRANSIENT_UNCERTAIN'`, `paymentMethod: 'PIX'`, and the response request ID.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment-provider-diagnostics.test.ts \
  test/orders.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: missing module and absent diagnostics fail; the transient case also proves the current `CheckoutError` loses provider classification.

- [ ] **Step 4: Implement the allowlisted diagnostic**

Create:

```ts
import type { OnlinePaymentMethod } from './provider'
import { PaymentProviderError } from './provider'

type ErrorLogger = Pick<Console, 'error'>

export function logPaymentProviderFailure(
  error: PaymentProviderError,
  context: { paymentMethod: OnlinePaymentMethod; requestId: string },
  logger: ErrorLogger = console,
): void {
  logger.error('payment_provider_failure', {
    failureClass: error.kind,
    upstreamStatus: error.httpStatus ?? null,
    paymentMethod: context.paymentMethod,
    requestId: context.requestId,
  })
}
```

Do not accept an arbitrary metadata/body object in this helper.

- [ ] **Step 5: Preserve transient classification without changing checkout semantics**

In `checkout.service.ts`, extend `CheckoutError` with an optional classified provider error:

```ts
export class CheckoutError extends Error {
  constructor(
    public readonly code: CheckoutErrorCode,
    public readonly status: 402 | 503,
    public readonly providerError?: PaymentProviderError,
  ) {
    super(`Payment checkout failure: ${code}`)
  }
}
```

Change only the existing transient conversion:

```ts
if (error instanceof PaymentProviderError && error.kind === 'TRANSIENT_UNCERTAIN') {
  throw new CheckoutError('PAYMENT_UNCERTAIN', 503, error)
}
```

Do not attach provider errors to validation/rejection `CheckoutError` instances and do not change persistence or recovery behavior.

- [ ] **Step 6: Attach route context only to online checkout failures**

In `orders.ts`, extend `rethrow` with an optional diagnostic context. When `e instanceof OrdersProviderError`, log only when the context exists, then throw the same generic `503`.

In `POST /orders`, bind validated input once:

```ts
const input = c.req.valid('json')
const paymentMethod = input.paymentMethod === 'PIX_ONLINE'
  ? 'PIX'
  : input.paymentMethod === 'CARD_ONLINE'
    ? 'CARD'
    : null
```

Pass `input` to `createOrder`. In its catch callback, call `rethrow(error, paymentMethod ? { paymentMethod, requestId: c.get('requestId') } : undefined)`.

Inside `rethrow`, log an `OrdersProviderError` directly. For `CheckoutError`, log only when `e.providerError` and diagnostic context both exist, then return the same generic public error. Do not log validation/rejection-only `CheckoutError`, `OrderError`, `PaymentError`, `AmendmentError`, or unexpected errors as provider failures.

- [ ] **Step 7: Run focused tests, security regression, and typecheck**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment-provider-diagnostics.test.ts \
  test/orders.routes.test.ts \
  test/sec03a-security-regression.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
```

Expected: all pass and public error text is unchanged.

- [ ] **Step 8: Review and commit Task 5**

Search the diff for forbidden fields and inspect all `console` calls:

```bash
rg -n 'console\.(log|error)|payment_provider_failure' apps/api/src apps/api/test
git diff --check
```

Then commit:

```bash
git add \
  apps/api/src/payments/provider-diagnostics.ts \
  apps/api/src/payments/checkout.service.ts \
  apps/api/src/routes/orders.ts \
  apps/api/test/payment-provider-diagnostics.test.ts \
  apps/api/test/orders.routes.test.ts
git commit -m "fix(payments): log safe provider failures"
```

---

### Task 6: Lock the webhook boundary with the official notification envelope

**Files:**
- Modify: `apps/api/test/webhooks.routes.test.ts`

**Interfaces:**
- Consumes: unchanged `POST /webhooks/mercadopago` signature boundary.
- Produces: official-shaped regression evidence that only signed query metadata enters the inbox.
- Changes no production webhook code.

- [ ] **Step 1: Replace the minimal body with a sanitized official Order notification envelope**

Use a helper:

```ts
function officialNotificationBody() {
  return {
    action: 'order.processed',
    api_version: 'v1',
    application_id: 'body-app-must-not-select-state',
    data: {
      id: 'body-order-must-not-be-trusted',
      external_reference: 'body-reference-must-not-be-trusted',
      status: 'processed',
      status_detail: 'accredited',
      total_paid_amount: 100000,
    },
    date_created: '2026-07-16T12:00:00.000Z',
    live_mode: true,
    type: 'order',
    user_id: 'body-user-must-not-select-state',
  }
}
```

Update `req` to send this body by default while continuing to sign query `data.id` and `x-request-id` only.

- [ ] **Step 2: Strengthen valid/invalid assertions**

For a valid signature, assert one inbox row with:

```ts
expect(row).toMatchObject({
  topic: 'order',
  resourceId: 'order-1',
  requestId: 'req-1',
})
expect(JSON.stringify(row)).not.toContain('body-order-must-not-be-trusted')
expect(JSON.stringify(row)).not.toContain('body-app-must-not-select-state')
```

For invalid HMAC, assert `401` and inbox row count remains zero. Keep unsupported topic `200`, missing-secret `503`, deduplication, background-client closure, and processor tests intact.

- [ ] **Step 3: Run the focused test**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/webhooks.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
```

Expected: PASS without production changes. If it fails because a body value affects routing, signature, or persistence, stop and report the boundary defect before modifying production behavior.

- [ ] **Step 4: Review and commit Task 6**

Confirm the fixture contains only synthetic markers, run `git diff --check`, then commit:

```bash
git add apps/api/test/webhooks.routes.test.ts
git commit -m "test(payments): mirror Order notifications"
```

---

### Task 7: Verify the corrective branch and prepare local integration

**Files:**
- No planned source changes.
- Modify earlier task files only if a verified review finding requires correction.

**Interfaces:**
- Consumes: all Task 1–6 commits.
- Produces: evidence-backed merge-ready branch.
- Does not execute external sandbox payments or webhook dashboard changes.

- [ ] **Step 1: Audit scope and provider conformance**

Run:

```bash
git status --short
git log --oneline --decorate -8
git diff main...HEAD --stat
git diff main...HEAD -- apps/api/src/payments apps/api/src/routes/orders.ts apps/api/src/services
rg -n '/v1/orders/search|15 \* 60_000|point_of_interaction|application_id: optionalString\(order|JSON.stringify\(\{\}\)' \
  apps/api/src/payments apps/api/src/services
rg -n 'idempotencyKey:' apps/api/src/payments apps/api/src/services
```

Expected: no obsolete search endpoint, 15-minute PIX fallback, old QR path, root-only application extraction, or serialized empty cancel/refund body remains. Every unrelated local file remains untouched.

- [ ] **Step 2: Run the focused corrective gate**

Run exactly:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment-snapshot-validation.test.ts \
  test/payment.service.test.ts \
  test/payment-reconciliation.test.ts \
  test/payment-operation.service.test.ts \
  test/payment-provider-diagnostics.test.ts \
  test/orders.routes.test.ts \
  test/webhooks.routes.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm --filter @delivery/api typecheck
```

Expected: all pass.

- [ ] **Step 3: Use verification-before-completion and run the repository gate**

Use `superpowers:verification-before-completion`, then run each command separately:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
git status --short
```

Expected: all pass. Status contains no unexpected generated file, secret, environment file, or unrelated modification.

- [ ] **Step 4: Request code review and correct only verified findings**

Use `superpowers:requesting-code-review` against the approved design and this plan. For each finding:

1. reproduce it with a focused test or concrete code path;
2. reject speculative/out-of-scope changes;
3. apply TDD for verified defects;
4. rerun the focused test and the repository gate;
5. commit the correction separately with a narrow message.

Review must explicitly check request/response fixture fidelity, bounded search dates, exact-match filtering, missing identity behavior, all provider-key producers, no-body mutations, diagnostic allowlist, and webhook body distrust.

- [ ] **Step 5: Confirm branch is merge-ready**

Run:

```bash
git status --short
git log --oneline main..HEAD
git diff --check main...HEAD
```

Expected: clean corrective worktree; only intentional commits exist; the original main-worktree `apps/driver/.env.development` change was never touched.

- [ ] **Step 6: Offer integration choice; do not merge without the user's selection**

Use `superpowers:finishing-a-development-branch`. Recommend local merge after presenting the available choices. If the user selects local merge:

1. verify the main worktree still contains only its pre-existing environment change;
2. merge `fix/mercado-pago-orders-provider-conformance` into `main` without push;
3. preserve `apps/driver/.env.development` exactly;
4. rerun at least the focused corrective gate from merged `main`;
5. report the resulting commit and verification evidence.

Do not run the post-merge sandbox/webhook procedure automatically.

## Post-Merge Manual Boundary

After the local merge, the operator performs these later, in order:

1. restart the local API/web clients with the already configured ignored local environment files;
2. run one real sandbox PIX Order and verify QR/30-minute expiry;
3. run one real sandbox card Order with a fresh test-user card token;
4. capture only sanitized request ID, failure class, upstream status, and outcome;
5. create/refresh the Cloudflare quick tunnel;
6. configure the matching Mercado Pago test application with the tunnel webhook URL and its current webhook secret;
7. select Order notifications and simulate using a real sandbox Order ID;
8. verify valid HMAC ingestion and reconciliation without recording raw bodies, signatures, tokens, emails, or QR content.

These manual checks are not implementation-plan merge gates and must not be represented as completed by automated tests.

## Completion Criteria

Implementation is complete only when:

- PIX and card create payloads match the current documented Orders contract;
- persisted PIX expiry and provider duration are both 30 minutes;
- official-shaped Order responses normalize correctly while explicit identity/currency/country conflicts remain fail-closed;
- uncertain-create search uses `GET /v1/orders`, required bounded dates, `data`, and exact post-filtering;
- cancel/full refund have no body and partial refund has one canonical transaction;
- every provider idempotency key is stable and 1–64 characters while internal business keys remain descriptive;
- generic checkout errors include safe diagnostics only on the server;
- official notification-envelope tests preserve signature verification and body distrust;
- focused and full repository gates pass;
- no unrelated environment change or secret was touched;
- the user explicitly selects local integration before merge.

# Mercado Pago Card Retry and PIX Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a definitively rejected card attempt safely retryable, make cancelled `CONT` payments converge without repeated invalid cancel mutations, and add Mercado Pago's official local-only PIX `APRO` sandbox scenario.

**Architecture:** Treat the browser idempotency key as one logical card attempt and make API replays return the original semantic outcome. Keep the existing durable `CANCEL` operation, but read the provider Order before deciding whether cancellation is actionable, pending, terminal, or must escalate to the existing canonical refund. Configure PIX `APRO` only inside the Mercado Pago adapter and keep the normal pending PIX path as the default.

**Tech Stack:** TypeScript 6, Vue 3, Hono 4, Vitest 4, Drizzle, PostgreSQL 17, Cloudflare Workers, Mercado Pago Checkout Transparente Orders API.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-17-mercado-pago-card-retry-pix-sandbox-design.md`.
- Work in an isolated worktree and branch; do not push or deploy.
- Execute inline and review each task diff before committing.
- Preserve user-owned changes in `apps/web/.env.development` and `apps/driver/.env.development`; never stage either file.
- Do not read, print, commit, or copy access tokens, card tokens, PIX payloads, emails, webhook secrets, provider response bodies, or full provider identifiers.
- Do not add a database migration, enum, dependency, provider-operation type, public request field, UI redesign, or compatibility path for old disposable local data.
- A new card idempotency key is permitted only after `402 PAYMENT_REJECTED`; network errors, timeouts, and every `503` retain the current key.
- `CANCEL` must read the provider Order before mutation; only provider `action_required` permits `Cancel Order`.
- Processing or `in_process` cancellation remains a bounded, read-only `CANCEL_PENDING` retry. Attempt eight becomes `REVIEW_REQUIRED/RETRY_EXHAUSTED`.
- A late approval of a cancelled order must enqueue exactly one existing canonical `REFUND_FULL` operation and must never reopen the order or expose it to store/dispatch scopes.
- `MP_TEST_PIX_SCENARIO` accepts only empty or `APRO`; `APRO` requires `APP_ENV=local` and `MP_LIVE_MODE=false`.
- Normal local PIX remains the default when `MP_TEST_PIX_SCENARIO` is empty.
- Use Mercado Pago's official PIX fixture only inside the adapter: `payer.email=test_user_br@testuser.com` and `payer.first_name=APRO`.
- Provider errors exposed to clients contain only a stable application code and generic message.

## Execution Preflight

- [ ] **Step 1: Confirm repository state without touching user files**

Run:

```bash
cd /home/omarques/Desktop/Projetos/Delivery
git status --short
git branch --show-current
```

Expected: the current branch is `main`; `apps/web/.env.development` and `apps/driver/.env.development` may be modified and must remain untouched.

- [ ] **Step 2: Create the isolated implementation worktree**

Use `superpowers:using-git-worktrees` and create:

```text
branch: feat/mp-card-retry-pix-sandbox
worktree: /home/omarques/Desktop/Projetos/Delivery/.worktrees/mp-card-retry-pix-sandbox
```

Expected: the worktree starts from the commit containing this plan and has no copied secret/env changes.

- [ ] **Step 3: Establish the focused baseline**

Run inside the new worktree:

```bash
pnpm --filter @delivery/api test -- orders.routes.test.ts payment-operation.service.test.ts mercadopago.test.ts
pnpm --filter @delivery/web test -- CheckoutView.test.ts OrderTrackingView.test.ts
pnpm --filter @delivery/api typecheck
pnpm --filter @delivery/web typecheck
```

Expected: all commands pass before implementation. Stop on a baseline failure.

---

### Task 1: Make rejected card attempts safely retryable

**Files:**
- Modify: `apps/api/src/services/order.service.ts`
- Modify: `apps/api/src/routes/orders.ts`
- Modify: `apps/api/src/payments/checkout.service.ts`
- Modify: `apps/api/test/orders.routes.test.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/web/src/views/CheckoutView.vue`
- Modify: `apps/web/src/views/CheckoutView.test.ts`

**Interfaces:**
- Consumes: existing `CheckoutError(code, status, providerError?)`, `getOrderPayment(db, orderId)`, and web `ApiError` fields `status` and `code`.
- Produces: `CreateOrderResult.payment.qrCodeBase64: string | null`; rejected idempotent replay returns JSON `{ error: string, code: 'PAYMENT_REJECTED' }` with status 402; the browser rotates its attempt UUID only after that exact outcome.

- [ ] **Step 1: Add API route tests for stable rejection and semantic replay**

In `apps/api/test/orders.routes.test.ts`, extend the existing online-card block with a test that uses one checkout body twice and verifies only one provider create:

```ts
it('returns the same safe 402 outcome when a rejected card attempt is replayed', async () => {
  const createOrder = vi.fn(async (input: Parameters<PaymentProvider['createOrder']>[0]) => providerSnapshot({
    providerOrderId: `mp-${input.orderId}`,
    providerTransactionId: `tx-${input.orderId}`,
    externalReference: input.orderId,
    method: 'CARD',
    paymentMethodId: 'visa',
    orderStatus: 'failed',
    orderStatusDetail: 'rejected',
    transactionStatus: 'failed',
    transactionStatusDetail: 'rejected',
    pix: null,
  }))
  vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(fakePaymentProvider({ createOrder }))
  const body = checkout({
    paymentMethod: 'CARD_ONLINE',
    cardToken: 'card-token-test',
    cardPaymentMethodId: 'visa',
    idempotencyKey: crypto.randomUUID(),
  })

  const first = await req('/orders', { method: 'POST', body: JSON.stringify(body) }, customerToken)
  const replay = await req('/orders', { method: 'POST', body: JSON.stringify(body) }, customerToken)

  expect(first.status).toBe(402)
  expect(replay.status).toBe(402)
  await expect(first.json()).resolves.toMatchObject({ code: 'PAYMENT_REJECTED' })
  await expect(replay.json()).resolves.toMatchObject({ code: 'PAYMENT_REJECTED' })
  expect(createOrder).toHaveBeenCalledTimes(1)
})
```

Use the existing imports from `test/helpers/payment-provider`; add the missing `PaymentProvider` type import only if the file does not already have it.

- [ ] **Step 2: Add API service tests for every replay classification**

In `apps/api/test/payment.service.test.ts`, add table-driven assertions after creating an online attempt and persisting each state:

```ts
it.each([
  ['REJECTED', 'HEALTHY', 'PAYMENT_REJECTED', 402],
  ['CANCELLED', 'HEALTHY', 'PAYMENT_REJECTED', 402],
  ['EXPIRED', 'HEALTHY', 'PAYMENT_REJECTED', 402],
  ['PENDING', 'REVIEW_REQUIRED', 'PAYMENT_REVIEW_REQUIRED', 503],
] as const)('preserves %s/%s on idempotent checkout replay', async (status, reconciliationState, code, httpStatus) => {
  const fixture = await createOnlineOrderAttempt({ method: 'CARD' })
  await testDb.update(payments).set({ status, reconciliationState }).where(eq(payments.id, fixture.payment.id))

  await expect(createOrder(
    testDb,
    fixture.customerId,
    fixture.checkout,
    fixture.paymentContext,
  )).rejects.toMatchObject({ code, status: httpStatus })
})
```

If the existing file has no combined `createOnlineOrderAttempt` helper, add this exact local helper using its current customer/product/provider fixtures:

```ts
async function createOnlineOrderAttempt(options: { method: 'PIX' | 'CARD' }) {
  const checkoutInput = {
    storeSlug: 'pizzaria',
    fulfillment: 'PICKUP' as const,
    paymentMethod: options.method === 'PIX' ? 'PIX_ONLINE' as const : 'CARD_ONLINE' as const,
    items: [{ productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
    ...(options.method === 'CARD'
      ? { cardToken: 'card-token-test', cardPaymentMethodId: 'visa', installments: 1 as const }
      : {}),
  }
  const paymentContext = {
    provider: fakePaymentProvider({
      createOrder: vi.fn(async (input) => providerSnapshot({
        providerOrderId: `mp-${input.orderId}`,
        providerTransactionId: `tx-${input.orderId}`,
        externalReference: input.orderId,
        method: input.method,
        paymentMethodId: input.method === 'PIX' ? 'pix' : 'visa',
        orderStatus: input.method === 'PIX' ? 'action_required' : 'processed',
        orderStatusDetail: input.method === 'PIX' ? 'waiting_transfer' : 'accredited',
        transactionStatus: input.method === 'PIX' ? 'action_required' : 'processed',
        transactionStatusDetail: input.method === 'PIX' ? 'waiting_transfer' : 'accredited',
        pix: input.method === 'PIX'
          ? { qrCode: 'copy-paste', qrCodeBase64: 'base64', ticketUrl: null, expiresAt: input.expiresAt }
          : null,
      })),
    }),
    payerEmail: 'payer@test.local',
    applicationId: 'app-test',
    accountId: 'account-test',
    liveMode: false,
  }
  const result = await createOrder(testDb, customerId, checkoutInput, paymentContext)
  const [payment] = await testDb.select().from(payments).where(eq(payments.orderId, result.order.id))
  return { customerId, checkout: checkoutInput, paymentContext, payment: payment! }
}
```

Add the positive replay cases:

```ts
it('returns an approved card order on replay without another provider create', async () => {
  const fixture = await createOnlineOrderAttempt({ method: 'CARD' })

  const replay = await createOrder(testDb, fixture.customerId, fixture.checkout, fixture.paymentContext)

  expect(replay.order.id).toBe(fixture.payment.orderId)
  expect(replay.payment).toBeNull()
  expect(vi.mocked(fixture.paymentContext.provider!.createOrder)).toHaveBeenCalledTimes(1)
})

it('returns stored PIX copy code when its base64 image is absent', async () => {
  const fixture = await createOnlineOrderAttempt({ method: 'PIX' })
  await testDb.update(payments).set({
    status: 'PENDING',
    qrCode: 'copy-paste',
    qrCodeBase64: null,
  }).where(eq(payments.id, fixture.payment.id))

  const replay = await createOrder(testDb, fixture.customerId, fixture.checkout, fixture.paymentContext)

  expect(replay.payment).toMatchObject({ qrCode: 'copy-paste', qrCodeBase64: null })
})
```

- [ ] **Step 3: Run API tests and verify RED**

Run:

```bash
pnpm --filter @delivery/api test -- orders.routes.test.ts payment.service.test.ts
```

Expected: failures show rejected replay returning 201, missing JSON `code`, and nullable PIX base64 not being accepted.

- [ ] **Step 4: Classify existing checkout attempts before returning them**

In `apps/api/src/services/order.service.ts`, import `CheckoutError` from `../payments/checkout.service`, make the PIX image nullable, and replace `resultFromExisting` with:

```ts
export type CreateOrderResult = {
  order: typeof orders.$inferSelect
  payment: { qrCode: string; qrCodeBase64: string | null; expiresAt: string } | null
}

async function resultFromExisting(db: Db, order: typeof orders.$inferSelect): Promise<CreateOrderResult> {
  const payment = await getOrderPayment(db, order.id)
  if (!payment) return { order, payment: null }

  if (payment.status === 'REJECTED' || payment.status === 'CANCELLED' || payment.status === 'EXPIRED') {
    throw new CheckoutError('PAYMENT_REJECTED', 402)
  }
  if (payment.reconciliationState === 'REVIEW_REQUIRED') {
    throw new CheckoutError('PAYMENT_REVIEW_REQUIRED', 503)
  }
  if (payment.status === 'PENDING' && payment.providerOrderId === null) {
    throw new CheckoutError('PAYMENT_UNCERTAIN', 503)
  }
  if (payment.method === 'PIX' && payment.qrCode) {
    return {
      order,
      payment: {
        qrCode: payment.qrCode,
        qrCodeBase64: payment.qrCodeBase64,
        expiresAt: (payment.expiresAt ?? new Date()).toISOString(),
      },
    }
  }
  return { order, payment: null }
}
```

This intentionally returns the existing order for approved/pending card attempts and never performs another provider create for the same key.

- [ ] **Step 5: Preserve a copy-and-paste PIX without a base64 image**

In `apps/api/src/payments/checkout.service.ts`, change both PIX result unions to:

```ts
{ kind: 'PIX'; qrCode: string; qrCodeBase64: string | null; expiresAt: string }
```

Replace both stored-result guards:

```ts
if (current.method === 'PIX' && current.qrCode) {
  return {
    kind: 'PIX',
    qrCode: current.qrCode,
    qrCodeBase64: current.qrCodeBase64,
    expiresAt: (current.expiresAt ?? new Date()).toISOString(),
  }
}
```

Keep `snapshot.pix.qrCodeBase64` unchanged in returned fresh snapshots; Task 2 makes its provider type nullable.

- [ ] **Step 6: Return a stable safe checkout code from the Hono route**

In `apps/api/src/routes/orders.ts`, replace only the `CheckoutError` arm in `rethrow` with:

```ts
if (e instanceof CheckoutError) {
  if (e.providerError && diagnosticContext) logPaymentProviderFailure(e.providerError, diagnosticContext)
  const message = e.code === 'PAYMENT_REJECTED'
    ? 'Pagamento recusado — revise os dados ou tente outro cartão'
    : 'Pagamento indisponível no momento — tente novamente ou use pagamento na entrega'
  throw new HTTPException(e.status, {
    res: Response.json({ error: message, code: e.code }, { status: e.status }),
  })
}
```

Do not include `providerError`, upstream status, raw body, payment identifier, card token, or payer data in the response.

- [ ] **Step 7: Add frontend tests for key rotation and key retention**

In `apps/web/src/views/CheckoutView.test.ts`, make the Brick mock capture its submit callback:

```ts
const cardSubmit = vi.hoisted(() => ({ current: null as null | ((data: CardFormData) => Promise<void>) }))

vi.mock('../lib/mp-brick', () => ({
  cardConfigured: () => true,
  mountCardBrick: vi.fn(async (_container: string, _amount: number, onSubmit: (data: CardFormData) => Promise<void>) => {
    cardSubmit.current = onSubmit
    return vi.fn()
  }),
}))
```

Add a helper that extracts `/orders` bodies:

```ts
function orderBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([input, init]) => new URL(String(input)).pathname === '/orders' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as { idempotencyKey: string })
}
```

Add these tests:

```ts
it('rotates the card attempt key only after PAYMENT_REJECTED', async () => {
  const fetchMock = apiMock()
  fetchMock
    .mockImplementationOnce(apiMock())
  const { wrapper } = await mountCheckout(fetchMock)
  ;(wrapper.vm as unknown as { paymentMethod: string }).paymentMethod = 'CARD_ONLINE'
  await flushPromises()

  fetchMock.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === '/orders' && init?.method === 'POST' && orderBodies(fetchMock).length === 1) {
      return new Response(JSON.stringify({ error: 'Pagamento recusado', code: 'PAYMENT_REJECTED' }), { status: 402 })
    }
    if (path === '/orders' && init?.method === 'POST') {
      return new Response(JSON.stringify({ order: { id: 'order-2' }, payment: null }), { status: 201 })
    }
    return apiMock()(input, init)
  })

  await cardSubmit.current!({ token: 'token-1', payment_method_id: 'visa' })
  await flushPromises()
  await cardSubmit.current!({ token: 'token-2', payment_method_id: 'visa' })
  await flushPromises()

  const bodies = orderBodies(fetchMock)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]!.idempotencyKey).not.toBe(bodies[0]!.idempotencyKey)
  expect(replace).toHaveBeenCalledWith('/pedido/order-2')
  wrapper.unmount()
})

it.each([
  [503, 'PAYMENT_UNCERTAIN'],
  [503, 'PAYMENT_REVIEW_REQUIRED'],
] as const)('retains the card attempt key after %s %s', async (status, code) => {
  const responses = [
    new Response(JSON.stringify({ error: 'Indisponível', code }), { status }),
    new Response(JSON.stringify({ error: 'Indisponível', code }), { status }),
  ]
  const fallback = apiMock()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/orders' && init?.method === 'POST') return responses.shift()!
    return fallback(input, init)
  })
  const { wrapper } = await mountCheckout(fetchMock)
  ;(wrapper.vm as unknown as { paymentMethod: string }).paymentMethod = 'CARD_ONLINE'
  await flushPromises()

  await cardSubmit.current!({ token: 'token-1', payment_method_id: 'visa' })
  await flushPromises()
  await cardSubmit.current!({ token: 'token-2', payment_method_id: 'visa' })
  await flushPromises()

  const bodies = orderBodies(fetchMock)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey)
  wrapper.unmount()
})
```

Add a network-failure case with two submissions and assert the UUID is unchanged:

```ts
it('retains the card attempt key after a network failure', async () => {
  const fallback = apiMock()
  let orderCalls = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/orders' && init?.method === 'POST') {
      orderCalls++
      if (orderCalls === 1) throw new TypeError('network unavailable')
      return new Response(JSON.stringify({ error: 'Indisponível', code: 'PAYMENT_UNCERTAIN' }), { status: 503 })
    }
    return fallback(input, init)
  })
  const { wrapper } = await mountCheckout(fetchMock)
  ;(wrapper.vm as unknown as { paymentMethod: string }).paymentMethod = 'CARD_ONLINE'
  await flushPromises()

  await cardSubmit.current!({ token: 'token-1', payment_method_id: 'visa' })
  await flushPromises()
  await cardSubmit.current!({ token: 'token-2', payment_method_id: 'visa' })
  await flushPromises()

  const bodies = orderBodies(fetchMock)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey)
  wrapper.unmount()
})
```

Add a concurrent-submit regression to preserve the existing `submitting` guard:

```ts
it('sends only one request when the card callback is submitted twice concurrently', async () => {
  const fallback = apiMock()
  let finishOrder!: (response: Response) => void
  const pendingOrder = new Promise<Response>((resolve) => { finishOrder = resolve })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/orders' && init?.method === 'POST') return pendingOrder
    return fallback(input, init)
  })
  const { wrapper } = await mountCheckout(fetchMock)
  ;(wrapper.vm as unknown as { paymentMethod: string }).paymentMethod = 'CARD_ONLINE'
  await flushPromises()

  const callback = cardSubmit.current!
  const first = callback({ token: 'token-1', payment_method_id: 'visa' })
  const second = callback({ token: 'token-2', payment_method_id: 'visa' })
  await Promise.resolve()
  expect(orderBodies(fetchMock)).toHaveLength(1)
  finishOrder(new Response(JSON.stringify({ order: { id: 'order-1' }, payment: null }), { status: 201 }))
  await Promise.all([first, second])
  wrapper.unmount()
})
```

Use the real `CardFormData` type import from `../lib/mp-brick`. If mocking `cardConfigured: true` changes existing contact tests, set their payment method to `CASH` explicitly before clicking; do not weaken their assertions.

- [ ] **Step 8: Rotate the key only on definitive rejection**

In `apps/web/src/views/CheckoutView.vue`, replace the constant with a mutable ref:

```ts
const idempotencyKey = ref(crypto.randomUUID())
```

Use its value in `checkoutBody`:

```ts
idempotencyKey: idempotencyKey.value,
```

Add the narrow type guard:

```ts
function isDefinitivePaymentRejection(error: unknown): error is Error & { status: number; code: string } {
  return error instanceof Error
    && (error as Error & { status?: number }).status === 402
    && (error as Error & { code?: string }).code === 'PAYMENT_REJECTED'
}
```

At the beginning of the card branch in `placeOrder`'s catch, rotate before remounting the Brick only for that outcome:

```ts
if (paymentMethod.value === 'CARD_ONLINE') {
  if (isDefinitivePaymentRejection(e)) idempotencyKey.value = crypto.randomUUID()
  cardData.value = null
  destroyCardBrick()
  await mountBrickIfReady()
}
```

Do not rotate for any other exception. Keep the existing `submitting` guard unchanged.

- [ ] **Step 9: Run focused and complete Task 1 verification**

Run:

```bash
pnpm --filter @delivery/api test -- orders.routes.test.ts payment.service.test.ts
pnpm --filter @delivery/web test -- CheckoutView.test.ts
pnpm --filter @delivery/api typecheck
pnpm --filter @delivery/web typecheck
pnpm --filter @delivery/api test
pnpm --filter @delivery/web test
git diff --check
```

Expected: all pass. Review the diff and confirm no provider content appears in an HTTP response or test snapshot.

- [ ] **Step 10: Commit Task 1**

```bash
git add \
  apps/api/src/services/order.service.ts \
  apps/api/src/routes/orders.ts \
  apps/api/src/payments/checkout.service.ts \
  apps/api/test/orders.routes.test.ts \
  apps/api/test/payment.service.test.ts \
  apps/web/src/views/CheckoutView.vue \
  apps/web/src/views/CheckoutView.test.ts
git commit -m "fix(payments): retry rejected card checkout"
```

Expected: one commit containing only Task 1 files.

### Task 2: Reconcile pending cancellation and add local PIX APRO

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/payments/provider.ts`
- Modify: `apps/api/src/payments/mercadopago.ts`
- Modify: `apps/api/src/payments/operation.service.ts`
- Modify: `apps/api/test/mercadopago.test.ts`
- Modify: `apps/api/test/payment-operation.service.test.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`
- Modify: `apps/api/test/helpers/payment-provider.ts`
- Modify: `apps/api/.dev.vars.example`
- Modify locally, never stage: `apps/api/.dev.vars`
- Modify: `apps/web/src/views/OrderTrackingView.vue`
- Modify: `apps/web/src/views/OrderTrackingView.test.ts`
- Modify: `docs/security/runbooks/mercado-pago-orders.md`

**Interfaces:**
- Consumes: existing `PaymentProvider.getOrder`, `cancelOrder`, `retryDisposition` maximum of eight attempts, `ensureCancelledOrderPaymentDisposition`, and canonical `refund-full:{paymentId}:ORDER_CANCELLED` business key.
- Produces: `ProviderOrderSnapshot.pix.qrCodeBase64: string | null`; `ProviderConfig.testPixScenario?: 'APRO' | null`; local-only `Env.MP_TEST_PIX_SCENARIO?: 'APRO'`; read-before-mutate cancellation behavior.

- [ ] **Step 1: Add provider tests for the PIX APRO payload and nullable image**

In `apps/api/test/mercadopago.test.ts`, add:

```ts
it('uses the official PIX APRO payer only when configured', async () => {
  const fetchMock = vi.fn(async () => response(snapshot({
    status: 'action_required',
    status_detail: 'waiting_transfer',
    transactions: { payments: [{
      id: 'transaction-test', status: 'action_required', status_detail: 'waiting_transfer', amount: '64.00',
      payment_method: { id: 'pix', type: 'bank_transfer', qr_code: 'copy-paste', qr_code_base64: '' },
    }] },
  })))
  vi.stubGlobal('fetch', fetchMock)
  const apro = new MercadoPagoOrdersProvider(token, {
    applicationId: 'app-test', accountId: 'account-test', liveMode: false, testPixScenario: 'APRO',
  })

  const result = await apro.createOrder({
    orderId: 'order-1', amountCents: 6400, payerEmail: 'ignored@test.local',
    idempotencyKey: 'pix-apro-key', method: 'PIX', expiresAt: new Date('2026-07-17T12:30:00Z'),
  })

  const [, init] = fetchMock.mock.calls[0]!
  expect(JSON.parse(String(init?.body)).payer).toEqual({
    email: 'test_user_br@testuser.com',
    first_name: 'APRO',
  })
  expect(result.pix).toMatchObject({ qrCode: 'copy-paste', qrCodeBase64: null })
})

it('keeps the normal PIX payer when the scenario is empty', async () => {
  const fetchMock = vi.fn(async () => response(snapshot()))
  vi.stubGlobal('fetch', fetchMock)
  await provider.createOrder({
    orderId: 'order-1', amountCents: 6400, payerEmail: 'payer@test.local',
    idempotencyKey: 'pix-normal-key', method: 'PIX', expiresAt: new Date('2026-07-17T12:30:00Z'),
  })
  const [, init] = fetchMock.mock.calls[0]!
  expect(JSON.parse(String(init?.body)).payer).toEqual({ email: 'payer@test.local' })
})
```

Replace the current test that rejects missing `qr_code_base64`: it must continue rejecting missing/empty `qr_code`, but must accept missing or empty `qr_code_base64` and normalize it to null.

- [ ] **Step 2: Add fail-closed factory tests**

Extend the factory test in `apps/api/test/mercadopago.test.ts`:

```ts
const localSandbox = {
  ...env,
  APP_ENV: 'local',
  MP_LIVE_MODE: 'false',
  MP_TEST_PIX_SCENARIO: 'APRO',
} as Env
expect(createPaymentProvider(localSandbox)).toBeInstanceOf(MercadoPagoOrdersProvider)
expect(createPaymentProvider({ ...localSandbox, MP_TEST_PIX_SCENARIO: 'UNKNOWN' } as unknown as Env)).toBeNull()
expect(createPaymentProvider({ ...localSandbox, MP_LIVE_MODE: 'true' })).toBeNull()
expect(createPaymentProvider({ ...localSandbox, APP_ENV: 'staging' })).toBeNull()
expect(createPaymentProvider({ ...localSandbox, APP_ENV: 'production' })).toBeNull()
```

Assert `fetch` has not been called by these factory checks.

- [ ] **Step 3: Add operation tests proving read-before-mutate**

In `apps/api/test/payment-operation.service.test.ts`, add these three focused cases using the existing `payment`, `snapshot`, `provider`, queue, and claim helpers:

```ts
it('polls processing cancellation without calling Cancel Order', async () => {
  const row = await payment()
  const now = new Date('2026-07-17T12:00:00.000Z')
  const queued = await enqueuePaymentOperation(testDb, {
    paymentId: row.id, type: 'CANCEL', amountCents: null,
    businessKey: `cancel-processing:${row.id}`, idempotencyKey: `cancel-processing:${row.id}`,
  }, now)
  const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
  const getOrder = vi.fn(async () => snapshot(row.providerOrderId!, row.expectedAmountCents, {
    providerTransactionId: row.providerTransactionId!, externalReference: row.orderId,
    orderStatus: 'processing', orderStatusDetail: 'in_process',
    transactionStatus: 'processing', transactionStatusDetail: 'in_process', refundedAmountCents: 0,
  }))
  const cancelOrder = vi.fn()

  await processPaymentOperation(testDb, provider({ getOrder, cancelOrder }), operationId!, 'worker-a', now)

  expect(getOrder).toHaveBeenCalledTimes(1)
  expect(cancelOrder).not.toHaveBeenCalled()
  expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
    status: 'PENDING', failureClass: 'CANCEL_PENDING', leaseOwner: null, leasedUntil: null,
  })
})

it('calls Cancel Order once only when the read is action_required', async () => {
  const row = await payment()
  const now = new Date('2026-07-17T12:00:00.000Z')
  const queued = await enqueuePaymentOperation(testDb, {
    paymentId: row.id, type: 'CANCEL', amountCents: null,
    businessKey: `cancel-actionable:${row.id}`, idempotencyKey: `cancel-actionable:${row.id}`,
  }, now)
  const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
  const actionable = snapshot(row.providerOrderId!, row.expectedAmountCents, {
    providerTransactionId: row.providerTransactionId!, externalReference: row.orderId,
    orderStatus: 'action_required', orderStatusDetail: 'waiting_transfer',
    transactionStatus: 'action_required', transactionStatusDetail: 'waiting_transfer', refundedAmountCents: 0,
  })
  const canceled = { ...actionable, orderStatus: 'canceled', orderStatusDetail: 'canceled', transactionStatus: 'canceled', transactionStatusDetail: 'canceled' }
  const cancelOrder = vi.fn(async () => canceled)

  await processPaymentOperation(testDb, provider({ getOrder: vi.fn(async () => actionable), cancelOrder }), operationId!, 'worker-a', now)

  expect(cancelOrder).toHaveBeenCalledWith(row.providerOrderId, queued.idempotencyKey)
  expect(cancelOrder).toHaveBeenCalledTimes(1)
  expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
    status: 'SUCCEEDED', resultCode: 'CANCELLED', failureClass: null,
  })
})

it('escalates a later approval to exactly one canonical refund without another cancel', async () => {
  const row = await payment()
  const firstNow = new Date('2026-07-17T12:00:00.000Z')
  const queued = await enqueuePaymentOperation(testDb, {
    paymentId: row.id, type: 'CANCEL', amountCents: null,
    businessKey: `cancel-late-approval:${row.id}`, idempotencyKey: `cancel-late-approval:${row.id}`,
  }, firstNow)
  const cancelOrder = vi.fn()
  const processing = snapshot(row.providerOrderId!, row.expectedAmountCents, {
    providerTransactionId: row.providerTransactionId!, externalReference: row.orderId,
    orderStatus: 'processing', orderStatusDetail: 'in_process',
    transactionStatus: 'processing', transactionStatusDetail: 'in_process', refundedAmountCents: 0,
  })
  const approved = snapshot(row.providerOrderId!, row.expectedAmountCents, {
    providerTransactionId: row.providerTransactionId!, externalReference: row.orderId,
    orderStatus: 'processed', orderStatusDetail: 'accredited',
    transactionStatus: 'processed', transactionStatusDetail: 'accredited', refundedAmountCents: 0,
  })
  const getOrder = vi.fn().mockResolvedValueOnce(processing).mockResolvedValueOnce(approved)

  const [firstId] = await claimDueOperations(testDb, firstNow, 1, 'worker-a')
  await processPaymentOperation(testDb, provider({ getOrder, cancelOrder }), firstId!, 'worker-a', firstNow)
  const [stored] = await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id))
  const secondNow = new Date(stored!.nextAttemptAt!.getTime() + 1)
  const [secondId] = await claimDueOperations(testDb, secondNow, 1, 'worker-b')
  await processPaymentOperation(testDb, provider({ getOrder, cancelOrder }), secondId!, 'worker-b', secondNow)

  expect(cancelOrder).not.toHaveBeenCalled()
  const operations = await testDb.select().from(paymentOperations).where(eq(paymentOperations.paymentId, row.id))
  expect(operations.find((operation) => operation.id === queued.id)).toMatchObject({
    status: 'SUCCEEDED', resultCode: 'ESCALATED_TO_REFUND',
  })
  expect(operations.filter((operation) => operation.type === 'REFUND_FULL')).toHaveLength(1)
  expect((await testDb.select().from(orders).where(eq(orders.id, row.orderId)))[0]!.status).toBe('CANCELLED')
})
```

Update existing direct-cancel tests so each provider supplies an initial `getOrder`. Keep the existing attempt-eight, duplicate-queue, cancelled-order, store-scope, and dispatch-scope assertions.

Add a terminal read table proving no mutation occurs and the commercial resolution is final:

```ts
it.each([
  ['failed', 'rejected', 'failed', 'rejected', 0, 'NOT_CHARGED'],
  ['canceled', 'canceled', 'canceled', 'canceled', 0, 'CANCELLED'],
  ['expired', 'expired', 'expired', 'expired', 0, 'NOT_CHARGED'],
  ['refunded', 'refunded', 'refunded', 'refunded', 6000, 'REFUNDED'],
] as const)('settles cancel from terminal read %s/%s without mutation', async (
  orderStatus,
  orderStatusDetail,
  transactionStatus,
  transactionStatusDetail,
  refundedAmountCents,
  resultCode,
) => {
  const row = await payment()
  const now = new Date('2026-07-17T12:00:00.000Z')
  const queued = await enqueuePaymentOperation(testDb, {
    paymentId: row.id, type: 'CANCEL', amountCents: null,
    businessKey: `cancel-terminal:${orderStatus}:${row.id}`,
    idempotencyKey: `cancel-terminal:${orderStatus}:${row.id}`,
  }, now)
  const [operationId] = await claimDueOperations(testDb, now, 1, 'worker-a')
  const cancelOrder = vi.fn()
  await processPaymentOperation(testDb, provider({
    getOrder: vi.fn(async () => snapshot(row.providerOrderId!, row.expectedAmountCents, {
      providerTransactionId: row.providerTransactionId!, externalReference: row.orderId,
      orderStatus, orderStatusDetail, transactionStatus, transactionStatusDetail, refundedAmountCents,
    })),
    cancelOrder,
  }), operationId!, 'worker-a', now)

  expect(cancelOrder).not.toHaveBeenCalled()
  expect((await testDb.select().from(paymentOperations).where(eq(paymentOperations.id, queued.id)))[0]).toMatchObject({
    status: 'SUCCEEDED', resultCode,
  })
})
```

The existing attempt-eight test must pass an initial pending `getOrder` for `CANCEL` and assert `cancelOrder` remains uncalled; this proves eight unresolved reads, rather than eight invalid mutations, end in review.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @delivery/api test -- mercadopago.test.ts payment-operation.service.test.ts payment-reconciliation.test.ts
```

Expected: failures show strict base64 normalization, missing PIX test config, and `cancelOrder` being called before `getOrder` for processing payments.

- [ ] **Step 5: Make PIX base64 nullable end to end**

In `apps/api/src/payments/provider.ts`, change only this field:

```ts
pix: {
  qrCode: string
  qrCodeBase64: string | null
  ticketUrl: string | null
  expiresAt: Date | null
} | null
```

In `apps/api/src/payments/mercadopago.ts`, normalize the image with `optionalString`:

```ts
const pix = method === 'PIX' && !terminalPix
  ? {
      qrCode: requiredString(paymentMethod.qr_code),
      qrCodeBase64: optionalString(paymentMethod.qr_code_base64),
      ticketUrl: optionalString(paymentMethod.ticket_url),
      expiresAt: dateOrNull(transaction.date_of_expiration ?? order.date_of_expiration),
    }
  : null
```

No schema change is needed because `payments.qr_code_base64` is already nullable. Update `apps/api/test/helpers/payment-provider.ts` only where TypeScript fixtures require the nullable type; keep its default non-null image.

- [ ] **Step 6: Add and validate the local-only PIX scenario**

In `apps/api/src/env.ts`, add beside the other Mercado Pago fields:

```ts
/** Local sandbox only: official Mercado Pago automatic PIX approval fixture. */
MP_TEST_PIX_SCENARIO?: 'APRO'
```

In `apps/api/src/payments/mercadopago.ts`, change the config type and add the resolver:

```ts
type ProviderConfig = {
  applicationId: string
  accountId: string
  liveMode: boolean
  testPixScenario?: 'APRO' | null
}

function resolveTestPixScenario(env: Env): 'APRO' | null {
  const value = env.MP_TEST_PIX_SCENARIO?.trim()
  if (!value) return null
  if (value !== 'APRO' || env.APP_ENV !== 'local' || env.MP_LIVE_MODE !== 'false') {
    throw new PaymentProviderError('CREDENTIAL_OR_CONFIG')
  }
  return 'APRO'
}
```

Build the payer in `createOrder`:

```ts
const payer = input.method === 'PIX' && this.config.testPixScenario === 'APRO'
  ? { email: 'test_user_br@testuser.com', first_name: 'APRO' }
  : { email: input.payerEmail }
```

Use `payer` in the existing JSON body. Replace the factory with:

```ts
export function createPaymentProvider(env: Env): PaymentProvider | null {
  if (!env.MP_ACCESS_TOKEN || !env.MP_APPLICATION_ID || !env.MP_ACCOUNT_ID
    || (env.MP_LIVE_MODE !== 'true' && env.MP_LIVE_MODE !== 'false')) return null
  try {
    return new MercadoPagoOrdersProvider(env.MP_ACCESS_TOKEN, {
      applicationId: env.MP_APPLICATION_ID,
      accountId: env.MP_ACCOUNT_ID,
      liveMode: env.MP_LIVE_MODE === 'true',
      testPixScenario: resolveTestPixScenario(env),
    })
  } catch (error) {
    if (error instanceof PaymentProviderError && error.kind === 'CREDENTIAL_OR_CONFIG') return null
    throw error
  }
}
```

This rejection occurs before provider I/O and causes the existing checkout fail-closed 503 path.

- [ ] **Step 7: Read the provider before attempting cancellation**

In `apps/api/src/payments/operation.service.ts`, add:

```ts
function canCancelProviderOrder(snapshot: Awaited<ReturnType<PaymentProvider['getOrder']>>): boolean {
  return snapshot.orderStatus.toLowerCase() === 'action_required'
}
```

Replace the operation selection inside `processPaymentOperation`'s `try` with:

```ts
let snapshot
if (operation.type === 'CANCEL') {
  const current = await provider.getOrder(payment.providerOrderId)
  if (!canCancelProviderOrder(current)) {
    await settleSnapshot(db, operation, current, now)
    return
  }
  snapshot = await provider.cancelOrder(payment.providerOrderId, operation.idempotencyKey)
} else if (operation.type === 'REFUND_FULL') {
  snapshot = await provider.refundOrder(payment.providerOrderId, operation.idempotencyKey)
} else {
  snapshot = await provider.refundPartial(
    payment.providerOrderId,
    payment.providerTransactionId ?? '',
    operation.amountCents!,
    operation.idempotencyKey,
  )
}
await settleSnapshot(db, operation, snapshot, now)
```

Do not special-case `processing` strings in this function: the existing transition/evaluation maps supported nonterminal snapshots to `PENDING`, and `settleSnapshot` persists `CANCEL_PENDING`, bounded backoff, and attempt-eight review. Approved reads retain the existing `ESCALATED_TO_REFUND` path and canonical refund deduplication.

- [ ] **Step 8: Update customer copy and its assertion**

In `apps/web/src/views/OrderTrackingView.vue`, replace only the `PROCESSING` sentence with:

```html
<p v-if="order.paymentResolution === 'PROCESSING'">
  Pedido cancelado. O pagamento ainda está em análise. Se for aprovado, o estorno será realizado automaticamente.
</p>
```

In `apps/web/src/views/OrderTrackingView.test.ts`, add:

```ts
it('explains automatic refund while canceled payment remains under analysis', async () => {
  mocks.api.mockResolvedValueOnce({ ...baseOrder, status: 'CANCELLED', paymentResolution: 'PROCESSING' })
  const wrapper = mount(OrderTrackingView, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
  await flushPromises()
  expect(wrapper.text()).toContain('O pagamento ainda está em análise')
  expect(wrapper.text()).toContain('o estorno será realizado automaticamente')
  wrapper.unmount()
})
```

- [ ] **Step 9: Document the toggle and manual proof without secrets**

Add to `apps/api/.dev.vars.example` next to `MP_TEST_PAYER_EMAIL`:

```dotenv
# Vazio = PIX pendente normal; APRO = fixture oficial de aprovação automática, somente local sandbox.
MP_TEST_PIX_SCENARIO=
```

Ensure the ignored local `apps/api/.dev.vars` has one line `MP_TEST_PIX_SCENARIO=` without printing the file. Verify it remains ignored:

```bash
git check-ignore -q apps/api/.dev.vars
```

In `docs/security/runbooks/mercado-pago-orders.md`, add a `## Cenários PIX locais` section with these exact operational rules:

```markdown
## Cenários PIX locais

- `MP_TEST_PIX_SCENARIO=` mantém o QR PIX pendente normal para expiração e cancelamento.
- `MP_TEST_PIX_SCENARIO=APRO` usa a fixture oficial de aprovação automática do Mercado Pago.
- `APRO` é permitido somente com `APP_ENV=local` e `MP_LIVE_MODE=false`; staging, produção, live mode e qualquer outro valor falham fechados antes de I/O externo.
- Reinicie `pnpm dev:api` após alternar o valor.
- A resposta inicial pode conter somente o código copia-e-cola; imagem base64 vazia não invalida o PIX.
- Confirme aprovação pela tela do pedido, liberação única para a loja e projeção sanitizada. Não registre QR, email, token ou identificador integral.
```

Also update the cancellation section to state that each `CANCEL` tick performs `GET Order` first, calls `Cancel Order` only for `action_required`, and polls `processing/in_process` read-only until terminal outcome or attempt eight.

- [ ] **Step 10: Run Task 2 focused verification**

Run:

```bash
pnpm --filter @delivery/api test -- mercadopago.test.ts payment-operation.service.test.ts payment-reconciliation.test.ts
pnpm --filter @delivery/web test -- OrderTrackingView.test.ts
pnpm --filter @delivery/api typecheck
pnpm --filter @delivery/web typecheck
```

Expected: all pass; processing cancellation never calls `cancelOrder`, actionable cancellation calls it once, late approval creates one refund, and PIX `APRO` payload/fail-closed cases pass.

- [ ] **Step 11: Run the complete repository gate**

Use `superpowers:verification-before-completion`, then run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
git status --short
```

Expected: all commands pass. Status contains only Task 2 tracked files plus the already committed Task 1 changes; ignored `.dev.vars` and user-owned `.env.development` files are absent.

- [ ] **Step 12: Review provider-boundary safety**

Run:

```bash
git diff -- apps/api/src/payments apps/api/src/routes/orders.ts apps/web/src/views
rg -n "MP_TEST_PIX_SCENARIO|test_user_br@testuser.com|first_name" apps/api apps/web --glob '!apps/api/.dev.vars' --glob '!**/node_modules/**'
```

Expected: the fixture exists only in the server adapter/tests/docs; no browser request/schema accepts the scenario; no secret or raw provider body appears in the diff.

- [ ] **Step 13: Commit Task 2**

```bash
git add \
  apps/api/src/env.ts \
  apps/api/src/payments/provider.ts \
  apps/api/src/payments/mercadopago.ts \
  apps/api/src/payments/operation.service.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/test/payment-operation.service.test.ts \
  apps/api/test/payment-reconciliation.test.ts \
  apps/api/test/helpers/payment-provider.ts \
  apps/api/.dev.vars.example \
  apps/web/src/views/OrderTrackingView.vue \
  apps/web/src/views/OrderTrackingView.test.ts \
  docs/security/runbooks/mercado-pago-orders.md
git commit -m "fix(payments): reconcile pending cancel and PIX"
```

Expected: `.dev.vars` is not staged and the commit contains no secret or user-owned environment file.

## Manual Acceptance After Implementation

Run with API, web, and local cron in separate terminals. Reset disposable local data before these checks.

1. Leave `MP_TEST_PIX_SCENARIO=` and create PIX: QR/copy code appears, remains `AWAITING_PAYMENT`, and normal expiration/cancellation still works.
2. Set `MP_TEST_PIX_SCENARIO=APRO`, restart API, create PIX: initial QR/copy code may omit the image; provider auto-approval transitions the order once and releases it once to the store.
3. Create card `OTHE`, then submit `APRO` without leaving checkout: first request is 402, second uses a new application idempotency key and opens the new approved order.
4. Create card `OTHE`, then submit `CONT`: second attempt uses a new key and opens the new pending order.
5. Cancel `CONT`: order becomes commercially cancelled immediately; each cron tick reads provider status without repeated Cancel Order calls. If later approved, one full refund is created; otherwise it ends not charged or reaches review at attempt eight.
6. Confirm cancelled orders never reappear in store active work or driver dispatch, including after webhook/cron reconciliation.

Record only PASS/FAIL, source commit, sanitized counts, and final application states. Never record PIX payloads, card tokens, emails, secrets, response bodies, or provider identifiers.

# Cancellation Request and Terminal PIX Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline; do not dispatch subagents.

**Goal:** Make browser direct cancellation reach the authenticated API route and let terminal Mercado Pago PIX snapshots settle after QR artifacts disappear.

**Architecture:** Keep the security middleware and generic API wrapper unchanged. Send an explicit empty JSON object only from the direct-cancellation UI call, then make Mercado Pago normalization discard QR artifacts for terminal PIX statuses while preserving fail-closed validation for active PIX.

**Tech Stack:** TypeScript 6, Vue 3, Hono 4, Vitest 4, Mercado Pago Orders API.

## Global Constraints

- Follow [the approved corrective design](../specs/2026-07-16-cancellation-request-terminal-pix-corrective-design.md).
- Work in an isolated worktree; preserve ignored/local environment files and do not print their values.
- Use TDD: observe each behavior-changing test fail before editing production code.
- Keep `securityBaseline`, the generic `api()` wrapper, database schema, payment transitions, operation semantics, and dashboard configuration unchanged.
- Never log or newly persist provider bodies, PIX payloads, payer data, credentials, card tokens, or complete provider identifiers.
- Do not call Mercado Pago, reset/reseed the database, deploy, push, or change external configuration.
- Review the diff and run every listed verification before committing.

---

### Task 1: Fix direct cancellation transport and terminal PIX normalization

**Files:**
- Modify: `apps/web/src/views/OrderTrackingView.test.ts`
- Modify: `apps/web/src/views/OrderTrackingView.vue`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/api/test/mercadopago.test.ts`
- Modify: `apps/api/src/payments/mercadopago.ts`

**Interfaces:**
- Consumes: `api<T>(path: string, init?: RequestInit, retried?: boolean): Promise<T>`; `MercadoPagoOrdersProvider.getOrder(providerOrderId): Promise<ProviderOrderSnapshot>`.
- Produces: direct cancellation calls `POST /orders/{id}/cancel` with the literal JSON body `{}`; terminal PIX snapshots normalize with `pix: null`; active PIX still requires both `qr_code` and `qr_code_base64`.
- Preserves: `ProviderOrderSnapshot` type, payment decision mapping, operation result codes, route authorization, and body security policy.

- [x] **Step 1: Write RED frontend cancellation contract**

Change the final assertion in `apps/web/src/views/OrderTrackingView.test.ts` to require the explicit empty JSON body:

```ts
expect(mocks.api).toHaveBeenCalledWith('/orders/order-1/cancel', {
  method: 'POST',
  body: JSON.stringify({}),
})
```

- [x] **Step 2: Run frontend test and verify RED**

Run:

```bash
pnpm --dir apps/web exec vitest run src/views/OrderTrackingView.test.ts
```

Expected: FAIL because the component currently calls the endpoint with only `{ method: 'POST' }`.

- [x] **Step 3: Write RED terminal PIX and active fail-closed tests**

In `apps/api/test/mercadopago.test.ts`, add this helper after `officialPixOrder`:

```ts
function pixWithoutQr(status: string, statusDetail: string) {
  return officialPixOrder({
    status,
    status_detail: statusDetail,
    transactions: { payments: [{
      id: 'PAY_TEST_PIX', amount: '64.00', refunded_amount: status === 'refunded' ? '64.00' : '0.00',
      status, status_detail: statusDetail,
      payment_method: { id: 'pix', type: 'bank_transfer' },
    }] },
  })
}
```

Add focused cases inside `describe('MercadoPagoOrdersProvider')`:

```ts
it.each([
  ['canceled', 'canceled_transaction'],
  ['expired', 'expired'],
  ['rejected', 'rejected'],
  ['processed', 'accredited'],
  ['refunded', 'refunded'],
] as const)('normalizes terminal PIX %s without stale QR artifacts', async (status, detail) => {
  vi.stubGlobal('fetch', vi.fn(async () => response(pixWithoutQr(status, detail))))

  await expect(provider.getOrder('ORD_TEST_PIX')).resolves.toMatchObject({
    orderStatus: status,
    transactionStatus: status,
    pix: null,
  })
})

it.each(['qr_code', 'qr_code_base64'] as const)(
  'rejects active PIX when %s is missing',
  async (missing) => {
    const paymentMethod = {
      id: 'pix', type: 'bank_transfer',
      qr_code: 'sanitized-copy-paste', qr_code_base64: 'sanitized-base64',
    }
    delete paymentMethod[missing]
    vi.stubGlobal('fetch', vi.fn(async () => response(officialPixOrder({
      transactions: { payments: [{
        id: 'PAY_TEST_PIX', amount: '64.00', refunded_amount: '0.00',
        status: 'action_required', status_detail: 'waiting_transfer',
        payment_method: paymentMethod,
      }] },
    }))))

    await expect(provider.getOrder('ORD_TEST_PIX')).rejects.toMatchObject({
      kind: 'PROVIDER_RESPONSE_INVALID',
    })
  },
)
```

If TypeScript rejects deleting a required inferred property, declare `paymentMethod` as `Record<string, unknown>`; do not weaken production types.

- [x] **Step 4: Run provider test and verify RED**

Run:

```bash
pnpm --dir apps/api exec vitest run test/mercadopago.test.ts
```

Expected: terminal PIX cases FAIL with `PROVIDER_RESPONSE_INVALID`; active missing-QR cases PASS as characterization of the fail-closed contract.

- [x] **Step 5: Implement explicit JSON cancellation request**

In `apps/web/src/views/OrderTrackingView.vue`, replace only the direct cancel request with:

```ts
await api(`/orders/${order.value.id}/cancel`, {
  method: 'POST',
  body: JSON.stringify({}),
})
```

Do not change `api.ts` or `security-baseline.ts`.

- [x] **Step 6: Document wrapper header behavior**

Add to `apps/web/src/lib/api.test.ts`:

```ts
it('marks an explicit empty JSON mutation body as application/json', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  await api('/orders/order-1/cancel', { method: 'POST', body: JSON.stringify({}) })

  const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  expect(init.credentials).toBe('include')
})
```

This is a characterization test for existing wrapper behavior. The behavior-changing RED test is Step 2.

- [x] **Step 7: Implement status-aware PIX normalization**

In `apps/api/src/payments/mercadopago.ts`, add beside the other module constants:

```ts
const TERMINAL_PIX_STATUSES = new Set([
  'processed', 'accredited', 'failed', 'rejected',
  'canceled', 'cancelled', 'expired', 'refunded',
])

function isTerminalPixStatus(...statuses: Array<string | null>): boolean {
  return statuses.some((status) => status !== null && TERMINAL_PIX_STATUSES.has(status.toLowerCase()))
}
```

Inside `normalize`, parse status values before constructing `pix` and replace the existing unconditional PIX artifact parsing:

```ts
const orderStatus = requiredString(order.status)
const transactionStatus = optionalString(transaction.status)
const terminalPix = method === 'PIX' && isTerminalPixStatus(orderStatus, transactionStatus)
const pix = method === 'PIX' && !terminalPix
  ? {
      qrCode: requiredString(paymentMethod.qr_code),
      qrCodeBase64: requiredString(paymentMethod.qr_code_base64),
      ticketUrl: optionalString(paymentMethod.ticket_url),
      expiresAt: dateOrNull(transaction.date_of_expiration ?? order.date_of_expiration),
    }
  : null
```

Reuse `orderStatus` and `transactionStatus` in the returned snapshot:

```ts
orderStatus,
orderStatusDetail: requiredString(order.status_detail),
transactionStatus,
transactionStatusDetail: optionalString(transaction.status_detail),
```

Do not alter status validation, transition logic, or operation evaluation.

- [x] **Step 8: Run focused GREEN tests**

Run:

```bash
pnpm --dir apps/web exec vitest run src/views/OrderTrackingView.test.ts src/lib/api.test.ts
pnpm --dir apps/api exec vitest run test/mercadopago.test.ts test/payment-operation.service.test.ts
```

Expected: PASS. Existing operation coverage must still show canceled snapshot result code `CANCELLED` and approved cancellation escalation to full refund.

- [x] **Step 9: Run package and repository gates**

Run:

```bash
pnpm --filter @delivery/web test
pnpm --filter @delivery/api test
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Expected: every command exits `0`; no secret or provider-body output appears.

- [x] **Step 10: Review exact scope and commit**

Run:

```bash
git status --short
git diff -- apps/web/src/views/OrderTrackingView.test.ts \
  apps/web/src/views/OrderTrackingView.vue \
  apps/web/src/lib/api.test.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/src/payments/mercadopago.ts
```

Expected: only the five planned implementation files and this corrected plan are changed; ignored/local env files and provider identifiers are absent.

Commit:

```bash
git add apps/web/src/views/OrderTrackingView.test.ts \
  apps/web/src/views/OrderTrackingView.vue \
  apps/web/src/lib/api.test.ts \
  apps/api/test/mercadopago.test.ts \
  apps/api/src/payments/mercadopago.ts \
  docs/superpowers/plans/2026-07-16-cancellation-request-terminal-pix-corrective-implementation.md
git commit -m "fix(payments): settle terminal PIX cancellation"
```

Do not merge, push, reset/reseed the database, or run sandbox mutations without a separate explicit instruction.

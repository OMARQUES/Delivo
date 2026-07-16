# Awaiting-Payment Cancellation Safety Design

**Status:** approved for implementation

**Goal:** Cancel online orders that remain `AWAITING_PAYMENT` for 30 minutes, allow the customer to cancel them earlier, ensure they cannot be released to the store after cancellation commits, and converge every Mercado Pago outcome to cancellation, full refund, or explicit financial review.

**Scope:** Mercado Pago Orders payments for PIX and card, the customer order-detail API and UI, payment reconciliation, payment-operation processing, sanitized operational evidence, and focused tests. No provider dashboard change, deployment, database reset, production activation, new order status, or unrelated UX redesign is included.

## Context

Online orders are created as `AWAITING_PAYMENT` and become visible to the store only after an authoritative provider snapshot changes them to `PENDING`. PIX already receives an expiration timestamp and has a reconciliation expiration stage. A card result such as Mercado Pago's test scenario `CONT` can remain `processing/in_process`; it currently has no local expiration, so the order can remain `AWAITING_PAYMENT` indefinitely.

The current customer UI also offers a cancel-request action for `AWAITING_PAYMENT`, while the API permits direct customer cancellation only for `PENDING` and permits store-mediated requests only after acceptance. This leaves the displayed action unusable for an awaiting-payment order.

Mercado Pago distinguishes cancellation from refund:

- cancellation applies before approval and prevents a charge from completing;
- refund applies after capture and returns the captured amount;
- the Orders cancel endpoint accepts only `created` or `action_required` Orders;
- a `processing/in_process` Order can reject cancellation with `409 cannot_cancel_order` and must be read authoritatively until it reaches a terminal state.

Official references:

- [Refunds and cancellations](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/refunds-cancellations)
- [Cancel Order by ID](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/cancel-order/post)
- [Order statuses](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/order-status)
- [Card test scenarios](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/cards)

## Approved decisions

1. Both PIX and card awaiting-payment flows expire after 30 minutes.
2. PIX uses the provider expiration returned in the authoritative snapshot; new PIX attempts start with the same configured 30-minute deadline.
3. A pending card stores `expires_at = payment.created_at + 30 minutes` when its payment attempt is created.
4. Cancellation changes the commercial order to `CANCELLED` immediately and performs provider cancellation or refund asynchronously.
5. No `CANCELLATION_PENDING` order status will be added. `orders.status` represents the commercial decision; `payment_operations` represents financial completion.
6. If approval races with cancellation, the order remains cancelled and a full refund is enqueued.
7. Provider failures never reopen or release a cancelled order.
8. After eight failed financial-operation attempts, the order remains cancelled and the payment work becomes `REVIEW_REQUIRED` for manual intervention.
9. Old development data does not require an expiration backfill because the database will be reset before validation. Any migration in this work must not add a legacy-data backfill.

## Safety invariants

The implementation must maintain all of these invariants:

- Only a validated, authoritative provider snapshot may perform `AWAITING_PAYMENT -> PENDING`.
- Once the cancellation transaction commits, no webhook, snapshot refresh, create recovery, operation, or cron may change the order from `CANCELLED` back to an operational status.
- Store order queries never include `AWAITING_PAYMENT` or `CANCELLED` as actionable orders.
- A cancelled order with a provider-pending payment converges to provider cancellation.
- A cancelled order with a provider-approved payment converges to a full refund.
- No provider response body, webhook body, card token, payer email, credential, PIX payload, or full provider identifier is logged or persisted outside its existing protected field.
- Provider mutation success is never inferred solely from an HTTP error, timeout, or empty response. An authoritative `GET Order` decides the financial outcome.
- Retried customer requests, cron runs, webhook deliveries, and provider responses create at most one logical cancellation and at most one logical full refund for the same disposition.
- Financial uncertainty is represented as `PROCESSING` or `REVIEW_REQUIRED`; the API never reports provider cancellation as confirmed before authoritative evidence exists.

## Architecture

### Commercial and financial state

The design keeps the existing separation:

```text
orders.status          = commercial lifecycle
payments               = authoritative normalized provider snapshot
payment_operations     = durable outbound CANCEL/REFUND work
```

The commercial cancellation and financial intent are established atomically in PostgreSQL. Provider I/O occurs only after the transaction commits.

No new table or order status is needed. The existing `payments.expires_at`, reconciliation state, and operation queue remain the source of truth.

### Lock order

Every path that can release or cancel an awaiting-payment order must lock rows consistently:

1. lock `payments` when processing a payment-specific transition;
2. lock its `orders` row;
3. re-check both current states inside the transaction;
4. apply one conditional transition;
5. insert the event and operation intent before commit.

Order-driven cancellation may locate the latest payment by order ID, but it must converge on the same payment-then-order lock order before mutation. Tests must exercise both possible winners of approval-versus-cancellation concurrency.

If approval commits before the server receives cancellation, the order may briefly become `PENDING`; the existing direct cancellation path then moves it to `CANCELLED` and enqueues a full refund. It is impossible to guarantee that a store never observes a payment that was already approved before cancellation arrived. The guarantee begins when the cancellation transaction commits.

## Expiration model

Rename the internal duration concept from PIX-specific to online-payment expiration while keeping it at 30 minutes.

Every new PIX and card payment attempt receives `expires_at`. The provider may replace the initial PIX value with its authoritative expiration timestamp. Card expiration remains the locally established deadline because the provider test state can remain `processing/in_process` without a usable expiration.

The schema should add a focused partial index for due pending payments by `expires_at`. Because development data will be reset, the migration must not update existing rows.

The deadline is authoritative at 30 minutes. With the existing five-minute cron, background processing can start between 30 and 35 minutes. A manual cancellation can start immediately at any time while the order is `AWAITING_PAYMENT`.

## Manual customer cancellation

`POST /orders/{id}/cancel` accepts a customer-owned order in either:

- `AWAITING_PAYMENT`: cancel commercially and dispose of the unresolved payment;
- `PENDING`: preserve the existing direct cancellation behavior and refund an approved payment.

States after `PENDING` continue using the store-mediated cancellation-request workflow.

For `AWAITING_PAYMENT`, one transaction must:

1. verify customer ownership;
2. lock payment and order;
3. re-check `AWAITING_PAYMENT`;
4. update the order to `CANCELLED` with a customer-safe reason;
5. add one `CUSTOMER` cancellation event;
6. expire any pending amendment if applicable;
7. create or ensure the appropriate durable financial intent when a provider Order ID is known.

The endpoint is idempotent for a repeated request against the same already-cancelled customer order: it returns the current order and derived financial state without adding another event or operation. It must not turn unrelated authorization or invalid-state errors into idempotent success.

After commit, the route schedules best-effort immediate processing using `executionCtx.waitUntil` and a dedicated database client. Cron processing is the durable fallback. Request-scoped database clients must not be reused by the background task.

## Automatic expiration

The reconciliation pipeline is reordered so due expirations can create operations that are processed during the same cron invocation:

```text
leases
dependencies
inbox
creates
snapshots
expirations
operations
reviews
```

Before expiration, inbox, uncertain-create recovery, and snapshot refresh get an opportunity to observe an authoritative terminal or approved state.

The expiration stage selects bounded, indexed payments where:

- `payments.status = PENDING`;
- `payments.expires_at <= now`;
- the related order remains `AWAITING_PAYMENT`.

For each candidate, the stage performs the same transactional commercial cancellation used by the manual path, with actor `SYSTEM`, reason `Pagamento não confirmado em 30 minutos`, and a timeout-specific event. It then ensures the canonical financial disposition and leaves operation processing to the operations stage later in the same run.

Manual cancellation and automatic expiration racing each other must create only one commercial event and one canonical provider disposition.

## Canonical payment disposition

Awaiting-payment cancellation uses one canonical business intent per payment rather than separate customer, timeout, webhook, and reconciliation cancellation keys. All paths call an `ensure`-style helper that returns the existing intent or creates it once.

When the authoritative state is:

| Provider decision | Required result |
|---|---|
| `created`, `action_required`, or another normalized pending state | enqueue or continue `CANCEL` |
| `processing/in_process` and cancellation is refused | keep `CANCEL` retrying after authoritative read |
| `canceled` | complete as provider-cancelled |
| `failed`, `rejected`, or `expired` | complete as not charged |
| `processed/accredited` | complete cancellation intent as escalated and enqueue `REFUND_FULL` |
| partially refunded | enqueue/continue the full-refund target |
| fully refunded | complete as refunded |
| contradictory identity, amount, environment, method, or provider IDs | `REVIEW_REQUIRED` |

The payment-operation result enum adds `NOT_CHARGED` so rejected and expired outcomes are not mislabeled as a provider cancellation. `observed_provider_status` retains the exact normalized provider state.

The existing outbound idempotency key, unique business key, operation dependency, lease, retry, and authoritative-read mechanisms remain in use.

## Cancel mutation handling

Mercado Pago cancellation is attempted only through `POST /v1/orders/{id}/cancel` with `X-Idempotency-Key`.

- HTTP 200 is followed by authoritative `GET Order`.
- `409 cannot_cancel_order`, `order_already_canceled`, and idempotency conflicts are followed by authoritative `GET Order`.
- timeouts, 429, and 5xx attempt authoritative read, then use existing bounded backoff when the result is still uncertain.
- 401/403 configuration failures fail closed into review.
- malformed request/response or contradictory snapshots fail closed into review.
- 404 remains uncertain and retries bounded reads; it is not treated as proof that no provider Order exists.

A pending authoritative read keeps the operation retryable. Approval escalates to full refund. A terminal no-charge state succeeds. Eight failed attempts produce `REVIEW_REQUIRED/RETRY_EXHAUSTED` and never reopen the order.

## Cancelled uncertain creates

A payment can be cancelled while its create result is uncertain and `provider_order_id` is still null. This case must not enqueue an immediately unprocessable provider operation and must never issue another create after commercial cancellation.

Recovery behavior for a cancelled order is search-only:

1. search exact `external_reference` in the bounded provider window;
2. reject multiple matches into review;
3. if one match exists, perform authoritative `GET Order`;
4. pending match ensures `CANCEL`;
5. approved match ensures `REFUND_FULL`;
6. terminal no-charge match completes the local payment accordingly;
7. no result retries bounded search without creating PIX or card Orders;
8. exhausted or contradictory recovery becomes `REVIEW_REQUIRED`.

Normal PIX recreation remains available only while the related order is still `AWAITING_PAYMENT` and not expired or cancelled. Card tokens remain non-persistent and are never replayed.

## Snapshot transition rules

Normal webhook and reconciliation snapshots retain their identity validation before any business transition.

For an order already `CANCELLED`:

- a pending snapshot ensures the canonical `CANCEL` intent;
- an approved snapshot ensures canonical `REFUND_FULL`;
- a cancelled, rejected, failed, or expired snapshot records the terminal no-charge result;
- a refunded snapshot records the refund result;
- no snapshot releases the order.

Operation settlement must avoid recursively creating a second cancel intent while evaluating its own pending snapshot. The canonical ensure helper and explicit transition options provide this boundary.

## Customer API projection

Customer order detail derives, rather than stores, a `paymentResolution`:

```ts
type PaymentResolution =
  | 'PROCESSING'
  | 'NOT_CHARGED'
  | 'REFUNDED'
  | 'REVIEW_REQUIRED'
  | null
```

Resolution precedence for a cancelled online order is:

1. any relevant operation or payment reconciliation in `REVIEW_REQUIRED` -> `REVIEW_REQUIRED`;
2. active cancel/refund operation, unresolved create, or approved payment awaiting refund -> `PROCESSING`;
3. fully refunded payment -> `REFUNDED`;
4. cancelled, rejected, failed, or expired payment -> `NOT_CHARGED`;
5. impossible or contradictory residual state -> `REVIEW_REQUIRED`.

Non-online orders and active orders return `null` unless an existing response contract explicitly requires payment information.

For every `AWAITING_PAYMENT` order, detail includes `payment.expiresAt`. PIX detail additionally includes its existing QR artifacts. Card detail must not expose token or provider identifiers.

## Customer UI

For `AWAITING_PAYMENT`:

- display the remaining server-derived deadline for PIX and card;
- render `Cancelar pagamento e pedido`;
- ask for confirmation before submitting;
- disable the action while the request is in flight;
- call `/orders/{id}/cancel`, never `/cancel-request`;
- refresh order detail after success.

For a cancelled online order:

- `PROCESSING`: `Pedido cancelado — confirmação financeira em processamento.`
- `NOT_CHARGED`: `Pedido cancelado — nenhuma cobrança foi concluída.`
- `REFUNDED`: `Pedido cancelado — pagamento estornado.`
- `REVIEW_REQUIRED`: `Pedido cancelado — confirmação financeira em análise.`

The UI must not promise an immediate refund date or expose internal failure classes.

## Store boundary

No store-facing route or list is allowed to treat `AWAITING_PAYMENT` or `CANCELLED` as actionable. Tests must prove:

- awaiting-payment orders never appear before approval;
- a cancellation winner never appears;
- an approval winner can appear only before the subsequent cancellation transaction commits;
- after cancellation commits, store updates and acceptance fail through existing status guards.

## Error handling and operations

- Commercial cancellation is never rolled back because Mercado Pago is unavailable.
- Outbound provider work remains durable, leased, bounded, retryable, and idempotent.
- The current maximum of eight attempts remains unchanged.
- `REVIEW_REQUIRED` requires sanitized operational inspection and explicit runbook requeue after investigation.
- Operational summaries expose counts, ages, local states, and safe failure classes only.
- The Mercado Pago Orders runbook documents awaiting-payment timeout, manual cancellation, `processing/in_process`, late approval/refund, and review procedures.

## Testing strategy

### Provider adapter

Cover:

- cancel 200 plus authoritative GET;
- 409 `cannot_cancel_order` plus pending, approved, cancelled, and refunded reads;
- already-cancelled and idempotency-conflict convergence;
- 404, 429 with bounded `Retry-After`, 5xx, and timeout;
- authentication/configuration failures;
- malformed and contradictory snapshots;
- no raw response or secret in errors/logs.

### Database services and concurrency

Cover:

- new PIX and card attempts receive a 30-minute expiration;
- just-before and at/after deadline behavior;
- manual cancellation of customer-owned PIX and card;
- authorization and invalid-state rejection;
- repeated endpoint, repeated cron, and manual-versus-timeout idempotency;
- approval wins the lock then cancellation/refund;
- cancellation wins the lock then late approval/refund;
- pending snapshot after cancellation ensures one cancel;
- terminal no-charge snapshot completes without refund;
- approved snapshot after cancellation ensures one full refund;
- cancellation operation pending, success, escalation, retry exhaustion, and reviewed dependency propagation;
- cancelled uncertain create never invokes `createOrder`;
- cancelled uncertain search with zero, one pending, one approved, one terminal, multiple, and provider-error outcomes;
- no release to store after cancellation commit.

### Routes and frontend

Cover:

- `/orders/{id}/cancel` accepts owned `AWAITING_PAYMENT` and preserves existing `PENDING` cancellation;
- it does not authorize another customer;
- it does not replace store-mediated cancellation for later states;
- response projection derives every `paymentResolution` safely;
- card detail includes expiration but no sensitive payment data;
- awaiting-payment button calls direct cancel and prevents duplicate submission;
- countdown works for PIX and card;
- each resolution message renders correctly;
- store lists exclude awaiting and cancelled orders.

### Final verification

Run focused provider, payment, reconciliation, route, and frontend suites, followed by repository typecheck, lint, tests, build, migration validation against disposable PostgreSQL, and `git diff --check`.

Manual sandbox validation occurs only after automated gates pass and the user resets/reseeds the disposable local database. It covers PIX cancellation, card `CONT` cancellation/review behavior, approval/cancellation race with full refund, sanitized queue inspection, and proof that cancelled orders do not reach the store.

## Out of scope

- Changing the 30-minute product policy after implementation.
- Adding a new order lifecycle status.
- Guaranteeing that a charge already approved before cancellation reached the server was never momentarily visible or captured; the guaranteed remediation is automatic full refund.
- Provider dashboard or webhook reconfiguration.
- Deploying or changing staging/production resources.
- Resetting any database as part of implementation.
- Backfilling legacy development payments.
- Redesigning unrelated order, checkout, store, or administrative interfaces.

# Mercado Pago Orders Hardening Design

**Status:** approved design; implementation pending

**Date:** 2026-07-15

## Objective

Replace the current Mercado Pago Payments API integration with the recommended Orders API and make the complete local payment lifecycle recoverable, idempotent, and fail-closed.

The implementation must preserve the current product offer: PIX and one-installment credit card are the only online methods. Cash and card-machine payments remain offline methods and are not sent to Mercado Pago. This work changes the financial integration and its internal reliability boundaries; it does not redesign checkout UX or add payment methods.

All existing payment data is disposable. The cutover starts from an empty database and deliberately provides no backfill, dual-write, dual-read, or compatibility layer for legacy provider payment IDs.

## Context and Problem Statement

The existing adapter creates resources through the legacy `/v1/payments` API and exposes only a provider payment ID and a simplified status. Important provider facts such as the external reference, amount, country, application identity, Order status detail, and transaction count are not represented in the application boundary.

The current flows also leave gaps between external side effects and PostgreSQL state:

- payment approval and order release are not one atomic local transition;
- webhook delivery is processed directly, without a durable inbox;
- timeout after provider submission is treated too similarly to a definitive failure;
- cancellation and refunds are not represented as durable retryable operations;
- partial refund is requested after the amendment transaction commits, so provider failure can leave untracked financial work;
- late approval of a locally cancelled order depends on one best-effort call;
- webhook reconciliation does not validate all financial and integration invariants.

This design resolves those gaps with an Order-centric provider adapter, a PostgreSQL webhook inbox, durable outbound operations, atomic local state transitions, and a periodic reconciler.

## Scope

### Included

- migrate all online payment calls from Payments API to Orders API;
- support automatic PIX Orders;
- support automatic one-installment credit-card Orders;
- obtain and normalize the current Order state from Mercado Pago;
- authenticate `order` webhooks and persist valid notifications before acknowledging them;
- reconcile the complete provider snapshot against local expectations;
- atomically update payment, application order, and order events locally;
- durably cancel pending provider Orders;
- durably request total and partial refunds;
- recover uncertain creates and external-success/local-failure scenarios;
- detect late payments, duplicated notifications, stale states, and financial mismatches;
- provide hermetic local tests using PostgreSQL and mocked provider HTTP responses;
- provide safe operational queries and requeue procedures.

### Excluded

- public or private staging webhook ingress and Mercado Pago external smoke tests;
- changes to Cloudflare Access, custom domain, DNS, WAF, or webhook bypass policy;
- production credentials or production deployment;
- boleto, debit card, installments, saved cards, 3DS/challenge, two-step capture, split payments, marketplace, or subscriptions;
- changes to cash or card-machine flows;
- payment administration UI or new public operational endpoints;
- material checkout UX/UI redesign;
- historical payment migration or backward compatibility;
- automatic refunds for ambiguous or mismatched provider resources.

External staging webhook delivery requires a separate design because Cloudflare Access currently blocks Mercado Pago from reaching the private API. This spec must not weaken that boundary.

## Approved Decisions

- Use Orders API in `automatic` processing mode.
- Allow exactly one provider transaction per Order.
- Use PostgreSQL, not an external Queue or Workflow, for the durable inbox and outbound-operation queue.
- Reuse the existing five-minute Worker cron for durable recovery.
- Use an immediate best-effort background processor after persistence to reduce latency; the cron remains the source of eventual progress.
- Store monetary values as integer cents locally and parse provider decimal strings without binary floating-point arithmetic.
- Keep card tokens in memory only. Never persist, return, or log them.
- Treat provider timeouts and interrupted responses as uncertain outcomes, not rejections.
- Fail closed on any financial or integration mismatch. Do not release the application order and do not automatically refund an ambiguously linked payment.
- Automatically queue a total refund only when a late approved payment is unequivocally linked to a locally cancelled order and every invariant matches.
- Start with clean payment tables in the next sequential migration. Existing payment data is discarded.

## Financial Invariants

Every online payment transition must satisfy these invariants:

1. The application order is released to the store only after a current provider Order snapshot validates successfully and maps to an approved state.
2. `external_reference` equals the immutable local application order ID.
3. The provider total equals the local expected total exactly in cents.
4. The integration is Brazilian: expected currency is `BRL` and provider country is `BR`. If the provider response contains an explicit currency, it must be `BRL`.
5. The provider Order contains exactly one payment transaction.
6. The normalized payment method matches the locally requested method.
7. The provider Order belongs to the expected Mercado Pago application, account, and environment wherever those facts are exposed or can be verified by the configured credential.
8. A provider Order ID and provider transaction ID can each belong to only one local payment attempt.
9. An approved, refunded, or review-required payment never regresses to a less authoritative state because of a delayed webhook.
10. External HTTP calls never execute inside a database transaction.
11. All related local mutations—payment state, application order state, and order event—commit or roll back together.
12. Every requested cancellation or refund has a durable local operation before execution is attempted.

Violation of an invariant changes the reconciliation state to `REVIEW_REQUIRED`, stores a bounded non-sensitive failure code, and prevents automatic order release.

## Configuration Boundary

The adapter consumes these server-side values:

- `MP_ACCESS_TOKEN`: secret used only in the API Worker;
- `MP_WEBHOOK_SECRET`: secret used only to validate webhook signatures;
- `MP_APPLICATION_ID`: non-secret expected application identifier;
- `MP_ACCOUNT_ID`: non-secret expected Mercado Pago account identifier obtained through a credential preflight;
- `MP_LIVE_MODE`: explicit non-secret boolean expectation, independent of `APP_ENV`;
- `MP_TEST_PAYER_EMAIL`: optional sandbox-only payer override already used by local testing.

`APP_ENV` must not determine Mercado Pago live/test mode implicitly. Staging can intentionally use a test account, so `MP_LIVE_MODE` is the authoritative expected environment.

Country and currency are application constants (`BR` and `BRL`), not deploy-time choices. Provider URLs are fixed in the adapter. Access tokens, webhook secrets, card tokens, payer emails, request/response bodies, QR payloads, and customer identifiers are excluded from logs.

Before financial smoke testing, an explicit credential preflight calls the provider-documented authenticated user lookup (`GET https://api.mercadolibre.com/users/me`) and verifies that the configured access token resolves to `MP_ACCOUNT_ID`. Each normalized Order must also match `MP_APPLICATION_ID` and `MP_LIVE_MODE` when those fields are returned. A missing provider identity field is not silently treated as a match: it is either established by the credential-scoped lookup or classified for review.

## Architecture

### Component Boundaries

#### Order-centric provider adapter

The Mercado Pago adapter owns HTTP, authentication, timeouts, provider payloads, strict response parsing, and error classification. Application services never consume raw Mercado Pago JSON.

Its interface exposes operations equivalent to:

- create an automatic PIX Order;
- create an automatic card Order;
- get an Order by provider Order ID;
- search Orders by exact `external_reference` for uncertain-create recovery;
- cancel an Order;
- refund an Order totally;
- refund one transaction partially;
- verify the account identity associated with the access token.

The adapter returns a normalized `ProviderOrderSnapshot`, not provider-specific response types.

#### Payment orchestrator

The orchestrator owns business intent. It creates local payment attempts, calls the adapter outside database transactions, validates snapshots, and applies the resulting local transition atomically. It decides whether the checkout response is approved, rejected, pending, uncertain, or under review.

#### Webhook ingress and inbox processor

Webhook ingress authenticates the notification and durably records its identifiers. It never applies financial state from the webhook body. The inbox processor re-fetches the current Order, validates it against the local attempt, and delegates the atomic transition to the orchestrator.

#### Outbound operation processor

This processor claims durable cancellation/refund operations, executes one idempotent provider request outside a database transaction, then records the resulting normalized snapshot. It retries transient failures without repeating completed business work.

#### Reconciler

The reconciler periodically scans uncertain, nonterminal, and due records. It recovers missing create responses, refreshes current provider state, processes webhook inbox rows, executes outbound operations, expires abandoned leases, handles PIX expiration, and escalates exhausted or contradictory cases.

Each component has one responsibility and depends on interfaces that can be tested independently.

### Provider Snapshot

`ProviderOrderSnapshot` contains at least:

- provider Order ID;
- provider transaction ID;
- Order `status` and `status_detail`;
- transaction `status` and `status_detail` when present;
- exact `external_reference`;
- total amount parsed to integer cents;
- refunded amount parsed to integer cents when available;
- country code;
- explicit currency when returned;
- processing mode;
- payment method family and provider method ID;
- application ID;
- account/user identity when returned;
- `live_mode`;
- transaction count;
- PIX QR data and provider expiration when applicable;
- provider update timestamp when available.

Parsing rejects missing required fields, non-canonical decimal amounts, negative values, overflow, unexpected transaction shapes, and multiple transactions. Decimal strings are converted directly to cents; they are never passed through JavaScript floating-point arithmetic.

### Mercado Pago Endpoints

The adapter uses only the Orders API for the financial lifecycle:

- `POST /v1/orders` to create automatic PIX or card Orders;
- `GET /v1/orders/{id}` to obtain the authoritative current snapshot;
- `GET /v1/orders/search` with exact `external_reference` for uncertain-create recovery;
- `POST /v1/orders/{id}/cancel` for cancellable pending Orders;
- `POST /v1/orders/{id}/refund` for total and partial refunds.

Every mutating request sends a stable `X-Idempotency-Key` of at most 150 characters. The key is generated locally, persisted before the provider call, and never derived from a card token.

Order creation does not set a local or private `notification_url`. The Mercado Pago application-level `order` webhook configuration belongs to the later external-staging design.

## Data Model

### Rebuilt `payments`

There is one row per online payment attempt. An application order can have multiple attempts, particularly after a rejected or uncertain card attempt.

Required fields:

- local UUID primary key;
- application `order_id`;
- provider fixed to `MERCADO_PAGO`;
- nullable provider Order ID until create recovery completes;
- nullable provider transaction ID;
- method `PIX` or `CARD`;
- local payment status;
- provider status and status detail;
- expected amount in cents;
- expected currency `BRL`;
- expected country `BR`;
- stable create idempotency key;
- reconciliation state;
- bounded reconciliation failure code;
- refunded amount in cents, default zero;
- PIX QR payload, QR image, ticket URL, and expiration when applicable;
- next reconciliation time and last reconciled time;
- created and updated timestamps.

Constraints:

- expected amount is positive;
- refunded amount is between zero and expected amount;
- create idempotency key is unique;
- `(provider, provider_order_id)` is unique when the provider ID is present;
- `(provider, provider_transaction_id)` is unique when the transaction ID is present;
- only PIX rows may contain QR fields;
- approved order release cannot be represented solely by provider text; it requires the validated local status transition.

The current shared payment statuses remain the application-facing lifecycle: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `REFUNDED`, and `EXPIRED`. Partial refund remains `APPROVED` with a positive `refunded_amount_cents`; total refund becomes `REFUNDED`.

Reconciliation state is independent: `PENDING`, `HEALTHY`, or `REVIEW_REQUIRED`. This separation allows a locally pending payment to be healthy while awaiting PIX and allows a provider-approved but mismatched payment to remain blocked for review.

### `payment_webhook_inbox`

The inbox stores only the minimum authenticated notification metadata:

- local UUID primary key;
- provider;
- notification topic;
- provider resource/Order ID;
- `x-request-id`;
- validated signature timestamp;
- processing status `PENDING`, `PROCESSING`, `PROCESSED`, or `REVIEW_REQUIRED`;
- attempt count;
- next attempt time;
- lease owner and lease expiration;
- bounded failure class;
- received, processed, created, and updated timestamps.

The unique deduplication key is `(provider, topic, resource_id, request_id)`. The table does not store the signature, authorization headers, raw request body, payer data, or provider response body.

### `payment_operations`

Durable outbound financial intent contains:

- local UUID primary key;
- payment ID;
- operation type `CANCEL`, `REFUND_FULL`, or `REFUND_PARTIAL`;
- optional amount in cents, required only for partial refund;
- persisted provider idempotency key;
- status `PENDING`, `PROCESSING`, `SUCCEEDED`, or `REVIEW_REQUIRED`;
- attempt count;
- next attempt time;
- lease owner and lease expiration;
- bounded failure class;
- provider Order status observed after completion;
- created, completed, and updated timestamps.

The business event supplies a deterministic uniqueness key so the same cancellation, total refund, or amendment refund cannot create duplicate intent. Partial refund amount is positive and cannot exceed the remaining refundable amount.

### Migration and Clean Cutover

The next sequential migration rebuilds payment persistence and creates the two durable work tables. No data migration is implemented. Local and staging databases are recreated from zero when this feature later moves to those environments.

The old `provider_payment_id` contract and `/v1/payments` adapter are removed in the same implementation. Tests must fail if production code still calls `/v1/payments`.

## Status Mapping

Provider Order and transaction state are mapped conservatively:

| Provider state | Local payment | Application order effect |
| --- | --- | --- |
| `created` | `PENDING` | remain `AWAITING_PAYMENT` |
| `processing` / `in_process` / `in_review` | `PENDING` | remain `AWAITING_PAYMENT` |
| `action_required` / `waiting_transfer` | `PENDING` | remain `AWAITING_PAYMENT`; PIX QR may be returned |
| `processed` / `accredited` | `APPROVED` | atomically release to `PENDING` |
| `processed` / `partially_refunded` | `APPROVED` plus refunded amount | retain business state; record refund progress |
| `failed` with definitive rejection detail | `REJECTED` | cancel only if no other approved attempt exists |
| `canceled` | `CANCELLED` | cancel only if still awaiting payment |
| `expired` | `EXPIRED` | cancel only if still awaiting payment |
| `refunded` | `REFUNDED` | record full refund; do not regress fulfilled business history |
| `charged_back` | unchanged financial status plus `REVIEW_REQUIRED` | never auto-release or rewrite completed history |
| unsupported challenge/capture state | `PENDING` plus `REVIEW_REQUIRED` | no release |
| unknown status or detail | unchanged plus `REVIEW_REQUIRED` | no release |

Delayed events may advance a valid state but cannot regress it. `REJECTED`, `CANCELLED`, and `EXPIRED` are definitive only for that payment attempt; another attempt for the same application order may later succeed.

## Checkout Flows

### Common Preparation

Within one local transaction, checkout validates the cart and business rules, creates the application order in `AWAITING_PAYMENT`, and creates a `PENDING` payment attempt containing immutable expected values and a random stable idempotency key. The transaction commits before any provider request.

If local preparation fails, no provider call occurs.

### PIX

1. Create one automatic Order with one PIX transaction, the exact local order ID as `external_reference`, expected total, payer data, and expiration.
2. Normalize and validate the returned snapshot.
3. If it is `action_required/waiting_transfer`, atomically persist the provider IDs and PIX data, mark reconciliation healthy, and return the QR data.
4. If it is already approved, atomically approve the payment, move the application order to `PENDING`, and append the order event.
5. If it is processing, retain `AWAITING_PAYMENT` and schedule reconciliation.
6. If it is definitively rejected, expired, or cancelled, apply the terminal local transition atomically.
7. If validation fails, store syntactically valid provider IDs only when they do not conflict with another local attempt, mark review required, return a generic unavailable response, and do not release the order.

PIX create can be retried with the same persisted idempotency key. The QR response is sensitive operational data and is returned only to the authenticated owner of the local order; it is not logged.

### Credit Card

1. Accept a short-lived Mercado Pago card token and enforce exactly one installment.
2. Create one automatic Order with one card transaction and the persisted idempotency key.
3. Remove all references to the token as soon as request construction finishes; no persistent object includes it.
4. Normalize and validate the response.
5. Approved/accredited atomically approves the payment, releases the order, and appends one event.
6. Definitive rejection atomically rejects the attempt and cancels the application order only when no other viable attempt exists.
7. Processing remains pending and schedules reconciliation.
8. Mismatch becomes review required and never releases the order.

If the create result is uncertain, the server first searches by exact `external_reference` and reconciles a unique matching Order. If no Order exists, a card attempt cannot be replayed because its token may no longer be valid: the client must obtain a new card token and create a new local attempt with a new idempotency key. Multiple provider matches are always review required.

### Local Atomic Transition

Applying a validated snapshot starts a short PostgreSQL transaction. It locks or conditionally updates the payment and application order, rechecks the current state, and writes payment fields, application order state, and one deduplicated order event together.

Concurrent checkout response handling, webhook processing, and cron reconciliation converge on the same transition. A stale processor that loses the compare-and-set observes the committed state and exits successfully without duplicating the event.

No Mercado Pago request is performed while row locks are held.

## Webhook Flow

### Ingress Authentication

Only the Mercado Pago `order` topic is part of this integration. Ingress requires query `type=order`, query `data.id`, `x-signature`, and `x-request-id`. It parses `ts` and `v1` from `x-signature`, constructs `id:{data.id};request-id:{x-request-id};ts:{ts};`, computes HMAC-SHA256 with `MP_WEBHOOK_SECRET`, and compares the hexadecimal digest in constant time.

The signature timestamp must be a syntactically valid bounded integer. It is stored for evidence but is not used as a strict short replay window: Mercado Pago can legitimately retry notifications much later. A replay can only insert once and trigger a fresh credential-scoped `GET /v1/orders/{id}`, so it cannot replay old financial content.

Outcomes:

- malformed or invalid signature: return `401`, do not insert;
- valid supported notification: insert or detect duplicate, then return `200`;
- valid duplicate: return `200` without duplicate work;
- valid but unsupported topic: return `200` and ignore safely;
- database failure before durable insert: return `500` so the provider retries.

The handler acknowledges quickly and does not wait for provider reconciliation. After persistence it may schedule best-effort processing with the Worker execution context. The durable cron is still responsible for eventual progress.

### Authoritative Processing

The inbox body is never financial truth. A processor claims the row atomically, fetches the current Order through the configured access token, finds the local payment by provider Order ID or exact external reference, validates every invariant, and applies the normalized snapshot.

An unknown but otherwise valid provider Order is not attached heuristically. It is marked for review. An exact external reference may be used only when it resolves to one local payment attempt and all other invariants match.

## Reconciliation

The existing five-minute scheduled Worker processes bounded batches in this order:

1. expired `PROCESSING` leases;
2. due webhook inbox rows;
3. due cancellation/refund operations;
4. uncertain creates without a provider Order ID;
5. nonterminal payment snapshots due for refresh;
6. expired PIX attempts;
7. review rows eligible for a safe automated recheck.

Claims use an atomic update or `FOR UPDATE SKIP LOCKED` pattern and a unique lease owner. Provider calls occur after the claim transaction commits. The result is then persisted in a separate short transaction.

Retries use `min(30 seconds × 2^(attempt - 1), 6 hours)` plus 0–25% jitter. For `429`, the next attempt is no earlier than a valid `Retry-After`. A work item receives at most eight automated attempts. Credential/configuration failures skip rapid retry and move directly to review. Exhaustion moves other items to `REVIEW_REQUIRED`; work is never silently discarded.

Reconciliation remains bounded by batch size and Worker execution time. More due work stays queued for the next cron. Every processor is safe when two Worker executions overlap.

## Cancellation and Refunds

### Pending Cancellation

When a PIX attempt expires or the application order is cancelled while the provider Order is cancellable, the same local transaction records the business transition and one `CANCEL` operation. The operation processor calls `POST /v1/orders/{id}/cancel`, then obtains or normalizes the current snapshot.

`already canceled`, already expired, or an observed equivalent terminal state is success. A provider response indicating the Order can no longer be cancelled triggers an immediate authoritative refresh. If payment is approved and all invariants match, the system creates a total refund operation; otherwise it requires review.

### Total Refund

A total refund operation contains no amount and targets the provider Order. It is created atomically with the local business decision that requires the refund. Success is confirmed by the returned or subsequently fetched Order snapshot before the local payment becomes `REFUNDED`.

### Partial Refund

Approving an order amendment and its refund intent occurs in one local transaction. The operation stores the exact refund amount and provider transaction ID. The Orders API request sends one transaction with that amount. The application records the amendment as accepted with refund pending; external completion later updates refunded cents.

The sum of successful and pending partial refund operations cannot exceed the approved amount. A full refund cannot be queued while conflicting partial refund work is processing without first reconciling the current refundable balance.

### Late Payment

If a current, fully validated provider snapshot shows approval after the local application order was cancelled, the system does not reopen the order. It atomically records the late approval and creates one total refund operation.

Automatic refund is allowed only when Order ID/transaction ID, external reference, amount, method, country/currency, environment, application, and account all match. Any ambiguity remains blocked for review.

## Failure Classification

| Condition | Classification | Automatic behavior |
| --- | --- | --- |
| timeout, connection reset, interrupted response | `TRANSIENT_UNCERTAIN` | reconcile before deciding whether to retry mutation |
| HTTP `429` | `RATE_LIMITED` | honor `Retry-After`, then exponential backoff with jitter |
| HTTP `500`–`599` | `PROVIDER_UNAVAILABLE` | retry within limit; create remains uncertain |
| HTTP `401` or `403` | `CREDENTIAL_OR_CONFIG` | no rapid retry; mark review and alert |
| HTTP `404` for known Order | `ORDER_NOT_FOUND` | bounded retry, exact-reference recovery, then review |
| malformed provider JSON | `PROVIDER_RESPONSE_INVALID` | mark review; do not transition financial state |
| financial/integration mismatch | specific bounded `MISMATCH_*` | mark review; never release or auto-refund |
| definitive provider rejection | `PAYMENT_REJECTED` | apply rejected attempt atomically |
| invalid webhook signature | `WEBHOOK_SIGNATURE_INVALID` | `401`, no inbox row |
| inbox persistence failure | `INBOX_PERSISTENCE_FAILED` | `500` so provider retries |
| operation retry limit exhausted | `RETRY_EXHAUSTED` | review required and operational alert |

Public API responses remain generic. Provider error bodies are not forwarded to clients or logs. The code may retain a bounded provider error code/status for diagnosis, never the raw body.

## Security and Privacy

- Access tokens and webhook secrets remain Worker secrets and are never exposed to Vite.
- Card tokens are accepted only over authenticated application routes, validated for size/shape, kept in memory, and redacted from all errors.
- Webhook authentication depends on HMAC, not source IP.
- HMAC comparison is constant-time.
- Webhook query/header values have strict size and character limits before signature computation or insertion.
- Orders are fetched with the configured credential; the webhook body cannot select an amount or local target.
- Payer emails, card data, QR contents, access tokens, signatures, raw provider bodies, and customer identifiers are not written to operational logs.
- Logs use local IDs, provider Order/transaction IDs where operationally necessary, status, failure class, attempt count, and duration.
- Existing rate limiting remains on customer checkout routes. The webhook route uses signature validation, input bounds, deduplication, and a conservative abuse limit that cannot discard a valid authenticated delivery.
- Manual intervention uses audited, parameterized scripts or runbook commands. Normal operations never instruct an operator to mutate financial rows with ad hoc SQL.

## Observability and Operations

Structured logs and counters cover:

- provider request count, latency, HTTP class, and operation name;
- webhook accepted, invalid, duplicate, processed, retried, and reviewed;
- operation claimed, succeeded, retried, and reviewed by type;
- reconciliation lag and oldest due item age;
- payments awaiting provider identification;
- mismatch class counts;
- late-payment refunds;
- lease recovery and retry exhaustion.

Logs never include provider response bodies or personal/payment secrets.

The runbook provides read-only sanitized queries for due inbox rows, pending operations, nonterminal payments, review-required records, and lease age. It also provides a parameterized requeue command that resets only eligible reviewed work after the underlying cause is understood. Requeue does not clear financial history or create a new refund idempotency key.

## Local Testing Strategy

All required acceptance tests run locally with the real disposable PostgreSQL service and mocked `fetch`. They require no domain, Resend delivery, Cloudflare Access cookie, Mercado Pago network call, or multiple real email accounts.

Test-only fixtures create distinct verified identities for CUSTOMER, STORE, and DRIVER using unique fake emails. These fixtures exist only in the test database and do not weaken production registration, activation, recipient allowlists, or staging seeds.

### Adapter Contract Tests

- create automatic PIX Order with one transaction and stable idempotency key;
- create automatic one-installment card Order;
- strict snapshot parsing and decimal-to-cents conversion;
- PIX QR extraction;
- Order lookup and exact-reference search;
- total refund, partial refund, and cancellation request shapes;
- explicit request timeout;
- `Retry-After` handling metadata;
- provider error classification without raw-body leakage;
- assertion that production code never calls `/v1/payments`.

### Webhook Tests

- valid signature with canonical manifest;
- uppercase/lowercase signature components as supported by the documented format;
- missing, malformed, oversized, and invalid signature inputs;
- constant-time validation path;
- valid duplicate notification;
- valid delayed notification;
- unsupported topic;
- inbox insert failure returns `500`;
- webhook body disagreement cannot influence financial state;
- quick acknowledgement independent of provider latency.

### Validation Matrix

Table-driven cases independently change:

- external reference;
- amount;
- country;
- explicit currency;
- payment method;
- transaction count;
- provider Order ID;
- provider transaction ID;
- application ID;
- account ID;
- live/test mode;
- unsupported processing mode, status, or status detail.

Every mismatch must produce `REVIEW_REQUIRED`, no application order release, no automatic ambiguous refund, and a bounded failure code.

### PostgreSQL Concurrency Tests

- payment/order/event transition commits atomically;
- forced failure rolls back every local mutation;
- webhook and checkout response racing on approval create one event;
- two cron workers claim a work item only once;
- expired lease becomes claimable again;
- duplicate operation intent remains one row;
- partial refund totals cannot exceed approved amount;
- stale provider snapshots cannot regress state;
- an outbound call is never made while the state transaction is open.

### Recovery and Lifecycle Tests

- unique uncertain create recovered by external reference;
- zero-result PIX create safely retried with the same key;
- zero-result card create requests a new client token/attempt;
- multiple external-reference matches require review;
- approved card, rejected card, and processing card;
- PIX awaiting transfer, approval, expiration, and cancellation;
- full refund and partial amendment refund;
- operation retry followed by success;
- retry exhaustion;
- external success followed by local persistence failure and later recovery;
- late valid payment on a cancelled order queues one total refund;
- mismatched late payment is not automatically refunded;
- failed delivery preserves financial ledger consistency;
- cash and card-machine behavior remains unchanged.

## Implementation Sequence Constraints

The implementation plan must preserve these dependencies:

1. define normalized provider contracts and tests;
2. rebuild schema and durable work tables;
3. implement strict Orders API adapter;
4. implement invariant validation and atomic local transitions;
5. migrate checkout creation paths;
6. add authenticated webhook inbox;
7. add operation processor and reconciliation cron;
8. migrate cancellation and amendment refunds;
9. add operational documentation and full regression gate;
10. remove all legacy Payments API code and prove its absence.

No step deploys to staging or resets a remote database. External staging work begins only under a separate reviewed spec and explicit destructive confirmation.

## Acceptance Criteria

This design is implemented locally when:

- no production path calls Mercado Pago `/v1/payments`;
- PIX and one-installment card checkout use automatic Orders;
- provider responses are normalized and fully validated before order release;
- payment, application order, and order event transitions are locally atomic;
- valid webhooks are durably persisted before `200` and duplicates are idempotent;
- webhook payloads never act as financial truth;
- transient and uncertain provider outcomes are recoverable;
- cancellations and refunds are durable, idempotent, and retryable;
- late valid payment triggers a durable refund without reopening the order;
- mismatches fail closed and remain visible for review;
- card tokens and secrets are absent from persistence and logs;
- concurrency and recovery tests pass against PostgreSQL;
- all repository type checks, lint, tests, builds, migration checks, diff checks, and secret scans pass;
- staging and production remain unchanged.

## Follow-up Work

After local implementation is complete and reviewed, a separate design must cover:

- a secure external ingress path compatible with private Cloudflare Access staging;
- Mercado Pago test users and test credentials;
- application webhook configuration for the `order` topic;
- staging credential/account/application preflight;
- real PIX/card, cancellation, refund, retry, and webhook smoke evidence;
- sanitized observability and rollback evidence;
- explicit staging database reset and Hyperdrive grant/update sequence.

Production activation remains a later gate after domain, infrastructure, credentials, monitoring, and security review are independently approved.

## Official References

- [Checkout Transparente API overview: Orders recommended and available endpoints](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/overview)
- [Create Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/create-order/post)
- [Get Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/get-order/get)
- [PIX through Orders API](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/pix)
- [Order notifications](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications)
- [Order statuses](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/order-status)
- [Transaction statuses](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/transaction-status)
- [Cancel Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/cancel-order/post)
- [Refund Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/refund-order/post)
- [Refunds and cancellations](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/refunds-cancellations)
- [Credential security](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/resources/credentials)
- [Credential ownership lookup](https://www.mercadopago.com.br/developers/en/docs/your-integrations/credentials)

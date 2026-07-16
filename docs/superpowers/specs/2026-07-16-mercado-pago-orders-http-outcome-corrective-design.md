# Mercado Pago Orders HTTP Outcome Corrective Design

**Status:** approved for implementation planning

**Goal:** Correctly interpret every Mercado Pago Orders API HTTP outcome needed by the current checkout, reconciliation, cancel, and refund flows so declined cards become an ordinary financial result instead of a generic provider outage, without weakening the existing fail-closed PostgreSQL model.

## Context

The Orders integration now creates valid PIX and approved card Orders and accepts signed Order webhooks. Manual sandbox testing exposed one remaining contract defect: a test card declined with `OTHE` made Mercado Pago return HTTP `402`, and the application converted it to `PROVIDER_RESPONSE_INVALID` and public HTTP `503`.

The provider Order actually existed. A sanitized authoritative lookup showed:

- Order status `failed`;
- transaction status `failed`;
- transaction detail `rejected_by_issuer`;
- provider Order and transaction identifiers present.

The current HTTP adapter throws for every non-2xx response before normalizing its body. This conflicts with the documented create-Order contract: HTTP `402` means the Order was created but its transaction failed. Existing route tests inject an already-normalized rejected snapshot, so they verify financial transitions but do not reproduce the real HTTP boundary.

Review of the current official Orders API documentation also found adjacent outcomes that need explicit behavior:

- create `409` can indicate a reused idempotency key and therefore a previously created Order;
- create `423` is a temporary resource lock;
- `429`, `5xx`, network failures, and timeouts do not prove that a mutation was not accepted;
- cancel and refund `409` responses can describe an already-reached or conflicting provider state;
- refund success and error responses must not be assumed to have the same complete shape as `GET Order`.

This correction addresses the provider HTTP outcome boundary. It does not redesign checkout or replace the existing financial state machine.

## Official Contracts

The design is based on the current official Mercado Pago Orders documentation:

- [Create Order](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-api/create-order/post)
- [Search Orders](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/search-order/get)
- [Get Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/get-order/get)
- [Cancel Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/cancel-order/post)
- [Refund Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/refund-order/post)
- [Order statuses](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/order-status)
- [Transaction statuses](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/transaction-status)

The documented responses relevant to this integration are:

### Create Order

| HTTP | Provider meaning | Required application behavior |
| --- | --- | --- |
| `201` | Order created | Normalize, validate, and persist the authoritative snapshot. |
| `400` | Invalid request, required/unsupported property, or invalid idempotency header | Deterministic provider-contract/configuration failure; do not retry unchanged input. |
| `401` | Invalid or missing credentials | Credential/configuration failure; do not retry unchanged credentials. |
| `402` | Order created but transaction failed | Recover the Order by exact external reference and persist its validated terminal state. |
| `409` | Idempotency key already used | Recover by exact external reference; never create a duplicate with a different key. |
| `423` | Resource temporarily locked | Treat as retryable/uncertain and schedule bounded recovery. |
| `429` | Quota exceeded | Respect `Retry-After` when valid, otherwise use bounded backoff. |
| `500` | Internal or idempotency validation failure | Treat the outcome as uncertain and recover before any replay. |

### Search and Get Order

| HTTP | Provider meaning | Required application behavior |
| --- | --- | --- |
| `200` | Search result or authoritative Order | Normalize and apply only after full snapshot validation. |
| `400` | Missing/invalid search or path parameter | Deterministic adapter-contract failure. |
| `401` | Invalid or missing credentials | Credential/configuration failure. |
| `404` on get | Order not found | Interpret according to recovery context; never infer rejection or success. |
| `429` | Quota exceeded | Schedule retry using `Retry-After` or bounded backoff. |
| `500` | Provider failure | Schedule retry; preserve existing local state. |

### Cancel Order

| HTTP | Provider meaning | Required application behavior |
| --- | --- | --- |
| `2xx` | Mutation accepted | Ignore heterogeneous mutation state and immediately `GET` the Order. |
| `400` | Invalid path/idempotency input | Deterministic request failure. |
| `401` | Invalid or missing credentials | Credential/configuration failure. |
| `404` | Order not found | Confirm with authoritative get when useful, then review without inventing state. |
| `409` | Cannot cancel, already canceled, or idempotency key reused | Always `GET` and evaluate the authoritative Order. |
| `429` | Quota exceeded | Retry later after an authoritative read attempt. |
| `500` | Provider/idempotency failure | Outcome uncertain; read before retrying. |

### Refund Order

| HTTP | Provider meaning | Required application behavior |
| --- | --- | --- |
| `2xx` | Mutation accepted | Immediately `GET` the complete Order before settling the operation. |
| `400` | Invalid path/idempotency input or refund amount exceeds the valid amount | Deterministic request failure. |
| `401` | Invalid or missing credentials | Credential/configuration failure. |
| `404` | Order or transaction not found | Confirm through authoritative read and require review if unresolved. |
| `409` | Idempotency reused, already refunded, refund in process, or cannot refund | Always `GET`; success is determined from current refunded amounts and state. |
| `429` | Quota exceeded | Retry later after an authoritative read attempt. |
| `500` | Provider/idempotency failure | Outcome uncertain; read before retrying. |

Undocumented status codes are not interpreted as financial outcomes. They remain fail-closed and produce a sanitized provider failure suitable for retry or review according to whether the request could have mutated provider state.

## Scope

### Included

- Explicit HTTP outcome classification for create, search, get, cancel, and refund.
- Recovery of create `402` and `409` through bounded exact-reference search.
- Retry handling for `423`, `429`, `5xx`, network failures, and timeouts.
- Safe parsing of `Retry-After` as delta seconds or HTTP date, bounded by the existing reconciliation policy.
- Authoritative `GET Order` after cancel/refund success, conflict, or uncertain mutation outcome.
- Normalization of all documented Order and transaction states needed by current payment flows.
- Correct public result for confirmed card rejection.
- Sanitized diagnostics for provider outcome and recovery decisions.
- Adapter, service, route, reconciliation, operation, webhook-regression, and manual tests.
- Runbook updates for approved card, declined card, PIX, webhook, cancellation, refund, and reconciliation.

### Excluded

- Checkout visual redesign or new visual identity.
- New database schema or migration unless implementation proves it unavoidable and the user separately approves it.
- Automated chargeback or dispute handling.
- New manual-capture, 3DS, or Point product flows.
- Reconfiguration of the external webhook.
- Staging/production secrets, deploys, or live payments.
- Reintroduction of Payments API or a compatibility fallback.
- Changes to PostgreSQL as the financial source of truth.
- Changes to existing retry-attempt limits unless required to fix a demonstrated correctness issue.

## Constraints

- Provider calls remain outside database transactions.
- PostgreSQL remains the durable source of truth for orders, payments, operations, and reconciliation.
- A provider HTTP status alone can never approve a payment.
- Every provider snapshot remains subject to application, account, environment, external reference, amount, currency, country, payment-method, and transaction validation.
- Raw provider error or success bodies are never logged or stored as diagnostic evidence.
- Card tokens remain memory-only and are never replayed after an uncertain create.
- Existing approved/refunded payments never regress to pending, rejected, canceled, or expired.
- Existing unrelated local changes in frontend `.env.development` files remain untouched and uncommitted.

## Architecture

### Semantic provider outcomes

The low-level HTTP adapter will stop collapsing every non-2xx response into `PROVIDER_RESPONSE_INVALID`. It will expose semantic outcomes sufficient for the caller to choose a safe recovery path:

- deterministic request/configuration failure;
- credential/configuration failure;
- authoritative Order not found;
- create requires exact-reference recovery;
- mutation requires authoritative read;
- temporarily locked;
- rate limited with an optional sanitized retry time;
- transient/uncertain provider outcome;
- malformed successful provider response.

The implementation may represent these outcomes as typed errors or discriminated results. It must not require callers to inspect raw provider bodies.

### Create flow

```text
POST /v1/orders
  ├─ 2xx → normalize → validate → persist
  ├─ 402/409 → exact-reference search
  │              ├─ one exact Order → GET → validate → persist
  │              ├─ zero → PENDING + scheduled reconciliation
  │              └─ multiple → REVIEW_REQUIRED
  ├─ 423/429/5xx/network/timeout → exact-reference recovery, then bounded retry policy
  └─ 400/401/403 → deterministic configuration/review path
```

Search uses the already-approved bounded date window and exact `external_reference` filter. A search result is not trusted until it is normalized and validated.

For the rare create `402` followed by zero immediate results, the local payment remains `PENDING`, the order remains `AWAITING_PAYMENT`, and reconciliation is scheduled. The public response is `PAYMENT_UNCERTAIN`, not `PAYMENT_REJECTED`, until an authoritative Order proves rejection. Multiple exact matches immediately require review.

Card tokens are never persisted or reused. Subsequent reconciliation is search/get-only for card creates. PIX may follow the existing idempotent retry behavior only after the approved zero-result safeguards and with the same persisted idempotency key.

### Cancel and refund flow

Mutation responses are acknowledgements, not authoritative financial snapshots:

```text
POST cancel/refund
  ├─ 2xx ───────────────┐
  ├─ 409 ───────────────┤
  └─ uncertain outcome ─┴→ GET /v1/orders/{id} → validate → settle/retry/review
```

This makes already-canceled, already-refunded, refund-in-process, and reused-idempotency outcomes safely idempotent when the authoritative Order proves the desired state.

- Cancel succeeds when the validated Order is canceled or expired.
- Cancel escalates to the existing refund path when payment approval makes cancellation inappropriate.
- Full refund succeeds only when the validated refunded amount equals the expected payment amount.
- Partial refund succeeds only when the validated cumulative refunded amount equals the operation target.
- A smaller amount remains retryable when the refund is still processing.
- A larger or contradictory amount requires review.
- A deterministic `400` is not turned into success merely because an unrelated current snapshot can be read.

## State Normalization

The provider's top-level and transaction states are reduced into the existing local payment states only after snapshot identity and amount validation.

| Provider state | Local payment decision | Local order behavior |
| --- | --- | --- |
| `processed` with accredited/processed payment | `APPROVED` | Advance `AWAITING_PAYMENT` to `PENDING`. |
| `created` | `PENDING` | Keep `AWAITING_PAYMENT`. |
| `processing` / `in_process` | `PENDING` | Keep `AWAITING_PAYMENT`; reconcile later. |
| `action_required` / waiting states | `PENDING` | Keep `AWAITING_PAYMENT`; preserve PIX artifacts when valid. |
| Order or transaction `failed` | `REJECTED` | Cancel an unpaid order. |
| `canceled` / `cancelled` | `CANCELLED` | Cancel an unpaid order. |
| `expired` | `EXPIRED` | Cancel an unpaid order. |
| `partially_refunded` | `PARTIALLY_REFUNDED` decision with validated amount | Keep local payment approved and update refunded amount. |
| `refunded` | `REFUNDED` | Preserve the order's valid terminal business state. |
| chargeback state/detail | `REVIEW_REQUIRED` | No automatic order transition. |
| unknown or contradictory state | `REVIEW_REQUIRED` | No automatic order transition. |

Documented failed transaction details such as `bad_filled_card_data`, `invalid_card_token`, `high_risk`, `rejected_by_issuer`, `required_call_for_authorize`, `max_attempts_exceeded`, `card_disabled`, `insufficient_amount`, `card_insufficient_amount`, `amount_limit_exceeded`, `processing_error`, `invalid_installments`, and `3ds_challenge_expired` are sanitized reason vocabulary. A top-level or transaction `failed` state is sufficient to classify a validated snapshot as rejected; adding a new provider `status_detail` must not convert an ordinary failed payment into a provider outage.

State precedence remains conservative:

- chargeback or identity/amount contradiction wins over ordinary terminal mapping and requires review;
- refund amount validation wins over generic refunded labels;
- approval cannot regress;
- unknown states cannot approve or reject automatically.

## Retry and Reconciliation Policy

- Existing retry-attempt budgets and terminal `RETRY_EXHAUSTED` behavior remain authoritative.
- `423` receives short bounded backoff with jitter.
- `429` uses a valid `Retry-After` delta or HTTP date; invalid, negative, or excessive values fall back to the existing bounded policy.
- Network failures, timeouts, and `5xx` are uncertain for mutation requests and require read/search recovery before replay.
- Create `402` and `409` use exact-reference recovery rather than blind replay.
- Cancel/refund `409` use authoritative `GET` rather than body-specific branching.
- Zero create-search results remain pending during the existing consistency window.
- Multiple create-search results immediately become `AMBIGUOUS_PROVIDER_CREATE` review.
- Exhausted unresolved outcomes become `REVIEW_REQUIRED/RETRY_EXHAUSTED`.

No loop may hold a database transaction or lease while waiting on the provider.

## Public API and Frontend Behavior

The public API continues returning stable application errors rather than provider details:

- confirmed rejection: HTTP `402`, `PAYMENT_REJECTED`;
- unresolved create outcome: HTTP `503`, `PAYMENT_UNCERTAIN`;
- financial mismatch/manual review: HTTP `503`, `PAYMENT_REVIEW_REQUIRED`;
- deterministic integration outage/configuration failure: existing generic payment-unavailable response.

The frontend behavior changes only where necessary for correctness:

- confirmed rejection tells the customer the payment was declined and permits a fresh attempt with a new card token;
- uncertain payment tells the customer confirmation is pending and prevents unsafe immediate replay;
- PIX pending continues showing QR code and expiration;
- no new layout, component system, or visual design is introduced.

## Diagnostics and Data Handling

Structured diagnostics may include only:

- stable event name;
- semantic failure class;
- provider operation/endpoint category;
- upstream HTTP status;
- local payment method;
- retry attempt;
- recovery decision;
- boolean presence of provider Order/transaction IDs;
- internal request ID.

They must not contain:

- access tokens or credentials;
- card token, PAN, security code, or payer email;
- raw request/response bodies;
- PIX QR code or ticket URL;
- webhook signature/secret;
- provider identifiers in full;
- database URLs or customer data.

Provider error bodies may be parsed only if implementation requires a small allowlisted code. The preferred design uses HTTP class plus authoritative reads so cancel/refund correctness does not depend on unstable error-body shapes. Parsed error text is never logged or persisted.

## Testing Strategy

Implementation follows TDD at the real failing boundary: mocked HTTP responses feed the adapter, then service/route tests verify persistence and public behavior.

### Adapter outcome matrix

Tests cover:

- create `201` approved card;
- create `201` pending PIX with artifacts;
- create `402` followed by one exact failed Order with `rejected_by_issuer`;
- create `402` followed by zero results;
- create `402` followed by multiple results;
- create `409` recovered idempotently;
- create `423`, `429` with both `Retry-After` forms, `5xx`, timeout, and network failure;
- deterministic create `400`, credential `401/403`, and malformed `2xx`;
- search/get `200`, `400`, `401`, `404`, `429`, and `500` classifications;
- cancel/refund `2xx` followed by authoritative get;
- cancel/refund `409` followed by terminal, processing, contradictory, and missing states;
- cancel/refund `429`, `5xx`, timeout, and network failure followed by read recovery;
- full and partial refund target validation;
- no mutation response being normalized as a full Order without a get.

### State matrix

Table-driven tests cover documented Order/transaction states and representative details:

- created, processed, processing, action required;
- failed with `rejected_by_issuer`, risk, funds, token, authorization, installment, processing, and 3DS details;
- canceled, expired, refunded, partially refunded;
- chargeback;
- unknown and contradictory states;
- approval non-regression and refund amount mismatch.

### Service and route regressions

- The exact `OTHE/rejected_by_issuer` scenario returns public `402 PAYMENT_REJECTED`.
- The payment becomes `REJECTED/HEALTHY`, provider identifiers are present, and the unpaid order becomes `CANCELLED`.
- `402` with no immediate result remains `PENDING` with `next_reconcile_at` and returns `PAYMENT_UNCERTAIN`.
- Reconciliation later discovers and applies that Order.
- `409` does not create a duplicate local or provider payment.
- Card tokens are never replayed during reconciliation.
- PIX and approved-card happy paths remain unchanged.
- Existing signed webhook processing remains idempotent and unaffected.
- Cancel/refund operation queues settle only from authoritative snapshots.
- Sanitized log assertions prove allowlisted fields are present and representative secrets/PII are absent.

### Manual acceptance

After merge, local sandbox testing covers:

1. approved card;
2. declined `OTHE` card;
3. PIX creation and QR display;
4. signed Order webhook using the real sandbox Order ID;
5. cancel before approval;
6. full and partial refund where supported by the test account;
7. payment work-status and reconciliation queries;
8. sanitized Worker logs.

Webhook dashboard reconfiguration remains a separate operator step after implementation and automated verification.

## Acceptance Criteria

1. A sandbox `OTHE/rejected_by_issuer` card produces local `REJECTED/HEALTHY`, cancels the unpaid order, and returns `402 PAYMENT_REJECTED`.
2. A confirmed declined card never becomes `503 PROVIDER_RESPONSE_INVALID`.
3. Create `402` without an immediately searchable Order remains pending and is recoverable by reconciliation.
4. Create `409` cannot produce a duplicate Order or payment.
5. `423`, `429`, timeout, network failure, and `5xx` follow bounded retry/recovery.
6. Cancel and refund settle only after authoritative `GET Order` validation.
7. All documented current Order/transaction states needed by the product map explicitly; unknown or contradictory states fail closed.
8. Approved card, PIX, webhook, refund validation, and non-regression tests remain green.
9. No schema change is introduced unless separately justified and approved.
10. No secret, payer data, card token, raw provider body, or QR artifact appears in committed code, test output, or diagnostics.
11. Repository typecheck, lint, tests, build, and diff checks pass before completion.

## Rollback

If automated verification fails, do not merge. If sandbox testing still finds an unsupported provider outcome, disable online methods locally while preserving cash/card-machine flows and all financial evidence. Do not delete payment rows, replay card tokens, bypass validation, weaken webhook verification, or fall back to Payments API.

## Completion Boundary

Completion means the current Orders API responses required by create, search, get, cancel, refund, reconciliation, and signed webhook regression are safely covered and the declined-card sandbox path behaves as an ordinary rejection. It does not authorize production deployment, live payments, automated disputes/chargebacks, or public release.

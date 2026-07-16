# Mercado Pago Orders Provider Conformance Corrective Design

**Status:** approved for implementation planning

**Goal:** Restore PIX and card checkout by aligning the Mercado Pago Orders adapter with the current documented provider contract, while preserving the existing PostgreSQL financial safety model and deferring external webhook reconfiguration until after merge.

## Context

The Orders hardening implementation passed its hermetic tests but failed the first real sandbox checkout for both PIX and card. The browser received the deliberately generic `503` checkout response. Review against the current Mercado Pago Orders documentation found that the adapter tests modeled a response shape that differs from the provider contract and did not assert several required request fields.

The local provider credential preflight succeeds, resolves to the configured account, and identifies a Brazilian test seller. The configured payer override is the canonical Orders sandbox email. The public Cloudflare quick tunnel reaches the local API and the webhook route. Therefore, the primary checkout failures are adapter contract defects rather than basic credential, account, database, frontend, or tunnel failures.

The failed webhook simulation is independent. Its payload identified a different Mercado Pago application and `live_mode=true`, while the local environment expects another application in sandbox mode. External webhook configuration and simulation will be repeated only after this corrective implementation is merged.

## Scope

### Included

- Correct PIX and card Order creation request shapes.
- Change PIX expiration from 15 minutes to the provider-supported minimum of 30 minutes.
- Normalize the current documented Order response shape into `ProviderOrderSnapshot`.
- Correct uncertain-create Order search to the current endpoint, required bounded date filters, and response envelope.
- Correct cancel, full-refund, and partial-refund request shapes.
- Enforce the provider's current 64-character idempotency-key limit.
- Add sanitized provider failure diagnostics without changing the public checkout error.
- Replace optimistic provider fixtures with sanitized contract fixtures based on current official examples.
- Add webhook regression coverage for the official notification envelope without weakening signature verification.
- Run focused and repository-wide automated verification before local merge.

### Excluded

- Mercado Pago dashboard changes.
- External webhook simulation or sandbox financial smoke as a merge gate.
- Production credentials, live payments, homologation, or production deployment.
- Schema or migration changes.
- Checkout UI redesign.
- Reintroduction of the Payments API or a compatibility fallback.
- Changes to PostgreSQL leases, queues, retry budgets, financial transitions, or source-of-truth ownership.

## Constraints

- Orders API remains the only online payment provider contract.
- PostgreSQL remains the durable source of truth.
- Provider calls remain outside database transactions.
- The webhook body remains untrusted and cannot select financial state or a local payment.
- Amount, external reference, payment method, application, account, environment, transaction identity, and provider state remain fail-closed.
- Public API errors remain generic.
- Logs and tests must not expose access tokens, card tokens, payer emails, QR data, webhook signatures, raw provider bodies, customer identifiers, or credential-bearing URLs.
- Existing unrelated worktree changes must be preserved.

## Request Contract

### Shared Order fields

Both payment methods send:

- `type: "online"`;
- `processing_mode: "automatic"`;
- the local order UUID as `external_reference`;
- `total_amount` and transaction `amount` as canonical two-decimal strings;
- exactly one entry in `transactions.payments`;
- the sandbox payer override when configured, otherwise the application user's email;
- a persisted `X-Idempotency-Key` between 1 and 64 characters;
- no per-Order `notification_url`.

### PIX

PIX sends:

```json
{
  "payment_method": {
    "id": "pix",
    "type": "bank_transfer"
  },
  "expiration_time": "PT30M"
}
```

The local payment expiration changes to the same 30-minute interval. Local expiry, provider expiry, reconciliation scheduling, and customer-facing expiry therefore describe one deadline rather than conflicting deadlines.

### Card

Card sends:

```json
{
  "payment_method": {
    "id": "visa",
    "type": "credit_card",
    "token": "ephemeral-card-token",
    "installments": 1
  }
}
```

The token remains memory-only and must not appear in persistence, logs, errors, test snapshots, or evidence.

## Response Normalization

The adapter normalizes provider vocabulary into the existing internal contract without weakening validation.

### Identity and environment

- Order ID comes from root `id`.
- Transaction ID comes from the sole payment transaction.
- Application ID comes from `integration_data.application_id` when present. A missing application ID is not silently replaced with configured input and therefore remains review-required.
- Account ID comes from an explicit provider field when available. If the Order omits it, the adapter may use only the credential-scoped account ID already verified by `GET /users/me` in the same provider instance.
- `live_mode` is validated when returned. If the Order omits it, the adapter uses the explicit provider configuration because account identity has already been checked and `MP_LIVE_MODE` is independently configured.

### Country and currency

- Provider country values `BR` and `BRA` normalize to internal `BR`.
- Any other explicit country remains a mismatch.
- An absent currency normalizes to the fixed integration currency `BRL`.
- Any explicit currency other than `BRL` remains a mismatch.

This follows the existing design rule: the integration is fixed to Brazil and BRL, while conflicting explicit provider data must fail closed.

### PIX artifacts and dates

- `ticket_url`, `qr_code`, and `qr_code_base64` come from the transaction's `payment_method` object.
- `date_of_expiration` is parsed when returned.
- If the provider omits an absolute expiry, the adapter returns no provider expiry and the persisted local 30-minute expiry remains authoritative.
- Invalid explicit dates remain provider-response failures.
- Provider update time is read from the documented update field when present; absence is permitted.

### Status

The existing snapshot validator continues mapping documented Order and transaction states to pending, approved, rejected, cancelled, expired, refunded, partially refunded, or review-required. This corrective work changes provider extraction and documented aliases, not financial transition policy.

## Uncertain-Create Search

The current provider search contract is `GET /v1/orders`, not `/v1/orders/search`. Search requires bounded RFC 3339 dates and returns an envelope with `data`.

The provider interface will receive the local payment creation time along with `external_reference`. It will request:

- `external_reference` equal to the local order UUID;
- `type=online`;
- `begin_date` equal to local payment creation minus five minutes;
- `end_date` equal to the earlier of local payment creation plus 24 hours or reconciliation time plus five minutes;
- a small first page sufficient for ambiguity detection.

After normalization, the adapter filters again by exact external reference. Outcomes remain unchanged:

- zero matches: existing PIX retry or fresh-card behavior;
- one exact match: apply the validated snapshot;
- multiple exact matches: `AMBIGUOUS_PROVIDER_CREATE` and manual review.

No broad unbounded provider scan is introduced.

## Cancel and Refund Operations

- Cancel sends `POST /v1/orders/{id}/cancel` with no request body.
- Full refund sends `POST /v1/orders/{id}/refund` with no request body.
- Partial refund sends one transaction containing the provider transaction ID and canonical amount.
- Each mutation retains its persisted stable idempotency key.
- New provider idempotency keys must be between 1 and 64 characters.
- The existing overlong escalated-refund key becomes a compact deterministic key derived from the predecessor operation ID. The long business key remains internal and unchanged.

Queue ordering, dependency propagation, retry classification, and outcome verification remain unchanged.

## Error Handling and Diagnostics

Provider failure responses remain classified without logging or returning raw provider bodies.

The customer continues receiving the generic payment-unavailable message. A sanitized server-side diagnostic records only:

- stable event name;
- provider failure class;
- upstream HTTP status when available;
- payment method;
- local request ID.

No diagnostic includes access token, card token, payer email, request or response body, QR content, webhook secret/signature, order/customer identifier, or database URL.

Unexpected non-provider errors continue through the existing error path instead of being mislabeled.

## Webhook Boundary

No webhook authentication behavior changes in this corrective implementation.

The regression fixture will mirror the official Order notification envelope and query parameters. Tests must prove that:

- `type=order`, query `data.id`, `x-request-id`, and `x-signature` remain required for a supported notification;
- valid HMAC inserts the minimal inbox row and returns `200`;
- invalid HMAC returns `401` and does not insert;
- body IDs, amounts, statuses, application IDs, and `live_mode` cannot override signed query metadata or financial state;
- unsupported topics remain harmless `200` responses.

After merge, the operator will configure the current quick-tunnel callback under the matching test application, use that application's webhook secret, select the test URL, and simulate an Order notification with a real sandbox Order ID.

## Testing Strategy

Implementation follows TDD: add one failing contract test, verify RED for the intended reason, implement the minimum correction, and verify GREEN before continuing.

### Adapter contract fixtures

Sanitized official-shaped fixtures cover:

- PIX request required fields and `PT30M`;
- card request required fields;
- official PIX response with QR artifacts under `payment_method`;
- official card response with nested application identity;
- `BR` and `BRA` country normalization;
- absent currency as BRL and explicit non-BRL mismatch;
- missing application identity remaining fail-closed;
- verified account fallback only after credential preflight;
- current search URL, required date window, exact filtering, and `data` envelope;
- cancel without body;
- full refund without body;
- partial refund with one transaction;
- idempotency bounds.

### Service and route regressions

- PIX attempts persist a 30-minute expiry.
- Provider failures return the existing generic public response.
- Sanitized diagnostics contain allowed fields and exclude representative secrets and PII.
- Official-shaped webhook notification coverage preserves current HMAC and body distrust.
- Recovery, reconciliation, operation, and concurrency suites remain green.

### Verification gate

Before merge:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/mercadopago.test.ts \
  test/payment-snapshot-validation.test.ts \
  test/payment-reconciliation.test.ts \
  test/payment-operation.service.test.ts \
  test/orders.routes.test.ts \
  test/webhooks.routes.test.ts
pnpm --filter @delivery/api typecheck
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
git status --short
```

Real PIX/card sandbox checkout is intentionally not a merge gate. It is the first post-merge manual verification. External webhook reconfiguration and simulation follow that payment smoke so a real sandbox Order ID is available.

## Rollback

If automated verification fails, do not merge. If post-merge sandbox verification finds a remaining provider mismatch, disable online payment methods locally, retain cash/card-machine flows, preserve all local payment attempts and reconciliation evidence, and diagnose the sanitized failure class. Do not fall back to Payments API, delete financial rows, replay card tokens, or bypass snapshot/signature validation.

## Completion Criteria

This corrective implementation is complete when:

- adapter requests and normalization match current official Orders contracts;
- PIX local/provider expiry is 30 minutes;
- uncertain-create search uses the current bounded search contract;
- cancel/refund mutations and idempotency keys conform to provider limits;
- sanitized diagnostics make generic checkout failures diagnosable;
- official-shaped contract fixtures and all existing payment safety tests pass;
- the full repository gate passes;
- the corrective branch is merged locally without modifying unrelated local environment changes.

Webhook dashboard configuration, external webhook simulation, and sandbox financial smoke remain explicit post-merge manual work.

## References

- [Mercado Pago Orders — create Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/create-order/post)
- [Mercado Pago Orders — PIX integration](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/pix)
- [Mercado Pago Orders — card integration](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/cards)
- [Mercado Pago Orders — search Orders](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/search-order/get)
- [Mercado Pago Orders — cancel Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/cancel-order/post)
- [Mercado Pago Orders — refund Order](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/refund-order/post)
- [Mercado Pago Orders — notifications](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications)

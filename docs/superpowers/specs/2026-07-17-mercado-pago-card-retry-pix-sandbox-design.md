# Mercado Pago Card Retry and PIX Sandbox Design

**Status:** approved in conversation; awaiting written-spec review

**Date:** 2026-07-17

## Goal

Correct checkout retries after a definitively rejected card payment, make cancellation of a card payment still under provider analysis converge without repeated invalid mutations, and expose Mercado Pago's official PIX `APRO` sandbox scenario through an explicit local-only configuration.

## Scope

This change covers three related behaviors in the existing Mercado Pago Orders integration:

1. a second card attempt after `OTHE` must create a new local/provider payment attempt;
2. a cancelled `CONT` payment must be re-read until it becomes chargeable, not charged, or requires review;
3. local development may opt into the official automatically approved PIX sandbox fixture.

No database migration, new payment-operation type, production payment behavior, UI redesign, or new dependency is included.

## Official provider contract

The implementation follows the current Mercado Pago Checkout Transparente Orders documentation:

- Card test holder `OTHE` produces a rejection, `CONT` produces a pending payment, and `APRO` produces approval.
- Order creation requires a unique idempotency key for each distinct attempt.
- Cancellation applies only while the provider Order is `action_required`.
- An approved payment requires refund, while a payment still being processed must be re-read until an authoritative outcome exists.
- The official PIX sandbox fixture uses `payer.email = test_user_br@testuser.com` and `payer.first_name = APRO`; it initially returns `action_required/waiting_transfer` and is then updated automatically to approved.

References:

- https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/cards
- https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix
- https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/refunds-cancellations
- https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/cards

## Card checkout attempt lifecycle

The checkout idempotency key represents one logical submission attempt, not the lifetime of the Vue view.

- The initial attempt receives a UUID when the checkout is mounted.
- Double clicks are already blocked by `submitting`; they do not create another key.
- Network failures, timeouts, `503 PAYMENT_UNCERTAIN`, and other non-terminal outcomes retain the current key so a retry cannot duplicate a charge.
- A definitive `402 PAYMENT_REJECTED` closes that attempt. Before accepting another card token, the frontend rotates to a fresh UUID.
- A successful response clears the cart and navigates to the returned order as today.

The API must expose the stable checkout code in the JSON error response. Provider details and raw bodies remain private.

Idempotent replay must preserve the original semantic result:

- rejected, cancelled, or expired checkout payment: `402 PAYMENT_REJECTED`;
- payment under review: `503 PAYMENT_REVIEW_REQUIRED`;
- uncertain create: `503 PAYMENT_UNCERTAIN` and existing recovery path;
- approved payment: return the existing successful order;
- pending PIX with artifacts: return the existing QR result;
- pending card: return the existing order without creating another provider Order.

This backend behavior prevents a stale or malicious client from converting a rejected replay into a successful `201` response.

## Cancelled card still under analysis

Commercial cancellation remains immediate and authoritative locally: the order becomes `CANCELLED`, leaves store/dispatch work, and cannot be reopened by a later provider snapshot.

The existing durable `CANCEL` operation remains the persisted intent. No new enum or migration is introduced.

Processing rules:

1. On the first actionable run, read the provider Order before mutating it.
2. If the provider Order is `action_required`, call `Cancel Order`, then confirm with the returned or subsequently fetched authoritative snapshot.
3. If it is `processing`, `in_process`, or another supported pending-but-not-cancellable status, do not call `Cancel Order`; schedule a bounded read-only retry with failure class `CANCEL_PENDING`.
4. If a later read is approved, complete the `CANCEL` intent as `ESCALATED_TO_REFUND` and enqueue exactly one canonical `REFUND_FULL` operation.
5. If a later read is rejected, cancelled, or expired, finish as `NOT_CHARGED`.
6. If a later read is fully refunded, finish as `REFUNDED`.
7. Eight unresolved attempts preserve the existing bounded policy and end in `REVIEW_REQUIRED/RETRY_EXHAUSTED`.

Retries reuse their persisted business and idempotency keys. Concurrent cron executions, webhook processing, and manual cancellation must converge without duplicate cancellation or refund calls.

While pending, the customer-facing message is:

> Pedido cancelado. O pagamento ainda está em análise. Se for aprovado, o estorno será realizado automaticamente.

Existing terminal messages for `REFUNDED`, `NOT_CHARGED`, and `REVIEW_REQUIRED` remain unchanged.

## PIX APRO sandbox scenario

Add the optional Worker variable:

```dotenv
MP_TEST_PIX_SCENARIO=
```

Accepted values are an empty value and `APRO` only.

- Empty: existing PIX QR, pending, manual cancellation, and expiration behavior remains unchanged.
- `APRO`: PIX Orders use the official test fixture payer fields `test_user_br@testuser.com` and `APRO`.

The scenario is resolved inside the Mercado Pago adapter configuration. It is never accepted from the browser or checkout request.

Fail-closed rules:

- `APRO` requires `APP_ENV=local`;
- `APRO` requires `MP_LIVE_MODE=false`;
- any other non-empty value is invalid;
- staging and production reject the test scenario during provider configuration;
- production payloads never include `payer.first_name` from this mechanism.

The initial `action_required/waiting_transfer` response continues through the normal PIX artifact path. Webhook processing and scheduled reconciliation remain authoritative for the automatic transition to approved and for releasing the order to the store.

The official fixture may return an empty `qr_code_base64`. The provider normalizer must accept a valid non-empty `qr_code` with an empty or absent base64 value, and the web response/UI must render the QR from base64 when present without treating its absence as provider corruption.

## Tests

### Card retry

- `OTHE` followed by `APRO` rotates the frontend attempt key and creates a second order.
- `OTHE` followed by `CONT` rotates the key and creates a second order.
- a `402 PAYMENT_REJECTED` response exposes the stable code without provider content.
- an idempotent replay of a rejected payment returns `402`, not `201`.
- timeout, network error, and `503 PAYMENT_UNCERTAIN` retain the original key.
- double submission does not create a second request.
- successful and pending idempotent replays keep their current behavior.

### CONT cancellation

- `action_required` permits one cancel mutation.
- `processing/in_process` performs read-only retries without repeated cancel mutations.
- pending to approved enqueues exactly one full refund.
- pending to rejected/cancelled/expired finishes `NOT_CHARGED`.
- pending to refunded finishes `REFUNDED`.
- eighth unresolved attempt becomes `REVIEW_REQUIRED/RETRY_EXHAUSTED`.
- concurrent workers and duplicate ticks do not duplicate operations.
- the cancelled order never returns to store or dispatch scopes.

### PIX sandbox

- empty scenario preserves the current PIX payload.
- local sandbox `APRO` sends exactly the official payer fixture.
- invalid value, live mode, staging, and production fail closed before provider I/O.
- initial fixture response tolerates empty base64 and preserves the copy-and-paste QR.
- later approved snapshot follows the existing reconciliation transition and releases the order once.

## Verification

Run focused web, provider, checkout, operation, reconciliation, route, and tracking tests; then run API/web typecheck and complete API/web suites. Manual sandbox verification covers:

1. `OTHE` followed by `APRO` without leaving checkout;
2. `OTHE` followed by `CONT` without leaving checkout;
3. cancellation of `CONT`, confirming read-only reconciliation and terminal review or provider outcome;
4. PIX with the scenario empty, confirming QR and expiration;
5. PIX with `APRO`, confirming automatic provider approval, store release, cancellation, and sandbox refund when allowed.

No evidence may contain tokens, card tokens, PIX payloads, emails, provider response bodies, or full provider identifiers.

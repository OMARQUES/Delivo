# Cancellation Request and Terminal PIX Corrective Design

**Status:** approved for implementation planning

## Goal

Remove the browser-only `415 Unsupported Media Type` from direct order
cancellation and allow Mercado Pago terminal PIX snapshots to complete
cancellation/reconciliation when the provider no longer returns QR artifacts.

## Scope

This correction changes only:

- the web customer's direct-cancellation request;
- Mercado Pago Orders snapshot normalization;
- focused regression tests for both defects.

It does not change database schema, cancellation state transitions, payment
operation semantics, security middleware, the generic API wrapper, Worker
configuration, Mercado Pago dashboard configuration, or existing timeout and
refund policy.

## Direct cancellation request

`OrderTrackingView` will keep using `POST /orders/{orderId}/cancel`, but the
request will carry the JSON object `{}`. The existing API wrapper will detect
the body and add `Content-Type: application/json`.

This is deliberately local to the cancellation call. The generic wrapper will
not invent bodies for every unsafe HTTP method, and the API security baseline
will continue rejecting non-JSON bodies with `415`.

The view test must assert the exact request contract, including
`body: JSON.stringify({})`. A wrapper regression test must prove that this body
causes `Content-Type: application/json` and preserves `credentials: 'include'`.

## Terminal PIX normalization

Mercado Pago may remove `qr_code`, `qr_code_base64`, and `ticket_url` after a
PIX Order becomes terminal. Snapshot normalization must therefore classify the
provider statuses before reading QR artifacts.

Status comparison is case-insensitive. A PIX snapshot is terminal for QR
purposes when either the Order status or its single payment transaction status
is one of:

```text
processed
accredited
failed
rejected
canceled
cancelled
expired
refunded
```

For a terminal PIX snapshot, normalization returns `pix: null`. QR artifacts
are no longer payable instructions and must not be retained merely because the
provider happened to include stale values.

For every non-terminal PIX snapshot, `qr_code` and `qr_code_base64` remain
mandatory non-empty strings. Missing or partial active QR data remains
fail-closed as `PaymentProviderError('PROVIDER_RESPONSE_INVALID')`.
`ticket_url` and expiration remain optional only after the two required QR
fields have passed validation.

Card behavior is unchanged and always normalizes with `pix: null`. Unknown or
unsupported provider statuses remain subject to the existing snapshot
validation and financial-review rules; this correction must not broaden the
set of trusted payment outcomes.

## Financial convergence

The existing operation processor remains authoritative. Once a canceled PIX
snapshot can be normalized, the existing validation maps it to `CANCELLED`, and
the existing cancellation operation completes with `NOT_CHARGED`. Approved or
refunded snapshots continue following the existing full-refund and refunded
paths. No order may be reopened by this correction.

## Error handling and security

- Do not weaken or special-case `securityBaseline`.
- Do not accept active PIX without both QR fields.
- Do not log or persist provider response bodies, PIX payloads, payer data,
  credentials, card tokens, or complete provider identifiers.
- Preserve the exact customer authorization and order-ownership checks on the
  cancellation route.
- Do not make external Mercado Pago calls from tests.

## Test strategy

Use TDD and cover:

1. the web view sends an explicit empty JSON object when cancelling;
2. the API wrapper applies JSON content type to that request while retaining
   Access cookies;
3. active PIX with complete QR data still normalizes normally;
4. active PIX with either QR field missing fails as
   `PROVIDER_RESPONSE_INVALID`;
5. terminal PIX snapshots for canceled, expired, rejected, processed, and
   refunded outcomes normalize with `pix: null` even without QR fields;
6. the existing canceled-operation test still completes as `NOT_CHARGED`;
7. focused API and web suites, typecheck, lint, and `git diff --check` pass.

## Completion boundary

Completion means direct cancellation reaches the authenticated API route from
the browser and terminal PIX readback no longer leaves a successful provider
cancellation retrying solely because QR artifacts disappeared. Manual sandbox
validation and database reset/reseed are separate follow-up actions and are not
authorized by this design.

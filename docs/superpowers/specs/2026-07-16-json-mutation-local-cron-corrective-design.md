# JSON Mutation and Local Cron Corrective Design

**Status:** approved for implementation planning

## Goal

Eliminate browser `415 Unsupported Media Type` failures for bodyless mutations
across web and driver clients, and make durable payment retries observable and
automatic during local development without changing staging or production
payment behavior.

## Evidence and root causes

The store cancellation-approval request reached
`POST /store/me/orders/{id}/cancel-request/approve` without a request body. In
the local Fetch/Workers boundary, that mutation arrived with a body stream but
without `Content-Type`. `securityBaseline` correctly rejected it with `415`.

The same transport mismatch previously affected customer direct cancellation.
A source scan now finds 31 bodyless mutations through the shared frontend API
wrappers: 16 in web and 15 in driver. They cover customer amendments, store
orders, batches, drivers, shifts and offers, admin finance/returns, and driver
accept/refuse/delivery actions. Patching one view at a time would leave the
underlying contract inconsistent.

The locally cancelled `CONT` card is not stuck because of schema, migration or
provider-response validation. Sanitized state showed:

```text
order_status: CANCELLED
payment_status: PENDING
reconciliation_state: HEALTHY
operation_type: CANCEL
operation_status: PENDING
failure_class: CANCEL_PENDING
attempt_count: 1
due_now: true
```

The first cancellation attempt observed an authoritative pending provider
state and correctly scheduled a retry. `wrangler dev --test-scheduled` exposes
`/__scheduled`, but it does not fire scheduled events periodically. Waiting in
local development therefore cannot advance a due retry without another
explicit scheduled invocation. Staging already has a five-minute cron.

## Decisions

### Central frontend mutation normalization

Both `apps/web/src/lib/api.ts` and `apps/driver/src/lib/api.ts` will normalize
requests before calling `fetch`:

- `POST`, `PUT`, `PATCH`, and `DELETE` with `body == null` receive the literal
  JSON body `{}`;
- the normalized body receives `Content-Type: application/json` only when the
  caller did not provide a content type;
- explicit bodies and explicit content types remain unchanged;
- `GET` and `HEAD` remain bodyless;
- `credentials: 'include'`, bearer authorization, and refresh-once behavior
  remain unchanged;
- a refresh retry re-normalizes the same original input and therefore sends the
  same effective body.

The API security middleware remains fail-closed. It will not be relaxed to
accept ambiguous mutation bodies. Individual components will not receive 31
duplicated `{}` patches.

Binary uploads already supply an explicit body and content type, so they stay
outside empty-JSON normalization. Direct `fetch` calls are not changed.

### Local scheduled-event runner

Local API development will use `wrangler dev --test-scheduled`, preserving the
normal HTTP server while exposing the Wrangler-only `GET /__scheduled` test
route.

A new `pnpm dev:cron` command will run a Node/TypeScript loop that calls only:

```text
http://127.0.0.1:8787/__scheduled?cron=*%2F5+*+*+*+*
```

The loop runs every 10 seconds. Calls never overlap: the next delay begins only
after the previous response or connection failure settles. The production
reconciler still enforces `next_attempt_at`, bounded claims, idempotency and the
eight-attempt limit, so extra local ticks do not create premature provider
mutations.

The runner has no configurable remote endpoint. It consumes no database URL,
provider credential or Worker secret. It cancels the response body without
printing it, emits only sanitized lifecycle states, tolerates API-unavailable
errors, and exits cleanly on `SIGINT` or `SIGTERM`.

The intended local layout is four terminals:

```bash
pnpm dev:api
pnpm dev:web
pnpm dev:driver
pnpm dev:cron
```

## Payment behavior preserved

This correction does not change payment state transitions or Mercado Pago
calls. A cancelled awaiting-payment order remains commercially `CANCELLED`
before provider I/O. Its durable financial work continues to converge as
follows:

- provider cancellation/rejection/expiration without capture becomes
  `NOT_CHARGED`;
- concurrent or late approval creates a durable full refund and becomes
  `REFUNDED` only after authoritative confirmation;
- an authoritative pending state remains `CANCEL_PENDING` and retries when due;
- the eighth unresolved retry becomes
  `REVIEW_REQUIRED/RETRY_EXHAUSTED` without reopening the order.

The runner only supplies missing local scheduled events. Staging and production
continue using their configured Cloudflare cron.

## Error handling and observability

- A failed local connection produces a sanitized `API_UNAVAILABLE` status and
  the loop continues.
- A non-success HTTP response produces `HTTP_ERROR` without logging its body.
- A successful scheduled invocation produces `TRIGGERED`.
- The runner must not log response bodies, provider identifiers, order IDs,
  emails, QR data, tokens, secrets, database URLs or idempotency keys.
- Existing `apps/api/scripts/payment-work-status.sql` remains the supported
  sanitized inspection mechanism.

## Test strategy

Frontend wrapper tests in both applications cover all four unsafe methods,
explicit-body preservation, GET preservation, content type, credentials, and
refresh retry behavior. Because every identified call site uses its
application wrapper, these tests enforce the transport contract centrally.

Local cron tests use injected `fetch`, wait and abort dependencies. They prove
the exact loopback URL, 10-second interval, sequential execution, resilience to
connection failure, sanitized statuses and clean abort without contacting the
real local API or Mercado Pago.

Focused tests run before each implementation commit, followed by full
typecheck, lint, test and build gates. Manual validation covers store approval
of a cancellation request, representative web/driver bodyless actions, and a
`CONT` cancellation advancing when due cron ticks execute.

## Non-goals

- Relaxing `securityBaseline` or changing its upload/webhook exceptions.
- Editing every bodyless frontend call site individually.
- Changing provider retry delays, attempt limits, payment enums, migrations or
  reconciliation ordering.
- Adding a public/local API endpoint beyond Wrangler's existing
  `--test-scheduled` route.
- Running scheduled events automatically in staging or production from the
  application process.
- Resetting the database, calling Mercado Pago, deploying or changing secrets
  during implementation.

## Completion boundary

Completion means all mutations made through web and driver wrappers have a
deterministic JSON transport when their logical payload is empty; the store
cancel-request approval no longer returns `415`; the local four-terminal
workflow advances due durable retries automatically; payment safety and API
body enforcement remain unchanged; and repository verification is green.

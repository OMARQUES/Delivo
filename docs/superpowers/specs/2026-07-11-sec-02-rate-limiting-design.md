# SEC-02 Rate Limiting and Anti-Automation Design

**Date:** 2026-07-11  
**Status:** Approved  
**Source:** `docs/security/2026-07-11-backend-security-review.md`, finding SEC-02

## 1. Goal

Protect authentication and expensive authenticated operations against brute force, credential stuffing, automated account creation, database pollution, provider-cost abuse, and resource exhaustion while preserving the initial Cloudflare/Neon free-tier architecture.

SEC-02 uses defense in depth:

1. Cloudflare Turnstile for registration and risk-based login challenges.
2. Atomic PostgreSQL counters by purpose, pseudonymous identity, authenticated principal, and source network.
3. One Cloudflare WAF rate-limiting rule when the API is attached to a Cloudflare zone.

Application controls are authoritative. Correctness must never depend on WAF enforcement.

## 2. Scope

### 2.1 Included

- `POST /auth/register`.
- `POST /auth/login`.
- `POST /auth/refresh`.
- Customer order quotation and creation.
- Public-media uploads for store logos and catalog products.
- Private return-evidence uploads by drivers.
- Minimal Turnstile integration in the existing web and driver authentication screens.
- PostgreSQL cleanup through the existing scheduled Worker.
- Staging/production configuration and a manual WAF activation runbook.

### 2.2 Deferred

- Mercado Pago webhook replay, freshness, inbox, and rate controls; these belong to SEC-08.
- Email-first registration, email verification, recovery, Google login, MFA, and their purpose-specific counters; these belong to SEC-03 and later identity plans.
- KV, Durable Objects, Queues, device fingerprinting, ASN reputation, behavioral scoring, and third-party bot-management products.
- Visual authentication refactoring beyond the minimum usable Turnstile states.
- A commercial order-volume policy. Initial quotas are security defaults and remain configurable.

## 3. Chosen architecture

### 3.1 Components

The implementation has four bounded units:

- `RateLimiter`: storage-independent contract for consuming, inspecting, and clearing limits.
- `PostgresRateLimiter`: production implementation backed by atomic PostgreSQL counters.
- `TurnstileVerifier`: server-side Siteverify adapter with an injectable transport for tests.
- Route policies: typed, centralized definitions that compose IP, identity, principal, and token-key limits.

Routes depend on contracts and policies rather than SQL or Siteverify response details. This preserves a future migration to Durable Objects without changing route behavior.

### 3.2 Why PostgreSQL

PostgreSQL is already the strongly consistent security-state store and is sufficient for the projected initial volume. It avoids a new paid service and operational surface. Worker memory is not shared between isolates, and KV is unsuitable for strict concurrent counters. Durable Objects remain an optimization only if measured database pressure or distributed abuse justifies them.

## 4. Counter model

### 4.1 Persistence

The database stores fixed-window buckets with these logical fields:

- `scope`: stable policy identifier;
- `key_hash`: full HMAC-SHA-256 digest of the scoped subject;
- `window_start`: deterministic UTC start of the window;
- `count`: positive request or failure count;
- `blocked_until`: optional absolute cooldown boundary set atomically when a policy threshold is crossed;
- `expires_at`: cleanup boundary.

The unique key is `(scope, key_hash, window_start)`. Consumption uses one atomic PostgreSQL statement equivalent to:

```sql
INSERT INTO rate_limit_buckets (..., count)
VALUES (..., 1)
ON CONFLICT (scope, key_hash, window_start)
DO UPDATE SET count = rate_limit_buckets.count + 1
RETURNING count;
```

The returned count and `blocked_until` decide whether the operation is allowed. A policy with a cooldown sets `blocked_until = greatest(existing value, now + cooldown)` in the same atomic statement that crosses its threshold. Concurrent requests cannot both observe and claim the final slot or shorten a cooldown. A consumed attempt remains counted even if another limit in the same policy rejects it; this prevents attackers from selectively avoiding longer-window accounting.

### 4.2 Fixed-window trade-off

Fixed windows can permit a burst around a boundary. The system accepts this bounded trade-off because every sensitive operation combines short and long application windows with Turnstile and, once a Cloudflare zone exists, an edge rule. This is substantially simpler and cheaper than per-attempt logs, distributed locks, or a new coordination service.

### 4.3 Key privacy

`RATE_LIMIT_HMAC_SECRET` is independent from `JWT_SECRET`. Key material is derived from a domain-separated string containing the scope and normalized subject. The database never stores raw:

- IP addresses;
- email addresses or phone numbers;
- user-supplied login identifiers;
- refresh tokens;
- Turnstile tokens.

Full digests are stored. Diagnostic logs may include only a short digest prefix that cannot be used as a database key.

### 4.4 Source address

Staging and production trust only Cloudflare's `CF-Connecting-IP`. `X-Forwarded-For` and other client-controlled forwarding headers are ignored. Local development and automated tests use an explicitly controlled local source value. Missing trusted source information outside local development fails closed for protected operations.

## 5. Initial policies

All values are centralized in a typed policy module and can change without a migration.

| Operation | Identity/principal limit | IP limit |
|---|---:|---:|
| Registration | 3/hour and 10/day per normalized identity | 10/hour and 30/day |
| Login attempts | 5 failures/15 min requires Turnstile; 10 failures/hour starts a 15 min cooldown | 30 attempts/15 min |
| Refresh | 10/10 min per refresh-token fingerprint | 60/10 min |
| Order quotation | 30/min and 300/day per customer | 100/min |
| Order creation | 10/hour and 30/day per customer | 30/hour |
| Public-media upload | 20/hour and 100/day per principal and purpose | 100/hour |
| Return-evidence upload | 10/hour and 30/day per driver | 50/hour |

Logo, product-image, and return-evidence counters use distinct scopes. IP limits are auxiliary and never create a permanent account lockout. Limits count accepted attempts as well as rejected business outcomes unless a flow explicitly defines failure-only accounting.

## 6. Turnstile

### 6.1 Server verification

The API sends the token, trusted remote IP, and a generated idempotency UUID to Cloudflare Siteverify using a strict timeout. It validates:

- `success === true`;
- the exact expected action (`register` or `login`);
- membership in the configured hostname allowlist;
- a valid `challenge_ts` no older than five minutes and not materially in the future.

Cloudflare enforces the token's five-minute lifetime and single use. Replayed and expired tokens are rejected. Secret keys never reach a frontend.

### 6.2 Failure behavior

- Missing challenge when required: `403` with code `TURNSTILE_REQUIRED`.
- Rejected, expired, reused, action-mismatched, or hostname-mismatched challenge: `403` with code `TURNSTILE_INVALID`.
- Timeout, non-success HTTP response, or malformed provider response: `503` with code `SECURITY_CHECK_UNAVAILABLE`.

Required flows fail closed. Provider failures do not consume credentials, create accounts, rotate tokens, create orders, or write media.

### 6.3 Environment

- Worker secret: `TURNSTILE_SECRET_KEY`.
- Worker variable: `TURNSTILE_EXPECTED_HOSTNAMES`, a non-empty comma-separated allowlist.
- Frontend variables: `VITE_TURNSTILE_SITE_KEY` in web and driver.
- Local development uses Cloudflare's official test sitekey and secret. There is no runtime bypass flag.
- Staging and production fail closed when required configuration is missing.

## 7. Request flows

### 7.1 Registration

1. Validate the request schema and normalize its current login identity.
2. Resolve the trusted source address.
3. Consume registration IP limits before calling Siteverify.
4. Require and validate a Turnstile token with action `register`.
5. Consume normalized-identity hourly and daily limits.
6. Call the existing registration service.

SEC-02 does not redesign the current account activation response. SEC-03 will replace it with email-first pending verification.

### 7.2 Login

1. Validate the request and normalize the identifier consistently for rate-limit keys.
2. Consume the general IP attempt limit before any password derivation.
3. Inspect identity failure counters.
4. If the active hourly failure bucket has reached ten failures and its `blocked_until` is in the future, enforce the remaining cooldown with `429`.
5. Starting with the attempt after five recorded failures in the active 15-minute window, require Turnstile action `login`.
6. Validate credentials. An unknown user or missing PASSWORD provider executes one verification against a fixed dummy password hash to reduce timing-based account enumeration.
7. On credential failure, atomically increment both identity failure windows. The tenth hourly failure also sets `blocked_until` to 15 minutes after that attempt. Return the same generic `401` envelope for the attempt that crosses the threshold; subsequent attempts receive `429` until the cooldown expires.
8. On successful authentication, clear identity failure and cooldown state. General IP traffic counters remain.

Account state failures after a correct password retain their existing explicit authenticated-user messages and do not count as incorrect credentials.

### 7.3 Refresh

1. Validate the request and resolve the trusted source address.
2. Derive a keyed fingerprint from the submitted refresh token without storing or logging it.
3. Consume token-fingerprint and IP limits.
4. Execute the existing transactional rotation and reuse-family revocation unchanged.

All refresh attempts count, whether the token is valid or not.

### 7.4 Orders

Order limits run after authentication and CUSTOMER role enforcement but before order services or payment-provider calls.

- Quotation consumes customer minute/day and IP-minute policies.
- Creation consumes customer hour/day and IP-hour policies.
- Read, cancellation, and amendment-decision endpoints are not included in the initial policy.

Rate limiting does not replace payment idempotency or duplicate-order prevention.

### 7.5 Uploads

Upload limits run after authentication, role, and ownership checks that do not require materializing the upload, but before `arrayBuffer()`, image processing, R2 writes, or database attachment.

- Store logo and catalog product images use separate public-media scopes.
- Driver return photos use the private-evidence scope.
- Existing byte and content-type limits remain independent and execute even when frequency is acceptable.

## 8. HTTP contract

Rate-limit rejection returns:

```json
{
  "error": "Muitas tentativas. Tente novamente mais tarde.",
  "code": "RATE_LIMITED"
}
```

The response status is `429`, and `Retry-After` contains a bounded whole number of seconds. The response does not reveal which counter, identity, account state, or key caused the rejection.

Turnstile errors follow the stable codes in Section 6.2. No artificial server-side sleeps are added because they consume Worker execution time without providing a reliable security boundary.

## 9. Minimal frontend behavior

- Registration renders Turnstile from the start and submits its token.
- Login renders Turnstile only after `TURNSTILE_REQUIRED`.
- Adaptive login preserves the entered identifier and password locally only for the current form interaction; credentials are never persisted.
- Expired, failed, or consumed challenges reset the widget and require a fresh token.
- Submitting while the required challenge is incomplete is disabled.
- `429` presents the retry interval without exposing internal policy details.
- No authentication-page visual refactor is part of SEC-02.

## 10. Cloudflare edge rule

Cloudflare's Free WAF plan currently permits one rate-limiting rule with a ten-second counting period. When the API is attached to a user-controlled Cloudflare zone, configure that rule for `/auth/*` at 20 requests per source IP per 10 seconds, using the Free-plan-supported mitigation behavior.

The initial private staging environment uses `workers.dev`, not a user-controlled zone. Therefore WAF activation is documented as a later manual gate tied to domain onboarding. Private staging relies on Cloudflare Access, Turnstile, and the PostgreSQL limiter. The application limiter is mandatory in every environment and is never bypassed because the WAF rule exists.

## 11. Cleanup and observability

The existing scheduled Worker deletes expired buckets in bounded batches. Expiration retains a bucket only as long as required to enforce its window and retry boundary. Cleanup failure does not disable enforcement; it is observable and retried by the next schedule.

Security logging records only:

- request ID;
- environment;
- policy scope;
- allowed, challenged, limited, or provider-unavailable result;
- optional truncated key digest;
- retry duration.

Logs never contain passwords, authorization headers, codes, raw tokens, raw identifiers, raw IP addresses, or Siteverify payloads.

## 12. Testing strategy

### 12.1 Unit and database tests

- deterministic UTC window boundaries and `Retry-After`;
- HMAC domain separation and normalization;
- increment, inspection, clearing, expiry, and cleanup;
- independent short and long windows;
- concurrent consumption of the final slot, proving only one request is allowed;
- full-digest persistence and absence of raw sensitive keys;
- trusted-IP behavior and rejection of spoofed forwarding headers.

### 12.2 Turnstile tests

- valid response;
- provider-declared invalid, expired, and replayed tokens;
- wrong hostname and wrong action;
- stale, future, or malformed `challenge_ts`;
- timeout, non-2xx response, and invalid JSON;
- secret never present in returned errors or logs.

Route suites inject a fake verifier. A focused adapter suite tests the real Siteverify request/response contract without making live network calls.

### 12.3 Route tests

- registration always requires Turnstile and respects IP plus identity limits;
- login switches to challenge after five failures and cooldown after ten;
- successful login clears identity failures without clearing IP traffic limits;
- unknown user and incorrect password share response shape and password-work path;
- refresh preserves rotation/reuse semantics while enforcing both keys;
- quotation and creation are isolated by customer and source IP;
- upload policies are isolated by actor and purpose;
- rejected requests do not call payment providers, materialize bodies, write R2 objects, or mutate protected business state;
- every `429` contains a valid bounded `Retry-After` and generic body.

### 12.4 Frontend and configuration tests

- registration token submission;
- adaptive login challenge and resubmission;
- widget reset on expiry/error;
- missing staging/production secrets fail closed;
- official local test-key configuration works without a bypass flag;
- generated migration applies from zero and test cleanup includes the new table.

## 13. Acceptance gate

SEC-02 is complete only when:

1. All route, service, database-concurrency, Turnstile, cron, and frontend tests pass.
2. API/shared/web/driver typechecks pass.
3. Repository lint and both frontend builds pass.
4. `git diff --check` is clean.
5. No raw protected key appears in database assertions or captured logs.
6. The local database can be recreated and migrated from `0000` through the generated SEC-02 migration.
7. The staging runbook identifies Turnstile provisioning and the future zone-bound WAF step as manual actions.

## 14. Source validation

- Cloudflare Turnstile server-side validation: <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Cloudflare WAF rate-limiting availability: <https://developers.cloudflare.com/waf/rate-limiting-rules/>
- Cloudflare `workers.dev` routing: <https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>

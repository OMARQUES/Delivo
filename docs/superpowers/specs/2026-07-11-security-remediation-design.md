# Security Remediation and Cloud Environments Design

**Date:** 2026-07-11  
**Status:** Proposed for user review  
**Source audit:** `docs/security/2026-07-11-backend-security-review.md`

## 1. Goal

Bring the backend from local-only development to a secure, production-capable architecture while preserving a low initial operating cost and validating Cloudflare-specific behavior in a private staging environment before any public production launch.

The target scale is initially small, with an optimistic ceiling of approximately 5,000 orders per month in the test city. The design therefore prioritizes Cloudflare and provider free tiers, but does not trade away authorization, tenant isolation, payment integrity, or private-data protection.

## 2. Delivery strategy

Work follows a hybrid sequence:

1. Implement the local P0 security foundation.
2. Provision a private, production-like staging environment.
3. Implement and validate identity, privacy, payment, and operational hardening in staging.
4. Promote to a separately provisioned production environment only after all security gates pass.

The existing `docs/superpowers/plans/2026-07-11-go-to-production.md` remains useful as an infrastructure inventory, but must not be executed as a production rollout. Its relevant content will be revised into a staging plan plus a later production-promotion plan.

## 3. Non-goals

- UI/visual refactoring beyond the minimal screens required for authentication, verification, MFA, and security feedback.
- Native Capacitor/Android delivery.
- Mercado Pago LIVE activation before staging is complete.
- SMS or phone-number verification in the initial release.
- Cloudflare KV, Durable Objects, or Queues in the initial architecture.
- Supporting or migrating real legacy user data. Current local data is disposable.
- Choosing the final commercial name or domain during staging.

## 4. Global principles

- Deny by default at route, object, and property level.
- Derive tenant and actor identifiers from the authenticated principal, never from a client-controlled body field.
- Keep PostgreSQL as the source of truth for security state.
- Never use eventually consistent state for strict security or financial decisions.
- Never expose database entities through object spreading in external responses.
- Separate public media from private evidence at storage and authorization boundaries.
- Make every financial transition idempotent, recoverable, and reconcilable.
- Keep local, staging, and production data, bindings, secrets, and deployments isolated.
- Production deployment is always manually approved.
- Security-sensitive behavior is covered by negative tests across every role and tenant.

## 5. Environment architecture

### 5.1 Local

- PostgreSQL Docker database, fully disposable.
- Wrangler local bindings and local R2 emulation.
- Capturing/in-memory email adapter or Mailpit.
- Turnstile test keys.
- Mock Google verifier and provider APIs in automated tests.
- Mercado Pago and Firebase fakes for tests; existing development credentials only for explicit local smoke tests.

### 5.2 Staging

- Publicly routable `workers.dev` hostnames with the entire environment initially protected by Cloudflare Access.
- Dedicated Neon staging database.
- Dedicated Hyperdrive staging binding.
- Dedicated public-media R2 bucket.
- Dedicated private-evidence R2 bucket.
- Dedicated staging secrets and non-secret vars.
- Mercado Pago TEST credentials only.
- Existing Firebase project may be reused initially, with environment labels in tokens/logs.
- Dedicated Google Web Client ID configured for staging origins.
- Dedicated Turnstile staging widget and secret.
- Resend API integration limited to the Resend account owner's address until a custom domain exists.
- External testers use Google login while Resend remains domain-limited.
- Automatic deployment from `main` is allowed only after CI gates pass.

Cloudflare Access remains mandatory for staging until the public-staging security gate is explicitly approved. Exact machine-to-machine paths that must remain reachable, such as the Mercado Pago webhook, use narrowly scoped Access bypass policies and retain their own HMAC/replay protections. No broad API bypass is allowed.

### 5.3 Production

- Separately provisioned Neon database, Hyperdrive binding, R2 buckets, secrets, Google client, Turnstile widget, and payment credentials.
- Custom domain is a production blocker because Resend requires a verified owned domain for arbitrary recipients.
- Resend uses a dedicated sending subdomain with SPF, DKIM, and DMARC.
- Mercado Pago LIVE credentials cannot coexist with TEST identifiers or environment configuration.
- Production deployment uses a manually triggered GitHub workflow with an approval environment.
- Database migrations run and pass in staging before production approval.
- Deployment and migration steps include a documented rollback path and smoke checks.

## 6. Cloudflare service choices

### 6.1 Turnstile

Turnstile is required for:

- password registration;
- password recovery initiation;
- verification-code resend when risk thresholds are reached;
- login after suspicious behavior or repeated failures.

Server-side Siteverify validation is mandatory. Validation checks success, expected hostname, expected action, token age, and single-use behavior. Calls use a strict timeout.

### 6.2 WAF rate limiting

The single Free-plan rate limiting rule protects `/auth/*` from bursts at the edge. The initial threshold is 20 requests per source IP per 10 seconds, resulting in a managed challenge or temporary mitigation.

Application-level limits remain necessary because WAF cannot enforce identity-based limits from JSON request bodies on the Free plan.

### 6.3 PostgreSQL rate limiting

PostgreSQL stores identity, IP, challenge, and purpose-based counters with explicit expiration. This is acceptable at the expected volume and remains protected by WAF and Turnstile.

A small `RateLimiter` interface isolates the implementation so Durable Objects can replace counters later without changing auth services.

### 6.4 Deferred services

- KV is not used for atomic counters, token revocation, or financial state.
- Durable Objects are deferred until database-backed counters show operational pressure or distributed abuse.
- Queues are deferred. PostgreSQL inbox/outbox plus cron provides the initial reliability layer.
- An `AsyncDispatcher` interface preserves a future migration path to Queues.

## 7. User identity model

### 7.1 Identity fields

- Email is mandatory, normalized, verified, and unique for password-based users.
- Phone is never a login identifier and is never used to find or link an account.
- Phone is not unique.
- Customer phone is optional.
- Driver password registration collects a phone number, and driver phone is required before administrative approval.
- Store-driver invitations use verified email instead of phone.
- Google identity is keyed by immutable Google `sub`, never by email.

### 7.2 Account states

The user lifecycle distinguishes:

- `PENDING_EMAIL`: password account exists but email is not verified;
- `PENDING_APPROVAL`: driver email is verified but admin approval is pending;
- `ACTIVE`: normal role-appropriate access;
- `BLOCKED`: all sessions and protected access denied.

`emailVerifiedAt` records verification time independently from the account state. `tokenVersion` invalidates all prior access tokens when incremented.

No compatibility path for phone login or real legacy accounts is required. Migration history remains intact, but new schema changes use new forward migrations. Local and staging databases may be recreated from zero during development.

### 7.3 Provisioned STORE and ADMIN accounts

- ADMIN bootstrap creates a single `PENDING_EMAIL` password account through a one-time CLI operation; email verification is required before application login.
- ADMIN access additionally requires Cloudflare Access at the perimeter.
- ADMIN-created STORE owners begin as `PENDING_EMAIL` and receive the same activation-code flow.
- Store records cannot become operational through an owner account that has not verified its email.
- Bootstrap credentials are never printed, committed, passed in command arguments, or reused across environments.

### 7.4 Password registration

1. Client completes Turnstile.
2. API applies IP and normalized-email rate limits.
3. API creates `PENDING_EMAIL` user and PASSWORD provider atomically.
4. API creates a hashed, purpose-bound email challenge.
5. Outbox/email adapter sends a six-digit numeric code.
6. Registration returns `verificationId`, never access or refresh tokens.
7. Correct code consumes the challenge atomically.
8. CUSTOMER becomes `ACTIVE` and receives a session.
9. DRIVER becomes `PENDING_APPROVAL` and receives no full session until approved.

Pending unverified accounts expire after 24 hours. Expiration releases the email for a future legitimate registration. A new code never extends an account indefinitely beyond abuse limits without a new valid registration flow.

### 7.5 Email verification code

- Exactly six numeric digits.
- Valid for 10 minutes.
- Stored only as a keyed hash, never plaintext.
- Five verification attempts per challenge.
- Resend cooldown of 60 seconds.
- Maximum five sends per hour and ten per day per normalized email, with additional IP limits.
- Challenges are single-use and purpose-bound.
- Responses do not log or expose the code.

The email has responsive HTML and a plain-text alternative. The code is selectable text, centered, visually large, and widely spaced using inline styles. It is never rendered as an image. The email clearly states expiry, non-sharing guidance, and how to ignore an unsolicited message.

### 7.6 Google customer registration and login

1. Client obtains a Google Identity Services ID token.
2. Backend verifies signature, `aud`, `iss`, `exp`, and `email_verified` against the configured client IDs.
3. Backend looks up the GOOGLE provider by `sub`.
4. Existing provider authenticates its associated user, subject to current account state.
5. If no provider and no local user owns the email, create an `ACTIVE` CUSTOMER and GOOGLE provider atomically.
6. A new Google customer does not need an additional Resend code, including Google accounts that use an external email domain.
7. Google never auto-creates DRIVER, STORE, or ADMIN accounts.

### 7.7 Existing PASSWORD email encountered through Google

The system never links solely because emails match.

1. Valid Google ID token identifies a PASSWORD email collision.
2. API creates a random opaque `linkTicket`, stored only as a hash.
3. Ticket is bound to the exact local user ID, Google `sub`, provider, purpose, expiry, and attempt counter.
4. Ticket is valid for 10 minutes and five password attempts.
5. UI displays the bound email as locked/read-only and explains that successful login will link Google.
6. API endpoint accepts only `linkTicket` and password; it does not accept email or user ID.
7. Correct password consumes the ticket, links GOOGLE, records audit, and issues a session in one transaction.
8. Future login may use either PASSWORD or GOOGLE.

Blocked accounts cannot link or receive a session. Provider uniqueness and row locks prevent concurrent duplicate linking.

### 7.8 Privileged provider linking

DRIVER, STORE, and ADMIN can use Google only after an explicit authenticated linking action. Password reauthentication is required. If the account enrolled in MFA, the active factor is also required. Cloudflare Access independently protects admin routes.

Linking and unlinking generate security notifications and audit events. The last usable authentication method cannot be removed.

### 7.9 Password recovery

- Turnstile is always required to initiate recovery.
- API always returns the same accepted response, regardless of account existence or provider type.
- Recovery uses a purpose-bound six-digit email code with the same storage and attempt protections.
- Successful password replacement increments `tokenVersion`, revokes all refresh-token families, records audit, and sends a security notification.
- Google-only users receive guidance to use Google login; external responses remain non-enumerable.

## 8. MFA and step-up authentication

### 8.1 Initial policy

- TOTP is optional for all roles.
- Email-code MFA is optional for all roles.
- MFA requirements are controlled by server-side environment/role policy, initially empty.
- The policy can later require `ADMIN`, `STORE`, or `DRIVER` without schema changes.
- Google login does not bypass an MFA requirement when one is configured.

### 8.2 TOTP

- Standard interoperable TOTP secrets.
- Enrollment requires recent primary authentication.
- Confirmation code is required before enrollment becomes active.
- Ten one-time recovery codes are generated and stored only as hashes.
- Disabling or replacing TOTP requires recent primary authentication plus current MFA or recovery code.

### 8.3 Email MFA

- Uses a separate challenge purpose from verification and recovery.
- Six numeric digits, short expiry, single use, attempt limits, and rate limits.
- Unavailable for arbitrary staging recipients until a Resend domain is verified.

### 8.4 Administrative perimeter

Cloudflare Access is mandatory for `/admin/*` and the admin frontend in staging and production, even while application MFA remains optional. This creates an independent authentication layer. High-risk actions require recent reauthentication; when MFA is enrolled, they also require that factor.

## 9. Authorization and session model

### 9.1 Request principal

JWT validation includes fixed algorithm, `iss`, `aud`, `exp`, `nbf`, `jti`, subject, role, and `tokenVersion`.

Protected requests resolve a small current-user and session-family projection from PostgreSQL on every protected request and reject when:

- user no longer exists;
- status is not allowed;
- current role differs from token role;
- token version is stale;
- the token's session family is revoked or expired;
- tenant/security status denies the operation.

Each access token contains a session-family identifier plus `jti`. Normal device logout revokes that family, immediately invalidating its access and refresh tokens through the request-time session check. Logout-all, password reset, account blocking, role changes, and security suspension increment `tokenVersion` and revoke every refresh family.

### 9.2 Role boundaries

- `/orders*` and `/me/addresses*` require CUSTOMER.
- `/driver/*` requires DRIVER.
- `/store/*` requires STORE and an active store security state.
- `/admin/*` requires ADMIN and Cloudflare Access at the perimeter.
- Public endpoints are explicitly enumerated and tested.

### 9.3 Tenant isolation

- Store IDs are always derived from the current owner principal.
- Object queries include store ownership in the same database statement wherever possible.
- Cross-store misses return `404`, not authorization-sensitive existence details.
- A tenant-aware service/repository boundary prevents new store queries without a tenant context.
- PostgreSQL RLS remains an evaluated P2 defense; application isolation and tests are required regardless.

### 9.4 Refresh sessions

- Refresh rotation is transactional.
- A failed concurrent claim is treated as reuse and revokes the known family.
- Users can list and revoke device/session families.
- Expired and revoked sessions are cleaned by cron.
- Access-token logout immediacy is enforced by token version or JTI denylist policy for security events.

## 10. Store lifecycle

- `PAUSED`: store-controlled operational state; no new orders, existing operations remain accessible.
- `SUSPENDED`: admin security action; all store sessions are revoked and every store route is blocked.
- `CLOSED`: terminal operational state; no store login, retention policies continue.

Suspension never doubles as an ordinary opening-hours or temporary-pause mechanism. Admin/support handles outstanding operational cases for suspended stores.

## 11. Phone and contact data

- CUSTOMER phone remains optional and never blocks checkout.
- Before the first order, UI may show a non-blocking prompt with explicit “add” and “continue without” actions.
- Refusal is not repeatedly nagged.
- Orders store `customerPhoneSnapshot`, which may be null.
- Store response explicitly says phone was not provided when null.
- Customer email is never exposed to the store as a fallback contact.
- DRIVER phone is required before admin approval and is available to linked stores for operational contact.
- Phone changes do not affect login or session validity.
- A future `phoneVerifiedAt` can be added without changing identity semantics.

## 12. Driver response minimization

- Active assigned delivery exposes only operationally required customer name, optional phone, address, reference, and coordinates.
- `taxId` is never returned to drivers.
- DELIVERED immediately removes customer contact and location from driver responses.
- DELIVERY_FAILED retains required data only while the return remains pending.
- Confirmed return immediately removes customer contact and location from driver responses.
- Driver history and earnings retain only store, item summary, timestamps, status, and financial values.
- Explicit DTOs replace all database-entity spreading.

## 13. Public and private media

### 13.1 Public media

- Logos and product images live in the public-media bucket.
- Public handler serves only allowed public prefixes/types.
- Immutable long caching is allowed for content-addressed/random immutable public keys.

### 13.2 Private evidence

- Return evidence lives in the private-evidence bucket.
- Access requires an authenticated logical evidence endpoint or short-lived signed URL.
- DRIVER access exists only while that driver's return is pending.
- Owning STORE and ADMIN can access during the analysis/retention window.
- CUSTOMER, unrelated drivers, unrelated stores, and anonymous users never receive access.
- Responses use `Cache-Control: private, no-store` unless a short-lived signed URL requires a narrowly bounded private cache.
- Every read is audited.

### 13.3 Upload safety and retention

- Ownership is verified before upload.
- Declared MIME is not trusted alone.
- Magic bytes are validated and images are safely decoded/re-encoded where supported.
- Size is rejected before or during streaming, not only after full materialization.
- Failed database attachment deletes the uploaded object.
- Orphan cleanup runs periodically.
- Private return evidence is retained for 90 days after return confirmation, or 90 days after a later dispute closes.
- Expiration deletes the R2 object and anonymizes/removes its active reference.

## 14. Payment integrity

### 14.1 Webhook inbox

1. Validate HMAC, timestamp freshness, required identifiers, and request shape.
2. Insert an idempotent provider/request/event record in `webhook_inbox`.
3. Re-fetch the payment from Mercado Pago.
4. Compare provider payment ID, amount, currency, external reference, merchant/account, and TEST/LIVE environment with local state.
5. Process immediately when possible; leave recoverable inbox state on transient failure.

### 14.2 Atomic local transition

Within a database transaction and row locks:

- claim the inbox item;
- compare-and-set payment state;
- transition order state;
- append order/security event;
- append outbox work;
- mark inbox processing result.

No early return can leave payment approved while order remains irrecoverably unpaid.

### 14.3 External side effects

- Refunds and cancellations use deterministic idempotency keys.
- PostgreSQL outbox records pending external operations.
- Cron retries with bounded backoff and records final/manual-review state.
- Divergent value, currency, reference, merchant, or environment becomes `REVIEW_REQUIRED`; it is never silently accepted.
- Five-minute cron reconciliation repairs transient local/provider divergence and raises observable alerts for persistent mismatches.

## 15. Abuse protection defaults

- WAF: 20 `/auth/*` requests per IP per 10 seconds before challenge/mitigation.
- Login identity: fifth failure within 15 minutes requires Turnstile.
- Login identity: ten failures within one hour cause a 15-minute cooldown.
- No permanent account lockout based only on failed remote attempts.
- Verification challenge: five code attempts.
- Resend: one minute cooldown, five/hour, ten/day per normalized email, plus IP limits.
- Registration, recovery, Google verification, MFA, and link tickets have distinct purpose-specific counters.
- Successful authentication resets or decays appropriate counters.
- Suspicious activity is audited without secrets, passwords, codes, raw tokens, or unnecessary PII.

## 16. API hardening

- Global and route-specific request-body limits reject with `413` before large materialization.
- JSON routes reject incorrect content type.
- Upload and CSV routes have byte, element, and per-line limits.
- External fetches use explicit timeouts.
- Authenticated and sensitive responses use `Cache-Control: no-store`.
- Global safe headers include `X-Content-Type-Options`, frame protection, appropriate CSP, and production HSTS.
- CORS is environment-specific, fail-closed, and covered by tests.
- `/docs`, `/openapi.json`, and detailed DB health are disabled or protected outside local development.
- Errors are stable and generic for authentication, recovery, and account existence.
- Internal logs use request IDs and redact authorization headers, tokens, codes, provider credentials, and sensitive request bodies.

## 17. Audit model

Append-only security/admin audit events cover:

- successful and failed authentication classes;
- email verification and recovery;
- provider link/unlink;
- MFA enrollment, recovery-code use, and disablement;
- session revocation and token-reuse detection;
- user block/unblock and role changes;
- store pause/suspension/closure;
- commission and financial status changes;
- private evidence read/delete;
- webhook divergence and manual review.

Events record actor, role, tenant, target type/ID, action, result, request ID, timestamp, and minimal environment/network context. They never store credentials or full sensitive payloads.

## 18. Failure and UX behavior

- Registration returns a verification flow, not a partial authenticated session.
- Recovery always returns an accepted generic envelope.
- Invalid login, link password, and MFA responses do not disclose unnecessary account state.
- Rate-limited operations return `429` with bounded retry information.
- Provider outages preserve retryable local state and do not create duplicate accounts, sessions, payments, or emails.
- Email delivery failure allows safe resend after cooldown and surfaces an actionable, non-sensitive message.
- Store suspension and blocked-account messages are explicit to the affected authenticated user but do not expose internals publicly.
- Customer phone prompt never blocks or penalizes checkout.

## 19. Testing strategy

### 19.1 Local automated tests

- Table-driven route authorization matrix for ANON, CUSTOMER, DRIVER, STORE_A, STORE_B, and ADMIN.
- Cross-tenant negative tests for every store-owned resource.
- Cross-driver and cross-customer object tests.
- Token-version, block, role-change, suspension, logout-all, and refresh-race tests.
- Password registration, verification, expiry, resend, recovery, and enumeration tests.
- Google verifier tests for signature/claim failures, new customer, existing provider, email collision, and explicit link ticket.
- MFA enrollment, login challenge, recovery code, disablement, and policy-toggle tests.
- Rate-limit threshold, cooldown, expiration, and anti-lockout tests.
- DTO snapshots proving driver responses never contain forbidden PII.
- Private evidence authorization, expiry, cache header, upload validation, and orphan-cleanup tests.
- Webhook replay, timestamp, provider mismatch, concurrency, injected failure, outbox, and reconciliation tests.
- Body-limit, content-type, CORS, safe-header, docs, and health exposure tests.

### 19.2 Staging gates

- Cloudflare Access blocks unauthenticated staging access.
- Worker-to-Hyperdrive-to-Neon smoke passes.
- Public and private R2 policies are independently verified.
- Turnstile real Siteverify succeeds and rejects replay.
- Google real ID-token login succeeds for an allowed tester.
- Resend sends only to the configured account owner before domain setup.
- Mercado Pago TEST PIX/card, webhook, cancellation, and refund reconciliation pass.
- FCM push smoke passes.
- Full CUSTOMER→STORE→DRIVER order lifecycle passes.
- Authenticated penetration checklist verifies tenant and role isolation.

### 19.3 Production gates

- All CI and staging gates pass on the exact release commit.
- Custom domain and Resend DNS are verified.
- Production secrets are distinct and validated.
- Backup and restore procedure is tested.
- Migration and application rollback are documented and rehearsed.
- Production deployment receives manual approval.
- Post-deploy smoke uses controlled non-destructive data before public launch.

## 20. Plan decomposition

After this design is approved, implementation is split into independently reviewable plans:

1. **P0 authorization and session foundation** — CUSTOMER guards, live principal state, token version, store suspension, private-media emergency guard, DTO minimization, body/header/docs baseline, and authorization matrix.
2. **Private staging infrastructure** — Neon/Hyperdrive, separate R2 buckets, environment configuration, Cloudflare Access, staging CI/CD, and smoke gates.
3. **Identity and account lifecycle** — email-first schema, Resend adapter, verification/recovery, Turnstile, Google, link tickets, rate limits, refresh/session management, optional TOTP/email MFA, and audit events.
4. **Privacy and media hardening** — final bucket handlers, signed/authenticated reads, safe uploads, PII DTOs, snapshots, retention, and cleanup.
5. **Payment reliability** — provider binding, inbox/outbox, atomic transitions, replay defense, retries, and reconciliation.
6. **Operational hardening** — admin Access enforcement, audit review surfaces, CI security scanning, secrets/runbooks, backup/restore, and observability.
7. **Production promotion** — custom domain, Resend DNS, production resources/secrets, manual deployment, E2E gate, and rollback.

Each plan uses TDD, contains exact file paths and commands, ends in a reviewable commit, and must leave the application deployable at its own boundary.

## 21. Acceptance criteria

The program is complete only when:

- no non-CUSTOMER role can use customer endpoints;
- no store can observe or mutate another store's private objects;
- no driver/customer can observe another actor's private objects;
- blocked/suspended/changed principals lose access immediately;
- password users cannot receive normal sessions before verified email;
- Google identity cannot take over an existing PASSWORD account by email match alone;
- auth abuse controls work without permanent victim-controlled lockout;
- admin surfaces remain behind Cloudflare Access;
- driver responses remove customer PII immediately after operational need ends;
- private evidence is never publicly retrievable and expires after policy retention;
- payment state survives retries, races, worker failure, and provider divergence;
- staging is isolated, private, and fully tested;
- production is separately provisioned and manually promoted only after all gates pass.

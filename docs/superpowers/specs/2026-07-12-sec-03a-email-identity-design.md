# SEC-03A Email Identity Lifecycle Design

**Date:** 2026-07-12
**Status:** Approved
**Source:** `docs/security/2026-07-11-backend-security-review.md`, finding SEC-03

## 1. Goal

Replace unverified phone-first password accounts with an email-first identity lifecycle that proves email ownership before account activation, provides safe password recovery, delivers transactional email through Resend, and resists account pre-hijacking, enumeration, code guessing, replay, concurrency, and provider outages.

SEC-03A must remain suitable for the projected low initial volume and Cloudflare/Neon free tiers. PostgreSQL is the authoritative store for identity state, challenges, action tickets, rate limits, audit events, and email outbox state. Cloudflare Queues, KV, and Durable Objects are not required.

## 2. Scope

### 2.1 Included

- Email-only PASSWORD login.
- Self-service CUSTOMER and DRIVER registration with verified email.
- Admin-provisioned STORE owner activation without an administrator-selected password.
- Bootstrap ADMIN email verification before first login.
- Six-digit email verification and password-recovery challenges.
- Single-use password setup and reset tickets.
- Resend adapter, local templates, PostgreSQL outbox, immediate delivery attempt, scheduled retry, and environment recipient policy.
- Purpose-specific PostgreSQL rate limits integrated with SEC-02.
- Expiration and cleanup through the existing scheduled Worker.
- Minimal web and driver screens required to complete registration, verification, store activation, and recovery.
- Store-driver invitations by verified email instead of phone.
- Focused append-only identity security events.

### 2.2 Deferred

- Google registration, login, collision handling, and provider linking: SEC-03B.
- TOTP, email MFA, recovery codes, and step-up authentication: SEC-17.
- Password hash algorithm and work-factor migration from the current PBKDF2 implementation.
- Full visual authentication refactoring.
- Resend bounce, complaint, and suppression webhooks. This is a production-scale carry-forward.
- Changing an authenticated account's email address.

## 3. Core security invariants

1. No self-service `users` row exists before email ownership is proven.
2. A PASSWORD session is never issued for an unverified email.
3. Phone is never a login identifier, recovery identifier, linking key, or unique identity.
4. A database dump never contains a plaintext or reversibly encrypted verification code, action ticket, password, refresh token, or Resend API key.
5. Codes and tickets are purpose-bound, short-lived, attempt-limited, single-use, and atomically consumed.
6. Matching an email never authorizes account linking, credential replacement, or role changes.
7. Public registration and recovery responses do not reveal whether an account, provider, role, or pending flow exists.
8. Provider failure cannot create duplicate users, duplicate sessions, duplicate password changes, or duplicate email sends.
9. STORE and ADMIN activation requires both verified email ownership and the role-appropriate password flow.
10. Every identity mutation that affects existing sessions updates or validates `tokenVersion` and refresh-token families as specified below.

## 4. Identity and account states

### 4.1 User fields

`users` gains:

- `email_verified_at timestamptz null`;
- `registration_source`: `SELF_SERVICE`, `ADMIN_PROVISIONED`, or `BOOTSTRAP`.

`users.email` becomes required and remains case-insensitively unique. Normalization is trim plus lowercase only. The system does not remove Gmail dots, strip plus-addressing, or apply provider-specific aliases.

`users.phone` remains nullable and loses its unique index:

- CUSTOMER phone is optional;
- DRIVER phone is required at registration and remains required before administrative approval;
- STORE and ADMIN user phone is optional;
- the commercial store contact remains `stores.phone` and is unrelated to login.

### 4.2 User status

The generic `PENDING` value is replaced by:

- `PENDING_EMAIL`: trusted provisioning created a STORE or ADMIN identity whose activation is incomplete;
- `PENDING_APPROVAL`: a DRIVER verified email ownership and awaits admin approval;
- `ACTIVE`: normal role-appropriate access;
- `BLOCKED`: sessions and protected access are denied.

Self-service CUSTOMER and DRIVER attempts live in `pending_registrations`, not `users`. A verified CUSTOMER is created directly as `ACTIVE`; a verified DRIVER is created directly as `PENDING_APPROVAL`.

### 4.3 Store state

`stores.security_status` gains `PENDING_ACTIVATION`. An admin-created store and owner start in `PENDING_ACTIVATION` and `PENDING_EMAIL`. Public discovery, catalog checkout, owner operational routes, and store live-principal resolution reject this state. Password setup after a valid activation challenge atomically sets:

- owner `emailVerifiedAt = now`;
- owner `status = ACTIVE`;
- store `securityStatus = ACTIVE`;
- a new PASSWORD provider containing the selected password hash.

Existing `SUSPENDED` and `CLOSED` semantics remain unchanged.

## 5. Persistence model

### 5.1 Pending registrations

`pending_registrations` contains a self-service attempt, not an identity:

- random UUID primary key used as `verificationId`;
- normalized email;
- name, optional/required phone according to role, role, terms acceptance time;
- password hash produced with the current password hasher;
- absolute `expiresAt = createdAt + 24 hours`;
- consumed/closed timestamp and result classification;
- created/updated timestamps.

Multiple bounded pending attempts may exist for the same email. SEC-02-derived IP and email limits cap storage. Confirmation creates `users` and `auth_providers` in one transaction. The case-insensitive user email unique index resolves races: one attempt wins; all others close without overwriting identity or credentials.

This detached model prevents an attacker from pre-registering a victim's email with an attacker-known password and leaving that password attached when the victim later verifies a different flow.

### 5.2 Auth challenges

`auth_challenges` represents email possession proof:

- UUID primary key;
- purpose: `REGISTRATION_VERIFY`, `STORE_ACTIVATION`, `ADMIN_ACTIVATION`, or `PASSWORD_RECOVERY`;
- optional `pendingRegistrationId` or `userId`, constrained according to purpose;
- normalized email snapshot required to bind delivery; rate-limit and audit contexts use a separate pseudonymous HMAC key;
- keyed verification hash of the six-digit code;
- `attemptCount`, maximum five;
- `expiresAt = createdAt + 10 minutes`;
- `consumedAt`, invalidation reason, and timestamps.

Only one unconsumed challenge per logical flow and purpose is current. Reissue invalidates the prior challenge atomically before creating the replacement.

### 5.3 Action tickets

`auth_action_tickets` stores only a keyed hash of a random opaque token. Purposes are `PASSWORD_RESET` and `INITIAL_PASSWORD_SETUP`. Each ticket binds exact user, purpose, expiry, creation challenge, and consumption state. Tickets expire after ten minutes and are claimed with one conditional update. Raw tickets exist only in the API response and ephemeral client memory; they never enter URLs or persistent browser storage.

### 5.4 Email outbox

`email_outbox` contains:

- UUID primary key and stable Resend idempotency key;
- template type;
- recipient and non-secret rendering metadata;
- optional challenge reference;
- `PENDING`, `PROCESSING`, `SENT`, `FAILED`, or `CANCELLED` status;
- attempt count, `nextAttemptAt`, provider message ID, bounded sanitized failure class, timestamps;
- a lease boundary so concurrent cron/request dispatchers cannot process the same row simultaneously.

No code or action ticket is stored in this table. Code emails reference a live challenge; the dispatcher reconstructs the code in Worker memory. Once a challenge expires or is invalidated, its unsent email is cancelled rather than delivering a stale code.

### 5.5 Identity security events

A focused append-only table records registration confirmation, challenge outcomes, password reset, session revocation, store activation, delivery failure class, and cleanup. It stores event kind, result, actor/target IDs where known, pseudonymous email/IP key where needed, server-generated request ID, and timestamp. It never stores raw email, phone, credentials, codes, tickets, provider tokens, or request bodies.

## 6. Code and ticket cryptography

`AUTH_CODE_SECRET` is a high-entropy production secret independent from `JWT_SECRET` and `RATE_LIMIT_HMAC_SECRET`.

For a challenge, the Worker computes a pseudorandom stream using domain-separated HMAC-SHA-256 over challenge ID and purpose. Rejection sampling over 32-bit chunks maps the stream uniformly into `000000` through `999999`; modulo bias is not accepted. The code is rendered with leading zeroes.

The database stores only a second domain-separated keyed hash of the derived code and challenge context. Verification recomputes the candidate hash and compares fixed-length bytes in constant time. A database dump without `AUTH_CODE_SECRET` cannot derive or brute-force live codes offline. The secret and derived values never enter logs.

Action tickets use at least 256 bits from `crypto.getRandomValues`. Only a domain-separated keyed hash is persisted. Ticket lookup/claim is atomic and independent from verification-code counters.

## 7. Password policy

- CUSTOMER password: 8 through 128 characters.
- DRIVER, STORE, and ADMIN password: 15 through 128 characters.
- Recovery applies the current role's minimum.
- Unicode, spaces, paste, password-manager autofill, and passphrases are accepted.
- Passwords are never silently trimmed or truncated.
- No uppercase, lowercase, digit, or symbol composition rule exists.
- A versioned local blocklist rejects very common passwords.
- No periodic password rotation is required.

The current PBKDF2 format remains compatible. Password-storage modernization is deliberately separate so identity lifecycle changes and hashing-cost changes are not combined in one migration.

## 8. Flows

### 8.1 Self-service CUSTOMER and DRIVER registration

1. Client submits normalized email, role-appropriate fields, password, terms acceptance, and mandatory Turnstile token.
2. API consumes registration IP and normalized-email policies before expensive work.
3. If an active/provisioned account already owns the email, the API creates no pending registration and returns a synthetic response with the same public shape. At most once per day per email, it queues a security notice explaining that an account already exists and points to login/recovery; no account data changes.
4. Otherwise the API hashes the password, creates a detached pending registration, challenge, and outbox row transactionally.
5. API attempts delivery after commit and returns `202` with opaque `verificationId`, `expiresAt`, and `resendAt`; it never returns tokens.
6. Confirmation claims the challenge and pending registration in a transaction.
7. If no user owns the email, confirmation creates the user and PASSWORD provider:
   - CUSTOMER: `ACTIVE`, `emailVerifiedAt = now`, then one session is issued;
   - DRIVER: `PENDING_APPROVAL`, `emailVerifiedAt = now`, no operational session.
8. A concurrent winner or account collision closes the attempt without modifying the existing account. The public failure remains generic.

Pending self-service attempts expire at their original 24-hour boundary. Reissuing a code never extends it.

### 8.2 Verification resend

- A valid flow may request a resend after 60 seconds.
- Reissue invalidates the old challenge and pending outbox email in one transaction.
- The new challenge expires in ten minutes but never after the pending registration's absolute 24-hour expiry.
- Limits are five sends/hour and ten/day per normalized email, plus IP limits.
- Turnstile becomes required on the third resend request for the same flow/email within one hour.
- Five incorrect confirmation attempts invalidate the challenge. A new challenge still requires all resend cooldowns and limits.

### 8.3 Admin-provisioned STORE activation

1. Authenticated ADMIN creates store and owner without supplying a password.
2. Owner is `PENDING_EMAIL`; store is `PENDING_ACTIVATION`; challenge and outbox are created in the same transaction.
3. Email contains the public web activation URL carrying only `verificationId`; the recipient types the six-digit code.
4. Correct code consumes the challenge and returns a ten-minute `INITIAL_PASSWORD_SETUP` ticket. It does not yet activate the account or store.
5. Owner submits only setup ticket and a role-compliant password.
6. One transaction claims the ticket, creates the PASSWORD provider, sets `emailVerifiedAt`, activates owner and store, and appends the security event.
7. No session is issued. Owner logs in with email and the new password.

Provisioned STORE records do not expire automatically. Expired codes/tickets may be reissued through an authenticated admin action. The administrator never learns the owner's password.

### 8.4 Bootstrap ADMIN activation

The one-time bootstrap command creates a single `PENDING_EMAIL` ADMIN with its password hash, activation challenge, and outbox row. Credentials are read from environment/stdin-compatible secret sources, never command arguments or output. Correct code atomically sets `emailVerifiedAt` and `ACTIVE`. No session is issued; the admin performs a normal password login. Cloudflare Access remains independently required outside local development.

### 8.5 Password recovery

1. `start` always requires Turnstile, consumes IP/email policies, and returns `202` with a syntactically valid `recoveryId` whether the account exists or supports PASSWORD.
2. For an eligible verified PASSWORD account, the transaction creates a recovery challenge and outbox row. Synthetic flows have no persisted challenge and behave externally like invalid/expired real flows.
3. Correct code atomically consumes the challenge and returns a ten-minute raw reset ticket while persisting only its keyed hash.
4. `reset` accepts only the reset ticket and new password; it does not accept email, user ID, or code.
5. One transaction validates the role-specific password policy, claims the ticket, updates the PASSWORD hash, increments `tokenVersion`, revokes every unrevoked refresh-token family, and appends the event.
6. A security-notification email is queued after the credential mutation in the same transaction.
7. Recovery never issues a session. The user signs in again.

Pending STORE/ADMIN accounts do not use ordinary password recovery until initial password setup is complete. Their activation resend flow handles expired setup.

## 9. API contract

The API exposes:

- `POST /auth/register`;
- `POST /auth/verification/confirm`;
- `POST /auth/verification/resend`;
- `POST /auth/recovery/start`;
- `POST /auth/recovery/verify`;
- `POST /auth/recovery/reset`;
- `POST /auth/password-setup`;
- authenticated ADMIN resend action for a provisioned owner/admin activation.

Confirmation returns a discriminated result:

- `CUSTOMER_SESSION`: public user plus access and refresh tokens;
- `DRIVER_PENDING_APPROVAL`: public user state without tokens;
- `EMAIL_VERIFIED`: ADMIN activation complete without tokens;
- `PASSWORD_SETUP_REQUIRED`: raw one-time setup ticket and expiry.

Stable public error codes include `FLOW_INVALID_OR_EXPIRED`, `CODE_INVALID_OR_EXPIRED`, `PASSWORD_POLICY_REJECTED`, `RATE_LIMITED`, `TURNSTILE_REQUIRED`, `TURNSTILE_INVALID`, `EMAIL_DELIVERY_UNAVAILABLE`, and existing generic authentication codes. Incorrect, expired, consumed, synthetic, or concurrently lost flows do not disclose which condition occurred.

Sensitive auth responses use `Cache-Control: no-store`. Request schemas reject unexpected identity selectors: confirmation accepts `verificationId + code`; reset/setup accepts `ticket + newPassword`; recovery initiation accepts normalized email plus Turnstile.

## 10. Rate limits and attempt accounting

SEC-03A extends the atomic PostgreSQL limiter from SEC-02 with purpose-separated scopes:

| Operation | Email/flow limit | IP limit |
|---|---:|---:|
| Registration | existing 3/hour, 10/day | existing 10/hour, 30/day |
| Code send/resend | 1/min, 5/hour, 10/day per email and purpose | 20/hour, 50/day |
| Code confirmation | 5 total per challenge | 30/hour |
| Recovery start | 5/hour, 10/day | 10/hour, 30/day |
| Recovery verification | 5 total per challenge | 30/hour |
| Ticket consumption | single atomic use | 30/hour |

Registration, registration resend, store/admin activation, recovery, and future MFA never share identity scopes. IP throttling is auxiliary and cannot permanently lock an account. A rejected code attempt is recorded atomically before the generic response. Successful code confirmation consumes the challenge; counters naturally expire through retention cleanup.

## 11. Email delivery

### 11.1 Adapter boundary

Routes and identity services depend on an `EmailSender` contract. The Resend implementation uses an API key restricted to sending, explicit request timeout, structured non-sensitive error classification, HTML plus plaintext bodies, and the outbox row's stable `Idempotency-Key`. Provider response bodies are not forwarded to clients.

### 11.2 Dispatch and retry

The identity transaction commits before external delivery. The request then attempts to lease and send its outbox row immediately. Failure leaves retryable state and still returns the flow's generic `202` response. A missing or invalid required environment secret fails before flow creation with generic `503 EMAIL_DELIVERY_UNAVAILABLE`.

The existing five-minute cron leases at most 50 rows for two minutes using row locks/skip-locked semantics. Code email is retried only while its challenge remains valid, normally allowing the immediate attempt and the next five-minute attempt. Expired/inactive challenge mail becomes `CANCELLED`. Non-code security notices attempt at approximately 0, 5 minutes, 30 minutes, 2 hours, and 12 hours, then end as `FAILED` with an auditable failure class. Resend's 24-hour idempotency retention covers this retry schedule.

### 11.3 Templates

Templates are source-controlled functions that produce responsive HTML with inline styles and a plain-text alternative. The six-digit code is selectable text, visually large, centered, and widely spaced; it is never an image. Messages state ten-minute expiry, advise never sharing the code, and explain how to ignore an unsolicited email. Templates do not include passwords, tickets, raw database identifiers, or sensitive account detail.

### 11.4 Environment policy

- Automated tests inject a fake sender and assert envelopes/templates without network calls.
- Local interactive use may use a configured Resend test account; code is never printed to logs.
- Staging requires `EMAIL_ALLOWED_RECIPIENTS`, initially limited to the Resend account owner's address. Requests for other recipients keep public response semantics but delivery is blocked and classified.
- Production startup/config validation rejects an allowlist and requires a verified-domain `EMAIL_FROM` value.
- A separate `PUBLIC_WEB_URL` builds activation/recovery URLs; it must be allowlisted per environment and never derived from request headers.

Required secrets/variables are documented without values: `RESEND_API_KEY`, `AUTH_CODE_SECRET`, `EMAIL_FROM`, `PUBLIC_WEB_URL`, and environment-specific `EMAIL_ALLOWED_RECIPIENTS`.

## 12. Login and surrounding domain changes

PASSWORD login accepts only normalized email and password. Phone lookup and phone-based rate-limit identities are removed. Unknown email and missing PASSWORD provider retain the fixed dummy-password verification path from SEC-02.

Login state behavior becomes:

- `PENDING_EMAIL`: no session; generic activation guidance appropriate to the known authenticated attempt without public provider detail;
- `PENDING_APPROVAL`: DRIVER receives explicit approval-pending result only after correct password verification;
- `ACTIVE`: normal session issuance;
- `BLOCKED`: explicit blocked response only after correct credential verification.

Store-driver invitation input changes from phone to normalized email and resolves only a verified DRIVER. Store lists may continue returning the driver's contact phone where business authorization already permits it.

## 13. Minimal client behavior

Web and driver clients add only the screens/state required for a usable security flow:

- registration requires email; CUSTOMER phone is optional; DRIVER phone is required;
- role-specific password length is shown before submission;
- successful registration navigates to code confirmation carrying `verificationId`, never password or code;
- refresh/reload preserves only public flow ID and expiry in the URL or session storage;
- resend displays bounded retry time and handles adaptive Turnstile;
- DRIVER confirmation explains admin approval is next;
- web login offers complete start/verify/reset recovery screens;
- store activation opens from the email URL, confirms code, then defines password;
- admin store creation removes the owner-password field;
- store driver invitation accepts email;
- login labels and autocomplete use email only.

No client stores passwords, codes, reset/setup tickets, access tokens, or refresh tokens in URLs. Existing token-storage modernization remains outside this design.

## 14. Concurrency and failure semantics

- Challenge consumption uses a conditional update requiring `consumedAt is null`, `expiresAt > now`, and `attemptCount < 5`.
- Incorrect attempt increment and fifth-attempt invalidation occur atomically.
- User/provider creation and pending-registration claim share one transaction.
- User email and provider unique constraints are the final race defense.
- Ticket claim and credential mutation share one transaction.
- Password reset updates password, `tokenVersion`, refresh revocation, event, and notification outbox atomically.
- Store activation updates provider, owner, store, ticket, and event atomically.
- Outbox leases recover after worker termination; idempotency keys prevent duplicate provider delivery.
- A Resend outage preserves locally retryable state and never rolls back a completed password reset or creates an authenticated pending identity.
- Invalid environment secrets fail closed for code generation and delivery.

## 15. Cleanup

The scheduled Worker processes bounded, indexed batches to:

- delete/close expired self-service pending registrations after 24 hours;
- invalidate expired challenges and tickets;
- cancel stale code outbox rows;
- retry eligible outbox rows;
- delete sent/cancelled outbox rows after seven days and failed rows after 30 days;
- delete expired challenges, consumed tickets, and consumed pending attempts after 24 hours;
- retain minimal pseudonymous identity security events for 90 days; a later LGPD policy may shorten or formally supersede this value.

Provisioned STORE and ADMIN users are never automatically deleted. Their challenges expire and may be reissued by an authenticated administrator.

## 16. Migration strategy

Migration history remains append-only. The migration:

- adds the new tables/enums/indexes and `users` fields;
- replaces generic user pending-state semantics;
- adds store `PENDING_ACTIVATION`;
- drops phone uniqueness;
- makes user email required after a precondition check;
- preserves the case-insensitive email unique index.

There is no production legacy-data compatibility requirement. Local data is disposable and staging has no real users. The migration must fail loudly rather than silently invent emails or delete unexpected rows when preconditions are violated; development databases may be recreated from zero. The exact generated migration filename follows the current Drizzle journal and is not predetermined in the implementation plan.

## 17. Testing strategy

Automated coverage includes:

- schema normalization, role-specific password policy, common-password blocklist, and phone optionality;
- deterministic code reconstruction, six-digit formatting, rejection sampling boundaries, domain separation, hash-only persistence, and constant-time comparison;
- challenge expiry, wrong attempts, fifth-attempt invalidation, resend invalidation, and single consumption;
- concurrent confirmation where only one user/provider is created;
- pre-hijacking regression where one pending attempt cannot leave its password on a separately verified flow;
- existing/inexistent/provider/state response equivalence for registration and recovery;
- CUSTOMER, DRIVER, STORE, and ADMIN state transitions and session outcomes;
- reset ticket expiry/replay/race, role password rule, `tokenVersion` increment, and all-family refresh revocation;
- store password setup race and atomic owner/store activation;
- per-purpose email/IP/flow thresholds and adaptive resend Turnstile;
- Resend timeout/error mapping, stable idempotency, immediate send, cron retry, stale-code cancellation, lease recovery, and concurrent dispatch;
- HTML/plaintext template content without secret leakage;
- staging recipient allowlist and production config fail-closed behavior;
- email-only login and store-driver invitation by verified email;
- cron cleanup boundaries and protection of provisioned users;
- migration application from an empty database;
- complete monorepo test, typecheck, lint, build, migration, and diff-whitespace gates.

Manual staging validation covers one real allowed-recipient registration, resend, expiration, recovery, password reset/session revocation, store activation, Resend outage simulation, and confirmation that no code/ticket appears in Worker logs or PostgreSQL rows.

## 18. Acceptance criteria

SEC-03A is complete when:

- no PASSWORD account or session can be created without verified email ownership;
- detached registration prevents attacker-selected credentials surviving victim verification;
- CUSTOMER and DRIVER reach the correct post-verification state;
- STORE activation never exposes the owner's password to ADMIN and never publishes a pending store;
- ADMIN cannot log in before email verification;
- phone is absent from login, recovery, identity uniqueness, and invitation lookup;
- code and ticket persistence is hash-only and all mutation/consumption races have tests;
- recovery revokes all existing sessions and never enumerates account state;
- Resend outage/retry is safe and duplicate-resistant without Queues, KV, or Durable Objects;
- environment restrictions make staging usable for the configured owner and fail closed in production;
- security review documents SEC-03 as remediated in code while preserving explicit external staging/domain prerequisites and deferred work.

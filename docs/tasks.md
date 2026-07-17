# Delivery — canonical task ledger

> **Authority:** this file is the source of truth for repository work. Specs and
> implementation plans provide detail but do not override the state or decisions
> recorded here. See `AGENTS.md` for the mandatory update protocol.

**Last reviewed:** 2026-07-17
**Current branch at review:** `main`
**Production status:** blocked; private staging and Mercado Pago sandbox are not
production authorization.

## Execution authorization

This ledger records work; it does not authorize work. `READY` means only that a
task is specified well enough to implement. No agent may implement a task, mutate
provider/infrastructure state, deploy, reset data, or promote an environment
without an explicit user request for that action. Updating this ledger or a spec
must not silently begin implementation.

## How to maintain this ledger

### Status vocabulary

| Status              | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `PROPOSED`          | Idea recorded, design not yet approved.                               |
| `DECISION_REQUIRED` | Progress depends on a product/security decision.                      |
| `READY`             | Scope and acceptance criteria are approved; implementation may start. |
| `IN_PROGRESS`       | Implementation is actively being performed.                           |
| `PARTIAL`           | Some acceptance criteria passed, but required work remains.           |
| `BLOCKED`           | External dependency or authority prevents meaningful progress.        |
| `DONE`              | All acceptance criteria passed with recorded evidence.                |
| `SUPERSEDED`        | Replaced by another task; replacement ID must be recorded.            |

### Required update rules

- Add a stable task ID before work begins.
- Update this file in the same commit that changes a task's implementation state.
- Record only sanitized evidence: commands, PASS/FAIL, commit IDs, version IDs,
  and resource names. Never record secrets or PII.
- A task may be `DONE` only after its focused tests and proportional repository
  gate pass.
- New findings discovered during another task become separate entries when they
  have an independently reviewable outcome.

## Approved product and financial invariants

These decisions are already approved and must not be silently changed.

1. The platform and drivers are service providers; they do not share the
   merchant's business risk. Every driver cancellation/return compensation is
   debited from the store.
2. Customer cancellation is immediate while an order is `AWAITING_PAYMENT`,
   `PENDING`, or only `ACCEPTED`. From `PREPARING` onward, store approval is
   normally required.
3. A delayed active order becomes directly cancelable by the customer after a
   deadline calculated from the store's acceptance, regardless of its active
   fulfillment status. Terminal orders are excluded.
4. Test deadlines are two minutes for store acceptance and ten minutes after
   store acceptance for delayed cancellation. The intended production delayed
   threshold is 90 minutes; values must be explicit and environment/config aware.
5. A cancellation racing with provider approval remains safe: approved money is
   refunded; unresolved provider state remains under durable reconciliation.
6. General-pool driver compensation:
   - assigned but not arrived: no compensation;
   - arrived at store but did not collect: 50% of the original delivery fee;
   - collected and return required: 100% of the original delivery fee plus the
     configured return-route bonus, released only after confirmed return.
7. Closed-shift/own-store drivers receive no arrival half-fee and no return-route
   bonus. A confirmed return releases only the normal frozen `perDeliveryCents`.
8. The return-route bonus is a global platform setting controlled by ADMIN,
   defaults to 50%, accepts integer values from 0% through 100%, is calculated
   over the original customer delivery fee, and is frozen when the return
   obligation is created.
9. Every case where a driver has custody of an item and must take it back to the
   store is a return route. Compensation remains conditional on the existing
   store/admin return confirmation.
10. A customer cancelling a delayed `OUT_FOR_DELIVERY` order sees a two-step
    warning. “Continue waiting” is primary, but “Cancel anyway” remains available
    without timers, typed phrases, or other dark patterns.
11. Push is best-effort notification, never the source of truth. API state and
    polling must prevent a cancelled delivery from continuing even when push
    fails.

## Roadmap order

1. `ORD-CAN-01` — cancellation deadlines and unified policy.
2. `DSP-RET-01` — driver compensation and return-route bonus.
3. `NOT-CAN-01` — cancellation UX and reliable actor notification.
4. `SEC-WEBHOOK-01`, `SEC-MEDIA-01`, `SEC-UPLOAD-01`, `SEC-PASSWORD-01` — highest
   remaining pre-production security corrections.
5. `STAGING-REFRESH-01` — promote the current schema/application to private
   staging only after its dependencies pass.
6. Remaining identity, tenancy, operations, edge, and production tasks.

The three cancellation tasks form one approved product program and should be
designed and implemented together in one isolated worktree, while retaining
separate review gates and commits.

**Implementation plan:**
[`2026-07-17-order-cancellation-deadlines-return-route-implementation.md`](superpowers/plans/2026-07-17-order-cancellation-deadlines-return-route-implementation.md)

---

## Active product program — cancellation, deadlines, and returns

### ORD-CAN-01 — Unified cancellation policy and deadlines

**Status:** `READY`
**Priority:** P0 before broader staging/payment use
**Detailed spec:**
[`2026-07-17-order-cancellation-deadlines-return-route-design.md`](superpowers/specs/2026-07-17-order-cancellation-deadlines-return-route-design.md)

**Objective:** make store acceptance timeout, fast customer cancellation, and
delayed-order cancellation race-safe, auditable, and independent from payment
provider timing.

**Scope:**

- Persist an acceptance deadline when an order becomes commercially visible to
  the store (`PENDING`), not when an unpaid order was originally created.
- Persist the first store acceptance timestamp on `PENDING → ACCEPTED`.
- Cancel unaccepted orders automatically after the configured deadline.
- Permit direct customer cancellation through `ACCEPTED`.
- Require store approval from `PREPARING` onward until the late-cancellation
  threshold is reached.
- After that threshold, permit direct cancellation of every non-terminal active
  status, including `OUT_FOR_DELIVERY`.
- Use one transactional cancellation policy/service for customer, store, cron,
  amendment rejection, and future support actions.
- Preserve durable Mercado Pago cancel/refund/reconciliation behavior.
- Remove a cancelled order safely from a batch without corrupting remaining
  batch deliveries.

**Dependencies:** current Orders payment operation queue, order events, amendment
expiry, batch invariants, `DSP-RET-01` for assigned-driver disposition.

**Acceptance criteria:**

- [ ] CASH/CARD_MACHINE orders receive a store acceptance deadline at creation.
- [ ] Online orders receive it only when authoritative payment approval moves
      them from `AWAITING_PAYMENT` to `PENDING`.
- [ ] Local/test timeout cancels an unchanged `PENDING` order after two minutes;
      the cron cadence gives a documented maximum execution delay.
- [ ] A store acceptance racing the timeout has exactly one winner under row lock
      or compare-and-set; no accepted order is later cancelled by the stale job.
- [ ] `AWAITING_PAYMENT`, `PENDING`, and `ACCEPTED` cancel directly for owner
      CUSTOMER.
- [ ] `PREPARING`, `READY`, and `AWAITING_DRIVER` require store approval before
      the late threshold.
- [ ] After ten minutes in local/test, active delayed orders cancel directly.
- [ ] `DELIVERED`, `DELIVERY_FAILED`, and `CANCELLED` reject this customer flow.
- [ ] Pending amendments and driver broadcasts are closed consistently.
- [ ] Cancelling one order in a batch preserves and recalculates the remaining
      batch safely.
- [ ] Duplicate customer/cron/store cancellation is idempotent and creates at
      most one canonical external payment disposition.
- [ ] Order events identify actor, reason (`CUSTOMER_FAST`,
      `STORE_ACCEPT_TIMEOUT`, `CUSTOMER_DELAYED`, or store decision), and time.
- [ ] Store queues never expose `AWAITING_PAYMENT`; timed-out orders leave active
      queues.

**Verification still required:** focused state-machine/service/route/cron/batch
tests, API suite, shared suite, typecheck, lint, build, and manual sandbox refund
smoke.

### DSP-RET-01 — Driver disposition and return-route compensation

**Status:** `READY`
**Priority:** P0, coupled to `ORD-CAN-01`
**Detailed spec:** same linked cancellation design.

**Objective:** ensure every cancellation involving an assigned driver stops the
delivery safely and pays only the approved, idempotent compensation after
verifiable milestones.

**Scope:**

- Classify the job as general-pool or closed-shift/own-store using the frozen
  assignment (`shiftId` plus assignment metadata), not only broadcast target.
- General pool: no pay before arrival; half original delivery fee after arrival
  without collection; full original delivery fee plus return-route bonus after
  collection and confirmed return.
- Shift/own: no arrival half-fee; confirmed return pays only frozen
  `perDeliveryCents`.
- Introduce a single return-obligation creator used by delivery failure,
  delayed cancellation after collection, and future custody-return cases.
- Snapshot compensation inputs when the obligation is created.
- Keep the driver attached while return is pending; block customer delivery and
  unrelated driver mutations.
- Release all credits only after store/admin confirmation using the existing
  return proof workflow.
- Pair every driver credit with a store debit; never charge the platform.

**Global configuration:**

- Default return-route bonus: 50%.
- Valid ADMIN range: integer 0–100%.
- Base: original `orders.deliveryFeeCents`.
- Applies only to general-pool drivers.
- The chosen percentage and computed cents are immutable snapshots per return.
- ADMIN changes require authorization, audit event, validation, and must not
  rewrite historical obligations.

**Acceptance criteria:**

- [ ] Pool driver assigned but not arrived is detached/notified with zero ledger
      entries.
- [ ] Pool driver arrived but did not collect receives exactly half the original
      delivery fee, rounded once, with equal store debit and idempotent keys.
- [ ] Shift/own driver in the same arrival scenario receives no partial entry.
- [ ] A collected cancelled delivery creates a return obligation rather than
      clearing `driverId` or pretending delivery completed.
- [ ] Before confirmation, both base and bonus credits are absent.
- [ ] Confirmed pool return at 50% produces total driver credit equal to 150% of
      original delivery fee and equal aggregate store debit.
- [ ] Confirmed shift/own return produces only frozen `perDeliveryCents` and its
      matching store debit.
- [ ] Changing the global percentage after obligation creation does not change
      its payout.
- [ ] Confirmation retries and concurrent store/admin confirmation cannot double
      pay.
- [ ] Existing `DELIVERY_FAILED` returns use the same centralized obligation and
      preserve current evidence/confirmation behavior.
- [ ] Return-route data is visible only to the assigned driver, owning store, and
      authorized admin.

**Verification still required:** migration-from-zero test; focused dispatch,
returns, ledger, settlement, authorization, and concurrency suites; manual tests
for pool and shift drivers.

### NOT-CAN-01 — Cancellation warnings and reliable actor notification

**Status:** `READY`
**Priority:** P1, required before enabling delayed direct cancellation
**Detailed spec:** same linked cancellation design.

**Objective:** warn customers without blocking their right to cancel and ensure
store/driver interfaces stop acting on cancelled work even if push delivery
fails.

**Scope:**

- Two-step customer warning for delayed `OUT_FOR_DELIVERY` cancellation.
- Primary action continues waiting; secondary action cancels anyway.
- No artificial timer, typed confirmation, hidden action, or repeated prompt.
- Urgent cancellation event for assigned driver and owning store.
- Best-effort FCM plus API/polling state convergence.
- Driver UI replaces navigation/delivery actions with return instructions when
  custody exists; otherwise removes the delivery from active work.
- Store UI exposes return confirmation and compensation summary without customer
  secrets or unnecessary driver PII.

**Acceptance criteria:**

- [ ] Warning appears only for an eligible delayed order currently
      `OUT_FOR_DELIVERY`.
- [ ] Server rechecks status, ownership, deadline, and terminal state on final
      confirmation.
- [ ] One click on “Continue waiting” performs no mutation.
- [ ] “Cancel anyway” remains accessible and calls exactly one mutation.
- [ ] Driver cannot collect, deliver, release, or otherwise advance a cancelled
      order after refreshing/polling, even when no push was received.
- [ ] Driver with custody receives return-to-store instructions.
- [ ] Store and driver receive sanitized cancellation reason and order ID only.
- [ ] Notification retries cannot duplicate ledger or payment operations.
- [ ] Web and driver accessibility tests cover focus, labels, keyboard behavior,
      and status announcements.

**Verification still required:** web/driver component tests, route contract tests,
push-adapter failure tests, polling/manual multi-session smoke.

---

## Security backlog

### SEC-WEBHOOK-01 — Webhook replay freshness and provider-cost control

**Status:** `READY`
**Priority:** P0 before production payments
**Origin:** SEC-15.

**Objective:** retain Mercado Pago signature/inbox protection while bounding
captured-request replay and provider lookup cost.

**Scope:** validate signed timestamp against a documented tolerance; preserve
constant-time HMAC verification; deduplicate request/resource IDs durably; rate
limit valid and invalid traffic without dropping legitimate retries; continue
authoritative provider GET before financial transitions.

**Acceptance criteria:**

- [ ] Correct current signatures pass; stale/future timestamps outside tolerance
      fail with stable response and no provider call.
- [ ] Identical notification retry is idempotent.
- [ ] A new request ID cannot create duplicate financial effects.
- [ ] Rate limiting occurs before expensive provider work and is observable
      without logging signature/body/secrets.
- [ ] Official Mercado Pago webhook test and sandbox order notification pass.

### SEC-MEDIA-01 — Private return evidence lifecycle

**Status:** `READY`
**Priority:** P0 before real return evidence
**Origin:** SEC-06.

**Objective:** replace the current emergency public-read block with authenticated,
tenant-scoped evidence access and retention.

**Acceptance criteria:**

- [ ] Return evidence is never reachable through public `/media/*`.
- [ ] Only assigned driver during need, owning store, and authorized admin can
      access evidence.
- [ ] Access is short-lived or streamed through authorization and audited.
- [ ] Retention and deletion jobs have idempotent tests and sanitized logs.
- [ ] Cross-customer/store/driver authorization matrix remains negative.

### SEC-PRIVACY-01 — Store/admin response minimization

**Status:** `READY`
**Priority:** P1
**Origin:** remaining SEC-07 scope.

**Objective:** replace broad store/admin order and return projections with explicit
DTOs containing only operationally necessary fields.

**Acceptance criteria:** explicit DTO contract tests; no internal payment secrets,
auth state, unrelated customer PII, or raw database row spreads; historical views
remove data after operational need.

### SEC-PASSWORD-01 — Password storage modernization

**Status:** `READY`
**Priority:** P0 before public launch
**Origin:** SEC-09.

**Objective:** adopt a Workers-compatible password baseline with versioned hashes
and transparent upgrade.

**Acceptance criteria:** benchmark-selected cost; minimum 15 characters for
single-factor accounts; compromised/common-password blocklist; constant-work
unknown-user path; rehash-on-login; legacy hashes continue to verify only for
migration; privileged accounts covered by `SEC-MFA-01`.

### SEC-SESSIONS-01 — Session/device lifecycle

**Status:** `READY`
**Priority:** P1
**Origin:** remaining SEC-11 and SEC-18 scope.

**Objective:** extend atomic refresh rotation with bounded, user-visible session
management.

**Acceptance criteria:** active-session cap; minimal device metadata; list/revoke
one/revoke-all; inactivity expiry; cleanup metrics; replay alert; password or
identity changes revoke affected families.

### SEC-PROVIDER-LIMITS-01 — External call budgets and deadlines

**Status:** `PARTIAL`
**Priority:** P1
**Origin:** SEC-12.

**Already present:** body limits, streaming upload limit, Mercado Pago/Resend and
selected provider timeouts.

**Remaining acceptance criteria:** every external adapter, including FCM and
future Google Identity, has a bounded deadline; concurrency/cost budgets; retry
classification; CSV byte/line-length limits; observable circuit behavior without
response-body logging.

### SEC-UPLOAD-01 — File authenticity, normalization, and orphan cleanup

**Status:** `READY`
**Priority:** P0 before user evidence/uploads at scale
**Origin:** SEC-13.

**Acceptance criteria:** ownership before storage; magic-byte validation; safe
decode/re-encode for supported images; declared MIME is not trusted; cleanup on
DB/race failure; tenant quota; orphan reconciliation; malicious/polyglot and
decompression tests.

### SEC-TENANCY-01 — Tenant isolation defense in depth

**Status:** `READY`
**Priority:** P1
**Origin:** SEC-16.

**Objective:** make store-scoped access difficult to express without a tenant ID.

**Acceptance criteria:** tenant-aware repository/service boundary; exhaustive
cross-store contracts; least-privilege runtime role retained; explicit privileged
admin/job path; evaluate and document PostgreSQL RLS decision before production.

### SEC-MFA-01 — Privileged MFA, step-up, and immutable audit

**Status:** `READY`
**Priority:** P0 before production ADMIN/STORE finance
**Origin:** SEC-17.

**Acceptance criteria:** phishing-resistant MFA or approved staged alternative;
recovery codes; step-up for commission, payouts, role/status, return confirmation,
and global configuration; append-only audit with actor/tenant/target/before-after/
request/result/time; alerting on high-risk actions.

### SEC-IDENTITY-CHANGE-01 — Verified identity changes

**Status:** `READY`
**Priority:** P1
**Origin:** remaining SEC-18 scope.

**Acceptance criteria:** current-password or step-up; verify new email/phone before
replacement; notify previous verified channel; non-enumerable APIs; revoke
sessions; audit without raw challenge/token persistence.

### SEC-SECRETS-01 — Local and CI secret hygiene

**Status:** `READY`
**Priority:** P0 operational correction
**Origin:** SEC-21.

**Current finding:** ignored local environment files were observed with mode
`0644` on 2026-07-17.

**Acceptance criteria:** sensitive local files documented/set to `0600`; secret
scanner in pre-commit and CI; minimum secret entropy and separation validation;
production rotation runbook with key identifiers; no secret values in evidence.

### SEC-TERMS-01 — Versioned legal acceptance

**Status:** `READY`
**Priority:** P1
**Origin:** SEC-22.

**Acceptance criteria:** immutable document version/hash, channel, and timestamp;
new material version requires reacceptance where applicable; no unnecessary raw
IP retention; exportable audit record.

---

## Identity, email, and external-service backlog

### ID-GOOGLE-01 — Google Identity and safe account linking

**Status:** `READY`
**Priority:** P1
**Origin:** SEC-03B.

**Acceptance criteria:** server verifies official ID token claims; email match
alone never links PASSWORD account; explicit short-lived linking ticket and
step-up; provider uniqueness; session/audit/rate-limit coverage; local and staging
smoke.

### EMAIL-PROD-01 — Production sender and STORE activation

**Status:** `BLOCKED`
**Priority:** P0 before public staging/production
**Blocker:** owned domain and DNS.

**Acceptance criteria:** verified Resend domain; SPF/DKIM/DMARC; production sender;
sending-only key; empty recipient allowlist; multi-recipient smoke; STORE pending,
activation, password setup, login, resend, and expiration evidence.

### EMAIL-EVENTS-01 — Bounce, complaint, and suppression handling

**Status:** `READY`
**Priority:** P1 after verified domain.

**Acceptance criteria:** signed/idempotent webhook ingestion; suppression before
send; generic public responses; retry/terminal classifications; sanitized audit
and operator visibility.

### PUSH-STAGING-01 — Firebase push in staging

**Status:** `BLOCKED`
**Priority:** P1 before driver pilot
**Blocker:** Firebase project/credentials and product decision for native app.

**Acceptance criteria:** least-privilege credentials; token registration/revocation;
sanitized payloads; retry/dead-token cleanup; cancellation/dispatch smoke; polling
fallback remains authoritative.

### PAY-LIVE-01 — Mercado Pago staging/production boundary and live validation

**Status:** `DECISION_REQUIRED`
**Priority:** P0 before production payments.

**Decision required:** choose a narrowly scoped webhook ingress architecture that
allows Mercado Pago to reach only the signed webhook surface without exposing the
private application behind Cloudflare Access. Evaluate it in a dedicated design;
do not add a broad Access bypass.

**Objective:** provision environment-specific Mercado Pago credentials and prove
real provider behavior without reusing local/test secrets or weakening Access.

**Acceptance criteria:**

- [ ] Test and production applications/accounts/credentials are explicitly
      separated and recorded only by non-secret identifiers.
- [ ] Public webhook ingress exposes no customer/store/admin API and still applies
      HMAC, freshness, deduplication, rate/cost limits, and authoritative GET.
- [ ] Production callback URL, topic `order`, application ID, account ID, and live
      mode fail closed on mismatch.
- [ ] Real low-value card and PIX acceptance, cancellation, refund, replay, and
      reconciliation are validated with sanitized evidence and an approved money
      limit.
- [ ] Refund funding/balance, operational ownership, alerting, and rollback are
      documented before the first real transaction.

---

## Edge, operations, and release backlog

### EDGE-WAF-01 — Production edge policies

**Status:** `BLOCKED`
**Priority:** P0 before production
**Blocker:** owned Cloudflare zone/domain.

**Acceptance criteria:** WAF/rate rules aligned with application limits; Access
separation for admin; no unprotected alternate hostname; TLS/HSTS/CORS verification;
safe OPTIONS behavior; rollback documented and tested.

### OPS-OBS-01 — Observability, alerting, deploy, and rollback

**Status:** `PARTIAL`
**Priority:** P0 before production.

**Already present:** CI verification and selected sanitized cron/payment logs.

**Remaining acceptance criteria:** environment promotion workflow; migration gate;
worker version rollback; structured metrics and alerts for auth abuse, payment
review/retry age, webhook failures, email suppression, acceptance timeouts,
cancel/refund SLA, returns, and provider budgets; no PII/secrets in logs.

### STAGING-REFRESH-01 — Bring private staging to current main

**Status:** `BLOCKED`
**Priority:** P0 before claiming current features work in staging
**Dependencies:** cancellation program when completed, security P0 tasks selected
for the next staging gate, and the `PAY-LIVE-01` ingress decision if external
webhooks are included.

**Context:** existing private-staging evidence covers the earlier identity build
through migrations `0000`–`0025`. It does not prove the current payment and
cancellation schema/application now present on `main`.

**Acceptance criteria:**

- [ ] Review every migration after `0025`, rehearse from zero, back up/confirm
      disposable staging data policy, and migrate with the owner role.
- [ ] Reapply and verify runtime least privilege after schema changes.
- [ ] Update Hyperdrive only if a credential/schema reset requires it.
- [ ] Deploy exact current commits behind the existing Access boundary with no
      alternate unprotected URL.
- [ ] Repeat unauthenticated Access negatives, CORS, identity, current Orders,
      R2, cron, cancellation, and sanitized-log smoke.
- [ ] Record current worker versions, source commit, migration range, PASS/FAIL,
      and no PII/secrets in the staging runbook and this ledger.

### PROD-INFRA-01 — Separate production infrastructure

**Status:** `BLOCKED`
**Priority:** P0 before production
**Dependencies:** domain, email, WAF, security P0 tasks.

**Acceptance criteria:** separate Workers, database role/database, Hyperdrive, R2,
Turnstile, secrets and provider credentials; backups/restore test; least privilege;
manual promotion; no staging data/credential reuse.

### ASSURANCE-01 — Final security, performance, and accessibility assurance

**Status:** `READY`
**Priority:** P0 release gate.

**Acceptance criteria:** focused second security review; authenticated pentest;
SAST, dependency and secret scanning; DAST against private staging; performance
budgets/Core Web Vitals; accessibility audit of critical flows; findings entered
as new stable task IDs; no open P0/P1 release blocker.

### DOC-SEC-01 — Reconcile stale security and staging documentation

**Status:** `READY`
**Priority:** P1.

**Objective:** remove contradictory status claims left by historical documents
without deleting useful audit history.

**Acceptance criteria:** the security review points to this ledger for current
status; stale “staging not run” claims are annotated with later evidence; payment
sandbox validation and remaining live boundary are distinguished; superseded
plans remain clearly historical; no old unchecked checkbox is treated as current
task state.

---

## Product-flow backlog retained from prior planning

### UX-EMAIL-01 — Email confirmation handoff

**Status:** `READY`
**Priority:** P2.

**Objective:** after login reports unverified email, route the user directly to a
usable verification screen with resend/cooldown and return-to-login behavior.

**Acceptance criteria:** no dead-end message; non-enumerable responses; accessible
code entry; resend/cooldown/error tests; no dependency on final visual identity.

### FLOW-ROLES-01 — Complete ADMIN, CUSTOMER, STORE, and DRIVER product flows

**Status:** `PROPOSED`
**Priority:** P2.

**Scope gate:** decompose remaining gaps into separate stable tasks after a route/UI
inventory. Do not use this umbrella entry as implementation authorization.

### NATIVE-APP-01 — Capacitor/native notification strategy

**Status:** `PROPOSED`
**Priority:** P2 after web flows and `PUSH-STAGING-01`.

**Scope gate:** decide native packaging, background push, deep links, token
lifecycle, store distribution, and polling fallback in a dedicated design.

---

## Completed security and staging baseline

These entries are retained so old plans are not mistaken for open work.

| ID                    | Status | Sanitized evidence summary                                                                                                         |
| --------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SEC-AUTHZ-BASE`      | `DONE` | CUSTOMER guards, live principal, role matrix, cross-store/driver negatives.                                                        |
| `SEC-RATE-TURNSTILE`  | `DONE` | Atomic PostgreSQL rate limits; Turnstile and private staging replay smoke passed.                                                  |
| `SEC-EMAIL-03A`       | `DONE` | CUSTOMER verification/recovery and ADMIN bootstrap passed in private staging.                                                      |
| `SEC-STORE-STATE`     | `DONE` | Suspended/closed store access and sessions fail closed.                                                                            |
| `SEC-PAYMENTS-ORDERS` | `DONE` | Orders API, snapshots, inbox/operations, cancellation/refund and sandbox flows validated. Live production remains a separate task. |
| `SEC-HEADERS-DOCS`    | `DONE` | Defensive headers/no-store; docs/OpenAPI/DB health are local-only.                                                                 |
| `STAGING-PRIVATE`     | `DONE` | Access, exact credentialed CORS, R2, Hyperdrive least privilege, CUSTOMER and ADMIN sanitized evidence.                            |

Historical evidence:

- [`backend-security-review.md`](security/2026-07-11-backend-security-review.md)
- [`private-workers-staging.md`](security/runbooks/private-workers-staging.md)
- [`mercado-pago-orders.md`](security/runbooks/mercado-pago-orders.md)

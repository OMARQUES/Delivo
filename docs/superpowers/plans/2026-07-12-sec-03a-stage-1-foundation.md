# SEC-03A Stage 1: Identity and Email Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compatible identity-security persistence, hash-only code/ticket primitives, source-controlled email templates, Resend transport, atomic PostgreSQL outbox, SEC-03A rate-limit policies, and scheduled cleanup without changing current registration behavior yet.

**Architecture:** This stage is additive. Current auth routes remain operational while later stages consume the new bounded services. PostgreSQL owns durable state; direct Resend HTTP calls are behind an injectable interface. Code delivery rows reference challenges and reconstruct codes in Worker memory.

**Tech Stack:** TypeScript 6, Hono, Drizzle/PostgreSQL, Web Crypto, Vitest, Cloudflare Workers scheduled events, Resend HTTP API.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-12-sec-03a-email-identity-design.md`.
- Preserve legacy `PENDING` and nullable email temporarily; Stage 2 removes them atomically with auth consumers.
- Add `PENDING_EMAIL`, `PENDING_APPROVAL`, and `PENDING_ACTIVATION` as compatible enum values now.
- PostgreSQL stores only keyed code hashes and keyed action-ticket hashes.
- No code/ticket in outbox payload, logs, errors, audit metadata, fixtures, or snapshots.
- Resend calls use explicit timeout and stable `Idempotency-Key`.
- Commit after every task; no mixed refactors.

---

### Task 1: Additive identity-security schema and migration

**Files:**
- Create: `apps/api/src/db/schema/pending-registrations.ts`
- Create: `apps/api/src/db/schema/auth-challenges.ts`
- Create: `apps/api/src/db/schema/auth-action-tickets.ts`
- Create: `apps/api/src/db/schema/email-outbox.ts`
- Create: `apps/api/src/db/schema/identity-security-events.ts`
- Create: `apps/api/src/db/types.ts`
- Modify: `apps/api/src/db/schema/users.ts`
- Modify: `apps/api/src/db/schema/stores.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/test/helpers/test-db.ts`
- Create: `apps/api/test/sec03a-schema.test.ts`
- Generate: `apps/api/drizzle/0024_sec_03a_foundation.sql` and matching `meta` journal/snapshot files

**Interfaces:**
- Produces Drizzle exports: `pendingRegistrations`, `authChallenges`, `authActionTickets`, `emailOutbox`, `identitySecurityEvents`.
- Produces `export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]` in `db/types.ts` for transaction-aware services.
- Produces enum values used by all later stages.
- Does not make `users.email` non-null or remove `PENDING`/phone uniqueness.

- [ ] **Step 1: Write failing schema tests**

Add tests that query PostgreSQL catalogs after `migrateTestDb()` and assert:

```ts
expect(await enumValues('user_status')).toEqual([
  'ACTIVE', 'PENDING', 'PENDING_EMAIL', 'PENDING_APPROVAL', 'BLOCKED',
])
expect(await enumValues('store_security_status')).toContain('PENDING_ACTIVATION')
expect(await tableNames()).toEqual(expect.arrayContaining([
  'pending_registrations', 'auth_challenges', 'auth_action_tickets',
  'email_outbox', 'identity_security_events',
]))
```

Assert DB checks reject: challenge with both/no subject FK, negative attempts, code hash missing, ticket without user, outbox attempt count below zero. Assert `users.email` is still nullable in this intermediate stage.

- [ ] **Step 2: Run test and confirm RED**

Run: `pnpm --filter @delivery/api test -- sec03a-schema.test.ts`

Expected: FAIL because tables/enums do not exist.

- [ ] **Step 3: Define focused schema files**

Use these stable enum/type names:

```ts
export const registrationSource = pgEnum('registration_source', [
  'SELF_SERVICE', 'ADMIN_PROVISIONED', 'BOOTSTRAP',
])
export const authChallengePurpose = pgEnum('auth_challenge_purpose', [
  'REGISTRATION_VERIFY', 'STORE_ACTIVATION', 'ADMIN_ACTIVATION', 'PASSWORD_RECOVERY',
])
export type AuthChallengePurpose = (typeof authChallengePurpose.enumValues)[number]
export const authActionTicketPurpose = pgEnum('auth_action_ticket_purpose', [
  'PASSWORD_RESET', 'INITIAL_PASSWORD_SETUP',
])
export const emailOutboxStatus = pgEnum('email_outbox_status', [
  'PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED',
])
```

Required columns and indexes:

```ts
// pending_registrations (DB check limits role to CUSTOMER or DRIVER)
id, email, name, phone, role, passwordHash, termsAcceptedAt,
expiresAt, consumedAt, closeReason, createdAt, updatedAt
// indexes: lower(email), expiresAt, consumedAt

// auth_challenges
id, purpose, pendingRegistrationId, userId, email, codeHash,
attemptCount default 0, expiresAt, consumedAt, invalidatedAt,
invalidationReason, createdAt
// checks: exactly one subject; attempts 0..5
// indexes: active subject/purpose, expiresAt

// auth_action_tickets
id, userId, purpose, challengeId, tokenHash unique, expiresAt,
consumedAt, createdAt

// email_outbox
id, template, recipient, challengeId, idempotencyKey unique, dedupeKey nullable unique,
status, attemptCount, nextAttemptAt, leasedUntil, providerMessageId,
failureClass, sentAt, createdAt, updatedAt
// indexes: (status,nextAttemptAt), leasedUntil, challengeId

// identity_security_events
id, eventType, result, actorUserId, targetUserId, subjectKey,
requestId, metadata jsonb default {}, createdAt
// indexes: targetUserId, createdAt
```

Add `emailVerifiedAt` and non-null `registrationSource` with default `SELF_SERVICE` to `users`. Extend Drizzle enums compatibly. Export every schema from `schema/index.ts`. Add all new tables at the start of `truncateAll()` before referenced parents.

- [ ] **Step 4: Generate and inspect migration**

Run: `pnpm --filter @delivery/api db:generate -- --name sec_03a_foundation`

Expected: next journal entry is index 24/tag `0024_sec_03a_foundation`; SQL is additive. If Drizzle emits a generated prefix variant, keep its generated filename and update this plan's checkbox note with the actual name; never rename without updating `_journal.json` and snapshot metadata.

Manually add DB check constraints through Drizzle `check()` definitions, regenerate, then inspect that no existing table/column is dropped.

- [ ] **Step 5: Apply migration and confirm GREEN**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/delivery pnpm --filter @delivery/api db:migrate
pnpm --filter @delivery/api test -- sec03a-schema.test.ts
```

Expected: migration succeeds; focused test PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema apps/api/drizzle apps/api/test/helpers/test-db.ts apps/api/test/sec03a-schema.test.ts
git commit -m "feat(auth): add identity lifecycle schema"
```

### Task 2: Hash-only code and action-ticket primitives

**Files:**
- Create: `apps/api/src/security/auth-code.ts`
- Create: `apps/api/test/auth-code.test.ts`

**Interfaces:**

```ts
export type AuthCodeContext = { challengeId: string; purpose: AuthChallengePurpose }
export async function deriveAuthCode(secret: string, context: AuthCodeContext): Promise<string>
export async function hashAuthCode(secret: string, context: AuthCodeContext, code: string): Promise<string>
export async function verifyAuthCode(secret: string, context: AuthCodeContext, code: string, expectedHash: string): Promise<boolean>
export async function createActionTicket(secret: string): Promise<{ token: string; hash: string }>
export async function hashActionTicket(secret: string, token: string): Promise<string>
```

- [ ] **Step 1: Write failing unit tests**

Cover exact six digits including leading zeroes, deterministic reconstruction, purpose/ID domain separation, wrong-code rejection, malformed codes rejected before comparison, full 256-bit ticket entropy shape, stable ticket hash, and no raw token equality with hash.

Inject a deterministic HMAC byte source into an internal rejection-sampling helper and test that a value at/above `floor(2^32 / 1_000_000) * 1_000_000` is skipped.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- auth-code.test.ts`

Expected: FAIL with missing module/functions.

- [ ] **Step 3: Implement Web Crypto primitives**

Use domain-separated inputs:

```ts
const deriveInput = `sec03a:code:derive:v1\0${purpose}\0${challengeId}\0${counter}`
const verifyInput = `sec03a:code:verify:v1\0${purpose}\0${challengeId}\0${code}`
const ticketInput = `sec03a:ticket:v1\0${token}`
```

Import the HMAC key exactly with `crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])`. Use base64url encoding and a byte-by-byte XOR accumulator for fixed-length comparison. Never use `Number(code)` before regex `^\d{6}$` validation.

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm --filter @delivery/api test -- auth-code.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/security/auth-code.ts apps/api/test/auth-code.test.ts
git commit -m "feat(auth): add hash-only code primitives"
```

### Task 3: Source-controlled transactional email templates

**Files:**
- Create: `apps/api/src/email/types.ts`
- Create: `apps/api/src/email/templates.ts`
- Create: `apps/api/test/email-templates.test.ts`

**Interfaces:**

```ts
export type EmailTemplate = 'VERIFICATION_CODE' | 'PASSWORD_RECOVERY' |
  'ACCOUNT_EXISTS_NOTICE' | 'PASSWORD_CHANGED_NOTICE'
export type EmailEnvelope = { to: string; subject: string; html: string; text: string }
export function renderEmail(input: {
  to: string
  template: EmailTemplate
  code?: string
  publicWebUrl: string
  flowId?: string
}): EmailEnvelope
```

- [ ] **Step 1: Write failing template tests**

Assert code templates contain the exact code in selectable text in HTML/text, `font-size` at least `32px`, centered alignment, letter spacing, ten-minute expiry, non-sharing guidance, escaped URL/attributes, and no image/data URI. Assert notice templates reject a supplied code and contain no flow IDs.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- email-templates.test.ts`

- [ ] **Step 3: Implement pure renderers**

Use escaped values and inline HTML styles. Central code fragment:

```html
<div style="margin:24px 0;text-align:center;font-size:40px;font-weight:700;letter-spacing:10px;line-height:1.2">123456</div>
```

Build URLs only from validated `PUBLIC_WEB_URL`; append only public flow ID with `URL.searchParams`. Return both explicit HTML and text; do not use remote Resend templates.

- [ ] **Step 4: Confirm GREEN and commit**

Run: `pnpm --filter @delivery/api test -- email-templates.test.ts`

```bash
git add apps/api/src/email apps/api/test/email-templates.test.ts
git commit -m "feat(email): add auth email templates"
```

### Task 4: Resend transport and fail-closed environment policy

**Files:**
- Create: `apps/api/src/email/sender.ts`
- Create: `apps/api/src/email/resend-sender.ts`
- Create: `apps/api/src/email/config.ts`
- Create: `apps/api/test/resend-sender.test.ts`
- Create: `apps/api/test/email-config.test.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/.dev.vars.example`
- Modify: `apps/api/wrangler.jsonc`

**Interfaces:**

```ts
export interface EmailSender {
  send(envelope: EmailEnvelope, options: { idempotencyKey: string }): Promise<{ providerMessageId: string }>
}
export function createResendSender(config: EmailConfig, fetchFn?: typeof fetch): EmailSender
export function resolveEmailConfig(env: Env): EmailConfig
export function assertRecipientAllowed(config: EmailConfig, recipient: string): void
```

`EmailConfig` is `{ apiKey: string; from: string; publicWebUrl: string; allowedRecipients: ReadonlySet<string> | null; appEnv: Env['APP_ENV'] }`.

- [ ] **Step 1: Write failing transport/config tests**

Cover `Authorization: Bearer`, JSON body with `from/to/subject/html/text`, exact `Idempotency-Key`, 5-second abort, 2xx provider ID, sanitized classes for 4xx/429/5xx/network/timeout, no response-body leakage, staging allowlist, production allowlist rejection, missing secret rejection, normalized exact recipient matching, HTTPS `PUBLIC_WEB_URL` outside local, and production rejection of malformed or `resend.dev` sender addresses.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- resend-sender.test.ts email-config.test.ts`

- [ ] **Step 3: Implement direct Resend HTTP adapter**

POST `https://api.resend.com/emails` using injected `fetchFn`, `AbortSignal.timeout(5_000)`, and no SDK dependency. Define `EmailDeliveryError` with only:

```ts
type EmailFailureClass = 'CONFIG' | 'RECIPIENT_BLOCKED' | 'TIMEOUT' |
  'NETWORK' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_REJECTED' | 'PROVIDER_UNAVAILABLE'
```

Add `RESEND_API_KEY`, `AUTH_CODE_SECRET`, `EMAIL_FROM`, `PUBLIC_WEB_URL`, and `EMAIL_ALLOWED_RECIPIENTS` as optional compile-time `Env` bindings so unrelated existing test fixtures remain valid. `resolveEmailConfig` enforces required values at runtime before any identity flow is created or due email is dispatched. Put no secret in `wrangler.jsonc`; only safe empty/example vars.

- [ ] **Step 4: Confirm GREEN and commit**

Run: `pnpm --filter @delivery/api test -- resend-sender.test.ts email-config.test.ts`

```bash
git add apps/api/src/email apps/api/src/env.ts apps/api/.dev.vars.example apps/api/wrangler.jsonc apps/api/test
git commit -m "feat(email): add Resend transport"
```

### Task 5: Atomic outbox leasing, dispatch, retry, and cancellation

**Files:**
- Create: `apps/api/src/email/outbox.service.ts`
- Create: `apps/api/test/email-outbox.test.ts`

**Interfaces:**

```ts
export async function enqueueChallengeEmail(tx: DbTx, input: ChallengeEmailInput): Promise<string>
export async function enqueueNoticeEmail(tx: DbTx, input: NoticeEmailInput): Promise<string>
export async function dispatchOutboxById(db: Db, sender: EmailSender, env: Env, id: string, now?: Date): Promise<DispatchResult>
export async function dispatchDueOutbox(db: Db, sender: EmailSender, env: Env, now?: Date, limit?: number): Promise<DispatchSummary>
```

Define inputs/results in `email/types.ts`:

```ts
export type ChallengeEmailInput = { template: 'VERIFICATION_CODE' | 'PASSWORD_RECOVERY'; recipient: string; challengeId: string; flowId: string }
export type NoticeEmailInput = { template: 'ACCOUNT_EXISTS_NOTICE' | 'PASSWORD_CHANGED_NOTICE'; recipient: string; dedupeSubjectKey: string }
export type DispatchSummary = { claimed: number; sent: number; retryScheduled: number; cancelled: number; failed: number }
```

- [ ] **Step 1: Write failing PostgreSQL tests**

Test two concurrent dispatchers send one provider call; lease recovery after two minutes; challenge code reconstructed from `AUTH_CODE_SECRET`; DB row/payload never contains code; stable idempotency across retry; stale/invalid challenge cancellation; immediate retryable failure returns `PENDING`; non-code schedule at 0/5m/30m/2h/12h; fifth failure becomes `FAILED`; batch max 50.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- email-outbox.test.ts`

- [ ] **Step 3: Implement conditional lease and dispatch**

Lease with one SQL statement using `FOR UPDATE SKIP LOCKED`, status/due checks, and `leased_until = now + interval '2 minutes'`. Before rendering challenge mail, load its challenge and require active/unexpired state. Reconstruct code with `deriveAuthCode`; never persist the rendered envelope. Clear lease on every terminal/update path.

Map provider outcomes:

```ts
type DispatchResult =
  | { status: 'SENT'; providerMessageId: string }
  | { status: 'RETRY_SCHEDULED'; nextAttemptAt: Date }
  | { status: 'CANCELLED' | 'FAILED'; failureClass: string }
  | { status: 'NOT_CLAIMED' }
```

- [ ] **Step 4: Confirm GREEN and commit**

Run: `pnpm --filter @delivery/api test -- email-outbox.test.ts`

```bash
git add apps/api/src/email/outbox.service.ts apps/api/test/email-outbox.test.ts
git commit -m "feat(email): add atomic delivery outbox"
```

### Task 6: Purpose-specific policies and identity audit writer

**Files:**
- Modify: `apps/api/src/security/rate-limit-policies.ts`
- Create: `apps/api/src/security/identity-abuse.ts`
- Create: `apps/api/src/services/identity-audit.service.ts`
- Create: `apps/api/src/middleware/request-id.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/env.ts`
- Create: `apps/api/test/identity-abuse.test.ts`
- Create: `apps/api/test/identity-audit.test.ts`

**Interfaces:**

```ts
export type CodePurpose = AuthChallengePurpose
export async function protectCodeSend(c: Context<AppContext>, purpose: CodePurpose, email: string, flowId: string): Promise<void>
export async function protectCodeAttempt(c: Context<AppContext>, purpose: CodePurpose, flowId: string): Promise<void>
export async function appendIdentityEvent(tx: DbTx, event: IdentityEvent): Promise<void>
```

`IdentityEvent` is a discriminated union with exact allowlisted keys: `eventType`, `result`, optional `actorUserId`, optional `targetUserId`, optional `subjectKey`, `requestId`, and optional `{ failureClass?: string; purpose?: AuthChallengePurpose }` metadata.

- [ ] **Step 1: Add failing policy/audit tests**

Assert exact spec thresholds, distinct scopes by purpose, third resend/hour requires Turnstile, raw email/IP never reaches bucket key, audit stores pseudonymous subject key and rejects forbidden metadata keys (`email`, `phone`, `code`, `ticket`, `token`, `password`). Assert request-ID middleware ignores inbound `X-Request-ID`, generates a UUID, exposes it through `c.get('requestId')`, and returns the same safe ID in the response header.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- identity-abuse.test.ts identity-audit.test.ts`

- [ ] **Step 3: Implement policies and writer**

Add immutable policies for minute/hour/day send, recovery, code-IP, and ticket-IP scopes. Reuse `consumeAll`, `resolveClientIp`, `PostgresRateLimiter`, and Turnstile verifier. Audit metadata is a typed allowlist, not arbitrary request JSON. Register request-ID middleware before logging/DB middleware and add required `requestId: string` to `AppContext.Variables`.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- identity-abuse.test.ts identity-audit.test.ts
git add apps/api/src/security apps/api/src/services/identity-audit.service.ts apps/api/test
git commit -m "feat(auth): add identity abuse policies"
```

### Task 7: Scheduled dispatch and bounded cleanup

**Files:**
- Create: `apps/api/src/services/identity-cleanup.service.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/cron.test.ts`
- Create: `apps/api/test/identity-cleanup.test.ts`

**Interfaces:**

```ts
export async function cleanupIdentityState(db: Db, now?: Date, limit?: number): Promise<CleanupSummary>
```

`CleanupSummary` is `{ pendingRegistrations: number; challenges: number; tickets: number; outbox: number; events: number }`.

- [ ] **Step 1: Write failing cleanup/cron tests**

Seed boundary rows and assert: expired pending attempts/challenges/consumed tickets deleted after 24h; sent/cancelled outbox after 7d; failed after 30d; events after 90d; provisioned users untouched; each delete bounded; scheduled handler creates sender only when email is due, dispatches due mail, then cleans state, and always closes DB. Resend config/dispatch failure must not prevent order/payment/shift/rate-limit cron jobs.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- identity-cleanup.test.ts cron.test.ts`

- [ ] **Step 3: Implement and wire cron**

Keep existing five-minute trigger. Use indexed CTE deletes with `LIMIT 500`. In scheduled handler check for due outbox work before resolving email config, dispatch at most 50 inside an isolated `try/catch`, then run cleanup. Existing order/payment/shift/rate-limit jobs must continue even if email configuration/provider fails. Log counts/failure class only—never recipient, flow, provider body, or code.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- identity-cleanup.test.ts cron.test.ts
git add apps/api/src/index.ts apps/api/src/services/identity-cleanup.service.ts apps/api/test
git commit -m "feat(auth): clean identity lifecycle state"
```

### Task 8: Stage 1 compatibility gate

**Files:**
- Modify only if gate exposes a Stage 1 regression; keep fixes in owning task files.

- [ ] **Step 1: Run focused foundation suite**

```bash
pnpm --filter @delivery/api test -- sec03a-schema.test.ts auth-code.test.ts email-templates.test.ts resend-sender.test.ts email-config.test.ts email-outbox.test.ts identity-abuse.test.ts identity-audit.test.ts identity-cleanup.test.ts cron.test.ts
```

Expected: PASS; no network calls.

- [ ] **Step 2: Recreate disposable dev/test databases and migrate from zero**

Use project DB tooling to drop/recreate only the explicitly disposable local databases, then run `db:migrate`. Never target a non-local URL. Expected journal reaches 0024.

- [ ] **Step 3: Run full gate**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
git status --short
```

Expected: all pass; status contains only intended Stage 1 changes before final task commit.

- [ ] **Step 4: Record checkpoint commit if gate fixes were needed**

```bash
git add -A
git commit -m "test(auth): verify SEC-03A foundation"
```

Skip empty commit. Do not start Stage 2 until Stage 1 review passes.

# SEC-03A Stage 3: Password Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-enumerable email recovery, atomic code verification, single-use reset tickets, role-aware password replacement, immediate session revocation, and one shared web recovery experience.

**Architecture:** Recovery start always returns a synthetic-compatible flow. Eligible verified PASSWORD users receive a Stage 1 outbox challenge. Code proof creates a hashed reset ticket; ticket consumption, password mutation, `tokenVersion`, refresh revocation, audit, and security email commit together.

**Tech Stack:** Shared Zod, Hono/OpenAPI, Drizzle/PostgreSQL, Stage 1 challenges/outbox/rate limiter, Vue/Pinia, Vitest.

## Global Constraints

- Stages 1–2 must be merged and green.
- Turnstile is mandatory for recovery start.
- External response never reveals account existence, role, status, or provider.
- Recovery code: six digits, 10 minutes, five attempts, one use.
- Reset ticket: random 256 bits, keyed hash only, 10 minutes, one use.
- Reset request accepts only ticket and new password—never email/user ID/code.
- Successful reset increments `tokenVersion`, revokes all refresh families, sends notice, and issues no session.
- Web recovery supports every PASSWORD role. Driver app links to it via configured public web URL.

---

### Task 1: Recovery schemas and abuse policies

**Files:**
- Modify: `packages/shared/src/auth.schema.ts`
- Modify: `packages/shared/src/auth.schema.test.ts`
- Modify: `apps/api/src/security/rate-limit-policies.ts`
- Modify: `apps/api/src/security/identity-abuse.ts`
- Create: `apps/api/test/recovery-abuse.test.ts`

**Interfaces:**

```ts
export const StartRecoverySchema = z.object({
  email: NormalizedEmail,
  turnstileToken: z.string().trim().min(1).max(2048),
}).strict()
export const VerifyRecoverySchema = z.object({
  recoveryId: z.uuid(), code: z.string().regex(/^\d{6}$/),
}).strict()
export const ResetPasswordSchema = z.object({
  resetTicket: z.string().min(40).max(512),
  newPassword: z.string().min(8).max(128),
}).strict()

export async function protectRecoveryStart(c, email): Promise<void>
export async function protectRecoveryVerify(c, recoveryId): Promise<void>
export async function protectTicketUse(c, ticket): Promise<void>
```

- [ ] **Step 1: Write failing schema/policy tests**

Assert email normalization, mandatory Turnstile, exact code, bounded ticket/password bodies, recovery scopes distinct from registration, 5/hour+10/day per email and 10/hour+30/day IP for start, 30/hour IP for verify/ticket, and ticket rate key derived from raw token HMAC without storing it.

- [ ] **Step 2: Confirm RED**

```bash
pnpm --filter @delivery/shared test -- auth.schema.test.ts
pnpm --filter @delivery/api test -- recovery-abuse.test.ts
```

- [ ] **Step 3: Implement schemas/policies**

Call Turnstile with action `password_recovery`. Consume IP before provider verification, then normalized email. Verify/ticket protection runs before DB lookup. Reuse SEC-02 stable rate-limit errors.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/shared test -- auth.schema.test.ts
pnpm --filter @delivery/api test -- recovery-abuse.test.ts
git add packages/shared/src/auth.schema* apps/api/src/security apps/api/test/recovery-abuse.test.ts
git commit -m "feat(auth): add recovery abuse controls"
```

### Task 2: Action-ticket repository and transactional session revocation

**Files:**
- Create: `apps/api/src/services/auth-ticket.service.ts`
- Create: `apps/api/test/auth-ticket.service.test.ts`
- Modify: `apps/api/src/services/security-session.service.ts`
- Modify: `apps/api/test/security-session.service.test.ts`

**Interfaces:**

```ts
export async function issueActionTicket(tx: DbTx, input: IssueTicketInput): Promise<{ token: string; expiresAt: Date }>
export async function inspectActionTicket(db: Db, input: ClaimTicketInput): Promise<AuthActionTicket & { role: UserRole }>
export async function claimActionTicket(tx: DbTx, input: ClaimTicketInput): Promise<AuthActionTicket>
export async function revokeAllSessionsInTx(tx: DbTx, userId: string, now: Date): Promise<number>
```

- [ ] **Step 1: Write failing ticket/race tests**

Assert DB contains only token hash, purpose/user binding, expiry boundary, wrong purpose, replay, two concurrent claims yield one winner, and `revokeAllSessionsInTx` increments version once and revokes every live family without opening a nested transaction.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- auth-ticket.service.test.ts security-session.service.test.ts`

- [ ] **Step 3: Implement conditional claim**

Hash raw ticket before lookup. Claim using one conditional update:

```sql
UPDATE auth_action_tickets SET consumed_at = $now
WHERE token_hash = $hash AND purpose = $purpose
  AND consumed_at IS NULL AND expires_at > $now
RETURNING *;
```

Refactor public `revokeAllSessions` to call `revokeAllSessionsInTx` inside its existing transaction; preserve all P0 behavior/tests.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- auth-ticket.service.test.ts security-session.service.test.ts
git add apps/api/src/services apps/api/test
git commit -m "feat(auth): add single-use action tickets"
```

### Task 3: Non-enumerable recovery service

**Files:**
- Create: `apps/api/src/services/password-recovery.service.ts`
- Create: `apps/api/test/password-recovery.service.test.ts`

**Interfaces:**

```ts
export async function startPasswordRecovery(db: Db, email: string, ctx: IdentityContext): Promise<{
  response: { recoveryId: string; expiresAt: string }
  outboxId: string | null
}>
export async function verifyPasswordRecovery(db: Db, recoveryId: string, code: string, ctx: IdentityContext): Promise<{
  resetTicket: string; expiresAt: string
}>
export async function resetPassword(db: Db, resetTicket: string, newPassword: string, ctx: IdentityContext): Promise<void>
```

- [ ] **Step 1: Write failing service tests**

Cover:

- eligible ACTIVE/PENDING_APPROVAL PASSWORD account creates challenge/outbox;
- unknown, blocked, unverified, missing PASSWORD provider all return identical response keys/status and no email;
- synthetic recovery ID verifies as generic invalid with fixed HMAC work;
- correct code creates hash-only ticket and consumes challenge;
- ticket reset enforces current role minimum/common blocklist;
- password hash, `tokenVersion + 1`, all refresh revocations, audit event, and PASSWORD_CHANGED_NOTICE outbox commit atomically;
- injected failure before commit changes nothing;
- concurrent reset yields one success;
- old/new access tokens and refresh families fail until normal re-login;
- no session returned.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- password-recovery.service.test.ts`

- [ ] **Step 3: Implement start/verify/reset**

Start performs one normalized user/provider query. Synthetic response uses random UUID and same ten-minute expiry shape; perform the same code-HMAC setup work without persisting. Do not send account-exists/provider guidance in public response.

Reset uses a non-consuming preflight to load ticket/user role and validate policy, computes PBKDF2 outside the transaction, then revalidates everything while claiming the ticket. This avoids holding row locks during expensive password hashing. Transaction order:

```ts
const preflight = await inspectActionTicket(db, { token: resetTicket, purpose: 'PASSWORD_RESET', now })
assertPasswordPolicy(newPassword, preflight.role)
const passwordHash = await hashPassword(newPassword) // outside transaction
await db.transaction(async (tx) => {
const ticket = await claimActionTicket(tx, { token: resetTicket, purpose: 'PASSWORD_RESET', now })
const user = await lockUserAndPasswordProvider(tx, ticket.userId)
assertPasswordPolicy(newPassword, user.role) // role/state recheck
await tx.update(authProviders).set({ passwordHash }).where(and(
  eq(authProviders.userId, user.id), eq(authProviders.provider, 'PASSWORD'),
))
await revokeAllSessionsInTx(tx, user.id, now)
await appendIdentityEvent(tx, passwordResetEvent(user.id, requestId))
await enqueueNoticeEmail(tx, passwordChangedNotice(user.email))
})
```

The preflight never consumes the ticket or reveals user state. Transaction rollback covers every local mutation; a concurrent winner causes the conditional claim to fail before credential update.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- password-recovery.service.test.ts
git add apps/api/src/services/password-recovery.service.ts apps/api/test/password-recovery.service.test.ts
git commit -m "feat(auth): reset passwords safely"
```

### Task 4: Recovery API routes and stable errors

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/security/http.ts`
- Modify: `apps/api/src/middleware/error-handler.ts`
- Modify: `apps/api/test/auth.routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Assert:

- `/auth/recovery/start` requires Turnstile and always returns 202 envelope for known/unknown/provider/state;
- immediate outbox dispatch happens after transaction and failure does not change response enumeration;
- `/verify` returns ticket only for valid code;
- `/reset` returns 204, no tokens/user, and has `Cache-Control: no-store`;
- replay/wrong/expired/synthetic use stable generic codes;
- provider/DB internals never appear;
- request body cannot add email/userId to reset schema.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- auth.routes.test.ts`

- [ ] **Step 3: Wire routes in security order**

For each route: validate JSON → abuse controls → service → optional immediate outbox dispatch → stable response. `EMAIL_DELIVERY_UNAVAILABLE` is used only for invalid environment before flow creation; transient provider failures remain queued.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- auth.routes.test.ts password-recovery.service.test.ts
git add apps/api/src/routes/auth.ts apps/api/src/security/http.ts apps/api/src/middleware/error-handler.ts apps/api/test/auth.routes.test.ts
git commit -m "feat(api): expose password recovery flow"
```

### Task 5: Shared web recovery experience

**Files:**
- Create: `apps/web/src/stores/recovery.ts`
- Create: `apps/web/src/stores/recovery.test.ts`
- Create: `apps/web/src/views/RecoveryStartView.vue`
- Create: `apps/web/src/views/RecoveryVerifyView.vue`
- Create: `apps/web/src/views/RecoveryResetView.vue`
- Create: `apps/web/src/views/RecoveryViews.test.ts`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/views/LoginView.vue`
- Modify: `apps/driver/src/views/LoginView.vue`
- Modify: `apps/driver/src/views/LoginView.test.ts`
- Modify: `apps/driver/.env.example`

**Interfaces:**

```ts
start(email, turnstileToken): Promise<{ recoveryId: string; expiresAt: string }>
verify(recoveryId, code): Promise<{ resetTicket: string; expiresAt: string }>
reset(resetTicket, newPassword): Promise<void>
```

- [ ] **Step 1: Write failing store/view tests**

Assert generic start copy, mandatory Turnstile, public recovery ID only in URL, six-digit input, reset ticket held only in Pinia memory and lost safely on reload, role-neutral password copy explaining minimum may vary, successful reset clears all flow state and links to login, errors do not reveal account state. Driver login recovery link uses `VITE_PUBLIC_WEB_URL`, not API URL/request origin.

- [ ] **Step 2: Confirm RED**

```bash
pnpm --filter @delivery/web test -- recovery.test.ts RecoveryViews.test.ts
pnpm --filter @delivery/driver test -- LoginView.test.ts
```

- [ ] **Step 3: Implement three-step UI**

Routes must be declared before `/:storeSlug`:

```ts
{ path: '/recuperar-senha', name: 'recovery-start', component: () => import('../views/RecoveryStartView.vue') },
{ path: '/recuperar-senha/codigo', name: 'recovery-verify', component: () => import('../views/RecoveryVerifyView.vue') },
{ path: '/recuperar-senha/nova-senha', name: 'recovery-reset', component: () => import('../views/RecoveryResetView.vue') },
```

Never persist raw reset ticket. If reset page reloads without in-memory ticket, return to start with neutral message.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
pnpm --filter @delivery/web typecheck
pnpm --filter @delivery/driver typecheck
git add apps/web/src apps/driver/src apps/driver/.env.example
git commit -m "feat(web): add password recovery screens"
```

### Task 6: Stage 3 security gate

- [ ] **Step 1: Focused tests**

```bash
pnpm --filter @delivery/api test -- auth-ticket.service.test.ts password-recovery.service.test.ts recovery-abuse.test.ts auth.routes.test.ts security-session.service.test.ts email-outbox.test.ts
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
```

- [ ] **Step 2: Manual local DB assertions**

Run a recovery test flow against disposable DB, then query `auth_challenges`, `auth_action_tickets`, `email_outbox`, and events. Assert no row contains the entered code or raw reset ticket. Confirm previous access/refresh tokens fail after reset.

- [ ] **Step 3: Full gate**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
git status --short
```

- [ ] **Step 4: Commit only gate fixes if needed**

```bash
git add -A
git commit -m "test(auth): verify password recovery"
```

Skip empty commit. Do not start privileged activation until review passes.

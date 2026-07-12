# SEC-03A Stage 4: Privileged Activation and Final Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate STORE/ADMIN only after verified email, remove administrator-known store passwords, move driver invitations to verified email, and close SEC-03A with complete automated/staging evidence.

**Architecture:** Admin store creation provisions an inert owner/store and email challenge. Verification yields a hash-only initial-password ticket; ticket use atomically creates the provider and activates both records. Bootstrap ADMIN uses the same challenge foundation but retains a securely supplied initial password. All public/owner paths reject pending stores by existing live-state checks.

**Tech Stack:** Hono/OpenAPI, Drizzle/PostgreSQL, Stage 1–3 identity primitives, Vue admin/public views, seed CLI, Vitest, Resend/Cloudflare staging runbook.

## Global Constraints

- Stages 1–3 must be merged and green.
- Admin never submits, receives, logs, or stores a STORE owner's plaintext password.
- New STORE is `PENDING_ACTIVATION`; owner is `PENDING_EMAIL`; no PASSWORD provider exists until setup.
- Store setup password minimum is 15 and ticket is raw only in ephemeral client memory.
- Bootstrap ADMIN is `PENDING_EMAIL` until code confirmation; no session is issued by confirmation.
- Pending STORE/ADMIN are never cron-deleted.
- Driver invitation requires normalized email, verified email timestamp, role DRIVER, and status ACTIVE.
- Mark SEC-03 fixed only after full automated gate and honest external-prerequisite documentation.

---

### Task 1: Provision inert store owners and preserve active test fixtures

**Files:**
- Modify: `packages/shared/src/store.schema.ts`
- Modify: `packages/shared/src/store.test.ts`
- Modify: `apps/api/src/services/store.service.ts`
- Create: `apps/api/test/store-provisioning.service.test.ts`
- Modify: `apps/api/test/helpers/test-db.ts`
- Modify: all API tests calling `createStoreWithOwner`

**Interfaces:**

```ts
// Replace only the owner member inside the existing StoreCreateSchema;
// every existing store field/constraint remains byte-for-byte unchanged.
owner: z.object({
  name: z.string().trim().min(2).max(120),
  email: NormalizedEmail,
}).strict()

export async function provisionStoreWithOwner(db: Db, input: StoreCreateInput, ctx: IdentityContext): Promise<{
  store: Store; owner: PublicUser; verificationId: string; outboxId: string
}>

// tests only
export type StoreFixtureInput = Omit<StoreCreateInput, 'owner'> & {
  owner: { name: string; email: string; password?: string }
}
export async function createActiveStoreTestFixture(input: StoreFixtureInput): Promise<Store>
```

- [ ] **Step 1: Write failing shared/service tests**

Assert strict owner schema rejects a password field, provisioning transaction creates owner `PENDING_EMAIL` with `ADMIN_PROVISIONED`, store `PENDING_ACTIVATION`, no PASSWORD provider, activation challenge/outbox, and no public discovery. Duplicate slug/email rolls back every row. Injected challenge/outbox failure rolls back owner/store. Admin security-status mutation cannot change a pending store to ACTIVE/SUSPENDED; only activation service may activate it. PENDING_ACTIVATION may transition to terminal CLOSED.

- [ ] **Step 2: Confirm RED**

```bash
pnpm --filter @delivery/shared test -- store.test.ts
pnpm --filter @delivery/api test -- store-provisioning.service.test.ts
```

- [ ] **Step 3: Implement provisioning and test fixture**

`StoreCreateSchema.owner` is strict. `provisionStoreWithOwner` performs all local inserts in one transaction and queues `STORE_ACTIVATION`. It never calls `hashPassword`. Guard `setStoreSecurityStatus` so `PENDING_ACTIVATION -> ACTIVE/SUSPENDED` is rejected; activation transaction is the only ACTIVE path.

Move active direct creation to `apps/api/test/helpers/test-db.ts`; it inserts verified ACTIVE owner, PASSWORD provider, and ACTIVE store. Update every file from:

```bash
rg -l 'createStoreWithOwner\(' apps/api/test
```

Production `store.service.ts` must no longer export an active-store bypass.

- [ ] **Step 4: Confirm GREEN and absence of bypass**

```bash
pnpm --filter @delivery/shared test -- store.test.ts
pnpm --filter @delivery/api test -- store-provisioning.service.test.ts store.service.test.ts stores-public.routes.test.ts
rg 'createStoreWithOwner|hashPassword' apps/api/src/services/store.service.ts apps/api/src/routes/admin-stores.ts
```

Expected: no active bypass/hash in production store creation.

- [ ] **Step 5: Commit breaking store contract**

```bash
git add packages/shared apps/api
git commit -m "feat(store)!: provision owners by email" -m "BREAKING CHANGE: admin store creation no longer accepts an owner password; owners activate and set their own password by email."
```

### Task 2: Admin provisioning/resend routes and authorization

**Files:**
- Modify: `apps/api/src/routes/admin-stores.ts`
- Modify: `apps/api/test/admin-stores.routes.test.ts`
- Modify: `apps/api/src/services/store.service.ts`

**Interfaces:**

```ts
POST /admin/stores -> 201 { store, owner, verification: { expiresAt, resendAt } }
POST /admin/stores/:id/activation/resend -> 202 { expiresAt, resendAt }
```

- [ ] **Step 1: Write failing route tests**

Cover ADMIN-only creation/resend, CUSTOMER/DRIVER/STORE denial, no password accepted/returned, immediate outbox dispatch after commit, duplicate conflict explicit only to authenticated ADMIN, resend only pending owner/store, active/suspended/closed rejection, purpose-specific limits, replacement invalidates old challenge, `StoreOut` includes `PENDING_ACTIVATION`, and security-status PATCH cannot publish a pending store.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- admin-stores.routes.test.ts`

- [ ] **Step 3: Wire routes**

Keep authorization before tenant/object lookup. Resend selects store+owner by store ID under ADMIN authorization and calls the common challenge replacement/outbox service. Provider failure leaves pending delivery and returns 202.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- admin-stores.routes.test.ts store-provisioning.service.test.ts
git add apps/api/src/routes/admin-stores.ts apps/api/src/services/store.service.ts apps/api/test/admin-stores.routes.test.ts
git commit -m "feat(admin): provision store activation"
```

### Task 3: Unified privileged confirmation and initial password setup

**Files:**
- Modify: `apps/api/src/services/registration.service.ts`
- Create: `apps/api/src/services/account-activation.service.ts`
- Create: `apps/api/test/account-activation.service.test.ts`
- Modify: `apps/api/src/services/auth.service.ts`
- Modify: `apps/api/src/services/security-session.service.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/test/auth.routes.test.ts`

**Interfaces:**

```ts
export async function confirmEmailFlow(db: Db, input: ConfirmVerificationInput, ctx: IdentityContext): Promise<
  | CustomerSessionResult
  | DriverPendingResult
  | { kind: 'EMAIL_VERIFIED' }
  | { kind: 'PASSWORD_SETUP_REQUIRED'; passwordSetupTicket: string; expiresAt: string }
>
export async function setupInitialPassword(db: Db, ticket: string, password: string, ctx: IdentityContext): Promise<void>
```

- [ ] **Step 1: Write failing activation/race tests**

STORE correct code consumes challenge and issues hash-only setup ticket without activating. Setup enforces 15 chars, creates exactly one PASSWORD provider, sets owner email verification/ACTIVE and store ACTIVE atomically, appends audit event, returns no session. Wrong purpose/user/store, expired/replayed ticket, blocked/closed store, and two concurrent setups fail safely. Injected provider/store update failure rolls back ticket claim.

ADMIN confirmation sets `emailVerifiedAt` and ACTIVE atomically but returns `EMAIL_VERIFIED` and no session/ticket.

Defense-in-depth tests assert PASSWORD login, refresh, and live-principal resolution reject an ACTIVE user whose `emailVerifiedAt` is null. Test factories must set verification timestamps for active accounts.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- account-activation.service.test.ts auth.routes.test.ts`

- [ ] **Step 3: Implement purpose dispatcher and setup route**

`POST /auth/verification/confirm` loads the active challenge by public ID and dispatches by purpose without accepting role/user/purpose from client. Add `POST /auth/password-setup` accepting only `{ passwordSetupTicket, newPassword }`. Protect ticket use before DB lookup. Store setup transaction locks ticket, owner, and store in deterministic order. Add explicit `emailVerifiedAt` checks to password login and current-principal/session resolution; ACTIVE status alone is insufficient.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- account-activation.service.test.ts registration.service.test.ts auth.routes.test.ts
git add apps/api/src/services apps/api/src/routes/auth.ts apps/api/test
git commit -m "feat(auth): activate privileged accounts"
```

### Task 4: Store activation and admin provisioning UI

**Files:**
- Modify: `apps/web/src/views/admin/AdminStoresView.vue`
- Create: `apps/web/src/views/admin/AdminStoresView.test.ts`
- Modify: `apps/web/src/views/VerifyEmailView.vue`
- Modify: `apps/web/src/views/VerifyEmailView.test.ts`
- Create: `apps/web/src/views/InitialPasswordSetupView.vue`
- Create: `apps/web/src/views/InitialPasswordSetupView.test.ts`
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/stores/auth.test.ts`
- Modify: `apps/web/src/router/index.ts`

- [ ] **Step 1: Write failing component/store tests**

Assert admin form has no password field/payload; pending store status displayed with resend button/countdown; public verification handles `PASSWORD_SETUP_REQUIRED` by storing ticket only in memory and navigating without ticket URL; setup requires 15 chars; success clears ticket and links to login; reload without ticket returns to activation guidance; ADMIN `EMAIL_VERIFIED` links to login and never stores session.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/web test -- AdminStoresView.test.ts VerifyEmailView.test.ts InitialPasswordSetupView.test.ts auth.test.ts`

- [ ] **Step 3: Implement minimal views**

Add public route `/ativar-conta/senha` before `/:storeSlug`. Pinia keeps `passwordSetupTicket` in non-persisted state. Admin status model includes `PENDING_ACTIVATION`; operational actions remain disabled until ACTIVE.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/web test
pnpm --filter @delivery/web typecheck
git add apps/web/src
git commit -m "feat(web): add store owner activation"
```

### Task 5: Secure bootstrap ADMIN activation

**Files:**
- Modify: `apps/api/src/db/seed.ts`
- Create: `apps/api/src/services/admin-bootstrap.service.ts`
- Create: `apps/api/test/admin-bootstrap.test.ts`
- Modify: `apps/api/.env.example`
- Modify: `README.md`

**Interfaces:**

```ts
export type BootstrapAdminInput = { name: string; email: string; password: string }
export type BootstrapContext = { authCodeSecret: string; requestId: string; now?: Date }
export async function bootstrapAdmin(db: Db, input: BootstrapAdminInput, ctx: BootstrapContext): Promise<{
  state: 'CREATED' | 'RESENT' | 'ALREADY_ACTIVE'; outboxId: string | null
}>
```

- [ ] **Step 1: Extract bootstrap service and write failing tests**

Assert 15-char password, normalized email, single ADMIN invariant, PENDING_EMAIL + BOOTSTRAP + provider hash + challenge/outbox transaction, no credential output, rerun pending admin replaces expired/current challenge within send limits (`RESENT`), active rerun no-op, second different admin rejected, correct confirmation required before login. Import tests from `admin-bootstrap.service.ts`, never from the side-effecting CLI module.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- admin-bootstrap.test.ts`

- [ ] **Step 3: Implement CLI-safe bootstrap**

Keep secrets in environment/stdin-compatible sources; never command args. CLI prints only state and non-sensitive IDs/counts, not email/password/code/verification ID. It may attempt outbox delivery using configured Resend; failure stays queued. Rerun is the first-admin resend path when no active ADMIN can authorize the HTTP resend route.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- admin-bootstrap.test.ts auth.routes.test.ts
git add apps/api/src/db/seed.ts apps/api/src/services/admin-bootstrap.service.ts apps/api/test/admin-bootstrap.test.ts apps/api/.env.example README.md
git commit -m "feat(admin): verify bootstrap email"
```

### Task 6: Driver invitations by verified email

**Files:**
- Modify: `packages/shared/src/store-driver.schema.ts`
- Modify: `packages/shared/src/store-driver.schema.test.ts`
- Modify: `apps/api/src/services/store-driver.service.ts`
- Modify: `apps/api/src/routes/store-drivers.ts`
- Modify: `apps/api/test/own-drivers.service.test.ts`
- Modify: `apps/api/test/own-drivers.routes.test.ts`
- Modify: every test calling `inviteDriver` with phone
- Modify: `apps/web/src/views/store/StoreDriversView.vue`
- Create or modify: `apps/web/src/views/store/StoreDriversView.test.ts`

**Interfaces:**

```ts
export const InviteStoreDriverSchema = StoreDriverTermsSchema.extend({
  email: NormalizedEmail,
})
export async function inviteDriver(db: Db, storeId: string, email: string, terms: StoreDriverTerms): Promise<StoreDriver>
```

- [ ] **Step 1: Write failing shared/service/route tests**

Assert phone field rejected, email normalized, lookup requires role DRIVER + `emailVerifiedAt IS NOT NULL` + ACTIVE, pending/unverified/blocked/customer/unknown all use `Entregador não encontrado ou indisponível`, cross-store behavior unchanged, and existing schedule-conflict/multiple-link logic remains.

- [ ] **Step 2: Confirm RED**

```bash
pnpm --filter @delivery/shared test -- store-driver.schema.test.ts
pnpm --filter @delivery/api test -- own-drivers.service.test.ts own-drivers.routes.test.ts
```

- [ ] **Step 3: Implement and migrate tests/UI**

Query `lower(users.email)` and explicit verified/role/status predicates in one statement. Update all `inviteDriver` test inputs deliberately; do not change store/customer contact-phone displays. UI label/input becomes email with `autocomplete="email"`.

- [ ] **Step 4: Confirm GREEN and commit breaking contract**

```bash
pnpm --filter @delivery/shared test -- store-driver.schema.test.ts
pnpm --filter @delivery/api test -- own-drivers.service.test.ts own-drivers.routes.test.ts returns.service.test.ts
pnpm --filter @delivery/web test
git add packages/shared apps/api apps/web
git commit -m "feat(drivers)!: invite by verified email" -m "BREAKING CHANGE: store-driver invitations accept email instead of phone and require an active verified DRIVER account."
```

### Task 7: Final authorization, enumeration, and persistence audit

**Files:**
- Modify: `apps/api/test/authorization-matrix.routes.test.ts`
- Modify: `apps/api/test/authorization-boundary.routes.test.ts`
- Create: `apps/api/test/sec03a-security-regression.test.ts`
- Modify: `apps/api/test/helpers/test-db.ts`

- [ ] **Step 1: Add failing final regression matrix**

Cover ANON/CUSTOMER/DRIVER/STORE_A/STORE_B/ADMIN against every new auth/admin endpoint; pending/blocked principals; pending store absent from public routes and denied operational routes; store A cannot resend/inspect store B activation; public recovery/register equivalence snapshots; no forbidden fields in responses.

- [ ] **Step 2: Add DB/secret leak assertions**

After full registration, resend, recovery, and store setup flows, recursively inspect text/JSON columns in new tables and captured logs. Assert entered codes/raw tickets/passwords/Turnstile tokens/API keys are absent. Verify code hashes and ticket hashes exist.

- [ ] **Step 3: Confirm GREEN**

Run:

```bash
pnpm --filter @delivery/api test -- authorization-matrix.routes.test.ts authorization-boundary.routes.test.ts sec03a-security-regression.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/test
git commit -m "test(security): cover SEC-03A boundaries"
```

### Task 8: Runbook, security review, and external staging prerequisites

**Files:**
- Create: `docs/security/runbooks/sec-03a-resend-identity.md`
- Modify: `docs/security/2026-07-11-backend-security-review.md`
- Modify: `docs/superpowers/specs/2026-07-11-security-remediation-design.md`
- Modify: `docs/carry-forwards.md`
- Modify: `README.md`

- [ ] **Step 1: Write exact runbook**

Document:

- generate independent `AUTH_CODE_SECRET` and create sending-only Resend key;
- configure `EMAIL_FROM`, `PUBLIC_WEB_URL`, staging `EMAIL_ALLOWED_RECIPIENTS`;
- workers.dev staging limitation and single-owner test;
- production custom-domain/DNS requirement;
- admin bootstrap/activation procedure without printing secrets;
- manual register/resend/expiry/recovery/session-revocation/store-activation checks;
- Resend outage simulation and outbox inspection;
- rollback: disable public registration/recovery at edge, preserve DB/outbox, restore prior Worker; never downgrade schema or re-enable phone login;
- deferred bounce/complaint/suppression webhook.

- [ ] **Step 2: Update review honestly**

Mark SEC-03 remediated in code only after Task 9 gate. State external Resend domain/staging smoke remains manual. Keep SEC-03B Google, SEC-17 MFA, password-storage modernization, and Resend webhooks pending.

- [ ] **Step 3: Documentation checks and commit**

```bash
rg -n "SEC-03|AUTH_CODE_SECRET|RESEND_API_KEY|EMAIL_ALLOWED_RECIPIENTS" docs README.md apps/api/.dev.vars.example
git diff --check
git add docs README.md apps/api/.dev.vars.example
git commit -m "docs(security): add SEC-03A rollout runbook"
```

### Task 9: Final SEC-03A gate

- [ ] **Step 1: Recreate disposable DBs and migrate from zero**

Repeat Stage 2's exact Docker-local recreation commands, then verify migrations 0024/0025 apply after 0000–0023. Run seed with safe test config and confirm ADMIN stays PENDING_EMAIL before code confirmation. Never run destructive recreation against staging/production URLs.

- [ ] **Step 2: Focused identity suite**

```bash
pnpm --filter @delivery/shared test -- auth.schema.test.ts password-policy.test.ts store.test.ts store-driver.schema.test.ts
pnpm --filter @delivery/api test -- sec03a-schema.test.ts auth-code.test.ts email-templates.test.ts resend-sender.test.ts email-config.test.ts email-outbox.test.ts identity-abuse.test.ts identity-cleanup.test.ts auth-challenge.service.test.ts registration.service.test.ts auth-ticket.service.test.ts password-recovery.service.test.ts account-activation.service.test.ts admin-bootstrap.test.ts auth.routes.test.ts admin-stores.routes.test.ts own-drivers.routes.test.ts sec03a-security-regression.test.ts
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
```

- [ ] **Step 3: Full monorepo gate**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
git status --short
```

Expected: all pass; clean worktree after intended commits.

- [ ] **Step 4: Static final-state checks**

```bash
rg "eq\(users\.phone|users_phone_unique|Telefone ou email já cadastrado|owner.*password|createStoreWithOwner" apps/api/src packages/shared/src apps/web/src apps/driver/src
rg "PENDING_EMAIL|PENDING_APPROVAL|PENDING_ACTIVATION" apps/api/src packages/shared/src apps/web/src apps/driver/src
```

First command must have no identity/bypass matches. Review second command for all expected state consumers.

- [ ] **Step 5: Manual allowed-recipient staging gate**

After user configures external resources, execute runbook with one allowlisted address. Record date, Worker commit, recipient class (not raw email), Resend message IDs, and pass/fail without codes/tickets. Production promotion remains blocked until custom domain and verified `EMAIL_FROM` exist.

- [ ] **Step 6: Verification evidence commit**

Append actual command counts/results and manual prerequisite status to security docs, then:

```bash
git add docs
git commit -m "docs(security): record SEC-03A verification"
```

Do not claim manual staging PASS if credentials/domain were unavailable.

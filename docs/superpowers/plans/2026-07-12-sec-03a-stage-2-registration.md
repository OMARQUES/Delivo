# SEC-03A Stage 2: Registration and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace immediate phone-first registration with detached email verification for CUSTOMER/DRIVER, finish user identity schema migration, make PASSWORD login email-only, and provide usable web/driver verification screens.

**Architecture:** Registration attempts remain outside `users` until a current challenge is atomically confirmed. Confirmation creates user/provider/session or pending driver once. Existing tests use an explicit verified-user factory rather than a production bypass. API responses remain non-enumerable and email dispatch uses Stage 1 outbox.

**Tech Stack:** Shared Zod schemas, Hono/OpenAPI, Drizzle/PostgreSQL, Stage 1 identity/email services, Vue 3/Pinia/Vue Router, Vitest.

## Global Constraints

- Stage 1 must be merged and green.
- Verification code is exactly six digits, valid ten minutes, max five attempts.
- Pending registration absolute expiry is 24 hours; resend cannot extend it.
- CUSTOMER password 8–128; DRIVER 15–128; both use local common-password blocklist.
- CUSTOMER phone optional; DRIVER phone required; email required for both.
- Final login request field is `email`, not `identifier`; phone login is removed.
- Public duplicate/synthetic registration response matches real `202` shape.
- No production helper may create a verified user without proof; test bypass stays under `apps/api/test/helpers`.

---

### Task 1: Shared email-registration contracts and password policy

**Files:**
- Create: `packages/shared/src/password-policy.ts`
- Create: `packages/shared/src/password-policy.test.ts`
- Modify: `packages/shared/src/auth.schema.ts`
- Modify: `packages/shared/src/auth.schema.test.ts`
- Modify: `packages/shared/src/schemas.ts`

**Interfaces:**

```ts
export type PasswordRole = 'CUSTOMER' | 'DRIVER' | 'STORE' | 'ADMIN'
export const NormalizedEmail: z.ZodType<string>
export function passwordMinLength(role: PasswordRole): 8 | 15
export function passwordPolicyIssue(password: string, role: PasswordRole): string | null

export const StartRegistrationSchema: ZodType<StartRegistrationInput>
export const ConfirmVerificationSchema = z.object({ verificationId: z.uuid(), code: z.string().regex(/^\d{6}$/) })
export const ResendVerificationSchema = z.object({ verificationId: z.uuid(), turnstileToken: TurnstileTokenSchema })
```

- [ ] **Step 1: Write failing shared tests**

Table-test CUSTOMER without phone/8 chars, DRIVER requiring phone/15 chars, required normalized email, whitespace retained in password, 128 accepted/129 rejected, common passwords rejected case-insensitively, exact six-digit code, role fixed to CUSTOMER/DRIVER only, and strict rejection of unexpected identity selectors/fields. Apply `.strict()` to registration, confirmation, and resend objects.

Use an explicit discriminated union:

```ts
const CustomerRegistration = Base.extend({ role: z.literal('CUSTOMER'), phone: Phone.optional() })
const DriverRegistration = Base.extend({ role: z.literal('DRIVER'), phone: Phone })
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/shared test -- password-policy.test.ts auth.schema.test.ts`

- [ ] **Step 3: Implement policy/contracts without replacing legacy route schema yet**

Use a versioned, source-controlled set of high-frequency passwords; reject exact normalized matches only. Do not call external breach APIs. Export new schemas alongside legacy `RegisterSchema`/`LoginSchema` until Task 4 switches all consumers in one commit.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/shared test -- password-policy.test.ts auth.schema.test.ts
git add packages/shared/src
git commit -m "feat(auth): define email registration contracts"
```

### Task 2: Challenge repository and atomic attempt accounting

**Files:**
- Create: `apps/api/src/services/auth-challenge.service.ts`
- Create: `apps/api/test/auth-challenge.service.test.ts`

**Interfaces:**

```ts
export async function createChallenge(tx: DbTx, input: CreateChallengeInput): Promise<AuthChallenge>
export async function replaceChallenge(tx: DbTx, input: ReplaceChallengeInput): Promise<AuthChallenge>
export async function verifyAndConsumeChallenge(
  tx: DbTx,
  input: VerifyChallengeInput,
): Promise<{ ok: true; challenge: AuthChallenge } | { ok: false; error: ChallengeError }>
```

- [ ] **Step 1: Write failing DB tests**

Cover stored hash differs from code, valid consume, malformed/wrong code, atomic attempt increments under concurrency, fifth wrong attempt invalidation, expiry boundary (`now >= expiresAt` invalid), replay, replacement invalidates old challenge/outbox, and replacement expiry clamped to pending registration expiry.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- auth-challenge.service.test.ts`

- [ ] **Step 3: Implement conditional SQL transitions**

`verifyAndConsumeChallenge` must lock/load the challenge, perform keyed verification, and use conditional updates. Wrong attempt uses:

```sql
UPDATE auth_challenges
SET attempt_count = attempt_count + 1,
    invalidated_at = CASE WHEN attempt_count + 1 >= 5 THEN $now ELSE invalidated_at END
WHERE id = $id AND consumed_at IS NULL AND invalidated_at IS NULL
  AND expires_at > $now AND attempt_count < 5
RETURNING attempt_count, invalidated_at;
```

Correct consume requires the same active predicates and `consumed_at IS NULL`. Map every invalid/expired/replayed condition to one internal `ChallengeError('INVALID_OR_EXPIRED')` result. Do not throw that domain error inside the transaction: throwing would roll back a wrong-attempt increment. The transaction owner must commit the `{ ok: false }` result, then map it to the generic HTTP/service error outside the transaction. Infrastructure/SQL errors still throw and roll back.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- auth-challenge.service.test.ts
git add apps/api/src/services/auth-challenge.service.ts apps/api/test/auth-challenge.service.test.ts
git commit -m "feat(auth): add atomic email challenges"
```

### Task 3: Detached registration service and concurrency defense

**Files:**
- Create: `apps/api/src/services/registration.service.ts`
- Create: `apps/api/test/registration.service.test.ts`
- Modify: `apps/api/src/services/auth.service.ts` (export reusable session issuer; remove registration only in Task 4)

**Interfaces:**

```ts
export async function startRegistration(db: Db, input: StartRegistrationInput, ctx: IdentityContext): Promise<{
  response: { verificationId: string; expiresAt: string; resendAt: string }
  outboxId: string | null
}>
export async function confirmRegistration(db: Db, input: ConfirmVerificationInput, ctx: IdentityContext): Promise<
  | { kind: 'CUSTOMER_SESSION'; user: PublicUser; accessToken: string; refreshToken: string }
  | { kind: 'DRIVER_PENDING_APPROVAL'; user: PublicUser }
>
export async function resendRegistrationVerification(db: Db, input: ResendVerificationInput, ctx: IdentityContext): Promise<{
  verificationId: string; expiresAt: string; resendAt: string; outboxId: string | null
}>
```

- [ ] **Step 1: Write failing service tests**

Test no `users` row before confirmation; pending password hash only; confirmation creates CUSTOMER ACTIVE/session; DRIVER PENDING_APPROVAL/no session; duplicate active email returns synthetic shape/no pending row; existing-account notice max once/day; two independent attempts cannot transfer password/profile; concurrent confirmations create one user/provider; losing flow generic; resend new ID invalidates old and preserves 24h absolute expiry; provider/outbox failure after transaction leaves retryable flow.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- registration.service.test.ts`

- [ ] **Step 3: Implement transactional flows**

Pass dependencies through `IdentityContext`:

```ts
export type IdentityContext = {
  authCodeSecret: string
  jwtSecret: string
  requestId: string
  now?: Date
}
```

Generate access/refresh material before entering final confirmation transaction where needed; insert refresh-token family in the same transaction as user/provider. Catch only SQLSTATE `23505` for user email/provider race; close losing pending attempt without updating existing account. Synthetic IDs use `crypto.randomUUID()` and real-looking timestamps.

For challenge confirmation, branch on `verifyAndConsumeChallenge` inside the transaction. Return `{ ok: false }` unchanged so failed-attempt accounting commits; convert its `ChallengeError` to the public generic error only after `db.transaction(...)` resolves.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/api test -- registration.service.test.ts
git add apps/api/src/services apps/api/test/registration.service.test.ts
git commit -m "feat(auth): add detached registration"
```

### Task 4: Route cutover, final identity migration, and test factories

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/services/auth.service.ts`
- Modify: `apps/api/src/security/auth-abuse.ts`
- Modify: `apps/api/src/security/http.ts`
- Modify: `apps/api/src/db/schema/users.ts`
- Modify: `apps/api/src/db/schema/stores.ts`
- Modify: `apps/api/test/helpers/test-db.ts`
- Modify: `apps/api/test/auth.routes.test.ts`
- Modify: `apps/api/test/auth.service.test.ts`
- Modify: every API test currently importing/calling `registerUser`
- Generate: `apps/api/drizzle/0025_sec_03a_email_identity.sql` and matching metadata

**Interfaces:**

```ts
export async function createVerifiedTestUser(input: {
  name: string; email: string; phone?: string | null; role?: UserRole;
  status?: FinalUserStatus; password?: string
}): Promise<typeof users.$inferSelect>
```

- [ ] **Step 1: Replace auth route tests with failing final contract**

Assert `/auth/register` returns 202 flow only; `/auth/verification/confirm` discriminated result; `/auth/verification/resend` returns replacement flow; Turnstile/rate limits run before password hashing/DB writes; duplicate account has same response keys/status; all auth responses `no-store`; malformed code validation and valid-shape wrong code both return HTTP 400, with only the latter using stable `CODE_INVALID_OR_EXPIRED`.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/api test -- auth.routes.test.ts`

- [ ] **Step 3: Cut routes to new services**

Route ordering:

```ts
await protectRegistration(c, { email: input.email, turnstileToken: input.turnstileToken })
const emailConfig = resolveEmailConfig(c.env)
const started = await startRegistration(db, input, identityContext(c))
if (started.outboxId) await dispatchOutboxById(db, createResendSender(emailConfig), c.env, started.outboxId).catch(() => undefined)
return c.json(started.response, 202)
```

Confirm/resend call purpose-specific protectors before service work. Use HTTP 400 for `FLOW_INVALID_OR_EXPIRED`, `CODE_INVALID_OR_EXPIRED`, and `PASSWORD_POLICY_REJECTED`; extend `SecurityHttpError` accordingly. Use 503 only for `EMAIL_DELIVERY_UNAVAILABLE`. Remove production `registerUser` after all tests use the test helper.

At cutover, remove the legacy phone-first schema and make the final export explicit:

```ts
export const RegisterSchema = StartRegistrationSchema
export type RegisterInput = z.infer<typeof RegisterSchema>
```

- [ ] **Step 4: Add final Drizzle state and migration**

Final Drizzle enums:

```ts
export const userStatus = pgEnum('user_status', [
  'PENDING_EMAIL', 'PENDING_APPROVAL', 'ACTIVE', 'BLOCKED',
])
```

Make `users.email.notNull()`, drop `users_phone_unique`, keep `users_email_lower_unique`. Because local/staging identity data is explicitly disposable and no production legacy users exist, migration must:

1. Abort with a clear exception if `users` contains any row, requiring explicit local/staging DB recreation; never delete, reinterpret, or auto-verify legacy identities.
2. Rebuild PostgreSQL enum safely through temporary type/cast because enum values cannot be dropped directly.
3. Set email NOT NULL.
4. Drop only phone unique index; never drop phone column.

Generate: `pnpm --filter @delivery/api db:generate -- --name sec_03a_email_identity`, inspect SQL, then add explicit precondition blocks before destructive casts.

- [ ] **Step 5: Add test factory and migrate old tests mechanically**

`createVerifiedTestUser` inserts final user/provider directly and is exported only from test helper. Update every file returned by:

```bash
rg -l 'registerUser\(' apps/api/test
```

Do not blanket-replace order/payment/shift `PENDING` values. Update only user status assertions/types to `PENDING_APPROVAL`. Make public/session user email non-null in final types. Update driver approval so transition to ACTIVE requires `emailVerifiedAt` and non-null phone; test direct malformed pending rows cannot be approved. Require:

```bash
rg 'registerUser\(' apps/api/test
rg "user.*PENDING|status: 'PENDING'" apps/api/test apps/web/src apps/driver/src
```

Each remaining match must be classified as non-user domain state or fixed.

- [ ] **Step 6: Apply migration and confirm GREEN**

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS delivery WITH (FORCE)"
docker compose exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE delivery"
docker compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS delivery_test WITH (FORCE)"
docker compose exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE delivery_test"
DATABASE_URL=postgres://postgres:postgres@localhost:5432/delivery pnpm --filter @delivery/api db:migrate
pnpm --filter @delivery/api test -- auth.routes.test.ts auth.service.test.ts registration.service.test.ts auth-challenge.service.test.ts
```

These commands target only the repository's named local Docker service and explicitly disposable `delivery`/`delivery_test` databases. Stop if Compose points at any external database.

- [ ] **Step 7: Commit breaking cutover**

```bash
git add packages/shared apps/api
git commit -m "feat(auth)!: require verified email accounts" -m "BREAKING CHANGE: registration returns a verification flow, login uses email only, user PENDING splits into PENDING_EMAIL/PENDING_APPROVAL, and phone is no longer unique."
```

### Task 5: Email-only login and state-safe responses

**Files:**
- Modify: `packages/shared/src/auth.schema.ts`
- Modify: `packages/shared/src/auth.schema.test.ts`
- Modify: `apps/api/src/services/auth.service.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/security/auth-abuse.ts`
- Modify: `apps/api/test/auth.service.test.ts`
- Modify: `apps/api/test/auth.routes.test.ts`

**Interfaces:**

```ts
export const LoginSchema = z.object({
  email: NormalizedEmail,
  password: z.string().min(1).max(128),
  turnstileToken: TurnstileTokenSchema,
}).strict()
```

- [ ] **Step 1: Add failing tests**

Assert phone-shaped request rejected, mixed-case email normalized, unknown/missing provider uses dummy PBKDF2, correct-password DRIVER `PENDING_APPROVAL` gets explicit 403, incorrect password never reveals state, PENDING_EMAIL/blocked behavior occurs only after correct password, login rate-limit keys use normalized email.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/shared test -- auth.schema.test.ts && pnpm --filter @delivery/api test -- auth.service.test.ts auth.routes.test.ts`

- [ ] **Step 3: Remove phone lookup and rename request field**

Query only `lower(users.email) = input.email`; retain fixed dummy hash path. `protectLogin`, failure recording, and clearing receive `input.email`. Update OpenAPI body and tests.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/shared test -- auth.schema.test.ts
pnpm --filter @delivery/api test -- auth.service.test.ts auth.routes.test.ts
git add packages/shared/src/auth.schema* apps/api/src apps/api/test/auth*
git commit -m "feat(auth): make password login email-only"
```

### Task 6: Optional CUSTOMER contact phone

**Files:**
- Create: `packages/shared/src/user-profile.schema.ts`
- Create: `packages/shared/src/user-profile.schema.test.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/test/auth.routes.test.ts`
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/views/CheckoutView.vue`
- Create or modify: `apps/web/src/views/CheckoutView.test.ts`

**Interfaces:**

```ts
export const UpdateCustomerContactSchema = z.object({
  phone: z.string().transform(normalizePhone).pipe(z.string().min(10).max(13)).nullable(),
}).strict()
PATCH /auth/me/contact -> { phone: string | null }
```

- [ ] **Step 1: Write failing schema/route/UI tests**

Assert only authenticated CUSTOMER may update its own contact phone; DRIVER/STORE/ADMIN denied; phone is never checked for uniqueness; two customers may share one contact number; null clears it; response contains no identity internals. At checkout, a CUSTOMER with null phone sees one optional WhatsApp prompt, may save or skip, and either path continues checkout. Dismissal/API failure never prevents order creation.

- [ ] **Step 2: Confirm RED**

```bash
pnpm --filter @delivery/shared test -- user-profile.schema.test.ts
pnpm --filter @delivery/api test -- auth.routes.test.ts
pnpm --filter @delivery/web test -- CheckoutView.test.ts
```

- [ ] **Step 3: Implement self-scoped contact update and non-blocking prompt**

Authorize with `authMiddleware` plus CUSTOMER role, update only `users.id = auth.sub`, and never query by phone. The prompt appears before checkout submit when session phone is null; `Agora não` continues immediately. Successful save updates Pinia user/persistence; failed save shows optional warning plus `Continuar sem telefone`.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/shared test -- user-profile.schema.test.ts
pnpm --filter @delivery/api test -- auth.routes.test.ts
pnpm --filter @delivery/web test -- CheckoutView.test.ts
git add packages/shared apps/api/src/routes/auth.ts apps/api/test/auth.routes.test.ts apps/web/src
git commit -m "feat(customer): add optional contact phone"
```

### Task 7: Web customer registration and verification UI

**Files:**
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/stores/auth.test.ts`
- Modify: `apps/web/src/views/RegisterView.vue`
- Create: `apps/web/src/views/VerifyEmailView.vue`
- Create: `apps/web/src/views/VerifyEmailView.test.ts`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/views/LoginView.vue`
- Modify: `apps/web/src/views/LoginView.test.ts`

**Interfaces:**

```ts
type VerificationFlow = { verificationId: string; expiresAt: string; resendAt: string }
auth.registerCustomer(input): Promise<VerificationFlow>
auth.confirmEmail(verificationId, code): Promise<ConfirmationResult>
auth.resendEmail(verificationId, turnstileToken?): Promise<VerificationFlow>
```

- [ ] **Step 1: Write failing Pinia/component tests**

Assert required email, optional phone, role CUSTOMER sent explicitly, no session on register, navigation to `/verificar-email?id=${verificationId}`, six numeric input, resend timer/`Retry-After`, adaptive Turnstile on `TURNSTILE_REQUIRED`, CUSTOMER session persisted only after confirmation, password/code never in URL/storage.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/web test -- auth.test.ts VerifyEmailView.test.ts LoginView.test.ts`

- [ ] **Step 3: Implement minimal UI/state**

Use query only for public `verificationId`; store expiry/resend timestamps in `sessionStorage` under a flow-ID-scoped key and remove them after completion/expiry. Replace login `identifier` model/copy with `email` and `autocomplete="email"`. Clear code after failed confirmation and whenever flow ID changes.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/web test
pnpm --filter @delivery/web typecheck
git add apps/web/src
git commit -m "feat(web): add verified email registration"
```

### Task 8: Driver registration and verification UI

**Files:**
- Modify: `apps/driver/src/stores/auth.ts`
- Modify: `apps/driver/src/stores/auth.test.ts`
- Modify: `apps/driver/src/views/RegisterView.vue`
- Create: `apps/driver/src/views/VerifyEmailView.vue`
- Create: `apps/driver/src/views/VerifyEmailView.test.ts`
- Modify: `apps/driver/src/router/index.ts`
- Modify: `apps/driver/src/views/LoginView.vue`
- Modify: `apps/driver/src/views/LoginView.test.ts`

- [ ] **Step 1: Write failing tests**

Assert DRIVER role forced client/server, phone required, password minimum 15, email required, confirmation displays approval-pending state and stores no session, resend/adaptive Turnstile works, login sends `email`, non-DRIVER session rejection remains intact.

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @delivery/driver test`

- [ ] **Step 3: Implement matching driver flow**

Reuse API contracts, not web components. Add `/verificar-email` before guarded layout. On `DRIVER_PENDING_APPROVAL`, clear flow state and link to login; never treat pending driver as authenticated.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
pnpm --filter @delivery/driver test
pnpm --filter @delivery/driver typecheck
git add apps/driver/src
git commit -m "feat(driver): verify registration email"
```

### Task 9: Stage 2 regression and migration gate

- [ ] **Step 1: Focused security suite**

```bash
pnpm --filter @delivery/shared test -- auth.schema.test.ts password-policy.test.ts
pnpm --filter @delivery/api test -- auth-challenge.service.test.ts registration.service.test.ts auth.routes.test.ts auth.service.test.ts security-session.service.test.ts admin-drivers.routes.test.ts
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
```

- [ ] **Step 2: Migration from zero**

Repeat the exact local Docker recreation commands from Task 4 Step 6, apply migrations through 0025, seed fixtures with final non-null email, and run schema tests. Expected: no `PENDING` user enum, no phone unique index.

- [ ] **Step 3: Full gate and static leak scan**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
rg "eq\(users\.phone|identifier" apps/api/src packages/shared/src apps/web/src apps/driver/src
git diff --check
git status --short
```

Every `identifier`/phone match must be unrelated to PASSWORD identity or removed.

- [ ] **Step 4: Commit only gate fixes if needed**

```bash
git add -A
git commit -m "test(auth): verify email registration flow"
```

Skip empty commit. Do not begin recovery until Stage 2 review passes.

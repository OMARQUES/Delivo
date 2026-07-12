# SEC-02 Rate Limiting and Anti-Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add atomic PostgreSQL rate limits and adaptive Cloudflare Turnstile protection to authentication, order creation/quotation, and uploads without introducing KV, Durable Objects, Queues, or webhook behavior changes.

**Architecture:** A storage-independent limiter contract is implemented by fixed-window PostgreSQL buckets keyed with HMAC-SHA-256. Routes compose typed policies for trusted Cloudflare IPs, normalized identities, principals, and refresh-token fingerprints; Turnstile is an isolated Siteverify adapter. Minimal Vue integration supplies mandatory registration challenges and adaptive login challenges in both customer/store web and driver apps.

**Tech Stack:** TypeScript 6, Hono, Zod/OpenAPI, Drizzle ORM, PostgreSQL/Neon, Cloudflare Workers and Turnstile, Vue 3, Pinia, Vitest.

---

## Scope guardrails

- Do not modify Mercado Pago webhook behavior; SEC-08 owns webhook freshness, replay, inbox, and provider reliability.
- Do not implement email-first identity, verification, recovery, Google login, Resend, or MFA.
- Do not add KV, Durable Objects, Queues, device fingerprints, ASN scoring, or artificial delays.
- Never persist or log raw IPs, identifiers, passwords, refresh tokens, Turnstile tokens, or Siteverify payloads.
- Never trust `X-Forwarded-For`. Staging/production accept only `CF-Connecting-IP`.
- Keep existing refresh rotation and reuse-family revocation semantics intact.
- Apply upload limits after cheap authorization/ownership checks and before reading the request body or writing R2.
- Use the exact approved defaults in the design spec; changes require updating the spec first.
- Follow red-green-refactor. Each task ends in a focused commit and leaves the relevant tests green.

## File map

**Shared contracts**

- Modify `packages/shared/src/auth.schema.ts`: accept bounded optional Turnstile tokens; routes enforce when required.
- Modify `packages/shared/src/auth.schema.test.ts`: schema regression coverage.

**API persistence and core**

- Create `apps/api/src/db/schema/rate-limit-buckets.ts`: bucket schema and inferred row types.
- Modify `apps/api/src/db/schema/index.ts`: export the schema.
- Generate `apps/api/drizzle/0023_sec_02_rate_limits.sql` and corresponding snapshot/journal entries.
- Create `apps/api/src/security/rate-limit.ts`: contracts, decisions, fixed-window math, HMAC keying, and PostgreSQL implementation.
- Create `apps/api/src/security/rate-limit-policies.ts`: the approved centralized policy constants.
- Create `apps/api/src/security/client-ip.ts`: trusted source extraction.
- Create `apps/api/src/security/turnstile.ts`: Siteverify adapter.
- Create `apps/api/src/security/http.ts`: stable abuse-protection errors and response headers.
- Create `apps/api/src/security/auth-abuse.ts`: authentication policy orchestration.
- Create `apps/api/src/middleware/rate-limit.ts`: context-aware policy consumption helpers.
- Modify `apps/api/src/env.ts`: required secrets/vars and injectable security variables.
- Modify `apps/api/src/middleware/error-handler.ts`: stable `code` and `Retry-After` envelope.

**API integration**

- Modify `apps/api/src/routes/auth.ts` and `apps/api/src/services/auth.service.ts`.
- Modify `apps/api/src/routes/orders.ts`.
- Modify `apps/api/src/routes/store-me.ts`, `apps/api/src/routes/store-catalog.ts`, and `apps/api/src/routes/driver.ts`.
- Modify `apps/api/src/index.ts`: bounded bucket cleanup.
- Modify `apps/api/test/helpers/test-db.ts`: truncate the new table.
- Create focused test files listed in each task; extend existing route suites only where setup reuse is material.

**Frontends**

- Modify both `src/lib/api.ts` files to expose error `code` and `retryAfter`.
- Modify both `src/stores/auth.ts` files to submit optional Turnstile tokens.
- Create `apps/web/src/components/TurnstileWidget.vue` and `apps/driver/src/components/TurnstileWidget.vue`.
- Modify both login and registration views.
- Add focused store/widget tests and driver Vitest configuration.

**Operations**

- Modify `apps/api/wrangler.jsonc` only for non-secret local vars.
- Modify `apps/api/.dev.vars.example`, `apps/web/.env.example`, and `apps/driver/.env.example`; create them if absent.
- Create `docs/security/runbooks/sec-02-turnstile-waf.md`.

### Task 1: Extend authentication request contracts

**Files:**
- Modify: `packages/shared/src/auth.schema.ts`
- Modify: `packages/shared/src/auth.schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests proving both requests accept an optional non-empty bounded token. The route, not the reusable service input type, makes registration mandatory so existing internal callers do not acquire a browser-challenge dependency:

```ts
it('accepts an optional bounded Turnstile token for registration', () => {
  expect(RegisterSchema.parse(valid).turnstileToken).toBeUndefined()
  expect(RegisterSchema.parse({ ...valid, turnstileToken: 'test-token' }).turnstileToken)
    .toBe('test-token')
  expect(() => RegisterSchema.parse({ ...valid, turnstileToken: 'x'.repeat(2049) })).toThrow()
})

it('allows an optional bounded Turnstile token for adaptive login', () => {
  expect(LoginSchema.parse({ identifier: 'a@b.com', password: 'senha123' }).turnstileToken)
    .toBeUndefined()
  expect(LoginSchema.parse({
    identifier: 'a@b.com', password: 'senha123', turnstileToken: 'test-token',
  }).turnstileToken).toBe('test-token')
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/shared test -- auth.schema.test.ts`

Expected: FAIL because the schemas do not return the supplied token or reject an oversized one.

- [ ] **Step 3: Implement the schemas**

```ts
const TurnstileTokenSchema = z.string().trim().min(1).max(2048)

export const RegisterSchema = z.object({
  // preserve existing fields
  turnstileToken: TurnstileTokenSchema.optional(),
})

export const LoginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
  turnstileToken: TurnstileTokenSchema.optional(),
})
```

Do not export the token schema unless another package needs it. `POST /auth/register` must still reject a missing token in Task 7 before calling the registration service.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @delivery/shared test -- auth.schema.test.ts && pnpm --filter @delivery/shared typecheck`

Expected: all shared auth tests and typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/auth.schema.ts packages/shared/src/auth.schema.test.ts
git commit -m "feat(auth): accept Turnstile tokens"
```

### Task 2: Add the PostgreSQL bucket schema and migration

**Files:**
- Create: `apps/api/src/db/schema/rate-limit-buckets.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/test/rate-limit-schema.test.ts`
- Modify: `apps/api/test/helpers/test-db.ts`
- Generate: `apps/api/drizzle/0023_sec_02_rate_limits.sql`
- Generate: `apps/api/drizzle/meta/0023_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`

- [ ] **Step 1: Write the failing schema test**

```ts
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { rateLimitBuckets } from '../src/db/schema'

describe('rate_limit_buckets schema', () => {
  it('uses a composite primary key and never stores a raw subject', () => {
    const config = getTableConfig(rateLimitBuckets)
    expect(config.columns.map((column) => column.name)).toEqual([
      'scope', 'key_hash', 'window_start', 'count', 'blocked_until', 'expires_at',
    ])
    expect(config.primaryKeys).toHaveLength(1)
    expect(config.columns.some((column) => /email|phone|ip|token|subject/.test(column.name))).toBe(false)
  })
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- rate-limit-schema.test.ts`

Expected: FAIL because `rateLimitBuckets` does not exist.

- [ ] **Step 3: Add the schema**

```ts
import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  scope: text('scope').notNull(),
  keyHash: text('key_hash').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
  blockedUntil: timestamp('blocked_until', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.scope, table.keyHash, table.windowStart] }),
  index('rate_limit_buckets_expires_idx').on(table.expiresAt),
])
```

Export it from `schema/index.ts`. Add `rate_limit_buckets` first in the `TRUNCATE TABLE` list in `test-db.ts`.

- [ ] **Step 4: Generate and inspect the migration**

Run:

```bash
pnpm --filter @delivery/api db:generate -- --name sec_02_rate_limits
```

Expected: Drizzle creates `0023_sec_02_rate_limits.sql`, snapshot `0023_snapshot.json`, and appends journal index 23. Inspect SQL and require the composite primary key plus expiry index; do not hand-edit the snapshot.

- [ ] **Step 5: Verify migration from zero and schema tests**

Run:

```bash
docker compose exec -T db psql -U postgres -c 'DROP DATABASE IF EXISTS delivery_sec02_test'
docker compose exec -T db psql -U postgres -c 'CREATE DATABASE delivery_sec02_test'
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/delivery_sec02_test pnpm --filter @delivery/api test -- rate-limit-schema.test.ts
```

Expected: migration chain `0000`–`0023` applies and the test PASSes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema apps/api/drizzle apps/api/test/rate-limit-schema.test.ts apps/api/test/helpers/test-db.ts
git commit -m "feat(security): add rate limit buckets"
```

### Task 3: Implement privacy-safe keys, trusted IPs, and policies

**Files:**
- Create: `apps/api/src/security/client-ip.ts`
- Create: `apps/api/src/security/rate-limit-policies.ts`
- Create: `apps/api/src/security/rate-limit-key.ts`
- Create: `apps/api/test/rate-limit-key.test.ts`
- Create: `apps/api/test/client-ip.test.ts`

- [ ] **Step 1: Write failing pure tests**

Cover domain separation, deterministic normalization, absence of raw subjects, trusted header behavior, and every approved constant:

```ts
expect(await hashRateLimitKey('secret', 'login-id', ' Ana@Email.COM '))
  .toBe(await hashRateLimitKey('secret', 'login-id', 'ana@email.com'))
expect(await hashRateLimitKey('secret', 'login-id', 'ana@email.com'))
  .not.toBe(await hashRateLimitKey('secret', 'register-id', 'ana@email.com'))
expect(resolveClientIp('production', new Headers({
  'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.9',
}))).toBe('203.0.113.7')
expect(() => resolveClientIp('production', new Headers({
  'X-Forwarded-For': '198.51.100.9',
}))).toThrow('Trusted client IP unavailable')
expect(resolveClientIp('local', new Headers())).toBe('127.0.0.1')
expect(POLICIES.orderCreateUserHour).toMatchObject({ limit: 10, windowMs: 3_600_000 })
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- rate-limit-key.test.ts client-ip.test.ts`

Expected: FAIL because the security modules do not exist.

- [ ] **Step 3: Implement the pure modules**

Use Web Crypto HMAC, full base64url output, lowercase trimmed login identities, digit-only phone normalization when the identifier contains no `@`, and strict `CF-Connecting-IP` outside local:

```ts
export async function hashRateLimitKey(secret: string, scope: string, subject: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${scope}\0${subject}`),
  ))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function normalizeLoginKey(raw: string) {
  const trimmed = raw.trim().toLowerCase()
  return trimmed.includes('@') ? trimmed : trimmed.replace(/\D/g, '')
}
```

Define all policies as immutable values with stable scope, limit, window, retention, and optional cooldown. Include every row from Section 5 of the approved spec; do not use environment variables for limits in this release.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @delivery/api test -- rate-limit-key.test.ts client-ip.test.ts && pnpm --filter @delivery/api typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/security apps/api/test/rate-limit-key.test.ts apps/api/test/client-ip.test.ts
git commit -m "feat(security): define abuse limit policies"
```

### Task 4: Implement the atomic PostgreSQL limiter

**Files:**
- Create: `apps/api/src/security/rate-limit.ts`
- Create: `apps/api/test/rate-limit.test.ts`

- [ ] **Step 1: Write failing database tests**

Tests must prove:

```ts
const limiter = new PostgresRateLimiter(testDb, 'rate-secret')
const policy = { scope: 'test-2-minute', limit: 2, windowMs: 60_000, retentionMs: 120_000 }
expect((await limiter.consume(policy, 'subject', now)).allowed).toBe(true)
expect((await limiter.consume(policy, 'subject', now)).allowed).toBe(true)
const denied = await limiter.consume(policy, 'subject', now)
expect(denied).toMatchObject({ allowed: false, count: 3 })
expect(denied.retryAfterSeconds).toBe(60)
```

Also start two concurrent `consume()` calls after pre-consuming `limit - 1`; assert exactly one is allowed. Add tests for UTC boundary rollover, independent scopes, `inspect`, `clear`, expiry, and cooldown: the threshold-crossing call is allowed, its next call is denied until `blockedUntil`, and concurrent calls never shorten the block.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- rate-limit.test.ts`

Expected: FAIL because `PostgresRateLimiter` is missing.

- [ ] **Step 3: Implement the contract and fixed-window math**

```ts
export type RateLimitPolicy = Readonly<{
  scope: string
  limit: number
  windowMs: number
  retentionMs: number
  cooldownMs?: number
}>

export type RateLimitDecision = {
  allowed: boolean
  count: number
  limit: number
  retryAfterSeconds: number
  blockedUntil: Date | null
}

export interface RateLimiter {
  consume(policy: RateLimitPolicy, subject: string, now?: Date): Promise<RateLimitDecision>
  inspect(policy: RateLimitPolicy, subject: string, now?: Date): Promise<RateLimitDecision>
  clear(policies: readonly RateLimitPolicy[], subject: string): Promise<void>
}
```

`consume` must use one parameterized `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` statement. Calculate `windowStart = floor(now/windowMs)*windowMs`, and ensure `expiresAt` is the later of `windowStart + retentionMs` and `blockedUntil`. Set `blocked_until` with `GREATEST` when the increment reaches a cooldown policy's threshold. The call that first reaches the threshold remains allowed; later calls inspect the existing future block and deny. Never build SQL identifiers from request data.

- [ ] **Step 4: Verify concurrency and green**

Run: `pnpm --filter @delivery/api test -- rate-limit.test.ts --reporter=verbose`

Expected: every test PASSes repeatedly, including the last-slot race.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/security/rate-limit.ts apps/api/test/rate-limit.test.ts
git commit -m "feat(security): enforce atomic rate limits"
```

### Task 5: Implement stable HTTP errors and policy composition

**Files:**
- Create: `apps/api/src/security/http.ts`
- Create: `apps/api/src/middleware/rate-limit.ts`
- Modify: `apps/api/src/middleware/error-handler.ts`
- Modify: `apps/api/src/env.ts`
- Create: `apps/api/test/rate-limit-middleware.test.ts`

- [ ] **Step 1: Write failing middleware tests**

Build a small Hono app with a fake limiter and assert:

```ts
expect(response.status).toBe(429)
expect(response.headers.get('Retry-After')).toBe('42')
expect(await response.json()).toEqual({
  error: 'Muitas tentativas. Tente novamente mais tarde.',
  code: 'RATE_LIMITED',
})
```

Also assert multiple policies are consumed in their declared order, a rejection still records later long-window policies, and neither subjects nor scope internals appear in the response.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- rate-limit-middleware.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement errors and helpers**

```ts
export class SecurityHttpError extends Error {
  constructor(
    public status: 403 | 429 | 503,
    public code: 'RATE_LIMITED' | 'TURNSTILE_REQUIRED' | 'TURNSTILE_INVALID' | 'SECURITY_CHECK_UNAVAILABLE',
    message: string,
    public retryAfterSeconds?: number,
  ) { super(message) }
}
```

Update `errorHandler` to serialize `{ error, code }` and set a bounded `Retry-After` only for `SecurityHttpError`. Production helpers instantiate the limiter from the request database/env and the verifier through an exported factory. Middleware unit tests receive a limiter argument directly; route tests mock only the verifier factory while exercising the real PostgreSQL limiter. Do not add test-only bindings or mutable global service locators to production code.

Add `RATE_LIMIT_HMAC_SECRET`, `TURNSTILE_SECRET_KEY`, and `TURNSTILE_EXPECTED_HOSTNAMES` to `Env`. Helper construction must reject missing/blank values when used; do not silently reuse `JWT_SECRET`.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @delivery/api test -- rate-limit-middleware.test.ts && pnpm --filter @delivery/api typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/security/http.ts apps/api/src/middleware/rate-limit.ts apps/api/src/middleware/error-handler.ts apps/api/src/env.ts apps/api/test/rate-limit-middleware.test.ts
git commit -m "feat(api): return stable abuse errors"
```

### Task 6: Implement and validate Turnstile Siteverify

**Files:**
- Create: `apps/api/src/security/turnstile.ts`
- Create: `apps/api/test/turnstile.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Use an injected `fetch` spy. Assert the request posts `secret`, `response`, `remoteip`, and a UUID `idempotency_key`. Cover success, `success:false`, duplicate/timeout provider codes, wrong action, wrong hostname, challenge older than 300 seconds, challenge more than 30 seconds in the future, timeout abort, non-2xx, and malformed JSON. Add a local-only case accepting Cloudflare's official test response only when it contains `metadata.result_with_testing_key: true` and `hostname: example.com`; prove the same missing-action response fails in staging and production.

```ts
const verifier = new CloudflareTurnstileVerifier({
  secret: 'secret', expectedHostnames: ['localhost'], fetch: fetchSpy, timeoutMs: 3_000,
})
await expect(verifier.verify({ token: 'token', remoteIp: '127.0.0.1', action: 'register', now }))
  .resolves.toEqual({ valid: true })
```

Assert captured errors and serialized results never contain `secret` or `token`.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- turnstile.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the verifier**

Define:

```ts
export interface TurnstileVerifier {
  verify(input: { token: string; remoteIp: string; action: 'register' | 'login'; now?: Date }): Promise<void>
}
```

POST form-encoded data to `https://challenges.cloudflare.com/turnstile/v0/siteverify`, abort after 3 seconds, parse a strict Zod response, and throw `SecurityHttpError` with `TURNSTILE_INVALID` or `SECURITY_CHECK_UNAVAILABLE`. Map `invalid-input-response` and `timeout-or-duplicate` to invalid challenge; map `internal-error`, secret/configuration errors, malformed requests, unknown provider errors, transport failures, and malformed responses to unavailable. Require exact action, allowlisted hostname, and `challenge_ts` in `[now - 300s, now + 30s]`. The sole exception is `APP_ENV=local` plus Cloudflare's provider-owned testing marker and `example.com` hostname; it may omit action. Do not expose a bypass option.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @delivery/api test -- turnstile.test.ts && pnpm --filter @delivery/api typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/security/turnstile.ts apps/api/test/turnstile.test.ts
git commit -m "feat(security): verify Turnstile server-side"
```

### Task 7: Protect registration, login, and refresh

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/services/auth.service.ts`
- Modify: `apps/api/test/auth.routes.test.ts`
- Modify: `apps/api/test/auth.service.test.ts`

- [ ] **Step 1: Add failing auth route tests**

Use the real test-database limiter and mock the exported verifier factory. Test:

- registration consumes IP limits, verifies action `register`, then consumes identity limits;
- no account/provider/session is created after invalid or unavailable challenge;
- login IP limit runs before password work;
- after five failures the next attempt without a token returns `TURNSTILE_REQUIRED`;
- valid challenge permits the next credential attempt;
- tenth failure sets cooldown, the following request returns generic `429`, and success later clears identity state;
- unknown identity and wrong password return identical `401` JSON;
- refresh consumes IP and token-fingerprint policies before rotation;
- rate-limited refresh does not mark a token used or revoke its family;
- concurrent refresh-reuse regression remains green.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- auth.routes.test.ts auth.service.test.ts`

Expected: new tests FAIL; pre-existing rotation tests remain PASSing.

- [ ] **Step 3: Add constant-work unknown-user password verification**

Generate one valid PBKDF2 dummy hash using the existing password format and store it as a module constant, not at request time. Change login so unknown users and missing PASSWORD providers call `verifyPassword(input.password, DUMMY_PASSWORD_HASH)` before returning the same `AuthError('Credenciais inválidas', 401)`. Never create dummy users or sessions.

- [ ] **Step 4: Compose auth protections in route order**

Create `apps/api/src/security/auth-abuse.ts` with `protectRegistration`, `protectLogin`, `recordLoginFailure`, `clearLoginFailures`, and `protectRefresh`, keeping route orchestration separate from credentials. In `routes/auth.ts`, define the OpenAPI registration body as `RegisterSchema.extend({ turnstileToken: z.string().trim().min(1).max(2048) })` so the public route documents and validates the mandatory token while the reusable service type remains optional. Use:

```ts
await consumeAll(c, [POLICIES.registerIpHour, POLICIES.registerIpDay], ip)
await verifier.verify({ token: input.turnstileToken, remoteIp: ip, action: 'register' })
for (const identity of [input.phone, input.email].filter((value): value is string => Boolean(value))) {
  await consumeAll(c, [POLICIES.registerIdentityHour, POLICIES.registerIdentityDay], identity)
}
```

Registration consumes the already-normalized phone and, when provided, normalized email as independent identity subjects. For login, inspect failure policies before credentials; require challenge after count 5, enforce `blockedUntil`, record both failure windows only for invalid credentials, and clear them only after successful authentication. Strip `turnstileToken` before passing the input to service code if necessary; it must never be logged or persisted. Update affected route-test env fixtures with `APP_ENV: 'local'`, rate-limit secret, Turnstile test configuration, and an explicit local source; do not weaken production IP extraction for tests.

- [ ] **Step 5: Verify green and refresh invariants**

Run: `pnpm --filter @delivery/api test -- auth.routes.test.ts auth.service.test.ts security-session.service.test.ts`

Expected: PASS, including concurrent refresh reuse.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/services/auth.service.ts apps/api/src/security apps/api/test/auth.routes.test.ts apps/api/test/auth.service.test.ts
git commit -m "feat(auth): throttle credentials and refresh"
```

### Task 8: Protect order quotation and creation

**Files:**
- Modify: `apps/api/src/routes/orders.ts`
- Modify: `apps/api/test/orders.routes.test.ts`

- [ ] **Step 1: Write failing order abuse tests**

Create two CUSTOMER sessions and source IPs. Assert quote and creation have independent scopes, customers do not consume one another's principal quota, shared IP limits combine users, and `429` happens before `quoteOrder`, `createOrder`, or payment-provider invocation. Assert GET, cancel, and amendment endpoints do not consume these policies.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- orders.routes.test.ts`

Expected: new tests FAIL.

- [ ] **Step 3: Add route-specific protection**

After auth/RBAC and before service calls:

```ts
await consumeAll(c, [POLICIES.orderQuoteUserMinute, POLICIES.orderQuoteUserDay], c.get('auth')!.sub)
await consumeAll(c, [POLICIES.orderQuoteIpMinute], resolveClientIp(c.env.APP_ENV, c.req.raw.headers))
```

Use creation equivalents only in `POST /orders`. Do not place these limits on `orderRoutes.use('/orders/*', ...)`, which would accidentally throttle reads and decisions.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @delivery/api test -- orders.routes.test.ts order.service.test.ts payment.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orders.ts apps/api/test/orders.routes.test.ts
git commit -m "feat(orders): limit quotes and creation"
```

### Task 9: Protect public and private uploads before materialization

**Files:**
- Modify: `apps/api/src/routes/store-me.ts`
- Modify: `apps/api/src/routes/store-catalog.ts`
- Modify: `apps/api/src/routes/driver.ts`
- Modify: `apps/api/src/services/catalog.service.ts`
- Modify: `apps/api/test/catalog.service.test.ts`
- Modify: `apps/api/test/store-me.routes.test.ts`
- Modify: `apps/api/test/store-catalog.routes.test.ts`
- Modify: `apps/api/test/driver.routes.test.ts`

- [ ] **Step 1: Write failing upload ordering tests**

Use a request body stream whose read throws and an R2 spy. For each upload assert:

- wrong role or ownership failure precedes limiter and body read;
- an authorized but rate-limited request returns `429` without reading the body or calling `BUCKET.put`;
- logo, product photo, and return photo use distinct policies;
- users and IPs are independently isolated;
- an accepted request preserves existing size, type, attachment, and orphan cleanup behavior.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- store-me.routes.test.ts store-catalog.routes.test.ts driver.routes.test.ts`

Expected: new tests FAIL.

- [ ] **Step 3: Insert limits at the correct boundary**

For logo: load the owning store, validate declared content type, consume principal-purpose and IP policies, then read `arrayBuffer()`.

For product photo: resolve `ownStoreId`, add and call `assertOwnedProduct(db, storeId, productId)`, implemented as one `SELECT id FROM products WHERE id = ? AND store_id = ? LIMIT 1` that throws the existing generic `CatalogError`/404. Run this before consuming, then rate-limit and read. Do not let a store consume upload quota by probing another store's product ID. Cover this helper in `catalog.service.test.ts`.

For return evidence: validate UUID/type/declared length and call `getDriverPendingReturn` first; then consume driver and IP policies before reading the body.

```ts
await consumeAll(c, [POLICIES.returnUploadDriverHour, POLICIES.returnUploadDriverDay], driverId)
await consumeAll(c, [POLICIES.returnUploadIpHour], resolveClientIp(c.env.APP_ENV, c.req.raw.headers))
const body = await c.req.arrayBuffer()
```

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @delivery/api test -- store-me.routes.test.ts store-catalog.routes.test.ts driver.routes.test.ts catalog.service.test.ts media.test.ts returns.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/store-me.ts apps/api/src/routes/store-catalog.ts apps/api/src/routes/driver.ts apps/api/src/services/catalog.service.ts apps/api/test/store-me.routes.test.ts apps/api/test/store-catalog.routes.test.ts apps/api/test/driver.routes.test.ts apps/api/test/catalog.service.test.ts
git commit -m "feat(media): limit authenticated uploads"
```

### Task 10: Clean expired buckets with the existing cron

**Files:**
- Create: `apps/api/src/security/rate-limit-cleanup.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/cron.test.ts`

- [ ] **Step 1: Write failing cleanup tests**

Insert expired and live buckets. Assert a single call deletes at most 1,000 oldest expired rows, leaves live rows, returns the count, and a second call continues the bounded cleanup.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/api test -- cron.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement bounded deletion and schedule it**

```ts
export async function deleteExpiredRateLimitBuckets(db: Db, now = new Date(), limit = 1_000) {
  const rows = await db.execute(sql`
    DELETE FROM rate_limit_buckets
    WHERE (scope, key_hash, window_start) IN (
      SELECT scope, key_hash, window_start FROM rate_limit_buckets
      WHERE expires_at <= ${now}
      ORDER BY expires_at ASC LIMIT ${limit}
    )
    RETURNING scope
  `)
  return rows.length
}
```

Call it in `scheduled()` even if earlier business cleanup returns zero. Log only the deleted count. Keep the existing `finally { client.end() }` behavior.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @delivery/api test -- cron.test.ts rate-limit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/security/rate-limit-cleanup.ts apps/api/src/index.ts apps/api/test/cron.test.ts
git commit -m "feat(security): expire rate limit buckets"
```

### Task 11: Add the web Turnstile and adaptive auth UX

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/stores/auth.test.ts`
- Create: `apps/web/src/components/TurnstileWidget.vue`
- Create: `apps/web/src/components/TurnstileWidget.test.ts`
- Modify: `apps/web/src/views/LoginView.vue`
- Modify: `apps/web/src/views/RegisterView.vue`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Add test dependency and failing tests**

Run: `pnpm --filter @delivery/web add -D @vue/test-utils`

Extend API errors to test `{ status, message, code, retryAfter }`. Test store payloads include tokens. Mount the widget with a fake `window.turnstile` and assert it emits a token, emits expiry with `null`, and calls `reset`. Add a login-view test proving `TURNSTILE_REQUIRED` reveals the widget and a second submit includes the token while retaining the entered identifier.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @delivery/web test`

Expected: new tests FAIL.

- [ ] **Step 3: Preserve stable API error metadata**

```ts
export type ApiError = {
  status: number
  message: string
  code?: string
  retryAfter?: number
}
```

Parse `body.code` and integer `Retry-After`; never include request credentials in the error. Change store signatures to `login(identifier, password, turnstileToken?)` and `register({...input, turnstileToken})`.

- [ ] **Step 4: Implement the widget and views**

The component loads `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` once, renders with `import.meta.env.VITE_TURNSTILE_SITE_KEY`, accepts action `login | register`, emits `update:token`, and resets on expiration/error. Registration always renders action `register`. Login starts hidden and becomes required only when caught error code equals `TURNSTILE_REQUIRED`; other errors keep their current display. Disable submit when a visible/mandatory widget has no token.

- [ ] **Step 5: Verify green**

Run: `pnpm --filter @delivery/web test && pnpm --filter @delivery/web typecheck && pnpm --filter @delivery/web build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pnpm-lock.yaml apps/web/package.json apps/web/src
git commit -m "feat(web): add adaptive Turnstile auth"
```

### Task 12: Add the driver Turnstile and test infrastructure

**Files:**
- Modify: `apps/driver/package.json`
- Create: `apps/driver/vitest.config.ts`
- Modify: `apps/driver/src/lib/api.ts`
- Modify: `apps/driver/src/stores/auth.ts`
- Create: `apps/driver/src/stores/auth.test.ts`
- Create: `apps/driver/src/components/TurnstileWidget.vue`
- Create: `apps/driver/src/components/TurnstileWidget.test.ts`
- Modify: `apps/driver/src/views/LoginView.vue`
- Modify: `apps/driver/src/views/RegisterView.vue`

- [ ] **Step 1: Install the same focused test stack**

Run:

```bash
pnpm --filter @delivery/driver add -D vitest happy-dom @vue/test-utils
```

Add script `"test": "vitest run"` and config with Vue plugin plus `environment: 'happy-dom'`.

- [ ] **Step 2: Write failing driver tests**

Mirror the web contract tests while preserving driver-specific behavior: registration always sends role `DRIVER`; login challenge resubmission still rejects a non-DRIVER session and logs it out; tokens never enter localStorage unless a real session is returned.

- [ ] **Step 3: Verify red**

Run: `pnpm --filter @delivery/driver test`

Expected: FAIL.

- [ ] **Step 4: Implement driver integration**

Use the same API error fields and widget contract as Task 11. Registration always renders `register`; login reveals `login` only after `TURNSTILE_REQUIRED`. Do not persist Turnstile tokens, passwords, or identifiers.

- [ ] **Step 5: Verify green**

Run: `pnpm --filter @delivery/driver test && pnpm --filter @delivery/driver typecheck && pnpm --filter @delivery/driver build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pnpm-lock.yaml apps/driver/package.json apps/driver/vitest.config.ts apps/driver/src
git commit -m "feat(driver): add adaptive Turnstile auth"
```

### Task 13: Configure environments and document manual Cloudflare work

**Files:**
- Modify: `apps/api/wrangler.jsonc`
- Create or modify: `apps/api/.dev.vars.example`
- Create or modify: `apps/web/.env.example`
- Create or modify: `apps/driver/.env.example`
- Create: `docs/security/runbooks/sec-02-turnstile-waf.md`

- [ ] **Step 1: Add safe local examples**

Use Cloudflare's official always-pass test sitekey/secret values in examples only. Add:

```dotenv
# API .dev.vars.example
RATE_LIMIT_HMAC_SECRET=replace-with-at-least-32-random-bytes
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
TURNSTILE_EXPECTED_HOSTNAMES=example.com

# both frontend .env.example files
VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA
```

Do not modify the user's real `.dev.vars` or `.env` files and never commit real secrets. If `wrangler.jsonc` needs `TURNSTILE_EXPECTED_HOSTNAMES`, set only `example.com` for the official local test response; secrets stay out of it.

- [ ] **Step 2: Write the runbook**

Document exact manual gates:

1. Create separate staging and production Turnstile widgets.
2. Allow only the corresponding frontend hostnames.
3. Store Worker secrets with `wrangler secret put`.
4. Set frontend public sitekeys per environment.
5. Smoke-test success, expiry, replay, wrong action, and adaptive login.
6. While using `workers.dev`, keep private staging behind Cloudflare Access; do not claim a zone WAF rule exists.
7. After attaching a custom domain/zone, create the single Free WAF rate rule matching path `/auth/*`, 20 requests/IP/10 seconds, with Free-plan-supported challenge/throttling behavior.
8. Record rollback: disable the WAF rule first if false positives occur; do not disable the application limiter or Turnstile requirement.

- [ ] **Step 3: Verify no secrets and configuration compiles**

Run:

```bash
git grep -nE 'TURNSTILE_SECRET_KEY=|RATE_LIMIT_HMAC_SECRET=' -- ':!*.example' ':!docs/**'
pnpm --filter @delivery/api typecheck
```

Expected: grep returns no committed assignments; typecheck PASSes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/wrangler.jsonc apps/api/.dev.vars.example apps/web/.env.example apps/driver/.env.example docs/security/runbooks/sec-02-turnstile-waf.md
git commit -m "docs(security): add SEC-02 rollout runbook"
```

### Task 14: Run migration, regression, and security gates

**Files:**
- Modify if evidence requires: `docs/security/2026-07-11-backend-security-review.md`
- Modify if evidence requires: `docs/superpowers/specs/2026-07-11-security-remediation-design.md`

- [ ] **Step 1: Recreate the disposable local database**

After confirming the configured database is the local disposable development database:

```bash
pnpm --filter @delivery/api db:migrate
```

Expected: migration `0023_sec_02_rate_limits` applies successfully. Never run this command against staging/production in this task.

- [ ] **Step 2: Run focused security suites**

```bash
pnpm --filter @delivery/shared test -- auth.schema.test.ts
pnpm --filter @delivery/api test -- rate-limit-schema.test.ts rate-limit-key.test.ts client-ip.test.ts rate-limit.test.ts rate-limit-middleware.test.ts turnstile.test.ts auth.routes.test.ts auth.service.test.ts orders.routes.test.ts store-me.routes.test.ts store-catalog.routes.test.ts driver.routes.test.ts cron.test.ts
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
```

Expected: all PASS.

- [ ] **Step 3: Run the complete repository gate**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Perform adversarial checks**

Run integration tests repeatedly with concurrency enabled and verify:

- exactly one final slot is accepted;
- raw test IP/email/phone/token strings are absent from `rate_limit_buckets`;
- `X-Forwarded-For` spoofing does not change the production key;
- `429` never invokes PBKDF2/provider/R2 work that should have been skipped;
- the tenth bad password returns generic `401`, the following attempt returns bounded `429`;
- a successful login clears identity failures but not shared-IP traffic counters;
- Turnstile replay is rejected by the adapter contract;
- refresh reuse still revokes the full family.

- [ ] **Step 5: Update security evidence accurately**

Mark SEC-02 as remediated in code for auth, refresh, orders, and uploads. Explicitly retain:

- WAF activation pending a user-controlled Cloudflare zone;
- webhook anti-replay/rate controls pending SEC-08;
- identity verification/recovery counters pending SEC-03;
- live Turnstile staging smoke tests pending staging provisioning.

Do not state that the complete security audit is resolved.

- [ ] **Step 6: Commit the gate evidence**

```bash
git add docs/security/2026-07-11-backend-security-review.md docs/superpowers/specs/2026-07-11-security-remediation-design.md
git commit -m "docs(security): record SEC-02 verification"
```

## Final manual acceptance checklist

- [ ] Registration cannot submit without a completed challenge.
- [ ] Five failed logins make the next attempt request Turnstile without losing the entered identifier.
- [ ] Ten failures create a 15-minute cooldown; no permanent account lockout occurs.
- [ ] Shared-IP users remain usable below the auxiliary IP thresholds.
- [ ] `Retry-After` is displayed and bounded.
- [ ] Order quotation, order creation, logo, product photo, and return photo limits are independent.
- [ ] A rejected upload does not read the body or create an R2 object.
- [ ] Staging/production reject missing trusted IP or missing security configuration.
- [ ] Local development works using official Cloudflare test keys without a bypass flag.
- [ ] No webhook behavior changed.
- [ ] Worktree is clean after all planned commits.

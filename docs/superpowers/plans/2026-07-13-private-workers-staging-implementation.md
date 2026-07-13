# Private Workers Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents unless the user explicitly changes the current no-subagent preference.

**Goal:** Deploy and validate a private staging environment for API, web, and driver on `workers.dev`, backed by Neon/Hyperdrive and R2, with Resend owner-only email, Turnstile, and Cloudflare Access.

**Architecture:** Keep the top-level Wrangler configuration local and add a named `staging` environment to each Worker. Cloudflare Access protects the three exact staging hostnames; frontend requests carry the Access cookie while Hono continues enforcing exact credentialed CORS and application JWT/RBAC. External setup remains fail-closed and follows local TDD, dry runs, database least privilege, then constrained smoke tests.

**Tech Stack:** TypeScript 6, Hono 4, Vue 3, Vite 8, Vitest 4, Wrangler 4, Cloudflare Workers/Access/R2/Turnstile/Hyperdrive, Neon PostgreSQL 17, Drizzle, Resend.

## Global Constraints

- Work task-by-task, review each diff, run its focused tests, then commit before continuing.
- Use an isolated worktree for implementation. No push.
- Preserve the intent of the existing dirty `apps/api/wrangler.jsonc`: R2 bucket `delivo-media-staging` and Hyperdrive ID `ee44ff9aa75d4b57826982d04a569c1d`; discard only the incorrect binding placement/names.
- Never commit or print secrets, database URLs, email allowlists, verification codes, tickets, passwords, JWTs, refresh tokens, Access cookies, or provider response bodies.
- Do not use the leaked Neon owner password or leaked Resend key. Replacement values enter only through provider dashboards or interactive prompts.
- Keep base Wrangler behavior local. Staging bindings must use the application names `BUCKET` and `HYPERDRIVE`.
- Worker names are exactly `delivery-api-staging`, `delivery-web-staging`, and `delivery-driver-staging`.
- Staging URLs are exactly:
  - `https://delivery-api-staging.otavio-marques20.workers.dev`
  - `https://delivery-web-staging.otavio-marques20.workers.dev`
  - `https://delivery-driver-staging.otavio-marques20.workers.dev`
- Access uses one multi-domain self-hosted application, email one-time PIN, the two approved pilot identities held outside Git, and a 24-hour session.
- Resend staging uses `Delivery staging <onboarding@resend.dev>` and only the account-owner recipient held as Worker secret.
- Preview URLs remain disabled; no unprotected alternate Worker URL.
- Hyperdrive cache remains disabled, TLS remains `require`, origin connection limit remains five, and runtime DB role is `delivo_app_staging`.
- No Access bypass is created in this plan. Mercado Pago, Firebase, Google OAuth, unrestricted email, and STORE activation are outside this smoke.
- Do not reopen `/docs`, `/openapi.json`, or `/health/db` outside local.
- No down migration. Staging DB is disposable and may be recreated only after an explicit destructive-action confirmation.

## Execution Preflight

Before Task 1:

1. Save the current user diff outside Git:

   ```bash
   git diff -- apps/api/wrangler.jsonc > /tmp/delivery-staging-wrangler-user.patch
   git status --short
   ```

2. Verify the saved diff contains only the known CLI formatting plus staging R2/Hyperdrive edits. Use `apply_patch` to restore `apps/api/wrangler.jsonc` to `HEAD` without touching another file. Confirm `/tmp/delivery-staging-wrangler-user.patch` exists and is non-empty.
3. Create branch `feat/private-workers-staging` in an isolated `.worktrees/private-workers-staging` worktree using `superpowers:using-git-worktrees`.
4. Install dependencies with `pnpm install --frozen-lockfile` and run `pnpm test`. Stop if baseline fails.

---

## Stage 1 — Repository and browser boundary

### Task 1: Harden ignored environment files

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: existing `.env.example` and `.dev.vars.example` tracked templates.
- Produces: ignore rules that cover every real dotenv/dev-vars variant while keeping templates trackable.

- [ ] **Step 1: Prove current ignore gap**

  Run:

  ```bash
  git check-ignore -q apps/api/.dev.vars.staging
  git check-ignore -q apps/web/.env.staging
  ```

  Expected: both commands return non-zero before the fix.

- [ ] **Step 2: Replace exact-file rules with safe families**

  Keep existing unrelated entries and replace `.dev.vars` / `.env` with:

  ```gitignore
  .dev.vars*
  !.dev.vars.example
  !.dev.vars.*.example
  .env*
  !.env.example
  !.env.*.example
  ```

- [ ] **Step 3: Verify secrets are ignored and templates are not**

  Run:

  ```bash
  git check-ignore -q apps/api/.dev.vars.staging
  git check-ignore -q apps/web/.env.staging
  git check-ignore -q apps/driver/.env.staging.local
  ! git check-ignore -q apps/api/.dev.vars.example
  ! git check-ignore -q apps/web/.env.staging.example
  git diff --check
  ```

  Expected: all commands succeed.

- [ ] **Step 4: Commit**

  ```bash
  git add .gitignore
  git commit -m "chore(security): ignore environment variants"
  ```

### Task 2: Enable exact credentialed CORS in the API

**Files:**
- Modify: `apps/api/test/health.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: comma-separated `Env.ALLOWED_ORIGINS`.
- Produces: allowed origins receive `Access-Control-Allow-Origin` plus `Access-Control-Allow-Credentials: true`; unknown origins remain unauthorized.

- [ ] **Step 1: Add failing preflight tests**

  Extend `describe('cors allowlist')`:

  ```ts
  it('allows credentialed preflight only for a configured origin', async () => {
    const res = await app.request('/auth/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      },
    }, env)

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  it('never authorizes credentialed CORS for an unknown origin', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'https://evil.example' },
    }, env)

    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
  ```

- [ ] **Step 2: Run focused test and verify RED**

  ```bash
  pnpm --filter @delivery/api test -- health.test.ts
  ```

  Expected: first new test fails because `access-control-allow-credentials` is absent.

- [ ] **Step 3: Enable Hono credentialed CORS**

  In `apps/api/src/app.ts`, add the explicit option:

  ```ts
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  })(c, next)
  ```

- [ ] **Step 4: Run focused and API tests**

  ```bash
  pnpm --filter @delivery/api test -- health.test.ts
  pnpm --filter @delivery/api test
  ```

  Expected: both pass.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/api/src/app.ts apps/api/test/health.test.ts
  git commit -m "fix(api): allow credentialed staging CORS"
  ```

### Task 3: Send Access cookies from both frontend clients

**Files:**
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/driver/src/lib/api.test.ts`
- Modify: `apps/driver/src/lib/api.ts`

**Interfaces:**
- Consumes: existing `api<T>(path, init, retried)` wrapper.
- Produces: every wrapper request and refresh retry forces `credentials: 'include'`; callers cannot downgrade it with `credentials: 'omit'`.

- [ ] **Step 1: Add the same failing contract test to web and driver**

  Add inside each existing API describe block:

  ```ts
  it('always includes Cloudflare Access cookies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/health', { credentials: 'omit' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/health',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
  ```

  Add `vi.unstubAllGlobals()` to each `beforeEach` after `vi.restoreAllMocks()`.

- [ ] **Step 2: Run both focused suites and verify RED**

  ```bash
  pnpm --filter @delivery/web test -- src/lib/api.test.ts
  pnpm --filter @delivery/driver test -- src/lib/api.test.ts
  ```

  Expected: both fail because caller-provided `omit` is retained.

- [ ] **Step 3: Force credentials after spreading caller input**

  Replace the fetch line in both wrappers with:

  ```ts
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  })
  ```

- [ ] **Step 4: Run focused and frontend suites**

  ```bash
  pnpm --filter @delivery/web test -- src/lib/api.test.ts
  pnpm --filter @delivery/driver test -- src/lib/api.test.ts
  pnpm --filter @delivery/web test
  pnpm --filter @delivery/driver test
  ```

  Expected: all pass.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/driver/src/lib/api.ts apps/driver/src/lib/api.test.ts
  git commit -m "fix(frontend): include Access cookies"
  ```

### Task 4: Fail staging builds closed on missing public configuration

**Files:**
- Create: `packages/shared/src/staging-env.ts`
- Create: `packages/shared/src/staging-env.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/driver/vite.config.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/driver/package.json`
- Create: `apps/web/.env.staging.example`
- Create: `apps/driver/.env.staging.example`

**Interfaces:**
- Produces: `assertStagingPublicEnv(mode, env, requirements): void`, where each requirement is `non-empty` or `workers-url`.
- Produces: `build:staging` and `deploy:staging` scripts using Vite mode `staging`.

- [ ] **Step 1: Write failing shared tests**

  ```ts
  import { describe, expect, it } from 'vitest'
  import { assertStagingPublicEnv } from './staging-env'

  const requirements = {
    VITE_API_URL: 'workers-url',
    VITE_TURNSTILE_SITE_KEY: 'non-empty',
  } as const

  describe('assertStagingPublicEnv', () => {
    it('does nothing outside staging', () => {
      expect(() => assertStagingPublicEnv('production', {}, requirements)).not.toThrow()
    })

    it('rejects missing values and non-workers HTTPS origins', () => {
      expect(() => assertStagingPublicEnv('staging', {}, requirements)).toThrow(/VITE_API_URL/)
      expect(() => assertStagingPublicEnv('staging', {
        VITE_API_URL: 'http://localhost:8787',
        VITE_TURNSTILE_SITE_KEY: 'site-key',
      }, requirements)).toThrow(/workers.dev/)
    })

    it('accepts complete workers.dev configuration', () => {
      expect(() => assertStagingPublicEnv('staging', {
        VITE_API_URL: 'https://delivery-api-staging.otavio-marques20.workers.dev',
        VITE_TURNSTILE_SITE_KEY: 'site-key',
      }, requirements)).not.toThrow()
    })
  })
  ```

- [ ] **Step 2: Verify RED**

  ```bash
  pnpm --filter @delivery/shared test -- staging-env.test.ts
  ```

  Expected: module/function missing.

- [ ] **Step 3: Implement the pure validator and export it**

  ```ts
  export type StagingEnvRequirement = 'non-empty' | 'workers-url'

  export function assertStagingPublicEnv(
    mode: string,
    env: Record<string, string>,
    requirements: Readonly<Record<string, StagingEnvRequirement>>,
  ): void {
    if (mode !== 'staging') return

    for (const [key, requirement] of Object.entries(requirements)) {
      const value = env[key]?.trim()
      if (!value) throw new Error(`Missing staging environment variable: ${key}`)
      if (requirement !== 'workers-url') continue

      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new Error(`Invalid staging workers.dev URL: ${key}`)
      }
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev')
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error(`Invalid staging workers.dev URL: ${key}`)
      }
    }
  }
  ```

  Export it from `packages/shared/src/index.ts`:

  ```ts
  export * from './staging-env'
  ```

- [ ] **Step 4: Gate both Vite staging builds**

  Replace `apps/web/vite.config.ts` with:

  ```ts
  import { assertStagingPublicEnv } from '@delivery/shared'
  import { defineConfig, loadEnv } from 'vite'
  import vue from '@vitejs/plugin-vue'
  import tailwindcss from '@tailwindcss/vite'

  export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), 'VITE_')
    assertStagingPublicEnv(mode, env, {
      VITE_API_URL: 'workers-url',
      VITE_TURNSTILE_SITE_KEY: 'non-empty',
    })
    return { plugins: [vue(), tailwindcss()] }
  })
  ```

  Replace `apps/driver/vite.config.ts` with:

  ```ts
  import { assertStagingPublicEnv } from '@delivery/shared'
  import { defineConfig, loadEnv } from 'vite'
  import vue from '@vitejs/plugin-vue'
  import tailwindcss from '@tailwindcss/vite'

  export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), 'VITE_')
    assertStagingPublicEnv(mode, env, {
      VITE_API_URL: 'workers-url',
      VITE_PUBLIC_WEB_URL: 'workers-url',
      VITE_TURNSTILE_SITE_KEY: 'non-empty',
    })
    return { plugins: [vue(), tailwindcss()] }
  })
  ```

- [ ] **Step 5: Add scripts and safe templates**

  Add to both frontend packages:

  ```json
  "build:staging": "vue-tsc -b && vite build --mode staging",
  "deploy:staging": "pnpm build:staging && wrangler deploy --env staging"
  ```

  `apps/web/.env.staging.example`:

  ```dotenv
  VITE_API_URL=https://delivery-api-staging.otavio-marques20.workers.dev
  VITE_MP_PUBLIC_KEY=
  VITE_TURNSTILE_SITE_KEY=
  ```

  `apps/driver/.env.staging.example`:

  ```dotenv
  VITE_API_URL=https://delivery-api-staging.otavio-marques20.workers.dev
  VITE_PUBLIC_WEB_URL=https://delivery-web-staging.otavio-marques20.workers.dev
  VITE_TURNSTILE_SITE_KEY=
  VITE_FIREBASE_API_KEY=
  VITE_FIREBASE_PROJECT_ID=
  VITE_FIREBASE_SENDER_ID=
  VITE_FIREBASE_APP_ID=
  VITE_FIREBASE_VAPID_KEY=
  ```

- [ ] **Step 6: Verify validator and expected build failure**

  ```bash
  pnpm --filter @delivery/shared test -- staging-env.test.ts
  pnpm --filter @delivery/web build:staging
  pnpm --filter @delivery/driver build:staging
  ```

  Expected: shared test passes; staging builds fail closed on missing `VITE_TURNSTILE_SITE_KEY` until Task 6 creates local ignored files.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/shared/src apps/web/vite.config.ts apps/driver/vite.config.ts apps/web/package.json apps/driver/package.json apps/web/.env.staging.example apps/driver/.env.staging.example
  git commit -m "build(staging): validate public frontend env"
  ```

### Task 5: Add exact named Worker environments and generated binding types

**Files:**
- Modify: `apps/api/wrangler.jsonc`
- Modify: `apps/web/wrangler.jsonc`
- Modify: `apps/driver/wrangler.jsonc`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/tsconfig.json`
- Generate: `apps/api/worker-configuration.d.ts`

**Interfaces:**
- Produces: exact staging `BUCKET`/`HYPERDRIVE` bindings and public API vars.
- Produces: generated `CloudflareBindings`; application `Env` selects `BUCKET` and `HYPERDRIVE` from it.

- [ ] **Step 1: Verify named environment is absent**

  ```bash
  pnpm --dir apps/api exec wrangler deploy --env staging --dry-run
  ```

  Expected: warning/error that environment `staging` is not defined.

- [ ] **Step 2: Normalize API base config and add `env.staging`**

  Restore the base R2 list to only `{ "binding": "BUCKET", "bucket_name": "delivo-media" }` and base Hyperdrive to ID `00000000000000000000000000000000` plus local connection string. Add:

  ```jsonc
  "env": {
    "staging": {
      "workers_dev": true,
      "preview_urls": false,
      "triggers": { "crons": ["*/5 * * * *"] },
      "vars": {
        "APP_ENV": "staging",
        "ALLOWED_ORIGINS": "https://delivery-web-staging.otavio-marques20.workers.dev,https://delivery-driver-staging.otavio-marques20.workers.dev",
        "TURNSTILE_EXPECTED_HOSTNAMES": "delivery-web-staging.otavio-marques20.workers.dev,delivery-driver-staging.otavio-marques20.workers.dev",
        "EMAIL_FROM": "Delivery staging <onboarding@resend.dev>",
        "PUBLIC_WEB_URL": "https://delivery-web-staging.otavio-marques20.workers.dev",
        "PUBLIC_API_URL": "https://delivery-api-staging.otavio-marques20.workers.dev",
        "MP_PUBLIC_KEY": ""
      },
      "r2_buckets": [
        { "binding": "BUCKET", "bucket_name": "delivo-media-staging" }
      ],
      "hyperdrive": [
        { "binding": "HYPERDRIVE", "id": "ee44ff9aa75d4b57826982d04a569c1d" }
      ]
    }
  }
  ```

  Do not add `EMAIL_ALLOWED_RECIPIENTS` under `vars`.

- [ ] **Step 3: Add named environments to static Workers**

  Add to both web and driver Wrangler files:

  ```jsonc
  "env": {
    "staging": {
      "workers_dev": true,
      "preview_urls": false
    }
  }
  ```

- [ ] **Step 4: Generate and consume binding types**

  Set the API script:

  ```json
  "cf-typegen": "wrangler types worker-configuration.d.ts --env staging --env-interface CloudflareBindings --strict-vars=false --include-runtime=false"
  ```

  Generate it:

  ```bash
  pnpm --filter @delivery/api cf-typegen
  ```

  Add `worker-configuration.d.ts` to API `tsconfig.json` includes. In `src/env.ts`, replace handwritten platform bindings with:

  ```ts
  type PlatformBindings = Pick<CloudflareBindings, 'HYPERDRIVE' | 'BUCKET'>

  export type Env = PlatformBindings & {
    APP_ENV: 'local' | 'staging' | 'production'
    JWT_SECRET: string
    RATE_LIMIT_HMAC_SECRET: string
    TURNSTILE_SECRET_KEY: string
    TURNSTILE_EXPECTED_HOSTNAMES: string
    ALLOWED_ORIGINS: string
    RESEND_API_KEY?: string
    AUTH_CODE_SECRET?: string
    EMAIL_FROM?: string
    PUBLIC_WEB_URL?: string
    EMAIL_ALLOWED_RECIPIENTS?: string
    FIREBASE_PROJECT_ID?: string
    FIREBASE_SERVICE_ACCOUNT?: string
    MP_ACCESS_TOKEN?: string
    MP_PUBLIC_KEY?: string
    MP_WEBHOOK_SECRET?: string
    MP_TEST_PAYER_EMAIL?: string
    PUBLIC_API_URL?: string
  }
  ```

  Preserve existing comments on Mercado Pago fields.

- [ ] **Step 5: Validate config locally**

  ```bash
  pnpm --filter @delivery/api cf-typegen
  pnpm --filter @delivery/api typecheck
  pnpm --dir apps/api exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-api-staging-dry
  pnpm --dir apps/web exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-web-staging-dry
  pnpm --dir apps/driver exec wrangler deploy --env staging --dry-run --outdir /tmp/delivery-driver-staging-dry
  ```

  Expected: API typecheck and all dry runs pass. Static dry runs may use the last local `dist`; real staging builds are gated in Task 6.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/api/wrangler.jsonc apps/web/wrangler.jsonc apps/driver/wrangler.jsonc apps/api/package.json apps/api/src/env.ts apps/api/tsconfig.json apps/api/worker-configuration.d.ts
  git commit -m "build(staging): add named Worker environments"
  ```

---

## Stage 2 — External resources and private deploy

### Task 6: Create Turnstile and Access boundaries before functional deploy

**Files:**
- Create locally, never commit: `apps/web/.env.staging.local`
- Create locally, never commit: `apps/driver/.env.staging.local`

**Interfaces:**
- Consumes: exact three staging hostnames.
- Produces: Managed Turnstile sitekey/secret and one default-deny multi-domain Access application.

- [ ] **Step 1: Create Turnstile widget manually**

  In Cloudflare Turnstile, create `delivery-staging`, mode Managed, with exactly:

  ```text
  delivery-web-staging.otavio-marques20.workers.dev
  delivery-driver-staging.otavio-marques20.workers.dev
  ```

  Keep the sitekey available for local public config. Store the secret only in the password manager until Task 8.

- [ ] **Step 2: Create ignored frontend staging files**

  Copy each `.env.staging.example` to `.env.staging.local`, set the same Turnstile sitekey in both, and leave optional MP/Firebase fields empty. Verify:

  ```bash
  git check-ignore -q apps/web/.env.staging.local
  git check-ignore -q apps/driver/.env.staging.local
  pnpm --filter @delivery/web build:staging
  pnpm --filter @delivery/driver build:staging
  ```

  Expected: files are ignored and both builds pass.

- [ ] **Step 3: Create one Access application manually**

  In Zero Trust, create self-hosted application `delivery-staging` with the exact three domains, 24-hour session, and one Allow policy using only the two approved individual emails. Enable email one-time PIN. Do not use `Everyone`, email-domain matching, wildcard hostnames, Bypass, or Service Auth.

  If Cloudflare refuses a hostname before its Worker exists, stop this step. Deploy only an initial secretless version against the still-empty database, immediately attach Access to all three hostnames, verify unauthenticated curl is intercepted, then resume Task 7. Do not migrate Neon or register secrets before Access is confirmed.

- [ ] **Step 4: Configure Access CORS**

  Under the application's Advanced settings → CORS, enable **Bypass OPTIONS requests to origin**. Confirm the application has three concrete domains so Access preemptively issues all three authorization cookies.

- [ ] **Step 5: Verify public configuration contains no secret**

  ```bash
  git status --short
  rg -n 'TURNSTILE_SECRET|RESEND_API|JWT_SECRET|AUTH_CODE_SECRET|RATE_LIMIT_HMAC' apps/web/.env.staging.local apps/driver/.env.staging.local
  ```

  Expected: ignored files absent from Git status; secret-name search has no matches.

### Task 7: Migrate Neon and enforce runtime least privilege

**Files:**
- Create: `apps/api/scripts/grant-staging-runtime.sql`
- Create: `apps/api/scripts/verify-staging-runtime.sql`

**Interfaces:**
- Consumes: empty `neondb`, owner direct connection for migrations, role `delivo_app_staging` created with a new password.
- Produces: runtime DML access without DDL/ownership/admin membership; future owner-created tables/sequences receive the same DML grants.

- [ ] **Step 1: Write grant and verification scripts**

  `grant-staging-runtime.sql` must fail if the role is absent or privileged, then revoke direct grants and grant only CONNECT, schema USAGE, table DML, and sequence USAGE/SELECT. It must also set matching owner default privileges:

  ```sql
  \set ON_ERROR_STOP on
  \if :{?migration_owner}
  \else
  \set migration_owner neondb_owner
  \endif
  BEGIN;
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'delivo_app_staging') THEN
      RAISE EXCEPTION 'delivo_app_staging role is missing';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
      WHERE member.rolname = 'delivo_app_staging' AND parent.rolname = 'neon_superuser'
    ) THEN
      RAISE EXCEPTION 'delivo_app_staging must not inherit neon_superuser';
    END IF;
  END $$;
  ALTER ROLE delivo_app_staging NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM delivo_app_staging', current_database()) \gexec
  SELECT format('GRANT CONNECT ON DATABASE %I TO delivo_app_staging', current_database()) \gexec
  REVOKE ALL PRIVILEGES ON SCHEMA public FROM delivo_app_staging;
  GRANT USAGE ON SCHEMA public TO delivo_app_staging;
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM delivo_app_staging;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO delivo_app_staging;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM delivo_app_staging;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO delivo_app_staging;
  ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO delivo_app_staging;
  ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO delivo_app_staging;
  COMMIT;
  ```

  `verify-staging-runtime.sql`:

  ```sql
  \set ON_ERROR_STOP on
  DO $$
  DECLARE
    runtime_oid oid;
  BEGIN
    SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname = 'delivo_app_staging';
    IF runtime_oid IS NULL THEN
      RAISE EXCEPTION 'delivo_app_staging role is missing';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_roles
      WHERE oid = runtime_oid
        AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    ) THEN
      RAISE EXCEPTION 'delivo_app_staging has unsafe role attributes';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid = m.roleid
      WHERE m.member = runtime_oid AND parent.rolname = 'neon_superuser'
    ) THEN
      RAISE EXCEPTION 'delivo_app_staging inherits neon_superuser';
    END IF;
    IF NOT has_database_privilege('delivo_app_staging', current_database(), 'CONNECT')
      OR has_database_privilege('delivo_app_staging', current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'unsafe database privileges';
    END IF;
    IF NOT has_schema_privilege('delivo_app_staging', 'public', 'USAGE')
      OR has_schema_privilege('delivo_app_staging', 'public', 'CREATE') THEN
      RAISE EXCEPTION 'unsafe schema privileges';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relowner = runtime_oid
    ) THEN
      RAISE EXCEPTION 'runtime role owns database objects';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND NOT (
          has_table_privilege('delivo_app_staging', c.oid, 'SELECT')
          AND has_table_privilege('delivo_app_staging', c.oid, 'INSERT')
          AND has_table_privilege('delivo_app_staging', c.oid, 'UPDATE')
          AND has_table_privilege('delivo_app_staging', c.oid, 'DELETE')
        )
    ) THEN
      RAISE EXCEPTION 'runtime DML grant missing';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND (
          has_table_privilege('delivo_app_staging', c.oid, 'TRUNCATE')
          OR has_table_privilege('delivo_app_staging', c.oid, 'REFERENCES')
          OR has_table_privilege('delivo_app_staging', c.oid, 'TRIGGER')
        )
    ) THEN
      RAISE EXCEPTION 'runtime has elevated table privileges';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S'
        AND NOT (
          has_sequence_privilege('delivo_app_staging', c.oid, 'USAGE')
          AND has_sequence_privilege('delivo_app_staging', c.oid, 'SELECT')
        )
    ) THEN
      RAISE EXCEPTION 'runtime sequence grant missing';
    END IF;
  END $$;
  ```

- [ ] **Step 2: Test scripts against disposable local PostgreSQL role**

  ```bash
  docker compose exec -T postgres psql -U postgres -d delivery -c "DROP ROLE IF EXISTS delivo_app_staging; CREATE ROLE delivo_app_staging LOGIN;"
  docker compose exec -T postgres psql -U postgres -d delivery -v migration_owner=postgres < apps/api/scripts/grant-staging-runtime.sql
  docker compose exec -T postgres psql -U postgres -d delivery < apps/api/scripts/verify-staging-runtime.sql
  docker compose exec -T postgres psql -U postgres -d delivery -c "DROP OWNED BY delivo_app_staging; DROP ROLE delivo_app_staging;"
  ```

  Expected: both scripts succeed; verification emits no sensitive data.

- [ ] **Step 3: Commit scripts before external execution**

  ```bash
  git add apps/api/scripts/grant-staging-runtime.sql apps/api/scripts/verify-staging-runtime.sql
  git commit -m "chore(db): define staging runtime grants"
  ```

- [ ] **Step 4: Apply migrations manually with hidden owner URL**

  From a private terminal, run:

  ```bash
  set +o history
  read -rsp 'Neon owner direct URL: ' DATABASE_URL && printf '\n'
  export DATABASE_URL
  pnpm --filter @delivery/api db:migrate
  unset DATABASE_URL
  set -o history
  ```

  Expected: migrations `0000` through `0025` apply. Never use the `-pooler` URL and never pass the URL as a command argument.

- [ ] **Step 5: Create and constrain runtime role**

  Create `delivo_app_staging` with a new random password using Neon role management. Then run the tracked psql scripts from a private terminal; they contain psql meta-commands and must not be pasted into the Neon SQL editor:

  ```bash
  set +o history
  export PGHOST=ep-soft-water-ac535kwv.sa-east-1.aws.neon.tech
  export PGPORT=5432
  export PGDATABASE=neondb
  export PGUSER=neondb_owner
  export PGSSLMODE=require
  read -rsp 'Neon owner password: ' PGPASSWORD && printf '\n'
  export PGPASSWORD
  psql -c 'REVOKE neon_superuser FROM delivo_app_staging'
  psql -v migration_owner=neondb_owner -f apps/api/scripts/grant-staging-runtime.sql
  psql -f apps/api/scripts/verify-staging-runtime.sql
  unset PGPASSWORD PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE
  set -o history
  ```

  Expected: role membership is absent and both scripts succeed. Stop on any assertion failure.

- [ ] **Step 6: Update and verify Hyperdrive manually**

  Update Hyperdrive `delivery-db-staging` to the direct Neon hostname, database `neondb`, runtime user `delivo_app_staging`, its new password, port 5432, and TLS required. Then run:

  ```bash
  pnpm --dir apps/api exec wrangler hyperdrive get ee44ff9aa75d4b57826982d04a569c1d
  ```

  Expected: user `delivo_app_staging`, direct host without `-pooler`, database `neondb`, connection limit 5, cache disabled, `sslmode=require`. Output must not contain password.

### Task 8: Deploy behind Access and register staging secrets

**Files:**
- No tracked source changes.

**Interfaces:**
- Consumes: Access app, migrated Neon, runtime Hyperdrive, Turnstile widget, R2 bucket, fresh Resend sending-only key.
- Produces: three private Worker deployments and six API secret bindings.

- [ ] **Step 1: Run full local gate and final dry runs**

  ```bash
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm build
  pnpm --filter @delivery/web build:staging
  pnpm --filter @delivery/driver build:staging
  pnpm --dir apps/api exec wrangler deploy --env staging --dry-run
  pnpm --dir apps/web exec wrangler deploy --env staging --dry-run
  pnpm --dir apps/driver exec wrangler deploy --env staging --dry-run
  ```

  Expected: all pass.

- [ ] **Step 2: Deploy API inert version and verify Access first**

  ```bash
  pnpm --dir apps/api exec wrangler deploy --env staging
  curl -sS -o /dev/null -w '%{http_code}\n' https://delivery-api-staging.otavio-marques20.workers.dev/health
  ```

  Expected: unauthenticated curl is intercepted by Access, normally 302 or 403; it must not return API `200`.

- [ ] **Step 3: Register independent secrets interactively**

  Run each command separately and paste only into Wrangler's hidden prompt:

  ```bash
  pnpm --dir apps/api exec wrangler secret put JWT_SECRET --env staging
  pnpm --dir apps/api exec wrangler secret put RATE_LIMIT_HMAC_SECRET --env staging
  pnpm --dir apps/api exec wrangler secret put AUTH_CODE_SECRET --env staging
  pnpm --dir apps/api exec wrangler secret put RESEND_API_KEY --env staging
  pnpm --dir apps/api exec wrangler secret put TURNSTILE_SECRET_KEY --env staging
  pnpm --dir apps/api exec wrangler secret put EMAIL_ALLOWED_RECIPIENTS --env staging
  pnpm --dir apps/api exec wrangler secret list --env staging
  ```

  Use independent random values of at least 32 bytes for the first three cryptographic secrets. `EMAIL_ALLOWED_RECIPIENTS` contains only the Resend owner mailbox. Expected list contains exactly the six names above; values never appear.

- [ ] **Step 4: Redeploy API and deploy static Workers**

  ```bash
  pnpm --dir apps/api exec wrangler deploy --env staging
  pnpm --filter @delivery/web deploy:staging
  pnpm --filter @delivery/driver deploy:staging
  ```

  Expected: exact three approved URLs. Immediately repeat unauthenticated curl against all three; none may return application `200`.

- [ ] **Step 5: Verify versions/resources without secrets**

  ```bash
  pnpm --dir apps/api exec wrangler versions list --env staging
  pnpm --dir apps/api exec wrangler r2 bucket info delivo-media-staging
  pnpm --dir apps/api exec wrangler hyperdrive get ee44ff9aa75d4b57826982d04a569c1d
  ```

  Record only Worker version IDs and resource names.

---

## Stage 3 — Allowlisted smoke and evidence

### Task 9: Execute private CUSTOMER/recovery, R2, and negative smoke

**Files:**
- Modify: `docs/security/runbooks/sec-03a-resend-identity.md`
- Create: `docs/security/runbooks/private-workers-staging.md`

**Interfaces:**
- Produces: sanitized PASS/FAIL evidence with no PII/secrets.

- [ ] **Step 1: Verify Access policy manually**

  In separate clean browser sessions: approved identity completes OTP once and reaches all three domains without a second OTP; a non-approved identity is denied. Verify API requests from web/driver succeed past Access and show `credentials: include` in DevTools.

- [ ] **Step 2: Run CUSTOMER identity smoke**

  With only the Resend owner mailbox: register CUSTOMER, inspect generic `202`, receive styled six-digit code, verify, login, resend after cooldown, reject previous code, recover password with Turnstile, and confirm old access/refresh sessions fail immediately. Never copy codes/tickets/tokens into evidence.

- [ ] **Step 3: Run security negatives**

  Verify invalid/replayed Turnstile fails, non-owner recipient receives no email, unauthenticated curl stays behind Access, `/docs`, `/openapi.json`, and `/health/db` return application 404 after authorized access, and an unknown CORS origin has no `Access-Control-Allow-Origin` in automated evidence.

- [ ] **Step 4: Verify R2 through the Worker and clean up**

  Create a temporary random payload and key, upload it directly, then fetch the same key through the authorized API in browser DevTools:

  ```bash
  SMOKE_FILE=$(mktemp)
  SMOKE_KEY="smoke/$(openssl rand -hex 16).txt"
  openssl rand -hex 32 > "$SMOKE_FILE"
  pnpm --dir apps/api exec wrangler r2 object put "delivo-media-staging/$SMOKE_KEY" --file "$SMOKE_FILE"
  printf 'R2 smoke key: %s\n' "$SMOKE_KEY"
  ```

  Fetch `https://delivery-api-staging.otavio-marques20.workers.dev/media/` plus the printed key with `credentials: 'include'`, compare its body to the local temporary file without recording the body, then clean up:

  ```bash
  pnpm --dir apps/api exec wrangler r2 object delete "delivo-media-staging/$SMOKE_KEY"
  rm -f "$SMOKE_FILE"
  unset SMOKE_FILE SMOKE_KEY
  ```

  Never upload customer or driver data.

- [ ] **Step 5: Inspect sanitized operational state**

  Use the existing safe outbox/challenge queries from the SEC-03A runbook and `wrangler tail --env staging`. Confirm no secret, raw email, code, ticket, password, access token, or refresh token appears.

- [ ] **Step 6: Document evidence and current limitations**

  Create the private-staging runbook with these exact sections:

  ```markdown
  # Runbook — private workers.dev staging

  ## Resources
  ## Access and CORS settings
  ## Non-secret deployment commands
  ## Secret-name checklist
  ## CUSTOMER/recovery smoke evidence
  ## R2/Hyperdrive evidence
  ## Rollback
  ## Known limitations and production blockers
  ```

  Name the three Workers, `delivo-media-staging`, `delivery-db-staging`, runtime role `delivo_app_staging`, and Turnstile widget `delivery-staging`, without PII. Evidence uses only:

  ```text
  date_utc:
  source_commit:
  worker_versions:
  access_allowed: PASS|FAIL
  access_denied: PASS|FAIL
  cors_allowed: PASS|FAIL
  cors_denied: PASS|FAIL
  customer_verification: PASS|FAIL
  recovery_session_revocation: PASS|FAIL
  turnstile_replay: PASS|FAIL
  recipient_allowlist: PASS|FAIL
  hyperdrive_runtime_role: PASS|FAIL
  r2_binding: PASS|FAIL
  logs_sanitized: PASS|FAIL
  notes_without_pii_or_secrets:
  ```

  Update the SEC-03A runbook status from “staging pending” only for CUSTOMER/recovery; keep STORE and production blocked.

- [ ] **Step 7: Commit sanitized evidence**

  ```bash
  git add docs/security/runbooks/private-workers-staging.md docs/security/runbooks/sec-03a-resend-identity.md
  git commit -m "docs(security): record private staging smoke"
  ```

### Task 10: Reset disposable DB, validate ADMIN separately, and close staging

**Files:**
- Modify: `docs/security/runbooks/private-workers-staging.md`
- Modify: `docs/superpowers/plans/2026-07-11-go-to-production.md`
- Modify: `docs/superpowers/specs/2026-07-13-private-workers-staging-design.md`

**Interfaces:**
- Consumes: explicit confirmation to destroy CUSTOMER smoke data.
- Produces: independent ADMIN bootstrap evidence, updated production plan, final gate, and merge-ready branch.

- [ ] **Step 1: Obtain destructive reset confirmation**

  Stop and ask the user immediately before resetting `neondb`. Do not infer approval from the general disposable-data decision.

- [ ] **Step 2: Recreate and secure staging DB**

  Recreate empty `neondb`, apply migrations `0000`–`0025`, recreate/regrant `delivo_app_staging`, rerun `verify-staging-runtime.sql`, update Hyperdrive credential if Neon rotated it, and verify the API reaches DB through an authorized identity flow.

- [ ] **Step 3: Run ADMIN bootstrap smoke**

  Follow the existing SEC-03A private-terminal bootstrap procedure using the Resend owner mailbox, a 15–128 character password, the direct owner URL, and the same staging `AUTH_CODE_SECRET`/Resend key. Verify pending admin has no session, email activation succeeds, login succeeds only afterward, resend cooldown works, and rerun returns `ALREADY_ACTIVE`.

- [ ] **Step 4: Update docs accurately**

  Record only PASS/FAIL and Worker version. Mark STORE activation deferred until verified Resend domain. Change the staging design status to:

  ```markdown
  **Status:** implemented and validated in private staging; production remains blocked
  ```

  Add this block at the top of the old go-to-production plan, immediately after its title:

  ```markdown
  > **Status em 2026-07-13:** este documento foi substituído para staging pela
  > [spec de staging privado](../specs/2026-07-13-private-workers-staging-design.md)
  > e pelo runbook `docs/security/runbooks/private-workers-staging.md`.
  > O histórico abaixo preserva decisões antigas e não deve ser executado literalmente.
  > O schema atual aplica migrations `0000`–`0025`; SEC-01, SEC-02 e SEC-03A já estão
  > remediados em código. Produção continua bloqueada.
  ```

- [ ] **Step 5: Final verification before completion claim**

  Use `superpowers:verification-before-completion`, then run:

  ```bash
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm build
  pnpm --filter @delivery/web build:staging
  pnpm --filter @delivery/driver build:staging
  pnpm --dir apps/api exec wrangler deploy --env staging --dry-run
  pnpm --dir apps/web exec wrangler deploy --env staging --dry-run
  pnpm --dir apps/driver exec wrangler deploy --env staging --dry-run
  git diff --check
  git status --short
  ```

  Expected: all pass; only intentional documentation changes remain before commit.

- [ ] **Step 6: Commit closure**

  ```bash
  git add docs/security/runbooks/private-workers-staging.md docs/superpowers/plans/2026-07-11-go-to-production.md docs/superpowers/specs/2026-07-13-private-workers-staging-design.md
  git commit -m "docs(staging): close private rollout"
  ```

- [ ] **Step 7: Review and integrate**

  Use `superpowers:requesting-code-review`, correct verified findings, rerun the final gate, then use `superpowers:finishing-a-development-branch`. Merge locally to `main` only after the user selects merge; do not push. Reconcile the saved `/tmp/delivery-staging-wrangler-user.patch` by proving the final `apps/api/wrangler.jsonc` contains its intended R2/Hyperdrive values in the correct `env.staging` locations.

## Completion Boundary

Completion means private staging works for Access, CUSTOMER email/recovery, ADMIN bootstrap after reset, Turnstile, Neon/Hyperdrive, and R2 with sanitized evidence. It does not authorize public beta or production. Domain/DNS, multi-recipient Resend, STORE activation, Mercado Pago webhook bypass/signature smoke, Firebase, Google OAuth, and production infrastructure remain separate planned work.

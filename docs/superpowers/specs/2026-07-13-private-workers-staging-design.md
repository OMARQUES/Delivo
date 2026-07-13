# Private Workers Staging Design

**Status:** approved design

**Date:** 2026-07-13

## Objective

Create a private, reproducible staging environment on `workers.dev` for the API, web application, and driver application. The environment must exercise Neon through Hyperdrive, R2, Resend, and Turnstile while remaining protected by Cloudflare Access and isolated from both local development and future production.

This design prepares and validates staging only. It does not configure a production domain, production credentials, Google OAuth, Mercado Pago live credentials, Firebase production delivery, continuous deployment, or unrestricted email delivery.

## Decisions

- Use Wrangler named environment `staging` in the three existing Worker configurations.
- Deploy `delivery-api-staging`, `delivery-web-staging`, and `delivery-driver-staging`.
- Protect all three exact `workers.dev` hostnames with one multi-domain Cloudflare Access application.
- Authenticate to Access with email one-time PIN.
- Allow only the two pilot emails supplied to Cloudflare out of band; never commit them.
- Use a 24-hour Access session.
- Use Resend in `OWNER_ONLY` mode with `onboarding@resend.dev`.
- Store the single allowed Resend recipient as a Worker secret, not as a tracked Wrangler variable.
- Use the existing staging R2 bucket `delivo-media-staging`.
- Use the existing staging Hyperdrive configuration with read caching disabled, TLS required, and an origin connection limit of five.
- Use a dedicated least-privilege PostgreSQL runtime role before smoke testing. The Neon owner role remains migration-only.
- Use one Managed Turnstile widget dedicated to staging.
- Keep all application JWT authentication and role authorization. Access is an additional outer privacy boundary, not a replacement.

## Architecture

The base Wrangler configuration remains the local-development configuration. Each `env.staging` block repeats every non-inheritable variable and binding required by that deployed Worker. Staging must never replace the base Hyperdrive ID or add alternate binding names that application code does not consume.

The API receives exactly these resource bindings in staging:

- `HYPERDRIVE`: staging Hyperdrive configuration;
- `BUCKET`: `delivo-media-staging`.

The web and driver Workers serve independently built static assets. Their staging builds contain only public configuration: API URL, Turnstile sitekey, and any already-public provider identifiers required by the application. No secret may use a `VITE_` variable.

The account `workers.dev` subdomain is an operational input, not a repository secret. Once resolved from the Cloudflare account, the three exact hostnames are deterministic from the approved Worker names and are used consistently by Wrangler variables, Vite builds, Turnstile, CORS, and Access.

## Configuration Boundaries

Tracked, non-secret API staging configuration includes:

- `APP_ENV=staging`;
- exact `ALLOWED_ORIGINS` for web and driver staging;
- exact `TURNSTILE_EXPECTED_HOSTNAMES` for web and driver staging;
- `EMAIL_FROM=Delivery staging <onboarding@resend.dev>`;
- exact `PUBLIC_WEB_URL` and `PUBLIC_API_URL`;
- public provider keys when required;
- staging R2 and Hyperdrive binding identifiers.

Worker secrets are registered through the interactive Wrangler prompt with `--env staging`:

- `JWT_SECRET`;
- `RATE_LIMIT_HMAC_SECRET`;
- `AUTH_CODE_SECRET`;
- `RESEND_API_KEY`;
- `TURNSTILE_SECRET_KEY`;
- `EMAIL_ALLOWED_RECIPIENTS`.

Provider secrets not needed by the identity smoke remain unset until their own integration smoke is scheduled. Secret values, connection strings, raw email allowlists, verification codes, tickets, access tokens, and refresh tokens must not appear in Git, commands, logs, reports, or chat transcripts.

## Cloudflare Access and CORS

One self-hosted Access application covers the exact API, web, and driver staging hostnames. Its Allow policy contains only the two pilot email identities and uses one-time PIN. There is no `Everyone` policy and no broad bypass.

Because the browser applications call the API cross-origin:

- Access preemptive authentication is enabled for the three application domains;
- Access bypasses `OPTIONS` requests to the origin;
- the API handles every preflight and allows only the exact web and driver origins;
- the API returns credentialed CORS headers for allowed origins;
- both frontend API wrappers use `credentials: 'include'` so the Access authorization cookie accompanies requests;
- unknown origins receive no CORS authorization;
- application bearer tokens and existing refresh behavior remain unchanged.

Cloudflare Access protects staging from its first functional deployment. The Access application is configured from the deterministic hostnames before the API is made usable. `/docs`, `/openapi.json`, and `/health/db` remain disabled by the application's non-local guards; Access does not justify reopening them.

## Neon and Hyperdrive

Schema migrations run through a direct, unpooled Neon connection authenticated as the migration owner. Migrations never run through Hyperdrive.

The Worker connects through Hyperdrive using a dedicated staging runtime role. That role receives schema usage and only the table/sequence privileges required for application DML. It receives no schema ownership, object creation, alteration, drop, role-management, or database-administration permissions. Default privileges owned by the migration role ensure future migrated tables and sequences remain usable by the runtime role without broadening it to DDL.

Before smoke testing, Hyperdrive is updated from the current owner credential to the dedicated runtime role. Read caching remains disabled to preserve auth/session/order read-after-write correctness. TLS remains required and the origin connection limit remains five.

The staging database is disposable. Rollback does not use down migrations; if incompatible state occurs, recreate the staging database and apply migrations from zero.

## Resend

Staging uses Resend's shared `onboarding@resend.dev` sender. The account-owner mailbox is the only permitted recipient and is repeated in `EMAIL_ALLOWED_RECIPIENTS` as a Worker secret. The second Access identity can enter staging but cannot complete application email flows.

Requests targeting any other address fail closed at the application's email boundary and retain generic public responses where enumeration resistance requires them. Provider bodies, API keys, destination addresses, codes, and tickets are excluded from logs.

`OWNER_ONLY` cannot validate CUSTOMER, ADMIN, and STORE activation together because those scenarios require distinct identities. Staging therefore validates CUSTOMER registration/recovery first, then may reset the disposable database and validate ADMIN bootstrap with the same permitted recipient. Complete STORE activation waits for a verified sending domain.

## Turnstile

The existing API performs server-side Siteverify validation. No additional validation Worker is introduced.

Create one Managed widget dedicated to staging and allow only the exact web and driver staging hostnames. The public sitekey is included in both frontend staging builds. The secret is registered only on the API Worker. `TURNSTILE_EXPECTED_HOSTNAMES` repeats the exact hostnames so a valid token minted for another host is rejected.

Registration and recovery continue requiring Turnstile. Login keeps the adaptive challenge behavior already implemented by SEC-02/SEC-03A. Tokens remain single-use and short-lived according to Cloudflare's validation contract.

## Deployment Sequence

1. Correct the Wrangler configuration and remove the accidental staging resource bindings from the base environment.
2. Add credentialed CORS behavior and frontend credential forwarding with automated tests.
3. Run type checking, linting, unit/integration tests, builds, generated-binding validation, and Wrangler dry runs locally.
4. Resolve the account `workers.dev` subdomain and derive the three approved hostnames.
5. Configure the multi-domain Access application and allowlist before making the API functional.
6. Apply all migrations to the disposable Neon staging database through the direct owner connection.
7. Create/grant the runtime database role and update Hyperdrive to use it.
8. Create the Turnstile widget for the two frontend hostnames.
9. Deploy the three staging Workers with their public configuration.
10. Register independent Worker secrets through interactive Wrangler prompts.
11. Run the allowlisted smoke suite and record only sanitized evidence.

If a platform dependency forces an initial Worker creation before Access or secrets can be attached, the initial version must be non-functional and contain no usable database/email secrets. Access is attached before enabling functional secrets and smoke traffic.

## Validation

Automated validation must cover:

- allowed-origin preflight with credential support;
- denied-origin preflight without CORS authorization;
- frontend fetch wrappers forwarding credentials;
- local environment behavior remaining unchanged;
- staging binding names matching application `Env` usage;
- Wrangler configuration schema/type generation;
- all existing repository tests, type checks, lint, and builds;
- dry-run deploy for API, web, and driver staging.

External smoke validation must cover:

- allowed Access identity succeeds;
- non-allowlisted identity is denied;
- direct API access without Access authorization is denied;
- unknown browser origin is denied by CORS;
- CUSTOMER registration, six-digit verification, login, resend rules, and password recovery;
- password recovery immediately invalidates old access and refresh sessions;
- invalid, expired, or replayed Turnstile tokens fail;
- a non-owner recipient is not sent email;
- API reaches Neon through Hyperdrive;
- permitted application paths can write/read R2 when an authenticated media scenario is exercised;
- logs contain no secrets, email codes, tickets, passwords, or auth tokens.

After a database reset, ADMIN bootstrap and activation may be validated separately with the Resend owner identity. STORE activation is explicitly deferred until a verified Resend domain permits a distinct owner identity.

## Failure Handling and Rollback

- Any failed local gate or dry run blocks deployment.
- Any failed Access deny test blocks application smoke.
- Any unexpected public API reachability causes immediate Access denial and Worker rollback.
- Roll back code with Wrangler version rollback while retaining Access default-deny protection.
- Do not down-migrate Neon. Recreate the disposable staging database when schema rollback is necessary.
- Revoke and replace affected provider keys after any credential incident.
- Preserve only sanitized operational evidence and provider message IDs.
- Production remains blocked regardless of staging success until it has separate infrastructure, secrets, verified email domain, and its own security gate.

## Success Criteria

Staging is complete when all three Workers are protected by the same allowlisted Access application, the API uses the exact staging Hyperdrive/R2 bindings, cross-origin browser calls function only for approved origins and Access identities, Resend and Turnstile pass their constrained smoke flows, Neon migrations and runtime least privilege are verified, the repository gate passes, and the sanitized smoke record contains no unresolved failure.

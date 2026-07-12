# SEC-03A Implementation Plan Index

> **For agentic workers:** Execute these plans in order. Each plan requires `superpowers:executing-plans` and its own verification checkpoint. Do not run tasks from different stages concurrently.

**Goal:** Deliver the approved SEC-03A email identity lifecycle in four independently reviewable stages without leaving the repository uncompilable between stages.

**Source spec:** `docs/superpowers/specs/2026-07-12-sec-03a-email-identity-design.md`

## Stage order

1. [`2026-07-12-sec-03a-stage-1-foundation.md`](./2026-07-12-sec-03a-stage-1-foundation.md) — additive database structures, code/ticket cryptography, templates, Resend adapter, PostgreSQL outbox, identity policies, cleanup.
2. [`2026-07-12-sec-03a-stage-2-registration.md`](./2026-07-12-sec-03a-stage-2-registration.md) — detached CUSTOMER/DRIVER registration, verification/resend, final user-status migration, email-only login, web/driver UI.
3. [`2026-07-12-sec-03a-stage-3-recovery.md`](./2026-07-12-sec-03a-stage-3-recovery.md) — non-enumerable recovery, code verification, reset ticket, session revocation, web UI and security notice.
4. [`2026-07-12-sec-03a-stage-4-privileged.md`](./2026-07-12-sec-03a-stage-4-privileged.md) — STORE/ADMIN activation, admin bootstrap, driver invitations by email, final audit/docs/staging gate.

## Cross-stage constraints

- TDD: observe each focused test fail before implementation.
- No subagents unless user explicitly changes the execution instruction.
- Execute one task at a time; review diff and focused tests before next task.
- Work in an isolated worktree created at execution time.
- Treat Stages 1–3 as non-deployable intermediate states; deploy/staging promotion is allowed only after the Stage 4 final gate.
- Never log/store plaintext codes, raw action tickets, passwords, refresh tokens, Resend keys, or Turnstile tokens.
- Keep `AUTH_CODE_SECRET`, `RATE_LIMIT_HMAC_SECRET`, and `JWT_SECRET` independent.
- No phone login, phone identity uniqueness, or phone-based invitation in final state.
- No Google, MFA, password-hash migration, broad visual refactor, Resend webhooks, KV, Durable Objects, or Queues.
- Do not edit existing migration files `0000` through `0023`.
- Generate forward migrations from current Drizzle state; verify journal/snapshot changes.
- Local database is disposable. Migrations fail on unexpected incompatible rows rather than silently deleting or inventing identity data.
- Each stage ends with `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, migration verification, and `git diff --check`.

## Completion rule

Passing one stage does not mark SEC-03 remediated. Update the security review only after Stage 4 passes its full gate and manual external prerequisites remain explicitly documented.

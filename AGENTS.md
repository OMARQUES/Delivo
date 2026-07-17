# Repository agent instructions

## Task source of truth

`docs/tasks.md` is the canonical source of truth for all planned, active,
partially completed, blocked, and completed work in this repository.

Every agent working in this repository must:

1. Read `docs/tasks.md` before proposing, planning, or implementing work.
2. Register every new task in `docs/tasks.md` before creating its detailed spec
   or implementation plan.
3. Update the task entry whenever scope, decisions, dependencies, priority,
   acceptance criteria, status, evidence, or implementation state changes.
4. Update `docs/tasks.md` in the same commit as the change that starts,
   partially implements, completes, blocks, supersedes, or reopens a task.
5. Never mark a task `DONE` without recording objective verification evidence.
6. Treat older files under `docs/superpowers/specs/` and
   `docs/superpowers/plans/` as supporting history. If they disagree with
   `docs/tasks.md`, the ledger wins and the conflicting document must be
   reconciled or explicitly marked superseded.
7. Use stable task IDs. Do not recycle or rename an ID after it has been
   referenced by a commit, spec, plan, or another task.
8. Preserve user-owned ignored environment files and secrets. A task entry and
   its evidence must never contain credentials, tokens, personal data,
   verification codes, or provider response bodies.

Allowed statuses are `PROPOSED`, `DECISION_REQUIRED`, `READY`, `IN_PROGRESS`,
`PARTIAL`, `BLOCKED`, `DONE`, and `SUPERSEDED`.

`READY` means that a task is sufficiently specified; it does not authorize
implementation. Agents must receive an explicit user request to implement a task.
Creating or updating the ledger/specs is documentation work only and must never
silently start product, infrastructure, provider, or production changes.

Each task entry must contain, at minimum: status, priority, objective, scope,
dependencies, governing decisions or linked spec, acceptance criteria, and
verification evidence or the exact evidence still required.

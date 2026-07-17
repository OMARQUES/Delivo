# Order Cancellation Deadlines, Return Route, and Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents unless the user explicitly changes the repository's current no-subagent preference.

**Goal:** Implement one race-safe cancellation policy, configurable store/deadline rules, driver return compensation, and reliable cancellation notifications for `ORD-CAN-01`, `DSP-RET-01`, and `NOT-CAN-01`.

**Architecture:** Persist every deadline and compensation input when it becomes effective, then route every commercial cancellation through one transactional command. Keep Mercado Pago disposition durable and separate from commercial state, represent custody as an explicit return obligation, and deliver sanitized store/driver push through a leased database outbox while polling remains authoritative.

**Tech Stack:** TypeScript 6, Hono 4, Vue 3, Vite 8, Vitest 4, PostgreSQL 17, Drizzle, Cloudflare Workers/Cron/Hyperdrive, Firebase Cloud Messaging HTTP v1.

## Global Constraints

- `docs/tasks.md` is canonical; the approved design is `docs/superpowers/specs/2026-07-17-order-cancellation-deadlines-return-route-design.md`.
- Execute inline in one isolated worktree. No subagents, push, deploy, provider mutation, or production change.
- Preserve existing user values in local environment files. The user authorizes adding only new required variables to local envs; never print, replace, stage, or commit their secrets.
- Local env files may already be tracked in this repository, but their local values must remain unstaged and uncommitted. Tracked `.env*.example` templates may be updated with empty public placeholders.
- No backfill or compatibility path is required for the current disposable database. Before manual validation, the user will explicitly authorize and run a clean reset so migrations execute from `0000` through the new migration.
- Do not perform that destructive reset from general approval: obtain confirmation immediately before it.
- Production defaults are acceptance `10` minutes, delayed cancellation `90` minutes, and return-route bonus `50%`.
- Demo/test settings are acceptance `2` minutes, delayed cancellation `10` minutes, and bonus `50%`.
- ADMIN ranges are acceptance `1–180`, delayed cancellation `1–1440`, and bonus integer `0–100`.
- Configuration changes affect only future deadlines/obligations. Never recalculate an existing snapshot.
- The store funds every driver compensation. No driver credit may exist without an equal store debit.
- General pool: zero before arrival, 50% after arrival without collection, and 100% of original delivery fee plus frozen bonus after confirmed return.
- Shift/own driver: zero partial arrival compensation and only frozen `perDeliveryCents` after confirmed return.
- Push is best effort. Cancellation commits even if Firebase is absent or unavailable; API state and polling remain authoritative.
- Push/events/DTOs must not contain customer name, phone, address, note, email, tokens, provider response bodies, or payment credentials unless an already-authorized UI independently requires that data.
- All date comparisons use injected/database time, never browser time.
- Every focused task follows RED → GREEN → focused suite → diff review → ledger update → commit.

## Execution Preflight

- [ ] **Step 1: Record the user worktree without exposing env contents**

Run:

```bash
cd /home/omarques/Desktop/Projetos/Delivery
git status --short
git branch --show-current
git log -1 --oneline
```

Expected: branch `main`; local env changes may appear and must not be copied into the feature worktree or staged.

- [ ] **Step 2: Create the isolated worktree**

Use `superpowers:using-git-worktrees` with:

```text
branch: feat/order-cancellation-returns
worktree: /home/omarques/Desktop/Projetos/Delivery/.worktrees/order-cancellation-returns
```

Expected: clean worktree based on the commit containing this plan.

- [ ] **Step 3: Establish the baseline**

Run in the worktree:

```bash
pnpm install --frozen-lockfile
pnpm --filter @delivery/shared test
pnpm --filter @delivery/api test
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
pnpm typecheck
```

Expected: all pass. Stop and diagnose any baseline failure before changing source.

- [ ] **Step 4: Start the canonical ledger entries**

In `docs/tasks.md`, change only `ORD-CAN-01`, `DSP-RET-01`, and `NOT-CAN-01` from `READY` to `IN_PROGRESS`, recording the branch/worktree and no completion evidence.

Commit with the first task's implementation rather than creating a documentation-only commit.

---

### Task 1: ORD-CAN-01 — Unified policy, settings, deadlines, and cancellation command

**Files:**
- Create: `apps/api/src/db/schema/platform-settings.ts`
- Create: `apps/api/src/services/platform-settings.service.ts`
- Create: `apps/api/src/services/order-cancellation-policy.ts`
- Create: `apps/api/src/services/order-cancellation.service.ts`
- Create: `apps/api/src/routes/admin-settings.ts`
- Create: `apps/web/src/views/admin/AdminSettingsView.vue`
- Create: focused API/shared/web tests for settings, policy, cancellation, cron, batch, and concurrency
- Modify: order/payment schemas, order creation/projections/routes, provider transition/recovery/operation paths, batch service, cron entrypoint, Wrangler cron, demo seed, router, and `docs/tasks.md`
- Generate: next Drizzle migration and metadata from the schema; edit the generated SQL only when necessary to express checks/indexes Drizzle cannot generate correctly

**Interfaces:**
- Produces `getPlatformSettings(db): Promise<PlatformSettings>`.
- Produces `updatePlatformSettings(db, actor, patch): Promise<PlatformSettings>`.
- Produces `resolveCustomerCancellationPolicy(order, now): CancellationPolicy`.
- Produces `cancelOrder(db, input): Promise<CancellationResult>` and an in-transaction `cancelLockedOrder(tx, input)` used by payment/cron paths.
- Produces customer projection `cancellationPolicy` and optional cancel body `{ confirmInTransitCancellation?: boolean }`.
- Task 2 consumes the cancellation command's driver-disposition boundary and frozen platform settings.
- Task 3 consumes `CancellationResult.notificationRecipients`, canonical cancellation code, and the public cancellation policy.

- [ ] **Step 1: Add shared constants and pure policy tests**

Define in shared code:

```ts
export const CANCELLATION_CODES = [
  'CUSTOMER_FAST',
  'CUSTOMER_DELAYED',
  'STORE_DECISION',
  'STORE_ACCEPT_TIMEOUT',
  'PAYMENT_EXPIRED',
  'PAYMENT_REJECTED',
  'AMENDMENT_REJECTED',
] as const

export type CancellationCode = (typeof CANCELLATION_CODES)[number]

export type CancellationPolicy = {
  action: 'DIRECT' | 'REQUEST_STORE' | 'NONE'
  reason: 'FAST' | 'DELAYED' | 'STORE_APPROVAL_REQUIRED' | 'IN_TRANSIT_NOT_DELAYED' | 'TERMINAL'
  lateEligibleAt: string | null
  requiresInTransitConfirmation: boolean
}
```

Add table-driven tests for every status before and after the threshold, including `CANCELLED` idempotence and terminal rejection.

Run:

```bash
pnpm --filter @delivery/shared test -- order-status.test.ts
pnpm --filter @delivery/api test -- order-cancellation-policy.test.ts
```

Expected RED: constants/policy do not exist and `OUT_FOR_DELIVERY → CANCELLED` is absent.

- [ ] **Step 2: Implement the pure policy and transition contract**

Policy matrix:

```text
AWAITING_PAYMENT/PENDING/ACCEPTED        DIRECT FAST
PREPARING/READY/AWAITING_DRIVER early   REQUEST_STORE
PREPARING/READY/AWAITING_DRIVER late    DIRECT DELAYED
OUT_FOR_DELIVERY early                  NONE IN_TRANSIT_NOT_DELAYED
OUT_FOR_DELIVERY late                   DIRECT DELAYED + confirmation
DELIVERED/DELIVERY_FAILED               NONE TERMINAL
CANCELLED                               idempotent existing result
```

Permit `OUT_FOR_DELIVERY → CANCELLED` in the shared state machine, but document and test that only the canonical cancellation service may exercise that transition.

Re-run the two focused suites; expected GREEN.

- [ ] **Step 3: Add settings/deadline schema tests and verify RED**

Add schema/service tests proving:

```ts
expect(defaults).toMatchObject({
  storeAcceptanceTimeoutMinutes: 10,
  delayedCancellationMinutes: 90,
  returnRouteBonusPercent: 50,
})
```

Also test integer/range rejection, ADMIN authorization at the route, no-op PATCH audit behavior, and one audit event per changed field.

Run:

```bash
pnpm --filter @delivery/api test -- platform-settings.service.test.ts admin-settings.routes.test.ts
```

Expected RED: tables/routes/services are absent.

- [ ] **Step 4: Add settings, audit, and order deadline schema**

Add singleton `platform_settings` and per-field `platform_setting_events`. Add order fields:

```ts
storeAcceptanceDeadlineAt: Date | null
storeAcceptedAt: Date | null
lateCancellationEligibleAt: Date | null
cancellationCode: CancellationCode | null
cancelledAt: Date | null
```

Add indexes on `(status, storeAcceptanceDeadlineAt)` and `(status, lateCancellationEligibleAt)`. Insert singleton defaults `10/90/50` in the migration.

Do not add backfill statements for existing orders or settings. The supported validation path is a database recreated from all migrations.

Run migration-from-zero against the disposable test database, then run the focused schema/settings tests. Expected GREEN.

- [ ] **Step 5: Implement the ADMIN API and UI**

API contract:

```ts
type PlatformSettingsResponse = {
  storeAcceptanceTimeoutMinutes: number
  delayedCancellationMinutes: number
  returnRouteBonusPercent: number
  updatedAt: string
}

type PlatformSettingsPatch = Partial<Pick<PlatformSettingsResponse,
  | 'storeAcceptanceTimeoutMinutes'
  | 'delayedCancellationMinutes'
  | 'returnRouteBonusPercent'
>>
```

`PATCH /admin/settings` must reject an empty object and unknown keys. Lock the singleton row, validate all values, update once, and insert audit rows containing actor/request ID and integer old/new values.

Add `/admin/configuracoes` to the admin router/navigation. The form must show ranges, current values, saving/error status, and must not claim historical orders were updated.

Run:

```bash
pnpm --filter @delivery/api test -- admin-settings.routes.test.ts platform-settings.service.test.ts
pnpm --filter @delivery/web test -- AdminSettingsView.test.ts
```

Expected: all pass.

- [ ] **Step 6: Persist deadlines exactly when they become effective**

Write failing tests first for:

- CASH/CARD_MACHINE creation sets `PENDING` and acceptance deadline.
- Online creation leaves the deadline null in `AWAITING_PAYMENT`.
- Authoritative approval sets `PENDING` and deadline once.
- First `PENDING → ACCEPTED` writes `storeAcceptedAt` and `lateCancellationEligibleAt` once.
- Later configuration changes do not alter either persisted deadline.
- Store acceptance at/after its deadline cancels with `STORE_ACCEPT_TIMEOUT` instead of accepting.

Use a supplied `now` in services/tests. Read current settings under the same transaction that persists the deadline.

Update demo seed/test fixture to `2/10/50`; production migration defaults stay `10/90/50`.

Run:

```bash
pnpm --filter @delivery/api test -- order.service.test.ts payment-reconciliation.test.ts store-orders.routes.test.ts
```

Expected: RED before implementation, GREEN afterward.

- [ ] **Step 7: Define the canonical command and stable errors**

Use these exact public shapes:

```ts
type CancellationActor =
  | { role: 'CUSTOMER'; id: string }
  | { role: 'STORE'; id: string }
  | { role: 'ADMIN'; id: string }
  | { role: 'SYSTEM'; id: null }

type CancelOrderInput = {
  orderId: string
  actor: CancellationActor
  reasonCode: CancellationCode
  expectedPolicy: 'CUSTOMER_DIRECT' | 'STORE_DECISION' | 'SYSTEM_TIMEOUT' | 'PAYMENT' | 'AMENDMENT'
  confirmInTransitCancellation?: boolean
  requestId: string
  now: Date
}

type CancellationResult = {
  order: typeof orders.$inferSelect
  changed: boolean
  operationId: string | null
  detachedDriverId: string | null
  returnRequired: boolean
  notificationRecipients: { storeOwnerId: string; driverId: string | null }
}
```

Stable API codes:

```text
ORDER_NOT_CANCELLABLE
STORE_ACCEPTANCE_EXPIRED
STORE_APPROVAL_REQUIRED
DIRECT_CANCELLATION_AVAILABLE
IN_TRANSIT_CONFIRMATION_REQUIRED
ORDER_STATE_CHANGED
```

Cross-customer/store access must remain `404`.

- [ ] **Step 8: Implement lock order and idempotent cancellation**

For batch members, acquire locks in this order:

```text
batch → target order → payment → payment operation
```

For standalone orders:

```text
order → payment → payment operation
```

Read candidate IDs before the transaction only to determine which locks may be needed. Revalidate after locking. If a previously standalone order joined a batch before its lock was acquired, abort and retry the transaction once using the actual batch; a second change returns `ORDER_STATE_CHANGED`.

The command must perform, once:

1. actor/tenant/policy revalidation;
2. amendment/cancel-request/broadcast closure;
3. batch member removal;
4. driver-disposition call;
5. CAS transition to `CANCELLED` with code/time/reason;
6. one order event with actor/request ID;
7. one canonical payment disposition;
8. return of the committed resolution.

Calling it again for `CANCELLED` returns `changed=false` and must not insert another event, ledger row, operation, return obligation, or future push event.

- [ ] **Step 9: Route every commercial cancellation through the command**

Replace direct order cancellation updates in:

- customer direct cancellation;
- store status cancellation;
- store approval of customer request;
- rejection of amendment;
- payment expiry/rejection;
- checkout recovery;
- provider transition;
- operation escalation.

`POST /orders/{id}/cancel` accepts absent JSON body or the optional confirmation field; explicitly test that an empty request returns the semantic result rather than `415`.

`POST /orders/{id}/cancel-request` is valid only when policy is `REQUEST_STORE`. When policy changed to direct while the screen was stale, return `DIRECT_CANCELLATION_AVAILABLE`.

Run:

```bash
rg -n "set\(\{[^}]*status: 'CANCELLED'|status: 'CANCELLED'" apps/api/src --glob '*.ts'
pnpm --filter @delivery/api test -- orders.routes.test.ts store-orders.routes.test.ts amendment.service.test.ts
```

Expected: remaining direct state writes are either inside the canonical service or unrelated non-order enums and are documented in the diff review.

- [ ] **Step 10: Normalize payment/order lock order**

In provider snapshot, checkout recovery, and operation settlement:

1. read immutable `orderId` without lock;
2. lock order;
3. lock payment;
4. verify payment still belongs to the order;
5. apply the transition.

Do not add a provider HTTP call inside a new database transaction. Preserve current durable operation keys and refund escalation.

Add deterministic concurrent tests for cancellation versus provider approval and fail the test if either promise exceeds its timeout.

Run:

```bash
pnpm --filter @delivery/api test -- payment-reconciliation.test.ts payment-operation.service.test.ts payment-cancellation.service.test.ts
```

Expected: no deadlock, exactly one cancel/refund business operation, and a cancelled order never reopens.

- [ ] **Step 11: Replace stale-createdAt cron with deadline claims**

Produce:

```ts
type AcceptanceTimeoutSummary = {
  cancelled: number
  skipped: number
  failed: number
  backlog: boolean
}

cancelDueStoreAcceptanceOrders(db, now, limit = 100): Promise<AcceptanceTimeoutSummary>
```

Claim one due `PENDING` row per short transaction using `FOR UPDATE SKIP LOCKED`; invoke `cancelLockedOrder` with `STORE_ACCEPT_TIMEOUT`. Continue after a per-row failure and expose only sanitized counters.

Use `new Date(event.scheduledTime)` in the Worker scheduled handler. Change base and staging cron to:

```jsonc
"triggers": { "crons": ["* * * * *"] }
```

Keep the local cron loop fast, but make it invoke the same scheduled endpoint and expression. Document nominal execution delay of one minute plus backlog/platform delay.

Run:

```bash
pnpm --filter @delivery/api test -- order-acceptance-timeout.test.ts local-cron.test.ts
pnpm --dir apps/api exec wrangler deploy --env staging --dry-run
```

Expected: focused tests and dry run pass.

- [ ] **Step 12: Preserve batch members and review Task 1**

Tests must cover:

- batch `2 → 1`: cancelled member detached, remaining member/driver/status preserved;
- batch `1 → 0`: batch becomes `CANCELLED`;
- collection racing cancellation: one lock winner;
- cancelled member cannot be collected/delivered;
- unrelated member remains actionable.

Run:

```bash
pnpm --filter @delivery/api test -- batch.service.test.ts order-cancellation.service.test.ts
pnpm --filter @delivery/api test
pnpm --filter @delivery/shared test
pnpm --filter @delivery/api typecheck
pnpm --filter @delivery/shared typecheck
git diff --check
git status --short
```

Review the diff for direct cancellation writes, lock inversions, configuration retroactivity, and accidental env staging. Keep `ORD-CAN-01` `IN_PROGRESS` because driver custody/finance completes in Task 2.

Commit:

```bash
git add -- apps/api apps/web packages/shared docs/tasks.md pnpm-lock.yaml \
  ':(exclude)apps/web/.env.development' \
  ':(exclude)apps/driver/.env.development'
git commit -m "feat(orders): unify cancellation deadlines"
```

---

### Task 2: DSP-RET-01 — Frozen assignment, return obligation, and paired compensation

**Files:**
- Create: `apps/api/src/services/driver-cancellation-disposition.service.ts`
- Create: `apps/api/src/services/return-obligation.service.ts`
- Create: focused disposition/obligation/concurrency tests
- Modify: order and finance schema, dispatch/batch/return/finance/settlement services, driver/store/admin return DTOs/routes/views, shared finance constants, migration, and `docs/tasks.md`

**Interfaces:**
- Produces `createReturnObligation(tx, input): Promise<ReturnObligationSnapshot>`.
- Produces `resolveCancelledDriverDisposition(tx, lockedOrder, now): Promise<DriverDisposition>`.
- Produces frozen return fields consumed by confirmation, settlement, store/admin views, and Task 3 notifications.

- [ ] **Step 1: Write RED schema and assignment-freeze tests**

Define:

```ts
type DriverAssignmentMode = 'GENERAL_POOL' | 'SHIFT'
type ReturnReason = 'DELIVERY_FAILED' | 'ORDER_CANCELLED'
type ReturnCompensationMode = 'GENERAL_POOL' | 'SHIFT'
```

Test individual pool accept, shift accept, and both batch accept paths. Pool freezes `GENERAL_POOL`; shift freezes `SHIFT` plus current `perDeliveryCents`.

Run:

```bash
pnpm --filter @delivery/api test -- dispatch.service.test.ts batch.service.test.ts
```

Expected RED: assignment mode/pay fields are absent.

- [ ] **Step 2: Add assignment and return snapshot schema**

Add order fields:

```ts
driverAssignmentMode
driverAssignmentPayCents
returnReason
returnCompensationMode
returnBasePayCents
returnBonusPercent
returnBonusCents
returnTotalPayCents
```

Remove `returnDriverPayCents` without backfill. Add checks for nonnegative cents, percent range, `total = base + bonus`, and zero bonus for `SHIFT`.

Add ledger types:

```ts
'DRIVER_RETURN_ROUTE_CREDIT'
'STORE_RETURN_ROUTE_DEBIT'
```

Run migration-from-zero and the focused schema/finance constant tests. Expected GREEN.

- [ ] **Step 3: Freeze every accepted assignment**

Update individual/general, individual/shift, batch/general, and batch/shift acceptance. Release before custody clears the active assignment snapshot; cancellation with custody preserves it.

Classification must use the frozen mode, never `driverRequestTarget`. If mode is unexpectedly null on a newly assigned order, fail closed with a stable server error rather than guessing compensation.

Run dispatch/batch tests; expected GREEN.

- [ ] **Step 4: Centralize return-obligation creation**

Use:

```ts
type CreateReturnObligationInput = {
  order: typeof orders.$inferSelect
  reason: ReturnReason
  now: Date
}

type ReturnObligationSnapshot = {
  mode: ReturnCompensationMode
  basePayCents: number
  bonusPercent: number
  bonusCents: number
  totalPayCents: number
}
```

For pool:

```text
base = original orders.deliveryFeeCents or 0
bonus = round(base × frozen percent / 100)
total = base + bonus
```

For shift:

```text
base = frozen driverAssignmentPayCents
bonusPercent = 0
bonus = 0
total = base
```

Calling the creator twice returns the existing snapshot. Use it for delivery failure and cancelled custody.

- [ ] **Step 5: Implement pre-custody cancellation disposition**

Under the already-held order lock:

```text
POOL + not arrived       detach, zero ledger
POOL + arrived           detach, half original fee, paired store debit
SHIFT + not arrived      detach, zero ledger
SHIFT + arrived          detach, zero ledger
collected/custody        retain driver, create return obligation
```

Calculate half once as integer rounding and use stable unique keys containing order/driver/component. Capture driver recipient before detach for Task 3.

Test cancellation × arrival and cancellation × collection races. Exactly one milestone may win.

- [ ] **Step 6: Integrate disposition into canonical cancellation and batch cleanup**

`cancelLockedOrder` must invoke the disposition before clearing assignment data. A collected cancelled batch member leaves the batch, retains its driver/return obligation, and does not alter remaining delivery members.

Commercial status remains `CANCELLED`; return obligation, not `DELIVERY_FAILED`, controls the return workflow.

Run:

```bash
pnpm --filter @delivery/api test -- order-cancellation.service.test.ts batch.service.test.ts returns.service.test.ts
```

Expected: all milestone and batch scenarios pass.

- [ ] **Step 7: Release paired ledger only after confirmed return**

Pool confirmation inserts four idempotent components when positive:

```text
DRIVER_DELIVERY_CREDIT      +base
STORE_DRIVER_FEE_DEBIT      -base
DRIVER_RETURN_ROUTE_CREDIT  +bonus
STORE_RETURN_ROUTE_DEBIT    -bonus
```

Shift confirmation inserts only:

```text
DRIVER_PER_DELIVERY_CREDIT  +base
STORE_PER_DELIVERY_DEBIT    -base
```

Before confirmation, none of these entries exist. Lock the order, require `returnedAt IS NULL`, insert ledger with unique keys, then mark confirmed in the same transaction.

Run tests for bonus `0/50/100`, odd-cent rounding, setting change after creation, duplicate confirmation, and concurrent store/admin confirmation.

- [ ] **Step 8: Make return DTOs safe and actionable**

Driver return DTO contains only:

```ts
{
  id: string
  status: 'CANCELLED' | 'DELIVERY_FAILED'
  returnReason: ReturnReason
  storeName: string
  storeAddressText: string
  returnPendingAt: string
  driverReturnedAt: string | null
  totalPayCents: number
}
```

Do not include customer address/contact/note. Store/admin projections may show proof and frozen base/bonus/total. Extend return queries to accept `CANCELLED` with a pending obligation.

Explicitly reject arrival, collect, deliver, release, and batch delivery actions for a cancelled member. Return fresh return guidance with the conflict where the current API pattern allows it.

- [ ] **Step 9: Verify settlement and authorization**

Run:

```bash
pnpm --filter @delivery/api test -- returns.service.test.ts returns.routes.test.ts finance.service.test.ts finance.routes.test.ts authorization-matrix.routes.test.ts
pnpm --filter @delivery/web test -- StoreOrdersView.test.ts AdminReturnsView.test.ts
pnpm --filter @delivery/driver test -- DeliveriesView.test.ts
```

Expected: paired entries appear once in invoice/payout documents; cross-store/driver access is denied; DTO tests contain no customer PII.

- [ ] **Step 10: Review and commit Task 2**

Run:

```bash
pnpm --filter @delivery/api test
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
pnpm --filter @delivery/shared test
pnpm typecheck
git diff --check
git status --short
```

Record objective focused-test evidence in `docs/tasks.md`. Mark `ORD-CAN-01` and `DSP-RET-01` `DONE` only if every criterion passes; otherwise use `PARTIAL` with the exact missing evidence.

Commit:

```bash
git add -- apps/api apps/web apps/driver packages/shared docs/tasks.md pnpm-lock.yaml \
  ':(exclude)apps/web/.env.development' \
  ':(exclude)apps/driver/.env.development'
git commit -m "feat(delivery): settle cancelled returns"
```

---

### Task 3: NOT-CAN-01 — Accessible warning, multi-device push, and polling convergence

**Files:**
- Create: `apps/api/src/db/schema/push.ts`
- Create: `apps/api/src/push/device.service.ts`
- Create: `apps/api/src/push/outbox.service.ts`
- Create: `apps/api/src/push/fcm-sender.ts`
- Create: `apps/api/src/routes/push.ts`
- Create: `apps/web/src/lib/push.ts`
- Create: `apps/web/public/firebase-messaging-sw.js`
- Modify: driver push/service worker, API FCM callers, cancellation service, Worker cron, store/driver layouts and order views, web tracking modal, env examples, local envs only for missing variables, migration, tests, and `docs/tasks.md`

**Interfaces:**
- Produces authenticated device endpoints and durable per-device push deliveries.
- Consumes canonical cancellation recipients/code/return state.
- Produces foreground events that trigger immediate refresh while existing polling remains active.

- [ ] **Step 1: Add RED device authorization and lifecycle tests**

Public request:

```ts
type RegisterPushDeviceInput = {
  installationId: string
  client: 'STORE_WEB' | 'DRIVER_WEB'
  token: string
}
```

Routes:

```text
POST   /me/push-devices
DELETE /me/push-devices/{installationId}
```

Test multiple devices, same installation token rotation, same token after account switch, role/client mismatch, cross-user delete, logout disable, and blocked-user disable.

Run:

```bash
pnpm --filter @delivery/api test -- push-devices.routes.test.ts push-device.service.test.ts
```

Expected RED: schema/routes/services absent.

- [ ] **Step 2: Add device and outbox schema**

Persist device fields:

```text
userId, client, installationId, token, enabled, lastSeenAt,
disabledAt, failureCount, lastFailureClass
```

Persist per-device delivery fields:

```text
eventKey, recipientUserId, deviceId, kind, orderId, reasonCode,
requiresReturn, status, attemptCount, nextAttemptAt, leasedUntil,
failureClass, sentAt, createdAt, updatedAt
```

Use unique installation ID, unique token, and unique `(eventKey, deviceId)`. Do not backfill `drivers.fcmToken`; remove it because the test database will be reset. Update all code in the same task so migration-from-zero compiles.

- [ ] **Step 3: Implement safe registration and revocation**

STORE may register only `STORE_WEB`; DRIVER only `DRIVER_WEB`. Registration transaction disables conflicting token ownership, then upserts the authenticated installation and returns only `{ id }`.

DELETE is idempotent for an owned installation and does not reveal another user's device. Account block disables all devices. Never return or log tokens.

Run the focused device suites; expected GREEN.

- [ ] **Step 4: Write RED FCM classification/outbox tests**

Test these outcomes:

```text
2xx                         SENT
network/429/5xx             retry
UNREGISTERED                disable device, terminal delivery
validated INVALID_ARGUMENT  disable device, terminal delivery
auth/config failure         terminal CONFIG failure
expired lease               reclaim once
duplicate event/device      one row
```

Retry offsets are `[0, 1m, 5m, 15m, 60m]`, lease two minutes, batch maximum 50.

Expected RED: current FCM adapter swallows all provider outcomes.

- [ ] **Step 5: Implement structured FCM sender and leased outbox**

Payload data is limited to strings:

```ts
{
  kind: 'ORDER_CANCELLED',
  orderId,
  status: 'CANCELLED',
  reasonCode,
  requiresReturn: String(requiresReturn),
  path: client === 'STORE_WEB' ? '/loja/pedidos' : '/entregas',
  tag: `order-cancelled:${orderId}`,
}
```

No notification provider response body may be logged. Logs contain only counts/failure class/request ID.

Create immediate background processing with its own short-lived DB client; request middleware cleanup must not race it. Cron reclaims pending/expired leases.

Replace existing direct dispatch push calls with this infrastructure so one token model remains.

- [ ] **Step 6: Enqueue cancellation notifications transactionally**

Before driver detach, retain the driver user ID. During the cancellation transaction, insert one delivery per active store-owner/driver device using stable event keys:

```text
order-cancelled:{orderId}:store:{ownerId}
order-cancelled:{orderId}:driver:{driverId}
```

Duplicate cancellation inserts nothing. Push insert failure caused by a database failure rolls back the whole cancellation transaction; Firebase delivery failure never rolls it back.

Add tests proving notification retries do not call cancellation, ledger, or payment services.

- [ ] **Step 7: Implement shared browser lifecycle without automatic prompts**

Both apps must:

- generate/persist a random installation ID per origin;
- show an explicit enable button;
- register a service worker with public Firebase config;
- call `getToken` with VAPID and that registration;
- register backend device;
- refresh registration on mount when permission is already granted;
- delete backend device and call Firebase `deleteToken` before authenticated logout;
- disable the known installation when browser permission becomes denied.

Remove hardcoded Firebase config from the driver service worker. Add empty `VITE_FIREBASE_*` placeholders to web examples. With the user's permission, add missing public values to local `apps/web/.env.development` and `apps/driver/.env.development` without changing existing values or staging them.

Firebase absence returns an explicit `off` state and does not fail build or business flow.

- [ ] **Step 8: Implement safe foreground/background behavior**

Use notification tag `order-cancelled:{orderId}` so visual retries replace the same notification. Service-worker click may open/focus only same-origin `/loja/pedidos` or `/entregas`; reject any payload path outside that allowlist.

Foreground message dispatches a local event, announces the cancellation, plays the existing short alert sound after user interaction permission, and requests an immediate reload. Poll intervals remain active.

Add service-worker/push helper tests with mocked Notification, ServiceWorker, Firebase, and API clients.

- [ ] **Step 9: Implement customer warning and actor convergence**

Customer tracking must consume server `cancellationPolicy`, not duplicate the matrix.

For delayed `OUT_FOR_DELIVERY`, render one accessible dialog:

```text
Primary:   Continuar aguardando
Secondary: Cancelar mesmo assim
```

Requirements:

- initial focus on primary;
- Escape/backdrop closes without mutation;
- focus restored to trigger;
- secondary makes exactly one request with `{ confirmInTransitCancellation: true }`;
- no timer, typed phrase, hidden action, or repeated prompt;
- stale conflict reloads current order and announces the result.

Store polling moves the order from active work to return confirmation/liability. Driver polling removes it when no custody or replaces it with a return card when custody exists. All forward-delivery buttons disappear for cancelled work.

Run:

```bash
pnpm --filter @delivery/web test -- OrderTrackingView.test.ts StoreOrdersView.test.ts StoreLayout.test.ts
pnpm --filter @delivery/driver test -- DeliveriesView.test.ts DriverLayout.test.ts
pnpm --filter @delivery/api test -- push-outbox.service.test.ts push-devices.routes.test.ts order-cancellation.service.test.ts
```

Expected: accessibility, exactly-one-mutation, polling-without-push, and sanitized payload tests pass.

- [ ] **Step 10: Review and commit Task 3**

Run:

```bash
pnpm --filter @delivery/api test
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
pnpm --filter @delivery/shared test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
git status --short
```

Confirm local env files are not staged. Record objective evidence in `docs/tasks.md`. Mark `NOT-CAN-01` `DONE` only after automated gates and configured local store/driver push smoke; otherwise mark `PARTIAL` and state the missing external evidence. Keep `PUSH-STAGING-01` blocked until staging Firebase provisioning is separately authorized.

Commit:

```bash
git add -- apps/api apps/web apps/driver packages/shared docs/tasks.md pnpm-lock.yaml \
  ':(exclude)apps/web/.env.development' \
  ':(exclude)apps/driver/.env.development'
git commit -m "feat(notifications): alert cancelled actors"
```

---

## Manual Validation After Explicit Reset Confirmation

- [ ] Obtain immediate destructive confirmation, then reset the local database and run all migrations plus demo seed.
- [ ] Confirm ADMIN settings are `2/10/50` and that changing them creates audit rows.
- [ ] Create offline and online orders; prove only commercially visible `PENDING` orders receive acceptance deadlines.
- [ ] Let one order time out; accept another immediately before the deadline; exercise an acceptance/timeout race.
- [ ] Cancel as customer in `AWAITING_PAYMENT`, `PENDING`, and `ACCEPTED`.
- [ ] Request store approval in `PREPARING`; cancel directly only after the delayed deadline.
- [ ] Cancel delayed `OUT_FOR_DELIVERY`; verify the warning and final server recheck.
- [ ] Pool driver: cancel before arrival, after arrival, and after collection/confirmed return.
- [ ] Shift driver: repeat all three milestones and verify no half-fee/bonus.
- [ ] Change bonus after obligation creation and prove the existing return snapshot remains unchanged.
- [ ] Cancel one batch member before and after collection; complete an unrelated member.
- [ ] Use Mercado Pago sandbox APRO/card cancellation to prove refund operation convergence.
- [ ] Enable push on separate store/driver browser profiles; verify sanitized notification and deep link.
- [ ] Disable Firebase credentials or network and prove both apps converge by polling.
- [ ] Inspect logs and database evidence without copying tokens, customer data, or provider payloads.

## Final Verification and Integration Boundary

- [ ] Use `superpowers:verification-before-completion`.

Run:

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

Verify the local env files are not staged:

```bash
if git diff --cached --name-only | rg -q '^apps/(web|driver)/\.env\.development$'; then
  printf 'local_env_staged=FAIL\n'
  exit 1
fi
printf 'local_env_staged=PASS\n'
```

Expected: all gates pass; local env files may remain modified in `git status`, but are absent from the staged diff and every commit. The branch contains exactly the three reviewed implementation commits plus any plan/ledger commit already present.

- [ ] Search for unsafe leftovers:

```bash
rg -n "fcmToken|returnDriverPayCents" apps packages --glob '!**/dist/**' --glob '!**/node_modules/**'
rg -n "set\(\{[^}]*status: 'CANCELLED'|status: 'CANCELLED'" apps/api/src --glob '*.ts'
rg -n "customerName|customerPhone|addressText|token|provider" apps/api/src/push apps/api/src/services/driver-delivery.dto.ts
```

Expected: removed legacy fields have no runtime references; direct commercial cancellation exists only in the canonical service; push/return projections contain only explicitly authorized fields.

- [ ] Use `superpowers:requesting-code-review`, correct verified findings, rerun the complete gate, then use `superpowers:finishing-a-development-branch`.

Merge locally only if the user chooses merge. Do not push or deploy.

## Completion Boundary

Completion means all three canonical tasks are `DONE` with sanitized evidence, cancellation/payment races are deterministic, driver/store finance is paired and idempotent, return data is tenant-scoped, and store/driver interfaces converge with and without push. It does not authorize staging promotion, production, public webhook ingress, live payments, media-evidence release, native packaging, or other backlog work.

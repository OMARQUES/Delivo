# Order cancellation deadlines and return-route compensation design

**Status:** approved for implementation planning
**Date:** 2026-07-17
**Canonical task IDs:** `ORD-CAN-01`, `DSP-RET-01`, `NOT-CAN-01`
**Canonical status:** [`docs/tasks.md`](../../tasks.md)

## Goal

Give customers predictable cancellation rights, prevent stores from holding paid
orders without accepting them, and settle every affected driver fairly without
making the platform share merchant business risk.

## Non-goals

- Dynamic pricing based on distance travelled after assignment.
- Platform-funded driver compensation.
- Replacing the existing Mercado Pago operation/reconciliation machinery.
- Continuous driver GPS tracking.
- Final visual design or native-only notification behavior.
- Migrating historical disposable local orders; tests may reset the database.

## Business rules

### Customer cancellation matrix

| Order state        | Before delayed threshold              | After delayed threshold      |
| ------------------ | ------------------------------------- | ---------------------------- |
| `AWAITING_PAYMENT` | Direct                                | Direct                       |
| `PENDING`          | Direct                                | Direct                       |
| `ACCEPTED`         | Direct                                | Direct                       |
| `PREPARING`        | Store approval                        | Direct                       |
| `READY`            | Store approval                        | Direct                       |
| `AWAITING_DRIVER`  | Store approval                        | Direct                       |
| `OUT_FOR_DELIVERY` | Not offered by normal flow            | Direct with two-step warning |
| `DELIVERED`        | Rejected                              | Rejected                     |
| `DELIVERY_FAILED`  | Rejected; use return/support flow     | Rejected                     |
| `CANCELLED`        | Idempotent read/result, no new effect | Same                         |

The API, not the UI, evaluates the matrix using database time, ownership, current
status, and persisted deadlines.

### Store acceptance timeout

`storeAcceptanceDeadlineAt` starts when the order enters `PENDING`:

- offline payment methods: during creation;
- online methods: only after authoritative approval changes
  `AWAITING_PAYMENT → PENDING`.

Local/test uses two minutes. Production configuration uses a separately explicit
value and must not accidentally inherit a development override. The scheduled job
claims due rows in bounded batches with `FOR UPDATE SKIP LOCKED`, rechecks status,
and applies the same canonical cancellation service used by interactive routes.

### Delayed cancellation eligibility

`storeAcceptedAt` is written once on the successful `PENDING → ACCEPTED`
transition. `lateCancellationEligibleAt` is calculated from that immutable time.

- local/test: ten minutes;
- intended production value: 90 minutes;
- changing configuration affects future acceptance deadlines, not accepted orders.

No cron automatically cancels a delayed accepted order. The threshold grants the
customer a right to cancel directly.

## Architecture

### Canonical cancellation command

All entry points call one transaction boundary, conceptually:

```ts
cancelOrder(db, {
  orderId,
  actor: { role, id },
  reason,
  expectedPolicy,
  now,
})
```

The command:

1. locks the order;
2. checks tenant/actor ownership and current state;
3. resolves cancellation eligibility from persisted deadlines;
4. resolves batch, amendment, broadcast, assignment, custody, and return effects;
5. transitions the commercial order once;
6. inserts one audit/order event;
7. queues one canonical payment disposition;
8. creates idempotent ledger entries or a return obligation when required;
9. returns a projection describing commercial, financial, and delivery resolution.

Customer routes, store decisions, acceptance-timeout cron, amendment rejection,
and future admin support must not implement independent cancellation side effects.

### Required persisted facts

Exact migration names may follow Drizzle conventions, but the model must preserve:

- store acceptance deadline;
- first store acceptance time;
- late-cancellation eligibility time;
- canonical cancellation origin/reason/time;
- whether custody requires return;
- frozen driver compensation mode;
- frozen base compensation cents;
- frozen return bonus percent and cents;
- frozen total compensation cents.

A singleton platform-settings row stores the current global return-route bonus.
The default is 50 and the validated ADMIN range is integer 0 through 100. Updating
it requires privileged authorization and an audit record. Order/return snapshots
are never recalculated from the current setting.

## Driver disposition

### Classification

- General pool: accepted without a valid closed-shift assignment; normally
  `shiftId` is null.
- Shift/own: accepted through an active store shift and freezes that shift's
  `perDeliveryCents`.

Broadcast target alone is insufficient: `OWN`/`SPECIFIC` describes routing, while
the accepted assignment determines payment.

### Before custody

| Milestone                        |              General pool | Shift/own |
| -------------------------------- | ------------------------: | --------: |
| Assigned, no confirmed arrival   |                         0 |         0 |
| Arrival confirmed, not collected | 50% original delivery fee |         0 |

Cancellation closes broadcasts, removes the active assignment, notifies the
driver, and creates idempotent general-pool half-fee/store-debit entries only when
arrival is already persisted.

### After custody

Collection (`OUT_FOR_DELIVERY`) means the driver has custody. Cancellation:

- immediately stops customer delivery;
- keeps driver/order linkage needed for the return;
- creates a return obligation;
- provides return-to-store instructions;
- refunds/cancels the customer payment through the existing durable operation;
- releases no driver credit until return confirmation.

After store/admin confirms the return:

- general pool receives original delivery fee plus the frozen bonus;
- default bonus is 50% of original delivery fee;
- store receives equal aggregate debits;
- shift/own receives only frozen `perDeliveryCents`, with matching store debit;
- confirmation/retry is idempotent.

The same obligation creator must cover delayed cancellation, failed delivery, and
future cases where driver custody requires return. Existing proof upload and
store/admin confirmation remain the release gate.

## Payment behavior

Commercial cancellation does not pretend financial completion:

- not charged/provider terminal: record no-charge/cancelled result;
- provider pending: request cancellation and reconcile;
- provider approved: request full refund and reconcile;
- provider unknown/racing: retain safe processing/review state until authoritative
  resolution.

The synthetic local PIX helper changes local rows but not Mercado Pago. Therefore
its cancellation may legitimately show that provider analysis is pending. This is
test divergence, not production proof; production alerting must catch operations
that exceed the defined reconciliation SLA.

## Batch behavior

Cancelling one order must not cancel unrelated orders in the batch. Under lock:

- remove the order from the batch;
- preserve the batch assignment for remaining orders;
- recalculate exposed totals/counts from current rows;
- if the cancelled order was already in driver custody, create its own return
  obligation without corrupting the remaining route;
- prevent collection/delivery mutations for the cancelled member.

## Notifications and UX

For delayed `OUT_FOR_DELIVERY` cancellation, the customer sees one modal:

- the driver already has the order;
- delivery is underway;
- cancellation will trigger refund and return to store;
- waiting remains recommended;
- “Continue waiting” is primary;
- “Cancel anyway” remains available without artificial friction.

The final mutation revalidates state and deadline. A stale UI cannot cancel a
delivered order.

Store and driver receive best-effort push containing only sanitized order/status
data. Polling/API state is authoritative. Once cancellation commits:

- driver actions that would continue customer delivery fail;
- without custody, the item disappears from active work;
- with custody, the app changes to a return task;
- store sees the return confirmation action and compensation liability.

## Security and audit

- CUSTOMER can affect only own order.
- STORE can decide only own-store request/return.
- DRIVER can view/act only on assigned return.
- ADMIN setting/return confirmation requires privileged authorization and later
  step-up under `SEC-MFA-01`.
- Events contain actor, reason code, request ID where available, and timestamp;
  no provider body, token, exact GPS history, or unnecessary PII.
- Financial ledger unique keys encode stable business intent and prevent duplicate
  credit/debit.
- Configuration and compensation arithmetic use integers; rounding occurs once
  when the obligation is created.

## Failure handling

- Database transaction failure commits no partial commercial/ledger state.
- Push failure does not roll back cancellation and is retried/best-effort.
- Provider timeout leaves durable operation pending; no synchronous guess.
- Concurrent cancellation returns the canonical existing result.
- Concurrent return confirmations have one winner.
- A cancelled driver mutation returns a stable conflict and the fresh return or
  terminal projection.
- Cron processes bounded batches and reports sanitized counts/failure classes.

## Test strategy

### State and concurrency

- every matrix state before/after threshold;
- acceptance versus timeout race;
- preparation versus fast cancel race;
- collection versus delayed cancel race;
- delivery completion versus final cancel confirmation;
- duplicate customer/store/cron cancellation;
- batch member cancellation.

### Driver finance

- pool: no arrival, arrival, collection/return;
- shift/own: same milestones with no half/bonus;
- 0%, 50%, and 100% global bonus;
- setting changes after obligation creation;
- concurrent store/admin return confirmation;
- exact paired store debits;
- settlement includes entries once.

### Payment

- offline method;
- provider pending cancellation;
- approved refund;
- provider approval racing cancellation;
- webhook/cron/background retry;
- local synthetic PIX divergence;
- sandbox APRO/card refund manual smoke.

### Authorization and UX

- cross-customer/store/driver negatives;
- terminal order rejection;
- warning modal behavior and accessibility;
- push failure with polling convergence;
- no sensitive fields in event/push projections.

## Completion boundary

The program is complete only when the three canonical task entries are `DONE`,
their focused and full gates pass, local manual scenarios cover both pool and
shift drivers, sandbox cancel/refund remains healthy, and `docs/tasks.md` records
the sanitized evidence. This does not authorize production; the separate security
and production blockers in the canonical ledger still apply.

# Mercado Pago Orders Completion Corrective Design

**Status:** approved design; implementation pending

## Goal

Close the financial-integrity, concurrency, reconciliation, and test-coverage gaps found after corrective Tasks 13–15, without changing the Orders-only Mercado Pago cutover or enabling staging/production payments.

## Scope

This corrective cycle is divided into three independently reviewable tasks:

- Task 16: exact financial invariants and serialized operation outcomes.
- Task 17: atomic business transitions and concurrency-safe recovery.
- Task 18: bounded reconciliation, webhook background isolation, complete regression matrix, and final gate.

The work remains local. It does not authorize provider activation, staging secrets, real charges, staging database migration, deployment, or production rollout.

## Global invariants

- PostgreSQL remains the durable source of truth for payment state, provider-operation intent, dependency ordering, retries, and manual-review state.
- Provider calls remain outside PostgreSQL transactions.
- Every provider mutation uses its already-persisted idempotency key.
- A financial operation is successful only after an authoritative provider snapshot proves its exact persisted target.
- Established provider identifiers, confirmed financial status, and cumulative refunded cents never regress because of a contradictory snapshot.
- A business decision and its required financial intent commit atomically or both roll back.
- Every durable work item has at most eight attempts; exhaustion becomes `REVIEW_REQUIRED`.
- Background and cron work is bounded, lease-safe, retryable, and free of request-owned database clients.
- Logs, summaries, errors, fixtures, and documentation never expose access tokens, webhook secrets, card tokens, payer emails, QR contents, provider bodies, signatures, database URLs, or credentials.

## Task 16 — Exact financial invariants

### Snapshot validation

`validateSnapshot` must fail closed before classifying a snapshot as financially complete:

- `processingMode` must equal `automatic`; any other value produces `UNSUPPORTED_PROCESSING_MODE`.
- `REFUNDED` requires `refundedAmountCents === expected.amountCents`.
- A refunded total below, above, negative, non-integer, or otherwise contradictory to the expected total produces `MISMATCH_REFUNDED_AMOUNT`.
- A partial-refund snapshot requires a positive cumulative value no greater than the expected payment total.

### Safe review persistence

When validation produces `REVIEW_REQUIRED`, the transition layer records only safe observational fields:

- provider status and status detail;
- reconciliation state and failure code;
- reconciliation timestamps.

It must preserve:

- an established `providerOrderId` or `providerTransactionId`;
- local `APPROVED` or `REFUNDED` status;
- the highest authoritative cumulative refunded amount;
- confirmed QR and expiry data when the contradictory snapshot is not allowed to replace them.

Provider identifiers may be attached only when the local field is null and uniqueness checks find no conflict.

### Operation-specific outcomes

`REFUND_FULL` succeeds only when the authoritative snapshot is `REFUNDED` and cumulative refunded cents equal the payment total.

`REFUND_PARTIAL` succeeds when cumulative refunded cents equal the operation's persisted `expectedRefundedAmountCents`. The provider may report `PARTIALLY_REFUNDED` or `REFUNDED`; the exact target controls completion. A lower value retries, while a greater or contradictory value requires review.

`CANCEL` succeeds directly only for `CANCELLED`, `EXPIRED`, or an already fully refunded payment. If an authoritative snapshot is approved or partially refunded, the same settlement transaction must:

1. create or verify one dependent `REFUND_FULL` operation;
2. preserve the cancellation intent instead of reopening the order;
3. mark the cancel operation `SUCCEEDED/ESCALATED_TO_REFUND` only after the dependent operation is durable.

### Retry exhaustion

One scheduling function owns the retry decision for direct provider results, transient exceptions, authoritative requery results, and webhook inbox failures. Attempt eight does not schedule attempt nine; it persists `REVIEW_REQUIRED` with a stable failure class and releases the lease.

### Exact operation deduplication

Operation enqueue locks the payment and derives the cumulative target before accepting an existing business key. Idempotent reuse requires equality of:

- payment ID;
- operation type;
- requested amount;
- expected cumulative refunded target;
- idempotency key.

Any divergence is a business-key conflict and rolls back the caller transaction.

## Task 17 — Atomicity and concurrency

### Uncertain-create compare-and-set

`recoverUncertainCreate` may perform provider search or create outside a transaction. Before every resulting local write, it starts a short transaction, locks the payment, and verifies that it remains `PENDING` with `providerOrderId IS NULL`.

If webhook processing or another reconciler has already identified or advanced the payment, recovery performs no stale write. It reloads the authoritative local state and returns the corresponding recovered or review result.

This guard applies to:

- transient retry scheduling;
- `FRESH_CARD_REQUIRED`;
- ambiguous/not-found review;
- uncertain PIX expiration;
- recovered provider snapshots;
- recreated PIX snapshots.

An uncertain PIX may be expired locally only while it still has no provider order. An identified PIX must be cancelled through a durable provider operation.

### Amendment decisions

Approval and rejection transactions lock and revalidate the order, proposed amendment, and amendment items before changing state.

Approval atomically applies item quantities and totals, resolves the amendment, records events, and persists any partial-refund intent.

Rejection atomically claims the amendment, performs a successful compare-and-set cancellation, records the event, and persists the cancellation/refund intent. A failed order compare-and-set throws and rolls back the amendment resolution and operation.

### Idempotent failed delivery

The first `failDelivery` transition atomically records `DELIVERY_FAILED`, its event, return information, and financial disposition.

A repeated identical request verifies that the deterministic operation business key exists with the exact expected fields. If the business transition exists but its operation is missing, the retry repairs the missing intent transactionally. A conflicting existing operation fails closed.

### Bounded stale-order cancellation

Stale pending-order cancellation claims a configured batch of IDs with row locking and `skip locked`, then processes each decision atomically. Concurrent cron runs cannot cancel or enqueue the same order twice.

The obsolete `expireStaleAwaitingPayment` wrapper is removed so PIX/provider expiration remains owned only by payment reconciliation.

## Task 18 — Reconciliation and final verification

### Dependency propagation

Dependency propagation selects only `PENDING` or `PROCESSING` children whose direct predecessor is `REVIEW_REQUIRED`. It updates one bounded batch and repeats until:

- no new child becomes eligible; or
- the total per-run operation budget is exhausted.

Already-reviewed rows never occupy later batches. Deep chains converge within the bounded run instead of starving behind previously reviewed rows.

### Persisted reconciliation failures

Known validation failures such as `MISMATCH_ACCOUNT` pass through normal snapshot validation and persist actionable payment review state. Provider failures update a stable failure class and a bounded next-reconcile time or enter review on exhaustion; they are not represented only by an aggregate `stageFailures` counter.

Every configured stage limit is clamped to the inclusive range 1–100. Tests disable a stage through an explicit test-only stage selector rather than a production limit of zero.

### Webhook inbox

Webhook processing follows the same eight-attempt policy as payment operations. On exhaustion, the inbox record becomes `REVIEW_REQUIRED`, clears its lease, and stops being claimed automatically.

After a webhook is authenticated and durably inserted, immediate best-effort processing uses a dedicated PostgreSQL client created inside `waitUntil`. The background function owns that client from creation through `client.end()`. It never receives `c.get('db')` from the request middleware.

The durable inbox plus cron remains the recovery path if immediate processing fails.

### Required regression matrix

The final corrective tests must cover:

- refunded status with zero, partial, excessive, and exact full cents;
- unsupported processing mode;
- review snapshots preserving established IDs, status, and cumulative refund;
- partial refund reaching its target with both partial and full provider status;
- cancel approval creating exactly one dependent full refund;
- cancel escalation from PIX expiration without reopening the order;
- attempt-eight exhaustion for cancel, full refund, partial refund, and inbox;
- operation dedupe with a conflicting cumulative target;
- dependency chains deeper than two and batches containing already-reviewed rows;
- two workers competing for the same operation, inbox item, uncertain create, and stale order;
- uncertain recovery racing a webhook and an authoritative snapshot;
- amendment approve/reject compare-and-set rollback;
- failed-delivery intent repair and conflicting-operation failure;
- bounded stale-order cancellation;
- isolation of every reconciliation stage when another stage throws;
- transient PIX retry and identified PIX provider cancellation;
- persisted account mismatch;
- dedicated webhook background-client ownership and cleanup;
- summaries and logs containing no raw payer email or sensitive provider material.

### Final gate

After focused tests pass, the branch must pass:

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

The review also proves that the intended R2 and Hyperdrive staging bindings remain unchanged, no legacy Mercado Pago Payments API symbols return, and no secret-shaped value was added to tracked files.

## Completion boundary

Completion means the Orders API implementation has exact financial outcomes, atomic local decisions, concurrency-safe recovery, bounded durable reconciliation, and a complete automated regression matrix. It is then eligible for local merge review and manual sandbox testing.

Completion does not mean staging or production payments are enabled. Provider credentials, webhook exposure, real transaction smoke, staging migration, deployment, and production activation require separate explicit authorization.

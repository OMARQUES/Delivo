# Mercado Pago Reconciliation Conformance Corrective Design

**Status:** approved design; implementation pending

## Goal

Close the three remaining Task 18 conformance gaps: exact concurrent inbox accounting, complete reconciliation isolation/sanitization coverage, and one authoritative snapshot-validation path.

## Scope

This cycle contains three independently reviewable tasks:

- Task 19: make webhook inbox claim outcomes explicit and prove exact overlap accounting for inbox, operations, and snapshots;
- Task 20: complete the eight-stage isolation matrix and sanitized summary/log regression coverage;
- Task 21: remove manual account-mismatch persistence, route snapshot refresh through the standard validator, and run the final regression gate.

The optimization that creates the webhook provider before the background database client is outside this cycle. There are no schema, migration, API-route, provider-activation, staging-secret, deployment, or production changes.

## Global invariants

- PostgreSQL remains the durable source of truth.
- Existing row locks, leases, compare-and-set predicates, retry limits, and provider idempotency keys remain unchanged.
- Provider calls remain outside PostgreSQL transactions.
- No second claim implementation or before/after counting query is introduced.
- Reconciliation summaries contain bounded numeric counters only.
- Tests and logs never expose provider payloads, access tokens, webhook secrets, signatures, payer data, QR contents, database URLs, or credentials.
- Every production-code change starts with a focused failing test and ends with focused and API-wide verification.

## Task 19 — Exact concurrent accounting

### Inbox processing result

`processWebhookInboxItem` returns an explicit claim outcome:

```ts
export type WebhookInboxProcessResult = 'CLAIMED' | 'NOT_CLAIMED'

export async function processWebhookInboxItem(
  db: Db,
  provider: PaymentProvider,
  inboxId: string,
  leaseOwner: string,
  now: Date,
): Promise<WebhookInboxProcessResult>
```

It returns `NOT_CLAIMED` when the locking transaction finds no eligible row. Once a row is claimed, every non-throwing durable outcome returns `CLAIMED`, including `PROCESSED` and `REVIEW_REQUIRED`. Transient provider failures continue to persist their retry disposition and throw; they increment `stageFailures`, not `inboxProcessed`.

The reconciliation inbox loop increments `summary.inboxProcessed` only when the result is `CLAIMED`. Existing direct callers may ignore the returned value without changing their behavior.

### Overlap contract

A deterministic PostgreSQL integration test starts two reconcilers at the same time against one eligible inbox row, one due operation, and one due snapshot. Across both summaries:

- `inboxProcessed` sums to exactly one;
- `operationsReleased` and `operationsProcessed` each sum to exactly one;
- `snapshotsRefreshed` sums to exactly one;
- the inbox and operation attempt counts are exactly one;
- each durable record reaches its expected single terminal or next state;
- no duplicate provider mutation occurs.

## Task 20 — Complete reconciliation regression matrix

### Stage isolation

The test suite covers all eight stages individually:

```text
leases
dependencies
inbox
operations
creates
snapshots
expirations
reviews
```

Each table-driven case creates one eligible sentinel for the selected stage plus explicit unrelated sentinels that would change if another stage ran. It supplies provider spies for every provider capability, runs reconciliation with exactly one stage enabled, and proves:

- the selected stage performs its expected durable transition;
- all unrelated summary counters remain zero;
- all unrelated durable sentinels remain unchanged;
- unrelated provider methods are not called;
- `stageFailures` has the exact expected value rather than a vacuous non-negative assertion.

### Sanitization

A focused test serializes the returned summary and captures reconciliation-path console methods. It seeds unique forbidden markers representing a provider payload, access token, webhook secret, signature, payer email, QR content, and database URL. The test proves none of those markers appear in the summary, emitted log arguments, or thrown error text.

The summary's exact public keys remain:

```text
leasesRecovered
dependenciesReviewed
operationsReleased
inboxProcessed
operationsProcessed
createsRecovered
snapshotsRefreshed
pixExpired
reviewsRechecked
stageFailures
```

No production logging is added merely to satisfy the test.

## Task 21 — One snapshot-validation authority

The pending-snapshot stage removes `persistMismatch`, removes the `account` parameter from `refreshPendingSnapshot`, and stops calling `provider.getAccountId()` for snapshot reconciliation. After the existing payment claim, every provider snapshot is passed directly to `applyProviderSnapshot`.

`applyProviderSnapshot` loads the locked payment and derives `ExpectedPayment` from persisted immutable expectation fields. `validateSnapshot` remains the sole authority for `MISMATCH_ACCOUNT` and every other snapshot invariant. An account mismatch must therefore persist the same safe `REVIEW_REQUIRED` state as all other known validation failures, without overwriting established financial identifiers or state.

Focused regression tests prove:

- a snapshot account mismatch is persisted through the standard transition path;
- `provider.getAccountId()` is not required by the snapshots stage;
- provider failures retain the existing bounded retry behavior;
- overlapping snapshot reconcilers still transition one payment once.

## Verification and completion

Each task ends with its focused tests, API tests, diff review, and one commit. Task 21 additionally runs the repository typecheck, lint, tests, builds, staging frontend builds, Worker dry-runs, migration-from-zero check, secret scan, legacy-payment-route scan, `git diff --check`, and clean-status verification defined by the existing completion corrective plan.

This corrective cycle is complete only when the exact overlap, isolation, sanitization, and single-validator tests pass and the final gate reports no failure. It does not authorize a merge, deployment, staging payment smoke, or production activation.

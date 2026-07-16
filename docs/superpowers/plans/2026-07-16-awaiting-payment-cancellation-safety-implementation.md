# Awaiting-Payment Cancellation Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline; do not dispatch subagents unless the user explicitly changes the current preference.

**Goal:** Cancel PIX and card orders that remain `AWAITING_PAYMENT` for 30 minutes or are cancelled earlier by their customer, while durably converging Mercado Pago to cancellation, no charge, full refund, or explicit financial review.

**Architecture:** Keep `orders.status` as the immediate commercial decision and use `payments` plus `payment_operations` as the durable financial state. One canonical disposition helper deduplicates every cancellation/refund source; payment-first row locking prevents approval/cancellation races from reopening a cancelled order. The request path only commits local state and schedules focused best-effort processing, while the reordered reconciliation cron remains the durable fallback.

**Tech Stack:** TypeScript 6, Hono 4, Vue 3, Vite 8, Vitest 4, PostgreSQL 17, Drizzle ORM/Kit, Cloudflare Workers, Mercado Pago Orders API.

## Global Constraints

- Implement this as one reviewable task and one final implementation commit; use the checkbox steps as the internal TDD checkpoints.
- Preserve the user's existing ignored edits in `apps/web/.env.development` and `apps/driver/.env.development`; do not stage, rewrite, print, or commit their contents.
- Do not reset any database, deploy, change Mercado Pago/Cloudflare dashboards, or modify staging/production resources.
- Do not add a legacy-data backfill. The disposable local database will be reset by the user only after implementation and automated verification.
- Keep the awaiting-payment deadline exactly 30 minutes for PIX and card. With the five-minute cron, automatic processing may begin between 30 and 35 minutes.
- Do not add an order status or table. `orders.status` remains commercial state; `payments` and `payment_operations` remain financial state.
- Once cancellation commits, no provider snapshot, webhook, create recovery, operation, or cron may reopen or release the order.
- Provider mutations occur only through the existing durable operation queue and are confirmed by an authoritative `GET Order`; never infer success from timeout, 404, 409, 429, 5xx, an empty body, or mutation response alone.
- Preserve the maximum of eight financial attempts. Exhaustion becomes `REVIEW_REQUIRED/RETRY_EXHAUSTED` and never reopens the order.
- Never log or newly persist provider response bodies, webhook bodies, card tokens, payer emails, credentials, PIX payloads, or full provider identifiers.
- Store-facing actionable queries must continue excluding `AWAITING_PAYMENT` and `CANCELLED`.
- Follow payment-then-order lock order in all payment-specific approval/cancellation paths.

---

### Task 1: Implement safe awaiting-payment cancellation end to end

**Files:**
- Create: `apps/api/src/payments/cancellation.service.ts`
- Create: `apps/api/src/payments/operation-background.service.ts`
- Create: `apps/api/drizzle/0030_safe_pending_cancellation.sql` via Drizzle generation
- Create: `apps/api/drizzle/meta/0030_snapshot.json` via Drizzle generation
- Create: `apps/web/src/views/OrderTrackingView.test.ts`
- Modify: `apps/api/src/payments/constants.ts`
- Modify: `apps/api/src/payments/mercadopago.ts`
- Modify: `apps/api/src/db/schema/payments.ts`
- Modify: `apps/api/drizzle/meta/_journal.json` via Drizzle generation
- Modify: `apps/api/src/services/order.service.ts`
- Modify: `apps/api/src/services/payment.service.ts`
- Modify: `apps/api/src/services/order-status.service.ts`
- Modify: `apps/api/src/services/amendment.service.ts`
- Modify: `apps/api/src/services/dispatch.service.ts`
- Modify: `apps/api/src/payments/operation-queue.service.ts`
- Modify: `apps/api/src/payments/operation.service.ts`
- Modify: `apps/api/src/payments/transition.service.ts`
- Modify: `apps/api/src/payments/checkout.service.ts`
- Modify: `apps/api/src/payments/reconciliation.service.ts`
- Modify: `apps/api/src/routes/orders.ts`
- Modify: `apps/api/test/payment.schema.test.ts`
- Modify: `apps/api/test/orders.routes.test.ts`
- Modify: `apps/api/test/payment.service.test.ts`
- Modify: `apps/api/test/payment-operation.service.test.ts`
- Modify: `apps/api/test/payment-reconciliation.test.ts`
- Modify: `apps/api/test/store-orders.routes.test.ts`
- Modify: `apps/web/src/views/OrderTrackingView.vue`
- Modify: `docs/security/runbooks/mercado-pago-orders.md`

**Interfaces:**
- Rename constants to `ONLINE_PAYMENT_EXPIRATION_MS = 30 * 60_000` and `ONLINE_PAYMENT_EXPIRATION_DURATION = 'PT30M'`.
- Produce `ensureCancelledOrderPaymentDisposition(tx, payment, now): Promise<PaymentDispositionResult>` where `PaymentDispositionResult` is `{ operationId: string | null; type: 'CANCEL' | 'REFUND_FULL' | null; inserted: boolean }`.
- Produce `cancelCustomerOrder(db, customerId, orderId, now): Promise<CancellationResult>` and `expireAwaitingPayment(db, paymentId, now): Promise<CancellationResult | null>` where `CancellationResult` is `{ order: typeof orders.$inferSelect; operationId: string | null; changed: boolean }`.
- Produce `claimPaymentOperationById(db, operationId, now, leaseOwner): Promise<boolean>` and `processPaymentOperationInBackground(env, operationId, now): Promise<void>`.
- Extend `PaymentOperationResultCode` with `'NOT_CHARGED'`.
- Extend customer order detail with `paymentResolution: 'PROCESSING' | 'NOT_CHARGED' | 'REFUNDED' | 'REVIEW_REQUIRED' | null`; awaiting PIX/card detail exposes `payment.expiresAt`, while only PIX exposes QR artifacts.

- [ ] **Step 1: Record the clean implementation boundary and run the baseline**

Run:

```bash
git status --short
git branch --show-current
pnpm --filter @delivery/api exec vitest run \
  test/payment.schema.test.ts \
  test/mercadopago.test.ts \
  test/payment.service.test.ts \
  test/payment-operation.service.test.ts \
  test/payment-reconciliation.test.ts \
  test/orders.routes.test.ts \
  test/store-orders.routes.test.ts
pnpm --filter @delivery/web test
```

Expected:

```text
git status shows only the two pre-existing ignored local environment edits.
The current branch is main or a new isolated implementation branch created from main.
All selected API and web tests pass before edits.
```

If implementation isolation is needed, use `superpowers:using-git-worktrees` and create branch `feat/awaiting-payment-cancellation-safety`; do not copy or expose the two ignored environment files.

- [ ] **Step 2: Write RED tests for the shared 30-minute deadline and schema**

In `apps/api/test/orders.routes.test.ts`, extend the existing online-order test so both methods prove the same persisted deadline:

```ts
it.each([
  ['PIX_ONLINE', 'PIX'],
  ['CARD_ONLINE', 'CARD'],
] as const)('persists a 30-minute deadline for %s', async (paymentMethod, gatewayMethod) => {
  const before = Date.now()
  const created = await postOrder({
    paymentMethod,
    idempotencyKey: crypto.randomUUID(),
    ...(paymentMethod === 'CARD_ONLINE'
      ? { cardToken: 'card-token-not-persisted', cardPaymentMethodId: 'visa' }
      : {}),
  })
  expect(created.status).toBe(201)
  const [payment] = await testDb.select().from(payments)
    .where(eq(payments.method, gatewayMethod))
    .orderBy(desc(payments.createdAt))
    .limit(1)
  expect(payment?.expiresAt).not.toBeNull()
  expect(payment!.expiresAt!.getTime() - payment!.createdAt.getTime()).toBe(30 * 60_000)
  expect(payment!.createdAt.getTime()).toBeGreaterThanOrEqual(before)
})
```

Use the suite's existing authenticated `postOrder` fixture and fake provider; do not introduce real credentials or provider I/O.

In `apps/api/test/payment.schema.test.ts`, change the enum expectation and assert the partial index predicate:

```ts
expect(operationResultEnum.map((row) => row.enumlabel)).toEqual([
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'ESCALATED_TO_REFUND',
  'NOT_CHARGED',
])

const expiryIndexes = await testDb.execute<{ indexname: string; indexdef: string }>(sql`
  select indexname, indexdef
  from pg_indexes
  where schemaname = 'public' and indexname = 'payments_pending_expires_at_idx'
`)
expect(expiryIndexes).toHaveLength(1)
expect(expiryIndexes[0]!.indexdef).toContain('(expires_at)')
expect(expiryIndexes[0]!.indexdef).toContain("WHERE ((status = 'PENDING'::payment_status) AND (expires_at IS NOT NULL))")
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.schema.test.ts test/orders.routes.test.ts
```

Expected: FAIL because card `expires_at`, `NOT_CHARGED`, and `payments_pending_expires_at_idx` do not exist yet.

- [ ] **Step 3: Implement the shared deadline, schema change, and migration**

Replace `apps/api/src/payments/constants.ts` with:

```ts
export const ONLINE_PAYMENT_EXPIRATION_MS = 30 * 60_000
export const ONLINE_PAYMENT_EXPIRATION_DURATION = 'PT30M'
```

Update `apps/api/src/payments/mercadopago.ts` to use `ONLINE_PAYMENT_EXPIRATION_DURATION` only in the PIX request payload. Update `apps/api/src/payments/checkout.service.ts` and `apps/api/src/services/order.service.ts` to use `ONLINE_PAYMENT_EXPIRATION_MS`. The payment-attempt call in `createOrder` must be:

```ts
const paymentNow = new Date()
paymentAttempt = await createPaymentAttempt(tx, {
  orderId: order.id,
  method: input.paymentMethod === 'PIX_ONLINE' ? 'PIX' : 'CARD',
  amountCents: order.totalCents,
  applicationId: paymentCtx!.applicationId,
  accountId: paymentCtx!.accountId,
  liveMode: paymentCtx!.liveMode,
  expiresAt: new Date(paymentNow.getTime() + ONLINE_PAYMENT_EXPIRATION_MS),
  now: paymentNow,
})
```

In `apps/api/src/db/schema/payments.ts`, append `NOT_CHARGED` and the partial index:

```ts
export const paymentOperationResultCode = pgEnum('payment_operation_result_code', [
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'ESCALATED_TO_REFUND',
  'NOT_CHARGED',
])

index('payments_pending_expires_at_idx')
  .on(t.expiresAt)
  .where(sql`${t.status} = 'PENDING' and ${t.expiresAt} is not null`),
```

Generate the migration:

```bash
pnpm --dir apps/api exec drizzle-kit generate --name safe_pending_cancellation
```

Expected generated SQL contains only the enum addition and partial index, equivalent to:

```sql
ALTER TYPE "public"."payment_operation_result_code" ADD VALUE 'NOT_CHARGED';
CREATE INDEX "payments_pending_expires_at_idx" ON "payments" USING btree ("expires_at") WHERE "payments"."status" = 'PENDING' and "payments"."expires_at" is not null;
```

Verify no legacy backfill was generated:

```bash
rg -n "UPDATE|INSERT INTO|DELETE FROM" apps/api/drizzle/0030_safe_pending_cancellation.sql
```

Expected: no matches. Then run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.schema.test.ts test/orders.routes.test.ts
```

Expected: PASS.

- [ ] **Step 4: Write RED tests for one canonical financial disposition**

In `apps/api/test/payment.service.test.ts`, replace transition-specific key expectations and add table-driven cancelled-order snapshots:

```ts
it('deduplicates every cancellation source into one canonical intent', async () => {
  const { order, payment } = await makePayment('CANCELLED')
  const now = new Date('2026-07-16T12:00:00.000Z')
  const [first, second] = await testDb.transaction(async (tx) => Promise.all([
    ensureCancelledOrderPaymentDisposition(tx, payment, now),
    ensureCancelledOrderPaymentDisposition(tx, payment, now),
  ]))
  expect(first.type).toBe('CANCEL')
  expect(second.operationId).toBe(first.operationId)
  const rows = await testDb.select().from(paymentOperations)
    .where(eq(paymentOperations.businessKey, `cancel:${payment.id}:ORDER_CANCELLED`))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.idempotencyKey).toBe(`c:oc:${payment.id}`)
  expect((await testDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('CANCELLED')
})

it.each([
  ['PENDING', 'CANCEL'],
  ['APPROVED', 'REFUND_FULL'],
  ['REJECTED', null],
  ['CANCELLED', null],
  ['EXPIRED', null],
  ['REFUNDED', null],
] as const)('maps cancelled payment %s to %s', async (status, expectedType) => {
  const { payment } = await makePayment('CANCELLED')
  await testDb.update(payments).set({ status }).where(eq(payments.id, payment.id))
  const current = (await testDb.select().from(payments).where(eq(payments.id, payment.id)))[0]!
  const result = await ensureCancelledOrderPaymentDisposition(testDb, current, new Date())
  expect(result.type).toBe(expectedType)
})
```

Also add assertions to the existing late-approval test that both the snapshot path and CANCEL escalation find exactly:

```ts
expect(await testDb.select().from(paymentOperations).where(and(
  eq(paymentOperations.paymentId, payment.id),
  eq(paymentOperations.type, 'REFUND_FULL'),
))).toHaveLength(1)
expect(refund.businessKey).toBe(`refund-full:${payment.id}:ORDER_CANCELLED`)
expect(refund.idempotencyKey).toBe(`rf:oc:${payment.id}`)
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts test/payment-operation.service.test.ts
```

Expected: FAIL because `ensureCancelledOrderPaymentDisposition` and canonical keys are not implemented.

- [ ] **Step 5: Implement canonical disposition and terminal no-charge outcomes**

Replace transition-specific disposition code in `apps/api/src/services/payment.service.ts` with:

```ts
export type PaymentDispositionResult = {
  operationId: string | null
  type: 'CANCEL' | 'REFUND_FULL' | null
  inserted: boolean
}

export async function ensureCancelledOrderPaymentDisposition(
  tx: Db | DbTransaction,
  payment: typeof payments.$inferSelect,
  now: Date,
): Promise<PaymentDispositionResult> {
  if (!payment.providerOrderId) return { operationId: null, type: null, inserted: false }
  const type = payment.status === 'PENDING'
    ? 'CANCEL' as const
    : payment.status === 'APPROVED'
      ? 'REFUND_FULL' as const
      : null
  if (!type) return { operationId: null, type: null, inserted: false }
  const prefix = type === 'CANCEL' ? 'cancel' : 'refund-full'
  const operation = await enqueuePaymentOperation(tx, {
    paymentId: payment.id,
    type,
    amountCents: null,
    businessKey: `${prefix}:${payment.id}:ORDER_CANCELLED`,
    idempotencyKey: providerIdempotencyKey(type === 'CANCEL' ? 'c:oc' : 'rf:oc', payment.id),
  }, now)
  return { operationId: operation.id, type, inserted: operation.inserted }
}

export async function enqueueOrderPaymentDisposition(
  tx: Db | DbTransaction,
  orderId: string,
  now: Date,
): Promise<PaymentDispositionResult> {
  const payment = await getOrderPayment(tx, orderId, true)
  return payment
    ? ensureCancelledOrderPaymentDisposition(tx, payment, now)
    : { operationId: null, type: null, inserted: false }
}
```

Update every caller in `order-status.service.ts`, `amendment.service.ts`, and `dispatch.service.ts` to remove the transition argument and pass only `(tx, orderId, now)`.

In `apps/api/src/payments/operation-queue.service.ts`, add `'NOT_CHARGED'` to `PaymentOperationResultCode`.

In `apps/api/src/payments/operation.service.ts`, change CANCEL evaluation to:

```ts
if (operation.type === 'CANCEL') {
  if (decision === 'CANCELLED') return { kind: 'SUCCEEDED', resultCode: 'CANCELLED' }
  if (decision === 'REJECTED' || decision === 'EXPIRED') {
    return { kind: 'SUCCEEDED', resultCode: 'NOT_CHARGED' }
  }
  if (decision === 'REFUNDED' && refundedAmountCents === expectedAmountCents) {
    return { kind: 'SUCCEEDED', resultCode: 'REFUNDED' }
  }
  if (decision === 'APPROVED' || decision === 'PARTIALLY_REFUNDED') {
    return { kind: 'ESCALATE_TO_REFUND' }
  }
  if (decision === 'PENDING') return { kind: 'RETRY', failureClass: 'CANCEL_PENDING' }
  return { kind: 'REVIEW_REQUIRED', failureClass: 'CANCEL_OUTCOME_INVALID' }
}
```

Replace the escalation-specific refund enqueue with `ensureCancelledOrderPaymentDisposition(tx, approvedPayment, now)` after the payment snapshot is persisted as `APPROVED`. In `transition.service.ts`, replace `LATE_APPROVAL` enqueue logic with the same helper. Add this option and use it when settling a CANCEL operation so the operation cannot recursively ensure itself:

```ts
export type SnapshotTransitionOptions = {
  ensureCancelledDisposition?: boolean
  releaseOrderOnApproval?: boolean
}

const [persistedPayment] = await tx.update(payments).set({
  ...providerFields,
  status: decision.kind === 'REFUNDED' ? 'REFUNDED' : 'APPROVED',
  refundedAmountCents: snapshot.refundedAmountCents,
  reconciliationState: 'HEALTHY',
  reconciliationFailure: null,
  reconciliationAttemptCount: 0,
  nextReconcileAt: null,
  lastReconciledAt: now,
  updatedAt: now,
}).where(eq(payments.id, payment.id)).returning()
if (!persistedPayment) throw new Error('payment not found')

if (order.status === 'CANCELLED' && options.ensureCancelledDisposition !== false) {
  const disposition = await ensureCancelledOrderPaymentDisposition(tx, persistedPayment, now)
  return {
    changed: !alreadyApproved || disposition.inserted,
    decision: decision.kind,
    operationEnqueued: disposition.inserted,
  }
}
```

For a pending snapshot on a cancelled order, persist the snapshot and call the same helper. For cancelled/rejected/failed/expired snapshots, persist the terminal payment state without changing the order. `settleSnapshot` must pass:

```ts
{
  ensureCancelledDisposition: operation.type !== 'CANCEL',
  releaseOrderOnApproval: operation.type !== 'CANCEL',
}
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts test/payment-operation.service.test.ts
```

Expected: PASS, including one CANCEL, one full refund after approval, `NOT_CHARGED` for rejected/expired, and unchanged retry exhaustion at attempt eight.

- [ ] **Step 6: Write RED service tests for manual cancellation, timeout, idempotency, and races**

Add imports for `cancelCustomerOrder` and `expireAwaitingPayment` in `apps/api/test/payment.service.test.ts`, then add:

```ts
it('cancels owned awaiting payment atomically and is idempotent', async () => {
  const { order, payment } = await makePayment()
  const now = new Date('2026-07-16T12:30:00.000Z')
  const first = await cancelCustomerOrder(testDb, customerId, order.id, now)
  const second = await cancelCustomerOrder(testDb, customerId, order.id, now)
  expect(first).toMatchObject({ changed: true })
  expect(second).toMatchObject({ changed: false, operationId: first.operationId })
  expect(first.order.status).toBe('CANCELLED')
  expect(await testDb.select().from(orderEvents).where(and(
    eq(orderEvents.orderId, order.id),
    eq(orderEvents.note, 'cancelamento de pagamento solicitado pelo cliente'),
  ))).toHaveLength(1)
  expect(await testDb.select().from(paymentOperations).where(and(
    eq(paymentOperations.paymentId, payment.id),
    eq(paymentOperations.type, 'CANCEL'),
  ))).toHaveLength(1)
})

it('rejects another customer and later operational states', async () => {
  const { order } = await makePayment()
  await expect(cancelCustomerOrder(testDb, crypto.randomUUID(), order.id, new Date()))
    .rejects.toMatchObject({ status: 404 })
  await testDb.update(orders).set({ status: 'ACCEPTED' }).where(eq(orders.id, order.id))
  await expect(cancelCustomerOrder(testDb, customerId, order.id, new Date()))
    .rejects.toMatchObject({ status: 409 })
})

it('expires only due pending payments whose order still awaits payment', async () => {
  const now = new Date('2026-07-16T12:30:00.000Z')
  const due = await makePayment()
  const future = await makePayment()
  await testDb.update(payments).set({ expiresAt: now }).where(eq(payments.id, due.payment.id))
  await testDb.update(payments).set({ expiresAt: new Date(now.getTime() + 1) }).where(eq(payments.id, future.payment.id))
  expect(await expireAwaitingPayment(testDb, due.payment.id, now)).toMatchObject({ changed: true })
  expect(await expireAwaitingPayment(testDb, due.payment.id, now)).toMatchObject({ changed: false })
  expect(await expireAwaitingPayment(testDb, future.payment.id, now)).toBeNull()
})

it('converges manual cancellation racing approval without reopening', async () => {
  const { order, payment } = await makePayment()
  const now = new Date('2026-07-16T12:30:00.000Z')
  await Promise.allSettled([
    cancelCustomerOrder(testDb, customerId, order.id, now),
    applyProviderSnapshot(testDb, payment.id, snapshot(order.id, order.totalCents), now),
  ])
  const [storedOrder] = await testDb.select().from(orders).where(eq(orders.id, order.id))
  expect(['PENDING', 'CANCELLED']).toContain(storedOrder!.status)
  if (storedOrder!.status === 'PENDING') {
    await cancelCustomerOrder(testDb, customerId, order.id, now)
  }
  expect((await testDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('CANCELLED')
  expect(await testDb.select().from(paymentOperations).where(and(
    eq(paymentOperations.paymentId, payment.id),
    eq(paymentOperations.type, 'REFUND_FULL'),
  ))).toHaveLength(1)
})
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts
```

Expected: FAIL because the cancellation service does not exist and `AWAITING_PAYMENT` is not directly cancellable.

- [ ] **Step 7: Implement the shared payment-first cancellation transaction**

Create `apps/api/src/payments/cancellation.service.ts` with these public types and functions:

```ts
import { and, eq, lte } from 'drizzle-orm'
import type { Db, DbTransaction } from '../db/client'
import { orderEvents, orders, payments } from '../db/schema'
import { OrderError } from '../services/order.service'
import { expirePendingAmendment } from '../services/amendment.service'
import { ensureCancelledOrderPaymentDisposition } from '../services/payment.service'

export type CancellationResult = {
  order: typeof orders.$inferSelect
  operationId: string | null
  changed: boolean
}

type Actor =
  | { role: 'CUSTOMER'; id: string; reason: 'Cancelado pelo cliente'; note: 'cancelamento de pagamento solicitado pelo cliente' }
  | { role: 'SYSTEM'; id: null; reason: 'Pagamento não confirmado em 30 minutos'; note: 'pagamento expirado após 30 minutos' }

async function cancelLocked(
  tx: DbTransaction,
  payment: typeof payments.$inferSelect,
  actor: Actor,
  now: Date,
): Promise<CancellationResult | null> {
  const [order] = await tx.select().from(orders)
    .where(eq(orders.id, payment.orderId)).for('update')
  if (!order) throw new OrderError('Pedido não encontrado', 404)
  if (order.status === 'CANCELLED') {
    const disposition = await ensureCancelledOrderPaymentDisposition(tx, payment, now)
    return { order, operationId: disposition.operationId, changed: false }
  }
  if (order.status !== 'AWAITING_PAYMENT') return null
  const [cancelled] = await tx.update(orders).set({
    status: 'CANCELLED',
    batchId: null,
    cancelReason: actor.reason,
    cancelRequestedAt: null,
    cancelRequestNote: null,
    updatedAt: now,
  }).where(and(eq(orders.id, order.id), eq(orders.status, 'AWAITING_PAYMENT'))).returning()
  if (!cancelled) return null
  await tx.insert(orderEvents).values({
    orderId: order.id,
    status: 'CANCELLED',
    actorRole: actor.role,
    actorId: actor.id,
    note: actor.note,
  })
  await expirePendingAmendment(tx, order.id)
  const disposition = await ensureCancelledOrderPaymentDisposition(tx, payment, now)
  return { order: cancelled, operationId: disposition.operationId, changed: true }
}

export async function cancelCustomerOrder(
  db: Db,
  customerId: string,
  orderId: string,
  now: Date,
): Promise<CancellationResult> {
  const [candidate] = await db.select({ paymentId: payments.id }).from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
    .orderBy(payments.createdAt)
    .limit(1)
  if (!candidate) throw new OrderError('Pedido não encontrado', 404)
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments)
      .where(eq(payments.id, candidate.paymentId)).for('update')
    if (!payment) throw new OrderError('Pedido não encontrado', 404)
    const awaiting = await cancelLocked(tx, payment, {
      role: 'CUSTOMER', id: customerId,
      reason: 'Cancelado pelo cliente',
      note: 'cancelamento de pagamento solicitado pelo cliente',
    }, now)
    if (awaiting) return awaiting
    const [order] = await tx.select().from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId))).for('update')
    if (!order) throw new OrderError('Pedido não encontrado', 404)
    if (order.status !== 'PENDING') {
      throw new OrderError('Pedido não pode mais ser cancelado direto — solicite à loja', 409)
    }
    const [cancelled] = await tx.update(orders).set({
      status: 'CANCELLED', batchId: null, cancelReason: 'Cancelado pelo cliente', updatedAt: now,
    }).where(and(eq(orders.id, order.id), eq(orders.status, 'PENDING'))).returning()
    if (!cancelled) throw new OrderError('Pedido mudou de status — recarregue', 409)
    await tx.insert(orderEvents).values({ orderId, status: 'CANCELLED', actorRole: 'CUSTOMER', actorId: customerId })
    await expirePendingAmendment(tx, orderId)
    const disposition = await ensureCancelledOrderPaymentDisposition(tx, payment, now)
    return { order: cancelled, operationId: disposition.operationId, changed: true }
  })
}

export async function expireAwaitingPayment(
  db: Db,
  paymentId: string,
  now: Date,
): Promise<CancellationResult | null> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(and(
      eq(payments.id, paymentId),
      eq(payments.status, 'PENDING'),
      lte(payments.expiresAt, now),
    )).for('update')
    if (!payment) return null
    return cancelLocked(tx, payment, {
      role: 'SYSTEM', id: null,
      reason: 'Pagamento não confirmado em 30 minutos',
      note: 'pagamento expirado após 30 minutos',
    }, now)
  })
}
```

Keep the existing no-payment `PENDING` cancellation path in `order-status.service.ts` for cash/maquininha orders. Import `cancelCustomerOrder as cancelOnlineCustomerOrder` from the new service and replace the exported function with:

```ts
export async function customerCancelOrder(db: Db, customerId: string, orderId: string) {
  const payment = await getOrderPayment(db, orderId)
  if (payment) return cancelOnlineCustomerOrder(db, customerId, orderId, new Date())

  return db.transaction(async (tx) => {
    const [cancelled] = await tx.update(orders)
      .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Cancelado pelo cliente' })
      .where(and(
        eq(orders.id, orderId),
        eq(orders.customerId, customerId),
        eq(orders.status, 'PENDING'),
      ))
      .returning()
    if (!cancelled) {
      const [owned] = await tx.select({ status: orders.status }).from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId))).limit(1)
      if (!owned) throw new OrderError('Pedido não encontrado', 404)
      throw new OrderError('Pedido não pode mais ser cancelado direto — solicite à loja', 409)
    }
    await addEvent(tx, orderId, 'CANCELLED', 'CUSTOMER', customerId)
    await expirePendingAmendment(tx, orderId)
    return { order: cancelled, operationId: null, changed: true }
  })
}
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts
```

Expected: PASS, including one event/intent under repeated manual/timeout calls and cancellation/refund convergence under both race winners.

- [ ] **Step 8: Write RED tests for reordered cron expiration and cancelled uncertain creates**

In `apps/api/test/payment-reconciliation.test.ts`, update the stage-order assertion and summary field:

```ts
expect(observedStages).toEqual([
  'leases',
  'dependencies',
  'inbox',
  'creates',
  'snapshots',
  'expirations',
  'operations',
  'reviews',
])
expect(summary.paymentsExpired).toBe(1)
```

Add expiration coverage for both gateway methods and the exact boundary:

```ts
it.each(['PIX', 'CARD'] as const)('commercially cancels due %s and processes its operation in the same run', async (method) => {
  const now = new Date('2026-07-16T12:30:00.000Z')
  const payment = await pendingPayment(now, method)
  const fake = provider({}, payment)
  const summary = await runPaymentReconciliation(testDb, fake, now, context)
  expect(summary.paymentsExpired).toBe(1)
  expect(summary.operationsProcessed).toBe(1)
  expect((await testDb.select().from(orders).where(eq(orders.id, payment.orderId)))[0]!.status).toBe('CANCELLED')
})

it('does not expire one millisecond before the deadline', async () => {
  const deadline = new Date('2026-07-16T12:30:00.000Z')
  const payment = await pendingPayment(deadline, 'CARD')
  const summary = await runPaymentReconciliation(testDb, provider({}, payment), new Date(deadline.getTime() - 1), context)
  expect(summary.paymentsExpired).toBe(0)
})
```

Change the test helper to accept `method: 'PIX' | 'CARD'` and make its order `AWAITING_PAYMENT`.

In `apps/api/test/payment.service.test.ts`, add cancelled uncertain-create cases:

```ts
it('never recreates a cancelled uncertain PIX when search finds no match', async () => {
  const { order, payment } = await makePayment('CANCELLED')
  await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null })
    .where(eq(payments.id, payment.id))
  const createOrder = vi.fn()
  const searchOrders = vi.fn(async () => [])
  const result = await recoverUncertainCreate(
    testDb,
    fakePaymentProvider({ searchOrders, createOrder }),
    payment.id,
    new Date(),
    (email) => email ?? 'payer@test.local',
  )
  expect(result).toBe('RETRY_PIX')
  expect(createOrder).not.toHaveBeenCalled()
  expect((await testDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('CANCELLED')
})

it.each([
  ['PENDING', 'CANCEL'],
  ['APPROVED', 'REFUND_FULL'],
  ['REJECTED', null],
] as const)('search-only cancelled recovery maps %s to %s', async (decision, operationType) => {
  const { order, payment } = await makePayment('CANCELLED')
  await testDb.update(payments).set({ providerOrderId: null, providerTransactionId: null })
    .where(eq(payments.id, payment.id))
  const found = snapshot(order.id, order.totalCents, decision === 'APPROVED'
    ? {}
    : decision === 'REJECTED'
      ? { orderStatus: 'failed', transactionStatus: 'failed' }
      : { orderStatus: 'processing', transactionStatus: 'processing' })
  const fake = fakePaymentProvider({
    searchOrders: vi.fn(async () => [found]),
    getOrder: vi.fn(async () => found),
    createOrder: vi.fn(),
  })
  await recoverUncertainCreate(testDb, fake, payment.id, new Date(), (email) => email ?? 'payer@test.local')
  const operations = await testDb.select().from(paymentOperations).where(eq(paymentOperations.paymentId, payment.id))
  expect(operations.map((row) => row.type)).toEqual(operationType ? [operationType] : [])
  expect(fake.createOrder).not.toHaveBeenCalled()
})
```

Preserve/add the existing multiple-match, provider-error, and eighth-attempt assertions; for a cancelled order they must end in `REVIEW_REQUIRED` without calling `createOrder`.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts test/payment-reconciliation.test.ts
```

Expected: FAIL because expiration is PIX-only, operations run before expiration, and cancelled uncertain PIX can still recreate a provider Order.

- [ ] **Step 9: Implement automatic expiration and search-only cancelled recovery**

In `apps/api/src/payments/reconciliation.service.ts`:

```ts
export type ReconciliationSummary = {
  leasesRecovered: number
  dependenciesReviewed: number
  operationsReleased: number
  inboxProcessed: number
  operationsProcessed: number
  createsRecovered: number
  snapshotsRefreshed: number
  paymentsExpired: number
  reviewsRechecked: number
  stageFailures: number
}

const allStages: readonly ReconciliationStage[] = [
  'leases',
  'dependencies',
  'inbox',
  'creates',
  'snapshots',
  'expirations',
  'operations',
  'reviews',
]
```

Move the existing operations block after expirations. Replace the PIX-only expiration query with the indexed selection and shared service:

```ts
const expiring = await db.select({ id: payments.id }).from(payments)
  .innerJoin(orders, eq(orders.id, payments.orderId))
  .where(and(
    eq(payments.status, 'PENDING'),
    isNotNull(payments.expiresAt),
    lte(payments.expiresAt, now),
    eq(orders.status, 'AWAITING_PAYMENT'),
  ))
  .orderBy(asc(payments.expiresAt), asc(payments.createdAt))
  .limit(capBy('expirations'))

for (const payment of expiring) {
  try {
    const result = await expireAwaitingPayment(db, payment.id, now)
    if (result?.changed) summary.paymentsExpired++
  } catch {
    summary.stageFailures++
  }
}
```

In `checkout.service.ts`, load the related order before choosing zero-match recovery. If it is `CANCELLED`, always call `scheduleCreateRecoveryRetry`; never enter the PIX recreation branch. When one match exists, authoritative `GET Order` plus `applyProviderSnapshotInTransaction` handles pending/cancel, approved/refund, and terminal/no-charge.

To close the zero-match PIX recreation race, perform its final eligibility check in one transaction with payment-first then order locking and keep those locks until the provider create response has been normalized:

```ts
return db.transaction(async (tx) => {
  const [current] = await tx.select().from(payments)
    .where(eq(payments.id, payment.id)).for('update')
  if (!current || current.status !== 'PENDING' || current.providerOrderId !== null) return 'RECOVERED'
  const [order] = await tx.select().from(orders)
    .where(eq(orders.id, current.orderId)).for('update')
  if (!order || order.status === 'CANCELLED') {
    return scheduleCreateRecoveryRetry(tx, current, now, 'CANCELLED_CREATE_SEARCH_PENDING')
  }
  if (order.status !== 'AWAITING_PAYMENT' || !current.expiresAt || current.expiresAt <= now) {
    return 'RECOVERED'
  }
  try {
    const snapshot = await provider.createOrder({
      method: 'PIX',
      orderId: current.orderId,
      amountCents: current.expectedAmountCents,
      payerEmail: resolvePayerEmail(identity.email, identity.userId),
      idempotencyKey: current.createIdempotencyKey,
      expiresAt: current.expiresAt,
    })
    const applied = await applyProviderSnapshotInTransaction(tx, current.id, snapshot, now)
    return applied.decision === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'RECOVERED'
  } catch (error) {
    if (requiresCreateRecovery(error)) {
      return scheduleCreateRecoveryRetry(
        tx,
        current,
        now,
        error.kind,
        error.retryAfterSeconds,
      )
    }
    await persistRecoveryReview(
      tx,
      current.id,
      now,
      error instanceof PaymentProviderError ? error.kind : 'CREATE_FAILED',
    )
    return 'REVIEW_REQUIRED'
  }
})
```

Change `scheduleCreateRecoveryRetry`, `persistRecoveryReview`, and their helpers to accept `Db | DbTransaction` so this branch does not open a nested transaction. Introduce this transaction adapter and route every `whileStillUncertain` mutation through it:

```ts
type DbScope = Db | DbTransaction

function inTransaction<T>(
  scope: DbScope,
  action: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return 'transaction' in scope
    ? scope.transaction(action)
    : action(scope)
}

async function whileStillUncertain<T>(
  scope: DbScope,
  paymentId: string,
  mutation: StillUncertainMutation<T>,
) {
  return inTransaction(scope, async (tx) => {
    const [current] = await tx.select().from(payments)
      .where(eq(payments.id, paymentId)).for('update')
    if (!current || current.status !== 'PENDING' || current.providerOrderId !== null) {
      return { applied: false as const }
    }
    return { applied: true as const, value: await mutation(tx, current) }
  })
}
```

Provider errors inside the locked branch must be caught as shown above so retry/review updates commit; they must not roll back the recorded retry schedule.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment.service.test.ts test/payment-reconciliation.test.ts
```

Expected: PASS; same-run operation processing is observed, all due online payments cancel commercially, and cancelled uncertain creates remain search-only.

- [ ] **Step 10: Write RED tests for focused request-background processing and route behavior**

In `apps/api/test/payment-operation.service.test.ts`, add:

```ts
it('claims only the requested due operation', async () => {
  const first = await queuedOperation('CANCEL')
  const second = await queuedOperation('CANCEL')
  const leaseOwner = crypto.randomUUID()
  expect(await claimPaymentOperationById(testDb, first.id, new Date(), leaseOwner)).toBe(true)
  const rows = await testDb.select().from(paymentOperations)
  expect(rows.find((row) => row.id === first.id)).toMatchObject({ status: 'PROCESSING', leaseOwner, attemptCount: 1 })
  expect(rows.find((row) => row.id === second.id)).toMatchObject({ status: 'PENDING', attemptCount: 0 })
})
```

In `apps/api/test/orders.routes.test.ts`, add route cases:

```ts
it('directly cancels owned AWAITING_PAYMENT and schedules its exact operation', async () => {
  const { order, payment } = await awaitingOnlineOrder('CARD')
  const pending: Promise<unknown>[] = []
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
    passThroughOnException: () => undefined,
  } as ExecutionContext
  const response = await app.fetch(new Request(`http://localhost/orders/${order.id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${customerToken}` },
  }), env, executionCtx)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'CANCELLED', paymentResolution: 'PROCESSING' })
  expect(pending).toHaveLength(1)
  await Promise.all(pending)
  const operations = await testDb.select().from(paymentOperations).where(eq(paymentOperations.paymentId, payment.id))
  expect(operations).toHaveLength(1)
})

it('keeps direct cancel idempotent and rejects another customer', async () => {
  const { order } = await awaitingOnlineOrder('PIX')
  expect((await requestAsCustomer(`/orders/${order.id}/cancel`, { method: 'POST' })).status).toBe(200)
  expect((await requestAsCustomer(`/orders/${order.id}/cancel`, { method: 'POST' })).status).toBe(200)
  expect((await requestAsOtherCustomer(`/orders/${order.id}/cancel`, { method: 'POST' })).status).toBe(404)
})
```

Use the suite's existing Hono request helpers and environment. Keep its existing `createDb` mock returning `testDb` plus a counted `client.end()`, and stub `createPaymentProvider` with the suite's fake provider so no real Mercado Pago request occurs. Assert the dedicated client is closed after `Promise.all(pending)`.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment-operation.service.test.ts test/orders.routes.test.ts
```

Expected: FAIL because focused claim/background processing and the awaiting-payment direct route response are absent.

- [ ] **Step 11: Implement focused best-effort processing with a dedicated client**

Add to `apps/api/src/payments/operation-queue.service.ts`:

```ts
export async function claimPaymentOperationById(
  db: Db,
  operationId: string,
  now: Date,
  leaseOwner: string,
): Promise<boolean> {
  const [claimed] = await db.update(paymentOperations).set({
    status: 'PROCESSING',
    leaseOwner,
    leasedUntil: new Date(now.getTime() + 5 * 60_000),
    attemptCount: sql`${paymentOperations.attemptCount} + 1`,
    updatedAt: now,
  }).where(and(
    eq(paymentOperations.id, operationId),
    eq(paymentOperations.status, 'PENDING'),
    or(isNull(paymentOperations.nextAttemptAt), lte(paymentOperations.nextAttemptAt, now)),
    or(
      isNull(paymentOperations.dependsOnOperationId),
      sql`exists (select 1 from payment_operations predecessor where predecessor.id = ${paymentOperations.dependsOnOperationId} and predecessor.status = 'SUCCEEDED')`,
    ),
  )).returning({ id: paymentOperations.id })
  return claimed !== undefined
}
```

Create `apps/api/src/payments/operation-background.service.ts`:

```ts
import { createDb } from '../db/client'
import type { Env } from '../env'
import { createPaymentProvider } from './mercadopago'
import { claimPaymentOperationById } from './operation-queue.service'
import { processPaymentOperation } from './operation.service'

export async function processPaymentOperationInBackground(
  env: Env,
  operationId: string,
  now: Date,
): Promise<void> {
  const { db, client } = createDb(env)
  try {
    const provider = createPaymentProvider(env)
    if (!provider) return
    const leaseOwner = crypto.randomUUID()
    if (await claimPaymentOperationById(db, operationId, now, leaseOwner)) {
      await processPaymentOperation(db, provider, operationId, leaseOwner, now)
    }
  } finally {
    await client.end()
  }
}
```

Update the cancel route to use the wrapper result, schedule only its returned operation, and return refreshed safe detail:

```ts
const result = await customerCancelOrder(
  c.get('db'),
  c.get('auth')!.sub,
  c.req.valid('param').id,
).catch(rethrow)

if (result.operationId) {
  const work = processPaymentOperationInBackground(c.env, result.operationId, new Date())
    .catch(() => undefined)
  try {
    c.executionCtx.waitUntil(work)
  } catch {
    // Local/unit requests may not provide an ExecutionContext; cron remains the durable fallback.
  }
}

const detail = await getCustomerOrder(c.get('db'), c.get('auth')!.sub, result.order.id)
return c.json(detail ?? result.order, 200)
```

Do not await provider I/O in the HTTP response and do not reuse `c.get('db')` in the background promise.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/payment-operation.service.test.ts test/orders.routes.test.ts
```

Expected: PASS and route latency remains independent of Mercado Pago availability.

- [ ] **Step 12: Write RED tests for customer projection and store isolation**

In `apps/api/test/orders.routes.test.ts`, add a table of derived customer results:

```ts
it.each([
  [{ operationStatus: 'PENDING' }, 'PROCESSING'],
  [{ paymentStatus: 'REJECTED' }, 'NOT_CHARGED'],
  [{ paymentStatus: 'CANCELLED' }, 'NOT_CHARGED'],
  [{ paymentStatus: 'EXPIRED' }, 'NOT_CHARGED'],
  [{ paymentStatus: 'REFUNDED' }, 'REFUNDED'],
  [{ operationStatus: 'REVIEW_REQUIRED' }, 'REVIEW_REQUIRED'],
  [{ reconciliationState: 'REVIEW_REQUIRED' }, 'REVIEW_REQUIRED'],
] as const)('derives cancelled payment resolution %#', async (patch, expected) => {
  const { order, payment } = await cancelledOnlineOrder()
  await applyPaymentProjectionFixture(payment.id, patch)
  const response = await requestAsCustomer(`/orders/${order.id}`)
  expect(response.status).toBe(200)
  expect((await response.json()).paymentResolution).toBe(expected)
})
```

Add card/PIX safe projection assertions:

```ts
it.each([
  ['CARD', false],
  ['PIX', true],
] as const)('returns awaiting %s deadline without sensitive provider fields', async (method, hasQr) => {
  const { order } = await awaitingOnlineOrder(method)
  const body = await (await requestAsCustomer(`/orders/${order.id}`)).json()
  expect(body.payment.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(Boolean(body.payment.qrCode)).toBe(hasQr)
  expect(JSON.stringify(body)).not.toContain('providerOrderId')
  expect(JSON.stringify(body)).not.toContain('providerTransactionId')
  expect(JSON.stringify(body)).not.toContain('cardToken')
})
```

In `apps/api/test/store-orders.routes.test.ts`, create awaiting and cancelled orders and assert:

```ts
expect(activeOrders.map((order) => order.id)).not.toContain(awaiting.id)
expect(activeOrders.map((order) => order.id)).not.toContain(cancelled.id)
expect((await storePatch(cancelled.id, 'ACCEPTED')).status).toBe(409)
```

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/orders.routes.test.ts test/store-orders.routes.test.ts
```

Expected: FAIL because card detail lacks payment data and `paymentResolution` is absent.

- [ ] **Step 13: Implement the safe customer payment projection**

In `apps/api/src/services/order.service.ts`, define:

```ts
export type PaymentResolution =
  | 'PROCESSING'
  | 'NOT_CHARGED'
  | 'REFUNDED'
  | 'REVIEW_REQUIRED'
  | null

async function paymentResolution(
  db: Db,
  order: typeof orders.$inferSelect,
  payment: typeof payments.$inferSelect | null,
): Promise<PaymentResolution> {
  if (!payment || order.status !== 'CANCELLED' || !order.paymentMethod.endsWith('_ONLINE')) return null
  if (payment.reconciliationState === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED'
  const operations = await db.select({ status: paymentOperations.status, type: paymentOperations.type })
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.paymentId, payment.id),
      inArray(paymentOperations.type, ['CANCEL', 'REFUND_FULL']),
    ))
  if (operations.some((row) => row.status === 'REVIEW_REQUIRED')) return 'REVIEW_REQUIRED'
  if (operations.some((row) => row.status === 'PENDING' || row.status === 'PROCESSING')) return 'PROCESSING'
  if (payment.status === 'REFUNDED') return 'REFUNDED'
  if (['CANCELLED', 'REJECTED', 'EXPIRED'].includes(payment.status)) return 'NOT_CHARGED'
  if (payment.providerOrderId === null || payment.status === 'APPROVED' || payment.status === 'PENDING') return 'PROCESSING'
  return 'REVIEW_REQUIRED'
}
```

Import `payments` and `paymentOperations`. In `getCustomerOrder`, return:

```ts
paymentResolution: await paymentResolution(db, order, payment),
payment: payment && order.status === 'AWAITING_PAYMENT'
  ? {
      qrCode: payment.method === 'PIX' ? payment.qrCode : null,
      qrCodeBase64: payment.method === 'PIX' ? payment.qrCodeBase64 : null,
      expiresAt: payment.expiresAt?.toISOString() ?? null,
    }
  : null,
```

Do not return `ticketUrl`, provider IDs, provider status/detail, reconciliation failure, operation failure, tokens, payer email, or idempotency keys.

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/orders.routes.test.ts test/store-orders.routes.test.ts
```

Expected: PASS.

- [ ] **Step 14: Write RED frontend tests for countdown, direct cancellation, duplicate prevention, and resolution copy**

Create `apps/web/src/views/OrderTrackingView.test.ts` using `@vue/test-utils`, `happy-dom`, a memory router, and a mocked `api` module. Include these cases:

```ts
it.each([
  ['PIX_ONLINE', { qrCode: 'pix-code', qrCodeBase64: 'base64' }],
  ['CARD_ONLINE', { qrCode: null, qrCodeBase64: null }],
] as const)('shows deadline and direct cancel for %s', async (paymentMethod, artifacts) => {
  mockOrder({
    status: 'AWAITING_PAYMENT',
    paymentMethod,
    paymentResolution: null,
    payment: { ...artifacts, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
  })
  const wrapper = await mountTracking()
  expect(wrapper.text()).toContain('Expira em')
  const button = wrapper.get('[data-testid="cancel-awaiting-payment"]')
  expect(button.text()).toBe('Cancelar pagamento e pedido')
})

it('confirms once, calls direct cancel, and disables duplicate submission', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true))
  const pending = deferred<void>()
  apiMock.mockImplementationOnce(async () => awaitingOrder())
  apiMock.mockImplementationOnce(async () => pending.promise)
  const wrapper = await mountTracking()
  const button = wrapper.get('[data-testid="cancel-awaiting-payment"]')
  await button.trigger('click')
  await button.trigger('click')
  expect(apiMock).toHaveBeenCalledWith(`/orders/${ORDER_ID}/cancel`, { method: 'POST' })
  expect(apiMock.mock.calls.filter(([path]) => path === `/orders/${ORDER_ID}/cancel`)).toHaveLength(1)
  expect(button.attributes('disabled')).toBeDefined()
  expect(apiMock.mock.calls.some(([path]) => String(path).includes('/cancel-request'))).toBe(false)
  pending.resolve()
})

it.each([
  ['PROCESSING', 'Pedido cancelado — confirmação financeira em processamento.'],
  ['NOT_CHARGED', 'Pedido cancelado — nenhuma cobrança foi concluída.'],
  ['REFUNDED', 'Pedido cancelado — pagamento estornado.'],
  ['REVIEW_REQUIRED', 'Pedido cancelado — confirmação financeira em análise.'],
] as const)('renders %s safely', async (paymentResolution, copy) => {
  mockOrder({ status: 'CANCELLED', paymentResolution, payment: null })
  const wrapper = await mountTracking()
  expect(wrapper.text()).toContain(copy)
  expect(wrapper.text()).not.toContain('RETRY_EXHAUSTED')
})
```

The test helper must use fake IDs/data only and clear timers/globals after every test.

Run:

```bash
pnpm --filter @delivery/web test -- src/views/OrderTrackingView.test.ts
```

Expected: FAIL because the UI lacks the new projection, button, card countdown, disabled state, and resolution messages.

- [ ] **Step 15: Implement the customer UI behavior without unrelated redesign**

In `apps/web/src/views/OrderTrackingView.vue`, update types:

```ts
type PaymentResolution = 'PROCESSING' | 'NOT_CHARGED' | 'REFUNDED' | 'REVIEW_REQUIRED' | null

type Order = {
  id: string
  status: OrderStatus
  paymentMethod: string
  paymentResolution: PaymentResolution
  payment: { qrCode: string | null; qrCodeBase64: string | null; expiresAt: string | null } | null
}
```

Keep all existing `Order` fields in the actual type; the snippet shows only changed fields.

Rename `pixCountdown` to `paymentCountdown`, add `const cancelling = ref(false)`, make `copyPix` return when `qrCode` is null, and replace `cancel()` with:

```ts
async function cancel() {
  if (!order.value || cancelling.value) return
  const message = order.value.status === 'AWAITING_PAYMENT'
    ? 'Cancelar o pagamento e o pedido? Se a cobrança for aprovada ao mesmo tempo, o estorno será solicitado automaticamente.'
    : 'Cancelar este pedido?'
  if (!confirm(message)) return
  cancelling.value = true
  try {
    await api(`/orders/${order.value.id}/cancel`, { method: 'POST' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  } finally {
    cancelling.value = false
  }
}
```

Render PIX artifacts only when `qrCode` exists, but render the countdown for both PIX and card. Add the awaiting action:

```vue
<button
  v-if="order.status === 'AWAITING_PAYMENT'"
  data-testid="cancel-awaiting-payment"
  :disabled="cancelling"
  class="w-full rounded border border-red-400 p-2 text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
  @click="cancel"
>
  {{ cancelling ? 'Cancelando…' : 'Cancelar pagamento e pedido' }}
</button>
```

Ensure the generic `requestCancel` button is rendered only for `ACCEPTED`, `PREPARING`, `READY`, or `AWAITING_DRIVER`; it must never handle `AWAITING_PAYMENT`.

Add exact cancelled resolution copy:

```vue
<p v-if="order.paymentResolution === 'PROCESSING'">Pedido cancelado — confirmação financeira em processamento.</p>
<p v-else-if="order.paymentResolution === 'NOT_CHARGED'">Pedido cancelado — nenhuma cobrança foi concluída.</p>
<p v-else-if="order.paymentResolution === 'REFUNDED'">Pedido cancelado — pagamento estornado.</p>
<p v-else-if="order.paymentResolution === 'REVIEW_REQUIRED'">Pedido cancelado — confirmação financeira em análise.</p>
```

Run:

```bash
pnpm --filter @delivery/web test -- src/views/OrderTrackingView.test.ts
pnpm --filter @delivery/web typecheck
```

Expected: PASS.

- [ ] **Step 16: Verify the unchanged provider adapter still covers every required cancel response**

Run:

```bash
pnpm --filter @delivery/api exec vitest run test/mercadopago.test.ts
```

Expected: PASS for all of these existing contracts:

```text
POST /v1/orders/{id}/cancel carries X-Idempotency-Key.
HTTP 200 is followed by authoritative GET Order.
409 cannot_cancel_order, order_already_canceled, and idempotency conflicts converge through GET.
423, 429 (including bounded Retry-After), 500, and timeout attempt authoritative GET.
404 remains ORDER_NOT_FOUND/uncertain, not proof of no charge.
401/403 are CREDENTIAL_OR_CONFIG.
Malformed/contradictory snapshots fail closed.
No secret or raw provider response is exposed in the thrown error.
```

The current suite already contains each named contract. If later code removes one, stop this task and restore that exact regression case before changing adapter behavior.

- [ ] **Step 17: Update the sanitized Mercado Pago runbook**

In `docs/security/runbooks/mercado-pago-orders.md`, add a section `## Cancelamento seguro de AWAITING_PAYMENT` containing:

````markdown
## Cancelamento seguro de AWAITING_PAYMENT

- PIX e cartão expiram comercialmente após 30 minutos; o cron de cinco minutos pode iniciar a resolução entre 30 e 35 minutos.
- Cancelamento manual usa `POST /orders/{id}/cancel`. O pedido vira `CANCELLED` antes de qualquer I/O com o provedor.
- Pagamento pendente converge por `CANCEL`; aprovação concorrente ou tardia converge por `REFUND_FULL`.
- `processing/in_process` pode recusar cancelamento; manter o trabalho retryable e confirmar somente por `GET Order` autoritativo.
- `NOT_CHARGED` significa estado autoritativo cancelado/rejeitado/expirado sem captura. `REFUNDED` significa estorno total autoritativo.
- Oitava falha gera `REVIEW_REQUIRED/RETRY_EXHAUSTED`; o pedido permanece cancelado e exige inspeção antes do requeue.
- Create incerto de pedido já cancelado é somente busca: nunca recriar Order PIX ou cartão.

Inspeção sanitizada:

```bash
psql "$DATABASE_URL" -f apps/api/scripts/payment-work-status.sql
```

Requeue somente após confirmar identidade, valor, ambiente, método e estado autoritativo:

```bash
psql "$DATABASE_URL" \
  -v work_type=operation \
  -v work_id=UUID \
  -f apps/api/scripts/requeue-payment-work.sql
```

Nunca registrar corpo do provedor, payload PIX, email, token, credencial ou identificador integral na evidência.
````

Keep existing webhook, refund, rollback, and production-blocker guidance intact.

Run:

```bash
git diff --check
rg -n "AWAITING_PAYMENT|processing/in_process|NOT_CHARGED|REFUND_FULL|REVIEW_REQUIRED" docs/security/runbooks/mercado-pago-orders.md
```

Expected: diff is clean and every required operational state is documented.

- [ ] **Step 18: Run focused automated gates and inspect invariants**

Run:

```bash
pnpm --filter @delivery/api exec vitest run \
  test/payment.schema.test.ts \
  test/mercadopago.test.ts \
  test/payment.service.test.ts \
  test/payment-operation.service.test.ts \
  test/payment-reconciliation.test.ts \
  test/orders.routes.test.ts \
  test/store-orders.routes.test.ts
pnpm --filter @delivery/web test -- src/views/OrderTrackingView.test.ts
pnpm --filter @delivery/api typecheck
pnpm --filter @delivery/web typecheck
```

Expected: all tests and both typechecks pass.

Review the diff specifically:

```bash
git diff --stat
git diff -- apps/api/src/payments apps/api/src/services/order.service.ts apps/api/src/services/order-status.service.ts apps/api/src/routes/orders.ts apps/web/src/views/OrderTrackingView.vue
rg -n "LATE_APPROVAL|ESCALATED_CANCEL|PIX_EXPIRED|CUSTOMER_CANCELLED|STORE_CANCELLED|STORE_CANCEL_REQUEST_APPROVED" apps/api/src apps/api/test
rg -n "console\.(log|error)|provider response|cardToken|payerEmail|qrCode" apps/api/src/payments/cancellation.service.ts apps/api/src/payments/operation-background.service.ts
```

Expected:

```text
No transition-specific CANCEL/REFUND business keys remain.
Any remaining transition labels are event/reason semantics only, not operation keys.
The two new services contain no logging and no sensitive data persistence.
No unrelated file or local environment file is changed/staged.
```

- [ ] **Step 19: Validate the generated migration against disposable PostgreSQL**

Use only the repository's disposable local PostgreSQL. Do not reset staging or production.

Run:

```bash
pnpm --filter @delivery/api db:migrate
pnpm --filter @delivery/api exec vitest run test/payment.schema.test.ts
PGPASSWORD=postgres psql \
  -h localhost -p 5432 -U postgres -d delivery \
  -Atc "select enumlabel from pg_enum join pg_type on pg_type.oid = pg_enum.enumtypid where pg_type.typname = 'payment_operation_result_code' order by enumsortorder"
PGPASSWORD=postgres psql \
  -h localhost -p 5432 -U postgres -d delivery \
  -Atc "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'payments_pending_expires_at_idx'"
```

Expected: migration succeeds idempotently, enum includes `NOT_CHARGED`, index is partial on pending non-null `expires_at`, and no data-reset command is run.

- [ ] **Step 20: Run the full repository gate**

Use `superpowers:verification-before-completion`, then run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
git status --short
```

Expected:

```text
All commands pass.
Git status contains only intentional implementation files plus the user's two pre-existing local environment edits.
No database reset, deployment, provider dashboard change, or manual sandbox mutation has occurred.
```

- [ ] **Step 21: Commit the single reviewed implementation unit**

Stage explicit paths only; never use `git add -A`:

```bash
git add \
  apps/api/src/payments/constants.ts \
  apps/api/src/payments/mercadopago.ts \
  apps/api/src/db/schema/payments.ts \
  apps/api/drizzle/0030_safe_pending_cancellation.sql \
  apps/api/drizzle/meta/0030_snapshot.json \
  apps/api/drizzle/meta/_journal.json \
  apps/api/src/services/order.service.ts \
  apps/api/src/services/payment.service.ts \
  apps/api/src/services/order-status.service.ts \
  apps/api/src/services/amendment.service.ts \
  apps/api/src/services/dispatch.service.ts \
  apps/api/src/payments/cancellation.service.ts \
  apps/api/src/payments/operation-queue.service.ts \
  apps/api/src/payments/operation.service.ts \
  apps/api/src/payments/operation-background.service.ts \
  apps/api/src/payments/transition.service.ts \
  apps/api/src/payments/checkout.service.ts \
  apps/api/src/payments/reconciliation.service.ts \
  apps/api/src/routes/orders.ts \
  apps/api/test/payment.schema.test.ts \
  apps/api/test/orders.routes.test.ts \
  apps/api/test/payment.service.test.ts \
  apps/api/test/payment-operation.service.test.ts \
  apps/api/test/payment-reconciliation.test.ts \
  apps/api/test/store-orders.routes.test.ts \
  apps/web/src/views/OrderTrackingView.vue \
  apps/web/src/views/OrderTrackingView.test.ts \
  docs/security/runbooks/mercado-pago-orders.md

git diff --cached --check
git diff --cached --name-only
git commit -m "feat(payments): cancel unresolved orders safely"
```

Expected: one implementation commit; `apps/web/.env.development` and `apps/driver/.env.development` are not staged or committed.

- [ ] **Step 22: Request review and stop before external/manual validation**

Use `superpowers:requesting-code-review`. Correct only verified findings, rerun Step 20 after every correction, and amend or add a focused corrective commit according to reviewer scope.

Do not merge automatically. Do not reset/reseed the database, run Mercado Pago sandbox mutations, deploy, or change dashboard configuration until the user explicitly requests the manual-validation phase. That later phase must validate PIX cancellation, card `CONT`, late approval/full refund, sanitized queue inspection, and exclusion from store views on freshly reset disposable data.

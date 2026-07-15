import { and, desc, eq, inArray, isNull, lte, not, or, sql } from 'drizzle-orm'
import type { Db, DbTransaction } from '../db/client'
import { paymentOperations, payments } from '../db/schema'

export type PaymentOperationResultCode =
  | 'CANCELLED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'ESCALATED_TO_REFUND'

export type PaymentOperationIntent = {
  paymentId: string
  type: 'CANCEL' | 'REFUND_FULL' | 'REFUND_PARTIAL'
  amountCents: number | null
  businessKey: string
  idempotencyKey: string
}

function assertAmount(input: PaymentOperationIntent) {
  if (input.type === 'REFUND_PARTIAL' && (!Number.isSafeInteger(input.amountCents) || input.amountCents! <= 0)) {
    throw new Error('partial refund amount invalid')
  }
  if (input.type !== 'REFUND_PARTIAL' && input.amountCents !== null) {
    throw new Error('non-partial refund amount invalid')
  }
}

async function existingByBusinessKey(tx: Db | DbTransaction, businessKey: string) {
  const [row] = await tx.select().from(paymentOperations).where(eq(paymentOperations.businessKey, businessKey)).limit(1)
  return row
}

export async function enqueuePaymentOperation(
  tx: Db | DbTransaction,
  input: PaymentOperationIntent,
  now: Date,
): Promise<{ id: string; inserted: boolean }> {
  assertAmount(input)

  const existing = await existingByBusinessKey(tx, input.businessKey)
  if (existing) {
    if (existing.paymentId !== input.paymentId || existing.type !== input.type || existing.amountCents !== input.amountCents || existing.idempotencyKey !== input.idempotencyKey) {
      throw new Error('payment operation business key conflict')
    }
    return { id: existing.id, inserted: false }
  }

  const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).for('update')
  if (!payment) throw new Error('payment not found')

  const review = await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.paymentId, input.paymentId),
    eq(paymentOperations.status, 'REVIEW_REQUIRED'),
  )).limit(1)
  if (review.length > 0) throw new Error('payment operation chain requires review')

  const active = await tx.select({ id: paymentOperations.id, type: paymentOperations.type }).from(paymentOperations).where(and(
    eq(paymentOperations.paymentId, input.paymentId),
    inArray(paymentOperations.status, ['PENDING', 'PROCESSING']),
  )).orderBy(desc(paymentOperations.createdAt)).limit(1)
  const predecessor = active[0]?.id ?? null

  let expectedRefundedAmountCents: number | null = null
  if (input.type === 'REFUND_FULL') {
    expectedRefundedAmountCents = payment.expectedAmountCents
  } else if (input.type === 'REFUND_PARTIAL') {
    if (active.some((row) => row.type === 'REFUND_FULL')) throw new Error('full refund already pending')
    const targets = await tx.select({ target: paymentOperations.expectedRefundedAmountCents }).from(paymentOperations).where(and(
      eq(paymentOperations.paymentId, input.paymentId),
      inArray(paymentOperations.type, ['REFUND_FULL', 'REFUND_PARTIAL']),
    ))
    const base = Math.max(payment.refundedAmountCents, ...targets.map((row) => row.target ?? 0))
    expectedRefundedAmountCents = base + input.amountCents!
    if (expectedRefundedAmountCents > payment.expectedAmountCents) throw new Error('refund target exceeds payment amount')
  }

  const [inserted] = await tx.insert(paymentOperations).values({
    paymentId: input.paymentId,
    type: input.type,
    amountCents: input.amountCents,
    expectedRefundedAmountCents,
    dependsOnOperationId: predecessor,
    businessKey: input.businessKey,
    idempotencyKey: input.idempotencyKey,
    status: 'PENDING',
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: paymentOperations.businessKey }).returning({ id: paymentOperations.id })

  if (inserted) return { id: inserted.id, inserted: true }
  const raced = await existingByBusinessKey(tx, input.businessKey)
  if (!raced || raced.paymentId !== input.paymentId || raced.type !== input.type || raced.amountCents !== input.amountCents || raced.idempotencyKey !== input.idempotencyKey) {
    throw new Error('payment operation business key conflict')
  }
  return { id: raced.id, inserted: false }
}

export async function claimDueOperations(db: Db, now: Date, limit: number, leaseOwner: string): Promise<string[]> {
  if (limit <= 0) return []
  return db.transaction(async (tx) => {
    const due = await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
      or(
        and(eq(paymentOperations.status, 'PENDING'), or(isNull(paymentOperations.nextAttemptAt), lte(paymentOperations.nextAttemptAt, now))),
        and(eq(paymentOperations.status, 'PROCESSING'), lte(paymentOperations.leasedUntil, now)),
      ),
      or(
        isNull(paymentOperations.dependsOnOperationId),
        sql`exists (select 1 from payment_operations predecessor where predecessor.id = ${paymentOperations.dependsOnOperationId} and predecessor.status = 'SUCCEEDED')`,
      ),
    )).orderBy(paymentOperations.createdAt).limit(Math.max(1, Math.min(100, limit))).for('update', { skipLocked: true })
    if (due.length === 0) return []
    const ids = due.map((row) => row.id)
    await tx.update(paymentOperations).set({
      status: 'PROCESSING',
      leaseOwner,
      leasedUntil: new Date(now.getTime() + 5 * 60_000),
      attemptCount: sql`${paymentOperations.attemptCount} + 1`,
      updatedAt: now,
    }).where(inArray(paymentOperations.id, ids))
    return ids
  })
}

export async function propagateReviewedDependencies(db: Db, now: Date, limit: number): Promise<number> {
  if (limit <= 0) return 0
  const ids = await db.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    not(eq(paymentOperations.status, 'SUCCEEDED')),
    sql`exists (select 1 from payment_operations predecessor where predecessor.id = ${paymentOperations.dependsOnOperationId} and predecessor.status = 'REVIEW_REQUIRED')`,
  )).orderBy(paymentOperations.createdAt).limit(Math.max(1, Math.min(100, limit)))
  if (ids.length === 0) return 0
  const rows = await db.update(paymentOperations).set({
    status: 'REVIEW_REQUIRED',
    failureClass: 'DEPENDENCY_REVIEW_REQUIRED',
    leaseOwner: null,
    leasedUntil: null,
    updatedAt: now,
  }).where(and(
    inArray(paymentOperations.id, ids.map((row) => row.id)),
    not(eq(paymentOperations.status, 'SUCCEEDED')),
  )).returning({ id: paymentOperations.id })
  return rows.length
}

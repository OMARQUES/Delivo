import { and, asc, desc, eq, gte, lt } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  driverPayoutItems,
  driverPayouts,
  ledgerEntries,
  orderItems,
  orders,
  storeInvoiceItems,
  storeInvoices,
  storePayoutItems,
  storePayouts,
  stores,
  users,
} from '../db/schema'

type PeriodInput = {
  periodStart: Date
  periodEnd: Date
}

export class FinanceError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

export async function closeFinancePeriod(db: Db, { periodStart, periodEnd }: PeriodInput) {
  if (periodEnd <= periodStart) throw new FinanceError('Período inválido', 400)

  return db.transaction(async (tx) => {
    async function hasStoreInvoiceItem(ledgerEntryId: string) {
      const [row] = await tx.select({ id: storeInvoiceItems.id }).from(storeInvoiceItems)
        .where(eq(storeInvoiceItems.ledgerEntryId, ledgerEntryId))
        .limit(1)
      return Boolean(row)
    }

    async function hasStorePayoutItem(ledgerEntryId: string) {
      const [row] = await tx.select({ id: storePayoutItems.id }).from(storePayoutItems)
        .where(eq(storePayoutItems.ledgerEntryId, ledgerEntryId))
        .limit(1)
      return Boolean(row)
    }

    async function hasDriverPayoutItem(ledgerEntryId: string) {
      const [row] = await tx.select({ id: driverPayoutItems.id }).from(driverPayoutItems)
        .where(eq(driverPayoutItems.ledgerEntryId, ledgerEntryId))
        .limit(1)
      return Boolean(row)
    }

    async function ensureStoreInvoice(storeId: string) {
      const [existing] = await tx.select().from(storeInvoices)
        .where(and(
          eq(storeInvoices.storeId, storeId),
          eq(storeInvoices.periodStart, periodStart),
          eq(storeInvoices.periodEnd, periodEnd),
        ))
        .limit(1)
      if (existing) return existing.status === 'OPEN' ? existing : null
      const [created] = await tx.insert(storeInvoices).values({ storeId, periodStart, periodEnd, totalCents: 0 })
        .onConflictDoNothing()
        .returning()
      if (created) return created
      const [raced] = await tx.select().from(storeInvoices)
        .where(and(
          eq(storeInvoices.storeId, storeId),
          eq(storeInvoices.periodStart, periodStart),
          eq(storeInvoices.periodEnd, periodEnd),
        ))
        .limit(1)
      return raced?.status === 'OPEN' ? raced : null
    }

    async function ensureStorePayout(storeId: string) {
      const [existing] = await tx.select().from(storePayouts)
        .where(and(
          eq(storePayouts.storeId, storeId),
          eq(storePayouts.periodStart, periodStart),
          eq(storePayouts.periodEnd, periodEnd),
        ))
        .limit(1)
      if (existing) return existing.status === 'OPEN' ? existing : null
      const [created] = await tx.insert(storePayouts).values({ storeId, periodStart, periodEnd, totalCents: 0 })
        .onConflictDoNothing()
        .returning()
      if (created) return created
      const [raced] = await tx.select().from(storePayouts)
        .where(and(
          eq(storePayouts.storeId, storeId),
          eq(storePayouts.periodStart, periodStart),
          eq(storePayouts.periodEnd, periodEnd),
        ))
        .limit(1)
      return raced?.status === 'OPEN' ? raced : null
    }

    async function ensureDriverPayout(driverId: string) {
      const [existing] = await tx.select().from(driverPayouts)
        .where(and(
          eq(driverPayouts.driverId, driverId),
          eq(driverPayouts.periodStart, periodStart),
          eq(driverPayouts.periodEnd, periodEnd),
        ))
        .limit(1)
      if (existing) return existing.status === 'OPEN' ? existing : null
      const [created] = await tx.insert(driverPayouts).values({ driverId, periodStart, periodEnd, totalCents: 0 })
        .onConflictDoNothing()
        .returning()
      if (created) return created
      const [raced] = await tx.select().from(driverPayouts)
        .where(and(
          eq(driverPayouts.driverId, driverId),
          eq(driverPayouts.periodStart, periodStart),
          eq(driverPayouts.periodEnd, periodEnd),
        ))
        .limit(1)
      return raced?.status === 'OPEN' ? raced : null
    }

    async function refreshStoreInvoiceTotal(invoiceId: string) {
      const items = await tx.select({ amountCents: storeInvoiceItems.amountCents }).from(storeInvoiceItems)
        .where(eq(storeInvoiceItems.invoiceId, invoiceId))
      await tx.update(storeInvoices)
        .set({ totalCents: items.reduce((sum, item) => sum + item.amountCents, 0) })
        .where(eq(storeInvoices.id, invoiceId))
    }

    async function refreshStorePayoutTotal(payoutId: string) {
      const items = await tx.select({ amountCents: storePayoutItems.amountCents }).from(storePayoutItems)
        .where(eq(storePayoutItems.payoutId, payoutId))
      await tx.update(storePayouts)
        .set({ totalCents: items.reduce((sum, item) => sum + item.amountCents, 0) })
        .where(eq(storePayouts.id, payoutId))
    }

    async function refreshDriverPayoutTotal(payoutId: string) {
      const items = await tx.select({ amountCents: driverPayoutItems.amountCents }).from(driverPayoutItems)
        .where(eq(driverPayoutItems.payoutId, payoutId))
      await tx.update(driverPayouts)
        .set({ totalCents: items.reduce((sum, item) => sum + item.amountCents, 0) })
        .where(eq(driverPayouts.id, payoutId))
    }

    const entries = await tx.select().from(ledgerEntries)
      .where(and(gte(ledgerEntries.createdAt, periodStart), lt(ledgerEntries.createdAt, periodEnd)))

    for (const entry of entries) {
      if (entry.party === 'STORE' && entry.amountCents < 0 && entry.storeId && !(await hasStoreInvoiceItem(entry.id))) {
        const invoice = await ensureStoreInvoice(entry.storeId)
        if (!invoice) continue
        await tx.insert(storeInvoiceItems)
          .values({ invoiceId: invoice.id, ledgerEntryId: entry.id, amountCents: Math.abs(entry.amountCents) })
          .onConflictDoNothing()
        await refreshStoreInvoiceTotal(invoice.id)
      }

      if (entry.party === 'STORE' && entry.amountCents > 0 && entry.storeId && !(await hasStorePayoutItem(entry.id))) {
        const payout = await ensureStorePayout(entry.storeId)
        if (!payout) continue
        await tx.insert(storePayoutItems)
          .values({ payoutId: payout.id, ledgerEntryId: entry.id, amountCents: entry.amountCents })
          .onConflictDoNothing()
        await refreshStorePayoutTotal(payout.id)
      }

      if (entry.party === 'DRIVER' && entry.amountCents > 0 && entry.driverId && !(await hasDriverPayoutItem(entry.id))) {
        const payout = await ensureDriverPayout(entry.driverId)
        if (!payout) continue
        await tx.insert(driverPayoutItems)
          .values({ payoutId: payout.id, ledgerEntryId: entry.id, amountCents: entry.amountCents })
          .onConflictDoNothing()
        await refreshDriverPayoutTotal(payout.id)
      }
    }

    const storeInvoiceDocs = await tx.select({ id: storeInvoices.id }).from(storeInvoices)
      .where(and(eq(storeInvoices.periodStart, periodStart), eq(storeInvoices.periodEnd, periodEnd)))
    const storePayoutDocs = await tx.select({ id: storePayouts.id }).from(storePayouts)
      .where(and(eq(storePayouts.periodStart, periodStart), eq(storePayouts.periodEnd, periodEnd)))
    const driverPayoutDocs = await tx.select({ id: driverPayouts.id }).from(driverPayouts)
      .where(and(eq(driverPayouts.periodStart, periodStart), eq(driverPayouts.periodEnd, periodEnd)))

    return {
      storeInvoices: storeInvoiceDocs.length,
      storePayouts: storePayoutDocs.length,
      driverPayouts: driverPayoutDocs.length,
    }
  })
}

export async function markStoreInvoicePaid(db: Db, id: string) {
  const [row] = await db.update(storeInvoices)
    .set({ status: 'PAID', paidAt: new Date() })
    .where(eq(storeInvoices.id, id))
    .returning()
  if (!row) throw new FinanceError('Fatura não encontrada', 404)
  return row
}

export async function markStorePayoutPaid(db: Db, id: string) {
  const [row] = await db.update(storePayouts)
    .set({ status: 'PAID', paidAt: new Date() })
    .where(eq(storePayouts.id, id))
    .returning()
  if (!row) throw new FinanceError('Repasse da loja não encontrado', 404)
  return row
}

export async function markDriverPayoutPaid(db: Db, id: string) {
  const [row] = await db.update(driverPayouts)
    .set({ status: 'PAID', paidAt: new Date() })
    .where(eq(driverPayouts.id, id))
    .returning()
  if (!row) throw new FinanceError('Repasse do entregador não encontrado', 404)
  return row
}

export async function listAdminFinance(db: Db) {
  const invoices = await db
    .select({
      id: storeInvoices.id,
      storeId: storeInvoices.storeId,
      storeName: stores.name,
      periodStart: storeInvoices.periodStart,
      periodEnd: storeInvoices.periodEnd,
      status: storeInvoices.status,
      totalCents: storeInvoices.totalCents,
      paidAt: storeInvoices.paidAt,
      createdAt: storeInvoices.createdAt,
    })
    .from(storeInvoices)
    .innerJoin(stores, eq(stores.id, storeInvoices.storeId))
    .orderBy(desc(storeInvoices.createdAt))
    .limit(100)
  const storePayoutRows = await db
    .select({
      id: storePayouts.id,
      storeId: storePayouts.storeId,
      storeName: stores.name,
      periodStart: storePayouts.periodStart,
      periodEnd: storePayouts.periodEnd,
      status: storePayouts.status,
      totalCents: storePayouts.totalCents,
      paidAt: storePayouts.paidAt,
      createdAt: storePayouts.createdAt,
    })
    .from(storePayouts)
    .innerJoin(stores, eq(stores.id, storePayouts.storeId))
    .orderBy(desc(storePayouts.createdAt))
    .limit(100)
  const driverPayoutRows = await db
    .select({
      id: driverPayouts.id,
      driverId: driverPayouts.driverId,
      driverName: users.name,
      periodStart: driverPayouts.periodStart,
      periodEnd: driverPayouts.periodEnd,
      status: driverPayouts.status,
      totalCents: driverPayouts.totalCents,
      paidAt: driverPayouts.paidAt,
      createdAt: driverPayouts.createdAt,
    })
    .from(driverPayouts)
    .innerJoin(users, eq(users.id, driverPayouts.driverId))
    .orderBy(desc(driverPayouts.createdAt))
    .limit(100)
  return { storeInvoices: invoices, storePayouts: storePayoutRows, driverPayouts: driverPayoutRows }
}

export async function getStoreFinance(db: Db, storeId: string) {
  const ledger = await db.select().from(ledgerEntries)
    .where(eq(ledgerEntries.storeId, storeId))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(100)
  const invoices = await db.select().from(storeInvoices)
    .where(eq(storeInvoices.storeId, storeId))
    .orderBy(desc(storeInvoices.createdAt))
    .limit(50)
  const payouts = await db.select().from(storePayouts)
    .where(eq(storePayouts.storeId, storeId))
    .orderBy(desc(storePayouts.createdAt))
    .limit(50)
  return { ledger, invoices, payouts }
}

export async function getDriverFinance(db: Db, driverId: string) {
  const ledger = await db.select().from(ledgerEntries)
    .where(eq(ledgerEntries.driverId, driverId))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(100)
  const payouts = await db.select().from(driverPayouts)
    .where(eq(driverPayouts.driverId, driverId))
    .orderBy(desc(driverPayouts.createdAt))
    .limit(50)
  return { ledger, payouts }
}

/** Explicit projection: this response must never expose customer or delivery data. */
export async function getDriverEarningOrderDetail(db: Db, driverId: string, orderId: string) {
  const [order] = await db.select({
    orderId: orders.id,
    createdAt: orders.createdAt,
    status: orders.status,
    storeName: stores.name,
  }).from(orders)
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .where(and(eq(orders.id, orderId), eq(orders.driverId, driverId)))
    .limit(1)
  if (!order) throw new FinanceError('Pedido não encontrado', 404)

  const [items, ledger] = await Promise.all([
    db.select({
      nameSnapshot: orderItems.nameSnapshot,
      quantity: orderItems.quantity,
    }).from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.sortIndex)),
    db.select({
      type: ledgerEntries.type,
      amountCents: ledgerEntries.amountCents,
      description: ledgerEntries.description,
      createdAt: ledgerEntries.createdAt,
    }).from(ledgerEntries)
      .where(and(eq(ledgerEntries.orderId, orderId), eq(ledgerEntries.driverId, driverId)))
      .orderBy(asc(ledgerEntries.createdAt)),
  ])
  return { ...order, items, ledger }
}

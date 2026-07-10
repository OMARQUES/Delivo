import { and, eq, gte, lt } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  driverPayoutItems,
  driverPayouts,
  ledgerEntries,
  storeInvoiceItems,
  storeInvoices,
  storePayoutItems,
  storePayouts,
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

import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { FINANCE_DOCUMENT_STATUSES, LEDGER_ENTRY_TYPES } from '@delivery/shared/constants'
import { orders } from './orders'
import { stores } from './stores'
import { users } from './users'

export const ledgerParty = pgEnum('ledger_party', ['STORE', 'DRIVER'])
export const ledgerEntryType = pgEnum('ledger_entry_type', LEDGER_ENTRY_TYPES)
export const financeDocumentStatus = pgEnum('finance_document_status', FINANCE_DOCUMENT_STATUSES)

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    party: ledgerParty('party').notNull(),
    type: ledgerEntryType('type').notNull(),
    amountCents: integer('amount_cents').notNull(),
    description: text('description').notNull(),
    uniqueKey: text('unique_key').notNull(),
    orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ledger_entries_unique_key').on(t.uniqueKey)],
)

export const storeInvoices = pgTable(
  'store_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    status: financeDocumentStatus('status').notNull().default('OPEN'),
    totalCents: integer('total_cents').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('store_invoices_period_unique').on(t.storeId, t.periodStart, t.periodEnd)],
)

export const storeInvoiceItems = pgTable(
  'store_invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id').notNull().references(() => storeInvoices.id, { onDelete: 'cascade' }),
    ledgerEntryId: uuid('ledger_entry_id').notNull().references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
  },
  (t) => [uniqueIndex('store_invoice_items_ledger_unique').on(t.ledgerEntryId)],
)

export const storePayouts = pgTable(
  'store_payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    status: financeDocumentStatus('status').notNull().default('OPEN'),
    totalCents: integer('total_cents').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('store_payouts_period_unique').on(t.storeId, t.periodStart, t.periodEnd)],
)

export const storePayoutItems = pgTable(
  'store_payout_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payoutId: uuid('payout_id').notNull().references(() => storePayouts.id, { onDelete: 'cascade' }),
    ledgerEntryId: uuid('ledger_entry_id').notNull().references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
  },
  (t) => [uniqueIndex('store_payout_items_ledger_unique').on(t.ledgerEntryId)],
)

export const driverPayouts = pgTable(
  'driver_payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    driverId: uuid('driver_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    status: financeDocumentStatus('status').notNull().default('OPEN'),
    totalCents: integer('total_cents').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('driver_payouts_period_unique').on(t.driverId, t.periodStart, t.periodEnd)],
)

export const driverPayoutItems = pgTable(
  'driver_payout_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payoutId: uuid('payout_id').notNull().references(() => driverPayouts.id, { onDelete: 'cascade' }),
    ledgerEntryId: uuid('ledger_entry_id').notNull().references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
  },
  (t) => [uniqueIndex('driver_payout_items_ledger_unique').on(t.ledgerEntryId)],
)

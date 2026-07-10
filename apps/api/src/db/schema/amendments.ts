import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { orders, orderItems } from './orders'
import { users } from './users'

export const amendmentStatus = pgEnum('amendment_status', ['PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED'])

/** Proposta de alteração da loja (1 PROPOSED por pedido — garantido no service) */
export const orderAmendments = pgTable('order_amendments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  status: amendmentStatus('status').notNull().default('PROPOSED'),
  proposedByUserId: uuid('proposed_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  note: text('note'),
  /** valores CONGELADOS no momento da proposta */
  newSubtotalCents: integer('new_subtotal_cents').notNull(),
  newTotalCents: integer('new_total_cents').notNull(),
  /** diferença a estornar (subtotal antigo - novo); informativo em pagamento na entrega */
  refundCents: integer('refund_cents').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})

export const orderAmendmentItems = pgTable('order_amendment_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  amendmentId: uuid('amendment_id').notNull().references(() => orderAmendments.id, { onDelete: 'cascade' }),
  orderItemId: uuid('order_item_id').notNull().references(() => orderItems.id, { onDelete: 'cascade' }),
  /** snapshot pro diff na UI */
  nameSnapshot: text('name_snapshot').notNull(),
  oldQuantity: integer('old_quantity').notNull(),
  newQuantity: integer('new_quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
})

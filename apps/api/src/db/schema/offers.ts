import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { OfferRecurrence } from '@delivery/shared'
import { stores } from './stores'
import { users } from './users'

export const offerStatus = pgEnum('driver_offer_status', ['OPEN', 'CLOSED'])
export const offerAcceptanceStatus = pgEnum('offer_acceptance_status', ['ACCEPTED', 'DISMISSED'])

export const driverOffers = pgTable('driver_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  status: offerStatus('status').notNull().default('OPEN'),
  dailyRateCents: integer('daily_rate_cents').notNull(),
  perDeliveryCents: integer('per_delivery_cents').notNull(),
  slots: integer('slots').notNull(),
  acceptedCount: integer('accepted_count').notNull().default(0),
  recurrence: jsonb('recurrence').$type<OfferRecurrence>().notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index('driver_offers_status_idx').on(t.status),
  index('driver_offers_store_status_idx').on(t.storeId, t.status),
  check('driver_offers_slots_valid', sql`${t.slots} between 1 and 20 and ${t.acceptedCount} between 0 and ${t.slots}`),
])

export const offerAcceptances = pgTable('offer_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  offerId: uuid('offer_id').notNull().references(() => driverOffers.id, { onDelete: 'cascade' }),
  driverUserId: uuid('driver_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: offerAcceptanceStatus('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('offer_acceptances_offer_driver_unique').on(t.offerId, t.driverUserId)])

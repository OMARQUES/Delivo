import { sql } from 'drizzle-orm'
import { boolean, date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { driverShifts, storeDrivers } from './store-drivers'

export const shiftAuthorizationStatus = pgEnum('shift_authorization_status', ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'USED'])
export const shiftTermProposalStatus = pgEnum('shift_term_proposal_status', ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'])

export const shiftStartAuthorizations = pgTable('shift_start_authorizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeDriverId: uuid('store_driver_id').notNull().references(() => storeDrivers.id, { onDelete: 'restrict' }),
  workDate: date('work_date').notNull(),
  status: shiftAuthorizationStatus('status').notNull().default('PENDING'),
  authorizedUntil: timestamp('authorized_until', { withTimezone: true }).notNull(),
  scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }).notNull(),
  scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }).notNull(),
  dailyRateCents: integer('daily_rate_cents').notNull(),
  perDeliveryCents: integer('per_delivery_cents').notNull(),
  note: text('note').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex('shift_auth_one_open_per_occurrence').on(t.storeDriverId, t.workDate)
    .where(sql`${t.status} in ('PENDING', 'ACCEPTED')`),
  index('shift_auth_link_status_idx').on(t.storeDriverId, t.status),
])

export const shiftTermProposals = pgTable('shift_term_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  shiftId: uuid('shift_id').notNull().references(() => driverShifts.id, { onDelete: 'restrict' }),
  status: shiftTermProposalStatus('status').notNull().default('PENDING'),
  dailyRateCents: integer('daily_rate_cents').notNull(),
  perDeliveryCents: integer('per_delivery_cents').notNull(),
  applyRetroactive: boolean('apply_retroactive').notNull().default(false),
  note: text('note'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('shift_terms_one_pending').on(t.shiftId).where(sql`${t.status} = 'PENDING'`),
  index('shift_terms_shift_status_idx').on(t.shiftId, t.status),
])

import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  SHIFT_CLOSED_BY,
  SHIFT_STATUSES,
  STORE_DRIVER_STATUSES,
} from '@delivery/shared/constants'
import type { ScheduleItem } from '@delivery/shared'
import { stores } from './stores'
import { users } from './users'

export const storeDriverStatus = pgEnum('store_driver_status', STORE_DRIVER_STATUSES)
export const shiftStatus = pgEnum('shift_status', SHIFT_STATUSES)
export const shiftClosedBy = pgEnum('shift_closed_by', SHIFT_CLOSED_BY)
export const shiftDailyDecision = pgEnum('shift_daily_decision', ['PENDING', 'APPROVED', 'REJECTED'])

export type DriverSchedule = ScheduleItem[]

export const storeDrivers = pgTable(
  'store_drivers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
    driverUserId: uuid('driver_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    status: storeDriverStatus('status').notNull().default('INVITED'),
    dailyRateCents: integer('daily_rate_cents').notNull().default(0),
    perDeliveryCents: integer('per_delivery_cents').notNull().default(0),
    schedule: jsonb('schedule').$type<DriverSchedule>().notNull().default(sql`'[]'::jsonb`),
    pendingDailyRateCents: integer('pending_daily_rate_cents'),
    pendingPerDeliveryCents: integer('pending_per_delivery_cents'),
    pendingSchedule: jsonb('pending_schedule').$type<DriverSchedule>(),
    pendingProposedAt: timestamp('pending_proposed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index('store_drivers_driver_status_idx').on(t.driverUserId, t.status),
    index('store_drivers_store_status_idx').on(t.storeId, t.status),
    check('store_drivers_pending_terms_complete', sql`(
      ${t.pendingProposedAt} is null
      and ${t.pendingDailyRateCents} is null
      and ${t.pendingPerDeliveryCents} is null
      and ${t.pendingSchedule} is null
    ) or (
      ${t.pendingProposedAt} is not null
      and ${t.pendingDailyRateCents} is not null
      and ${t.pendingPerDeliveryCents} is not null
      and ${t.pendingSchedule} is not null
    )`),
  ],
)

export const driverShifts = pgTable(
  'driver_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    driverUserId: uuid('driver_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    storeDriverId: uuid('store_driver_id').notNull().references(() => storeDrivers.id, { onDelete: 'restrict' }),
    status: shiftStatus('status').notNull().default('ACTIVE'),
    dailyRateCents: integer('daily_rate_cents').notNull(),
    perDeliveryCents: integer('per_delivery_cents').notNull(),
    /** Data operacional no fuso da loja (MVP: America/Sao_Paulo). */
    workDate: date('work_date').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }),
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    earlyClose: boolean('early_close').notNull().default(false),
    closedBy: shiftClosedBy('closed_by'),
    dailyDecision: shiftDailyDecision('daily_decision'),
    dailyDecidedAt: timestamp('daily_decided_at', { withTimezone: true }),
    dailyDecidedBy: uuid('daily_decided_by').references(() => users.id, { onDelete: 'restrict' }),
    dailyDecisionReason: text('daily_decision_reason'),
    autoApproveAt: timestamp('auto_approve_at', { withTimezone: true }),
    reopenUntil: timestamp('reopen_until', { withTimezone: true }),
    reopenCount: integer('reopen_count').notNull().default(0),
    adjustmentSeq: integer('adjustment_seq').notNull().default(0),
  },
  (t) => [
    uniqueIndex('driver_shifts_link_day_unique').on(t.storeDriverId, t.workDate),
    uniqueIndex('driver_shifts_one_active_per_driver')
      .on(t.driverUserId)
      .where(sql`${t.status} = 'ACTIVE'`),
    index('driver_shifts_store_status_idx').on(t.storeId, t.status),
  ],
)

import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { userRole } from './users'

export const pendingRegistrations = pgTable(
  'pending_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    role: userRole('role').notNull(),
    passwordHash: text('password_hash').notNull(),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('pending_registrations_email_lower_idx').on(sql`lower(${t.email})`),
    index('pending_registrations_expires_at_idx').on(t.expiresAt),
    index('pending_registrations_consumed_at_idx').on(t.consumedAt),
    check('pending_registrations_role_allowed', sql`${t.role} in ('CUSTOMER', 'DRIVER')`),
  ],
)

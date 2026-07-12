import { sql } from 'drizzle-orm'
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pendingRegistrations } from './pending-registrations'
import { users } from './users'

export const authChallengePurpose = pgEnum('auth_challenge_purpose', [
  'REGISTRATION_VERIFY',
  'STORE_ACTIVATION',
  'ADMIN_ACTIVATION',
  'PASSWORD_RECOVERY',
])

export type AuthChallengePurpose = (typeof authChallengePurpose.enumValues)[number]

export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: authChallengePurpose('purpose').notNull(),
    pendingRegistrationId: uuid('pending_registration_id').references(() => pendingRegistrations.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    codeHash: text('code_hash').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    invalidationReason: text('invalidation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('auth_challenges_pending_active_idx')
      .on(t.pendingRegistrationId, t.purpose)
      .where(sql`${t.pendingRegistrationId} is not null and ${t.consumedAt} is null and ${t.invalidatedAt} is null`),
    index('auth_challenges_user_active_idx')
      .on(t.userId, t.purpose)
      .where(sql`${t.userId} is not null and ${t.consumedAt} is null and ${t.invalidatedAt} is null`),
    index('auth_challenges_email_active_idx')
      .on(sql`lower(${t.email})`, t.purpose)
      .where(sql`${t.email} is not null and ${t.consumedAt} is null and ${t.invalidatedAt} is null`),
    index('auth_challenges_expires_at_idx').on(t.expiresAt),
    check('auth_challenges_exactly_one_subject', sql`
      (
        case when ${t.pendingRegistrationId} is null then 0 else 1 end
        + case when ${t.userId} is null then 0 else 1 end
        + case when ${t.email} is null then 0 else 1 end
      ) = 1
    `),
    check('auth_challenges_attempt_count_valid', sql`${t.attemptCount} between 0 and 5`),
  ],
)

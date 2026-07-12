import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { authChallenges } from './auth-challenges'
import { users } from './users'

export const authActionTicketPurpose = pgEnum('auth_action_ticket_purpose', [
  'PASSWORD_RESET',
  'INITIAL_PASSWORD_SETUP',
])

export const authActionTickets = pgTable(
  'auth_action_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: authActionTicketPurpose('purpose').notNull(),
    challengeId: uuid('challenge_id').references(() => authChallenges.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_action_tickets_token_hash_unique').on(t.tokenHash),
    index('auth_action_tickets_user_idx').on(t.userId),
    index('auth_action_tickets_expires_at_idx').on(t.expiresAt),
  ],
)

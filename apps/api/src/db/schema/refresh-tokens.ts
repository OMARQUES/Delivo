import { index, pgTable, timestamp, uuid, text } from 'drizzle-orm/pg-core'
import { users } from './users'

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 (base64url) do token opaco — cru nunca toca o banco */
    tokenHash: text('token_hash').notNull().unique(),
    /** Família de rotação. Reuso → revoga família inteira. */
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refresh_tokens_family_idx').on(t.familyId)],
)

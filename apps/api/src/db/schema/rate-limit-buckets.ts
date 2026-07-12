import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    scope: text('scope').notNull(),
    keyHash: text('key_hash').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.keyHash, t.windowStart] }),
    index('rate_limit_buckets_expires_at_idx').on(t.expiresAt),
  ],
)

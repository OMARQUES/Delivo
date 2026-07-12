import { check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { authChallenges } from './auth-challenges'

export const emailOutboxStatus = pgEnum('email_outbox_status', [
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
  'CANCELLED',
])

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    template: text('template').notNull(),
    recipient: text('recipient').notNull(),
    challengeId: uuid('challenge_id').references(() => authChallenges.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull(),
    dedupeKey: text('dedupe_key'),
    status: emailOutboxStatus('status').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    providerMessageId: text('provider_message_id'),
    failureClass: text('failure_class'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('email_outbox_idempotency_key_unique').on(t.idempotencyKey),
    uniqueIndex('email_outbox_dedupe_key_unique').on(t.dedupeKey),
    index('email_outbox_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
    index('email_outbox_leased_until_idx').on(t.leasedUntil),
    index('email_outbox_challenge_idx').on(t.challengeId),
    check('email_outbox_attempt_count_valid', sql`${t.attemptCount} >= 0`),
  ],
)

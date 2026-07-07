import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const authProviderType = pgEnum('auth_provider_type', ['PASSWORD', 'GOOGLE'])

export const authProviders = pgTable(
  'auth_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderType('provider').notNull(),
    /** Google: sub do id_token. PASSWORD: null. */
    providerUserId: text('provider_user_id'),
    /** PASSWORD: string `pbkdf2$iter$saltB64$hashB64`. GOOGLE: null. */
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('auth_providers_user_provider_unique').on(t.userId, t.provider),
    uniqueIndex('auth_providers_provider_uid_unique').on(t.provider, t.providerUserId),
  ],
)

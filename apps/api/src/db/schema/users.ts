import { sql } from 'drizzle-orm'
import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['CUSTOMER', 'STORE', 'DRIVER', 'ADMIN'])
export const userStatus = pgEnum('user_status', ['PENDING_EMAIL', 'PENDING_APPROVAL', 'ACTIVE', 'BLOCKED'])
export type UserRole = (typeof userRole.enumValues)[number]
export type UserStatus = (typeof userStatus.enumValues)[number]
export const registrationSource = pgEnum('registration_source', [
  'SELF_SERVICE',
  'ADMIN_PROVISIONED',
  'BOOTSTRAP',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: userRole('role').notNull().default('CUSTOMER'),
    status: userStatus('status').notNull().default('ACTIVE'),
    tokenVersion: integer('token_version').notNull().default(0),
    /** LGPD: momento do aceite da política (null = conta criada por admin/seed) */
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    registrationSource: registrationSource('registration_source').notNull().default('SELF_SERVICE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Case-insensitive uniqueness: Foo@x.com and foo@x.com are the same user.
    uniqueIndex('users_email_lower_unique').on(sql`lower(${t.email})`),
  ],
)

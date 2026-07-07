import { sql } from 'drizzle-orm'
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['CUSTOMER', 'STORE', 'DRIVER', 'ADMIN'])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: userRole('role').notNull().default('CUSTOMER'),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Case-insensitive uniqueness: Foo@x.com and foo@x.com are the same user.
    uniqueIndex('users_email_lower_unique').on(sql`lower(${t.email})`),
    // Unique when present; multiple NULL phones allowed.
    uniqueIndex('users_phone_unique').on(t.phone).where(sql`${t.phone} is not null`),
  ],
)

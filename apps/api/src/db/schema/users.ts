import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['CUSTOMER', 'STORE', 'DRIVER', 'ADMIN'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: userRole('role').notNull().default('CUSTOMER'),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

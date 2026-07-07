/**
 * Seed idempotente. Lê DATABASE_URL + ADMIN_* do apps/api/.env.
 * Uso: pnpm --filter @delivery/api db:seed
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import * as schema from './schema'
import { hashPassword } from '../lib/password'

const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env
if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error('Defina DATABASE_URL, ADMIN_EMAIL e ADMIN_PASSWORD no apps/api/.env')
}

const client = postgres(DATABASE_URL, { max: 1 })
const db = drizzle(client, { schema })

const email = ADMIN_EMAIL.trim().toLowerCase()
const existing = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(sql`lower(${schema.users.email}) = ${email}`)
  .limit(1)

if (existing.length > 0) {
  console.log(`admin já existe (${email}) — nada a fazer`)
} else {
  const [admin] = await db
    .insert(schema.users)
    .values({ name: ADMIN_NAME ?? 'Admin', email, role: 'ADMIN', status: 'ACTIVE' })
    .returning()
  await db.insert(schema.authProviders).values({
    userId: admin!.id,
    provider: 'PASSWORD',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
  })
  console.log(`admin criado: ${email}`)
}

await client.end()

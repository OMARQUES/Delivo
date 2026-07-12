import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../../src/db/schema'
import { refreshTokens, users } from '../../src/db/schema'
import { signAccessToken } from '../../src/lib/tokens'

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/delivery_test'

// Resolvido relativo a este arquivo (não ao CWD): funciona tanto local
// (`pnpm --filter`, cwd=apps/api) quanto em CI (`pnpm test` recursivo, cwd=repo root).
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle')

const client = postgres(TEST_DATABASE_URL, { max: 2, fetch_types: false })
export const testDb = drizzle(client, { schema })

/** Aplica migrations (idempotente). Chamar em beforeAll. */
export async function migrateTestDb() {
  await migrate(testDb, { migrationsFolder })
}

/** Limpa dados entre testes preservando schema. */
export async function truncateAll() {
  await testDb.execute(sql`TRUNCATE TABLE email_outbox, auth_action_tickets, auth_challenges, pending_registrations, identity_security_events, rate_limit_buckets, shift_term_proposals, shift_start_authorizations, offer_acceptances, driver_offers, driver_payout_items, store_payout_items, store_invoice_items, driver_payouts, store_payouts, store_invoices, ledger_entries, order_amendment_items, order_amendments, payments, order_events, order_item_options, order_items, orders, delivery_batches, driver_shifts, store_drivers, customer_addresses, drivers, option_variation_prices, options, option_groups, products, product_categories, refresh_tokens, auth_providers, stores, users CASCADE`)
}

/** Fecha a conexão. Chamar em afterAll do último suite. */
export async function closeTestDb() {
  await client.end()
}

export async function createTestSession(
  principal: { sub: string; role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'; name: string },
  secret: string,
) {
  let [user] = await testDb.select().from(users).where(sql`${users.id} = ${principal.sub}`).limit(1)
  if (!user) {
    [user] = await testDb.insert(users).values({
      id: principal.sub,
      name: principal.name,
      role: principal.role,
      status: 'ACTIVE',
      email: `${principal.sub}@test.local`,
    }).returning()
  }
  if (!user) throw new Error('test session user was not created')
  const familyId = crypto.randomUUID()
  await testDb.insert(refreshTokens).values({
    userId: user.id,
    familyId,
    tokenHash: `test-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  })
  return signAccessToken(
    { sub: user.id, role: user.role, name: user.name, tokenVersion: user.tokenVersion },
    secret,
    familyId,
  )
}

/** Agenda semanal cuja janela começou agora e termina em uma hora (fuso SP). */
export function scheduleForNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  const startMinutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'))
  const endMinutes = (startMinutes + 60) % 1440
  const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  return [{ dow, start: time(startMinutes), end: time(endMinutes) }]
}

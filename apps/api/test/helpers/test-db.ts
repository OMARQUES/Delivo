import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../../src/db/schema'

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
  await testDb.execute(sql`TRUNCATE TABLE option_variation_prices, options, option_groups, products, product_categories, refresh_tokens, auth_providers, stores, users CASCADE`)
}

/** Fecha a conexão. Chamar em afterAll do último suite. */
export async function closeTestDb() {
  await client.end()
}

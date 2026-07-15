import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../../src/db/schema'
import { authProviders, refreshTokens, users } from '../../src/db/schema'
import type { UserRole, UserStatus } from '../../src/db/schema'
import { signAccessToken } from '../../src/lib/tokens'
import { hashPassword } from '../../src/lib/password'
import { issueSessionTokens, toPublicUser } from '../../src/services/auth.service'
import type { StoreCreateInput } from '@delivery/shared/schemas'

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
  await testDb.execute(sql`TRUNCATE TABLE payment_operations, payment_webhook_inbox, payments, email_outbox, auth_action_tickets, auth_challenges, pending_registrations, identity_security_events, rate_limit_buckets, shift_term_proposals, shift_start_authorizations, offer_acceptances, driver_offers, driver_payout_items, store_payout_items, store_invoice_items, driver_payouts, store_payouts, store_invoices, ledger_entries, order_amendment_items, order_amendments, order_events, order_item_options, order_items, orders, delivery_batches, driver_shifts, store_drivers, customer_addresses, drivers, option_variation_prices, options, option_groups, products, product_categories, refresh_tokens, auth_providers, stores, users CASCADE`)
}

/** Fecha a conexão. Chamar em afterAll do último suite. */
export async function closeTestDb() {
  await client.end()
}

function collectTextValues(value: unknown, output: string[]) {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (value instanceof Date || value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, output)
    return
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      output.push(key)
      collectTextValues(nested, output)
    }
  }
}

/** All persisted identity text/JSON values, for raw-secret regression scans. */
export async function identityPersistenceTextValues(): Promise<string[]> {
  const rowSets = await Promise.all([
    testDb.select().from(schema.users),
    testDb.select().from(schema.authProviders),
    testDb.select().from(schema.pendingRegistrations),
    testDb.select().from(schema.authChallenges),
    testDb.select().from(schema.authActionTickets),
    testDb.select().from(schema.emailOutbox),
    testDb.select().from(schema.identitySecurityEvents),
    testDb.select().from(schema.rateLimitBuckets),
    testDb.select().from(schema.refreshTokens),
    testDb.select().from(schema.stores),
  ])
  const values: string[] = []
  collectTextValues(rowSets, values)
  return values
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
      emailVerifiedAt: new Date(),
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

type VerifiedUserInput = {
  name: string
  email: string
  phone?: string | null
  role?: UserRole
  status?: UserStatus
  password?: string
}

async function insertVerifiedTestUser(db: typeof testDb, input: VerifiedUserInput) {
  const email = input.email.trim().toLowerCase()
  if (!email) throw new Error('verified test user email is required')
  if (input.status === 'PENDING_EMAIL') throw new Error('verified test user cannot be PENDING_EMAIL')
  const role = input.role ?? 'CUSTOMER'
  const status = input.status ?? (role === 'DRIVER' ? 'PENDING_APPROVAL' : 'ACTIVE')
  const now = new Date()
  return db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({
      name: input.name,
      email,
      phone: input.phone ?? null,
      role,
      status,
      emailVerifiedAt: now,
      termsAcceptedAt: now,
      registrationSource: 'SELF_SERVICE',
      createdAt: now,
      updatedAt: now,
    }).returning()
    if (!user) throw new Error('verified test user was not created')
    if (input.password !== undefined) {
      await tx.insert(authProviders).values({
        userId: user.id,
        provider: 'PASSWORD',
        passwordHash: await hashPassword(input.password),
        createdAt: now,
        updatedAt: now,
      })
    }
    return user
  })
}

export async function createVerifiedTestUser(input: VerifiedUserInput): Promise<typeof users.$inferSelect> {
  return insertVerifiedTestUser(testDb, input)
}

export type StoreFixtureInput = Omit<StoreCreateInput, 'owner'> & {
  owner: StoreCreateInput['owner'] & { password?: string }
}

const storeFixturePasswordHashes = new Map<string, Promise<string>>()

function storeFixturePasswordHash(password: string): Promise<string> {
  let hash = storeFixturePasswordHashes.get(password)
  if (!hash) {
    hash = hashPassword(password)
    storeFixturePasswordHashes.set(password, hash)
  }
  return hash
}

/** Test-only bypass: creates an already verified/active store without exercising activation email. */
export async function createActiveStoreTestFixture(
  input: StoreFixtureInput,
): Promise<typeof schema.stores.$inferSelect> {
  const { password = 'active-store-test-password', ...ownerInput } = input.owner
  const parsed = {
    ...input,
    phone: input.phone.replace(/\D/g, ''),
    owner: { ...ownerInput, email: ownerInput.email.trim().toLowerCase() },
  }
  // Reusing hashes is acceptable only in this test fixture and keeps the suite fast.
  const passwordHash = await storeFixturePasswordHash(password)
  const now = new Date()

  return testDb.transaction(async (tx) => {
    const [owner] = await tx.insert(schema.users).values({
      name: parsed.owner.name,
      email: parsed.owner.email,
      role: 'STORE',
      status: 'ACTIVE',
      emailVerifiedAt: now,
      termsAcceptedAt: now,
      registrationSource: 'ADMIN_PROVISIONED',
      createdAt: now,
      updatedAt: now,
    }).returning()
    if (!owner) throw new Error('active store fixture owner was not created')

    await tx.insert(schema.authProviders).values({
      userId: owner.id,
      provider: 'PASSWORD',
      passwordHash,
      createdAt: now,
      updatedAt: now,
    })
    const [store] = await tx.insert(schema.stores).values({
      ownerUserId: owner.id,
      name: parsed.name,
      slug: parsed.slug,
      category: parsed.category,
      phone: parsed.phone,
      city: parsed.city,
      addressText: parsed.addressText,
      lat: parsed.lat,
      lng: parsed.lng,
      securityStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    }).returning()
    if (!store) throw new Error('active store fixture was not created')
    return store
  })
}

type LegacyVerifiedAccountInput = {
  name: string
  email?: string
  phone?: string | null
  role?: 'CUSTOMER' | 'DRIVER'
  password: string
  acceptedTerms?: true
}

/** Compatibility helper while legacy tests migrate off the removed production createVerifiedTestAccount bypass. */
export async function createVerifiedTestAccount(
  db: typeof testDb,
  input: LegacyVerifiedAccountInput,
  jwtSecret: string,
) {
  const role = input.role ?? 'CUSTOMER'
  const user = await insertVerifiedTestUser(db, {
    name: input.name,
    email: input.email ?? `test-${crypto.randomUUID()}@test.local`,
    phone: input.phone,
    role,
    status: role === 'DRIVER' ? 'PENDING_APPROVAL' : 'ACTIVE',
    password: input.password,
  })
  const publicUser = toPublicUser(user)
  if (user.status !== 'ACTIVE') return { user: publicUser, accessToken: null, refreshToken: null }
  const tokens = await db.transaction((tx) => issueSessionTokens(
    tx,
    publicUser,
    user.tokenVersion,
    jwtSecret,
  ))
  return { user: publicUser, ...tokens }
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

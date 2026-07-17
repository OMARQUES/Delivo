import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { eq, and } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { hashPassword } from '../lib/password'
import * as schema from './schema'
import { DEMO_OPENING_HOURS, parseDemoAccounts, type DemoAccount } from './demo-seed-config'

const DEMO_FILE = path.resolve(process.cwd(), '.demo-accounts.md')
const REQUIRED_KEYS = [
  'admin', 'customer_a', 'customer_b', 'store_a', 'store_b', 'driver_a', 'driver_b',
] as const

type Db = ReturnType<typeof drizzle<typeof schema>>

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

function accountMap(accounts: DemoAccount[]): Map<string, DemoAccount> {
  const map = new Map(accounts.map((account) => [account.key, account]))
  for (const key of REQUIRED_KEYS) {
    if (!map.has(key)) throw new Error(`DEMO_ACCOUNT_${key.toUpperCase()}_REQUIRED`)
  }
  return map
}

async function ensureUser(tx: Parameters<Parameters<Db['transaction']>[0]>[0], account: DemoAccount) {
  const [existing] = await tx.select().from(schema.users).where(eq(schema.users.email, account.email)).limit(1)
  const now = new Date()
  if (existing && existing.role !== account.role) {
    throw new Error(`DEMO_ACCOUNT_ROLE_MISMATCH_${account.key}`)
  }
  const user = existing ?? (await tx.insert(schema.users).values({
    role: account.role,
    status: account.role === 'DRIVER' ? 'ACTIVE' : 'ACTIVE',
    name: account.name,
    phone: account.phone,
    email: account.email,
    emailVerifiedAt: now,
    termsAcceptedAt: now,
    registrationSource: account.role === 'ADMIN' ? 'BOOTSTRAP' : account.role === 'STORE' ? 'ADMIN_PROVISIONED' : 'SELF_SERVICE',
    createdAt: now,
    updatedAt: now,
  }).returning())[0]
  if (!user) throw new Error(`DEMO_ACCOUNT_CREATE_FAILED_${account.key}`)

  const passwordHash = await hashPassword(account.password)
  const [provider] = await tx.select().from(schema.authProviders).where(and(
    eq(schema.authProviders.userId, user.id),
    eq(schema.authProviders.provider, 'PASSWORD'),
  )).limit(1)
  if (provider) {
    await tx.update(schema.authProviders).set({ passwordHash, updatedAt: now }).where(eq(schema.authProviders.id, provider.id))
  } else {
    await tx.insert(schema.authProviders).values({
      userId: user.id,
      provider: 'PASSWORD',
      passwordHash,
      createdAt: now,
      updatedAt: now,
    })
  }
  return user
}

async function main(): Promise<void> {
  if ((process.env.APP_ENV?.trim() || 'local') !== 'local') {
    throw new Error('DEMO_SEED_LOCAL_ONLY')
  }
  const databaseUrl = requiredEnv('DATABASE_URL')
  const accounts = accountMap(parseDemoAccounts(await readFile(DEMO_FILE, 'utf8')))
  const client = postgres(databaseUrl, { max: 1, fetch_types: false })
  const db = drizzle(client, { schema })

  try {
    const result = await db.transaction(async (tx) => {
      const admin = await ensureUser(tx, accounts.get('admin')!)
      const customerA = await ensureUser(tx, accounts.get('customer_a')!)
      const customerB = await ensureUser(tx, accounts.get('customer_b')!)
      const storeOwnerA = await ensureUser(tx, accounts.get('store_a')!)
      const storeOwnerB = await ensureUser(tx, accounts.get('store_b')!)
      const driverA = await ensureUser(tx, accounts.get('driver_a')!)
      const driverB = await ensureUser(tx, accounts.get('driver_b')!)

      const stores = []
      for (const [owner, values] of [
        [storeOwnerA, { name: 'Demo Burger', slug: 'demo-burger', category: 'Hamburgueria', phone: '44999991001', city: 'Maringá', addressText: 'Rua Demo, 100', lat: -23.4205, lng: -51.9333 }],
        [storeOwnerB, { name: 'Demo Pizza', slug: 'demo-pizza', category: 'Pizzaria', phone: '44999991002', city: 'Maringá', addressText: 'Avenida Demo, 200', lat: -23.4215, lng: -51.9343 }],
      ] as const) {
        const [existing] = await tx.select().from(schema.stores).where(eq(schema.stores.slug, values.slug)).limit(1)
        const store = existing ?? (await tx.insert(schema.stores).values({
          ownerUserId: owner.id,
          ...values,
          securityStatus: 'ACTIVE',
          deliveryFeeMode: 'FIXED',
          deliveryFixedFeeCents: 500,
          minOrderCents: 1000,
          deliveryEtaMinutes: [30, 50],
          pickupEtaMinutes: [15, 25],
          openingHours: DEMO_OPENING_HOURS,
        }).returning())[0]
        if (!store) throw new Error(`DEMO_STORE_CREATE_FAILED_${values.slug}`)
        if (store.ownerUserId !== owner.id) throw new Error(`DEMO_STORE_OWNER_MISMATCH_${values.slug}`)
        await tx.update(schema.stores).set({
          openingHours: DEMO_OPENING_HOURS,
          isPaused: false,
          securityStatus: 'ACTIVE',
          updatedAt: new Date(),
        }).where(eq(schema.stores.id, store.id))
        const [opened] = await tx.select().from(schema.stores).where(eq(schema.stores.id, store.id)).limit(1)
        if (!opened) throw new Error(`DEMO_STORE_UPDATE_FAILED_${values.slug}`)
        stores.push(store)
      }

      for (const [store, productName, price] of [
        [stores[0]!, 'Demo Burger', 2500],
        [stores[1]!, 'Demo Pizza', 3500],
      ] as const) {
        const [category] = await tx.select().from(schema.productCategories).where(and(
          eq(schema.productCategories.storeId, store.id),
          eq(schema.productCategories.name, 'Principal'),
        )).limit(1)
        const productCategory = category ?? (await tx.insert(schema.productCategories).values({ storeId: store.id, name: 'Principal', sortIndex: 0 }).returning())[0]
        if (!productCategory) throw new Error('DEMO_CATEGORY_CREATE_FAILED')
        const [product] = await tx.select().from(schema.products).where(and(
          eq(schema.products.storeId, store.id),
          eq(schema.products.name, productName),
        )).limit(1)
        if (!product) await tx.insert(schema.products).values({
          storeId: store.id,
          categoryId: productCategory.id,
          name: productName,
          description: 'Produto de demonstração local',
          basePriceCents: price,
          isAvailable: true,
          sortIndex: 0,
        })
      }

      for (const [user, label, addressText, lat, lng] of [
        [customerA, 'Casa', 'Rua Cliente A, 10', -23.422, -51.932],
        [customerB, 'Casa', 'Rua Cliente B, 20', -23.423, -51.931],
      ] as const) {
        const [address] = await tx.select().from(schema.customerAddresses).where(and(
          eq(schema.customerAddresses.userId, user.id),
          eq(schema.customerAddresses.label, label),
        )).limit(1)
        if (!address) await tx.insert(schema.customerAddresses).values({ userId: user.id, label, addressText, lat, lng })
      }

      for (const [store, driver] of [[stores[0]!, driverA], [stores[0]!, driverB], [stores[1]!, driverA]] as const) {
        const [link] = await tx.select().from(schema.storeDrivers).where(and(
          eq(schema.storeDrivers.storeId, store.id),
          eq(schema.storeDrivers.driverUserId, driver.id),
        )).limit(1)
        if (!link) await tx.insert(schema.storeDrivers).values({
          storeId: store.id,
          driverUserId: driver.id,
          status: 'CONFIRMED',
          dailyRateCents: 5000,
          perDeliveryCents: 700,
          schedule: [],
        })
      }

      for (const driver of [driverA, driverB]) {
        const [profile] = await tx.select().from(schema.drivers).where(eq(schema.drivers.userId, driver.id)).limit(1)
        if (!profile) await tx.insert(schema.drivers).values({ userId: driver.id, isAvailable: true })
      }

      return { users: 7, stores: stores.length, products: stores.length, customers: 2, drivers: 2, admin: admin.id }
    })
    console.log(`demo_seed=PASS users=${result.users} stores=${result.stores} products=${result.products} customers=${result.customers} drivers=${result.drivers}`)
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(`demo_seed=FAIL code=${error instanceof Error ? error.message : 'UNKNOWN'}`)
  process.exitCode = 1
})

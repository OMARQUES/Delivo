import { lte, sql } from 'drizzle-orm'
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

const scheduledClientEnd = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: scheduledClientEnd } }) }
})

import worker from '../src/index'
import type { Env } from '../src/env'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct, replaceProductOptions } from '../src/services/catalog.service'
import { createOrder, getCustomerOrder } from '../src/services/order.service'
import { cancelStalePendingOrders } from '../src/services/order-status.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'
import { emailOutbox, rateLimitBuckets } from '../src/db/schema'
import { deleteExpiredRateLimitBuckets } from '../src/security/rate-limit-cleanup'

const storeInput: StoreCreateInput = {
  name: 'Pizzaria',
  slug: 'pizzaria',
  category: 'PIZZARIA',
  phone: '4433334444',
  city: 'C',
  addressText: 'Rua A, 1',
  lat: -23.55,
  lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}
const ana = { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER' as const, acceptedTerms: true as const }

let customerId: string
let addressId: string
let productId: string
let groupIds: { varId: string; varG: string; adId: string; adBorda: string }

beforeAll(migrateTestDb)
beforeEach(async () => {
  scheduledClientEnd.mockClear()
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  await updateStore(testDb, store.id, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'DISTANCE',
    deliveryMinFeeCents: 400,
    deliveryPerKmCents: 200,
    deliveryMaxKm: 8,
    minOrderCents: 5000,
  })
  const customer = await createVerifiedTestAccount(testDb, ana, 'test-secret')
  customerId = customer.user.id
  const addr = await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })
  addressId = addr.id
  const cat = await createCategory(testDb, store.id, { name: 'Pizzas' })
  const prod = await createProduct(testDb, store.id, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })
  productId = prod.id
  await replaceProductOptions(testDb, store.id, productId, [
    {
      name: 'Tamanho',
      type: 'VARIATION',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { name: 'P', priceCents: 3000, isAvailable: true },
        { name: 'G', priceCents: 5000, isAvailable: true },
      ],
    },
    {
      name: 'Extras',
      type: 'ADDON',
      minSelect: 0,
      maxSelect: 2,
      options: [{ name: 'Borda', priceCents: 800, isAvailable: true }],
    },
  ])
  const { getStoreCatalog } = await import('../src/services/catalog.service')
  const catalog = await getStoreCatalog(testDb, store.id)
  const groups = catalog[0]!.products[0]!.groups
  const v = groups.find((g) => g.type === 'VARIATION')!
  const a = groups.find((g) => g.type === 'ADDON')!
  groupIds = { varId: v.id, varG: v.options[1]!.id, adId: a.id, adBorda: a.options[0]!.id }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(closeTestDb)

function cronEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'local',
    HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
    BUCKET: {} as R2Bucket,
    JWT_SECRET: 'jwt-secret',
    RATE_LIMIT_HMAC_SECRET: 'rate-secret',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  }
}

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY' as const,
    addressId,
    paymentMethod: 'CASH' as const,
    changeForCents: 10000,
    items: [{
      productId,
      quantity: 2,
      selections: [
        { groupId: groupIds.varId, optionIds: [groupIds.varG] },
        { groupId: groupIds.adId, optionIds: [groupIds.adBorda] },
      ],
    }],
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  }
}

describe('cancelStalePendingOrders', () => {
  it('cancels only PENDING older than cutoff, adds SYSTEM event', async () => {
    const { order: fresh } = await createOrder(testDb, customerId, checkout())
    const { order: stale } = await createOrder(testDb, customerId, checkout())
    await testDb.execute(sql`update orders set created_at = now() - interval '31 minutes' where id = ${stale.id}`)
    const { order: accepted } = await createOrder(testDb, customerId, checkout())
    await testDb.execute(sql`update orders set created_at = now() - interval '31 minutes', status = 'ACCEPTED' where id = ${accepted.id}`)

    const n = await cancelStalePendingOrders(testDb, 30)
    expect(n).toBe(1)
    const staleAfter = await getCustomerOrder(testDb, customerId, stale.id)
    expect(staleAfter!.status).toBe('CANCELLED')
    expect(staleAfter!.events.at(-1)!.actorRole).toBe('SYSTEM')
    expect((await getCustomerOrder(testDb, customerId, fresh.id))!.status).toBe('PENDING')
    expect((await getCustomerOrder(testDb, customerId, accepted.id))!.status).toBe('ACCEPTED')
  })

  it('does not cancel AWAITING_PAYMENT orders in the PENDING timeout job', async () => {
    const { order: awaiting } = await createOrder(testDb, customerId, checkout())
    await testDb.execute(sql`
      update orders
      set created_at = now() - interval '40 minutes', status = 'AWAITING_PAYMENT', payment_method = 'PIX_ONLINE'
      where id = ${awaiting.id}
    `)
    const n = await cancelStalePendingOrders(testDb, 30)
    expect(n).toBe(0)
    expect((await getCustomerOrder(testDb, customerId, awaiting.id))!.status).toBe('AWAITING_PAYMENT')
  })
})

describe('deleteExpiredRateLimitBuckets', () => {
  it('deletes expired buckets in bounded batches and leaves live buckets', async () => {
    await truncateAll()
    const now = new Date('2026-07-12T12:00:00.000Z')
    await testDb.insert(rateLimitBuckets).values([
      ...Array.from({ length: 1_002 }, (_, i) => ({
        scope: 'auth:login',
        keyHash: `expired-${i}`,
        windowStart: new Date(now.getTime() - (i + 1) * 60_000),
        count: 1,
        expiresAt: new Date(now.getTime() - (i + 1) * 1_000),
      })),
      {
        scope: 'auth:login',
        keyHash: 'live',
        windowStart: now,
        count: 1,
        expiresAt: new Date(now.getTime() + 60_000),
      },
    ])

    await expect(deleteExpiredRateLimitBuckets(testDb, now, 1_000)).resolves.toBe(1_000)
    const [remaining] = await testDb
      .select({ count: sql<number>`count(*)::int` })
      .from(rateLimitBuckets)
      .where(lte(rateLimitBuckets.expiresAt, now))
    expect(remaining!.count).toBe(2)

    await expect(deleteExpiredRateLimitBuckets(testDb, now, 1_000)).resolves.toBe(2)
    const rows = await testDb.select().from(rateLimitBuckets)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyHash).toBe('live')
  })
})

describe('scheduled identity maintenance', () => {
  it('does not resolve email configuration when no outbox row is due', async () => {
    await truncateAll()
    const fetchSpy = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchSpy)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await worker.scheduled({} as ScheduledEvent, cronEnv())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(scheduledClientEnd).toHaveBeenCalledTimes(1)
  })

  it('dispatches due email before cleanup and closes the database', async () => {
    await truncateAll()
    const id = crypto.randomUUID()
    await testDb.insert(emailOutbox).values({
      id,
      template: 'PASSWORD_CHANGED_NOTICE',
      recipient: 'allowed@example.com',
      idempotencyKey: `outbox:${id}`,
      nextAttemptAt: new Date(Date.now() - 1),
    })
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'email-cron' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchSpy)

    await worker.scheduled({} as ScheduledEvent, cronEnv({
      RESEND_API_KEY: 're_test',
      AUTH_CODE_SECRET: 'auth-code-secret-with-at-least-32-bytes',
      EMAIL_FROM: 'Delivery <auth@example.com>',
      PUBLIC_WEB_URL: 'http://localhost:5173',
      EMAIL_ALLOWED_RECIPIENTS: 'allowed@example.com',
    }))

    const [row] = await testDb.select().from(emailOutbox).where(sql`${emailOutbox.id} = ${id}`)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(row).toMatchObject({ status: 'SENT', providerMessageId: 'email-cron' })
    expect(scheduledClientEnd).toHaveBeenCalledTimes(1)
  })

  it('continues rate-limit cleanup when email configuration fails and logs no recipient', async () => {
    await truncateAll()
    const id = crypto.randomUUID()
    await testDb.insert(emailOutbox).values({
      id,
      template: 'PASSWORD_CHANGED_NOTICE',
      recipient: 'secret-recipient@example.com',
      idempotencyKey: `outbox:${id}`,
      nextAttemptAt: new Date(Date.now() - 1),
    })
    await testDb.insert(rateLimitBuckets).values({
      scope: 'expired',
      keyHash: 'expired',
      windowStart: new Date(Date.now() - 60_000),
      count: 1,
      expiresAt: new Date(Date.now() - 1),
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await worker.scheduled({} as ScheduledEvent, cronEnv())

    expect(await testDb.select().from(rateLimitBuckets)).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).toContain('CONFIG')
    expect(logged).not.toContain('secret-recipient')
    expect(scheduledClientEnd).toHaveBeenCalledTimes(1)
  })
})

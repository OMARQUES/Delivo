import { lte, sql } from 'drizzle-orm'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import { createAddress } from '../src/services/address.service'
import { registerUser } from '../src/services/auth.service'
import { createCategory, createProduct, replaceProductOptions } from '../src/services/catalog.service'
import { createOrder, getCustomerOrder } from '../src/services/order.service'
import { cancelStalePendingOrders } from '../src/services/order-status.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'
import { rateLimitBuckets } from '../src/db/schema'
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
  const customer = await registerUser(testDb, ana, 'test-secret')
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
afterAll(closeTestDb)

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

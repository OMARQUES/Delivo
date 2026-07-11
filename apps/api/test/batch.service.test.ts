import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { closeTestDb, migrateTestDb, scheduleForNow, testDb, truncateAll } from './helpers/test-db'
import { createAddress } from '../src/services/address.service'
import { registerUser } from '../src/services/auth.service'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { acceptDelivery, completeDelivery, listAvailableDeliveries, setAvailability } from '../src/services/dispatch.service'
import { createOrder } from '../src/services/order.service'
import { storeUpdateOrderStatus } from '../src/services/order-status.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'
import { confirmLink, inviteDriver } from '../src/services/store-driver.service'
import { startShift } from '../src/services/shift.service'
import { deliveryBatches, driverShifts, ledgerEntries, orderEvents, orders, users } from '../src/db/schema'
import {
  BatchError,
  acceptBatch,
  broadcastBatch,
  cancelBatch,
  collectBatch,
  createBatch,
  listAvailableBatches,
  listShiftBatches,
  listStoreBatches,
  refuseBatch,
  releaseBatch,
} from '../src/services/batch.service'

const storeInput: StoreCreateInput = {
  name: 'Pizzaria',
  slug: 'pizzaria-batch',
  category: 'PIZZARIA',
  phone: '4433334444',
  city: 'C',
  addressText: 'Rua A, 1',
  lat: -23.55,
  lng: -51.9,
  owner: { name: 'João', email: 'batch-store@email.com', password: 'senha123' },
}
const person = {
  name: 'Ana',
  phone: '44999998888',
  password: 'senha123',
  role: 'CUSTOMER' as const,
  acceptedTerms: true as const,
}

let storeId: string
let otherStoreId: string
let customerId: string
let addressId: string
let productId: string
let otherProductId: string
let driver1: string
let driver2: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  const other = await createStoreWithOwner(testDb, {
    ...storeInput,
    name: 'Sushi',
    slug: 'sushi-batch',
    phone: '4433335555',
    owner: { name: 'Maria', email: 'batch-other@email.com', password: 'senha123' },
  })
  storeId = store.id
  otherStoreId = other.id
  for (const id of [storeId, otherStoreId]) {
    await updateStore(testDb, id, {
      openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
      deliveryFeeMode: 'FIXED',
      deliveryFixedFeeCents: 500,
    })
  }
  const customer = await registerUser(testDb, person, 'test-secret')
  customerId = customer.user.id
  addressId = (await createAddress(testDb, customerId, {
    addressText: 'Rua B, 22',
    lat: -23.56,
    lng: -51.9,
  })).id
  const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
  productId = (await createProduct(testDb, storeId, {
    categoryId: cat.id,
    name: 'Pizza',
    basePriceCents: 3000,
    isAvailable: true,
  })).id
  const otherCat = await createCategory(testDb, otherStoreId, { name: 'Sushi' })
  otherProductId = (await createProduct(testDb, otherStoreId, {
    categoryId: otherCat.id,
    name: 'Combinado',
    basePriceCents: 4000,
    isAvailable: true,
  })).id
  const d1 = await registerUser(testDb, { ...person, name: 'Duda', phone: '44911111111', role: 'DRIVER' }, 'test-secret')
  const d2 = await registerUser(testDb, { ...person, name: 'Edu', phone: '44922222222', role: 'DRIVER' }, 'test-secret')
  driver1 = d1.user.id
  driver2 = d2.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(inArray(users.id, [driver1, driver2]))
})
afterAll(closeTestDb)

async function makeEligible(otherStore = false) {
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: otherStore ? 'sushi-batch' : 'pizzaria-batch',
    fulfillment: 'DELIVERY',
    addressId,
    paymentMethod: 'CASH',
    items: [{ productId: otherStore ? otherProductId : productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
  })
  await storeUpdateOrderStatus(testDb, otherStore ? otherStoreId : storeId, order.id, 'ACCEPTED', customerId)
  return order.id
}

async function makeBatch() {
  const ids = await Promise.all([makeEligible(), makeEligible(), makeEligible()])
  const batch = await createBatch(testDb, storeId, ids)
  return { batch, ids }
}

describe('store-side batches', () => {
  it('creates OPEN with at least two distinct eligible orders and exposes totals', async () => {
    const first = await makeEligible()
    await expect(createBatch(testDb, storeId, [first, first])).rejects.toMatchObject({ status: 400 })
    const second = await makeEligible()
    const batch = await createBatch(testDb, storeId, [first, second])

    expect(batch).toMatchObject({ storeId, status: 'OPEN', driverId: null })
    const rows = await testDb.select().from(orders).where(inArray(orders.id, [first, second]))
    expect(rows.every((o) => o.batchId === batch.id)).toBe(true)
    expect(await listStoreBatches(testDb, storeId)).toMatchObject([
      { id: batch.id, count: 2, feeTotalCents: 1000 },
    ])
  })

  it('rejects missing/cross-store/ineligible/already-batched orders', async () => {
    const own = await makeEligible()
    const foreign = await makeEligible(true)
    await expect(createBatch(testDb, storeId, [own, crypto.randomUUID()])).rejects.toMatchObject({ status: 404 })
    await expect(createBatch(testDb, storeId, [own, foreign])).rejects.toMatchObject({ status: 404 })

    const assigned = await makeEligible()
    await testDb.update(orders).set({ driverId: driver1 }).where(eq(orders.id, assigned))
    await expect(createBatch(testDb, storeId, [own, assigned])).rejects.toMatchObject({ status: 409 })

    const second = await makeEligible()
    await createBatch(testDb, storeId, [own, second])
    const third = await makeEligible()
    await expect(createBatch(testDb, storeId, [own, third])).rejects.toMatchObject({ status: 409 })
  })

  it('atomically prevents the same orders from entering two packages', async () => {
    const ids = await Promise.all([makeEligible(), makeEligible()])
    const results = await Promise.allSettled([
      createBatch(testDb, storeId, ids),
      createBatch(testDb, storeId, ids),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 409 })
  })

  it('broadcasts OPEN packages and cancellation clears dispatch fields', async () => {
    const { batch, ids } = await makeBatch()
    const pending = await broadcastBatch(testDb, storeId, batch.id)
    expect(pending.status).toBe('PENDING')
    expect((await testDb.select().from(orders).where(inArray(orders.id, ids))).every((o) => o.driverRequestedAt)).toBe(true)
    await expect(broadcastBatch(testDb, storeId, batch.id)).resolves.toMatchObject({ status: 'PENDING', target: 'GENERAL' })

    const cancelled = await cancelBatch(testDb, storeId, batch.id)
    expect(cancelled.status).toBe('CANCELLED')
    expect((await testDb.select().from(orders).where(inArray(orders.id, ids))).every((o) => !o.batchId && !o.driverRequestedAt)).toBe(true)
    await expect(cancelBatch(testDb, otherStoreId, batch.id)).rejects.toMatchObject({ status: 404 })
  })

  it('direciona pacote a próprios/específico e aceite em turno grava shiftId', async () => {
    for (const [id, phone] of [[driver1, '44911111111'], [driver2, '44922222222']] as const) {
      const link = await inviteDriver(testDb, storeId, phone, { dailyRateCents: 5_000, perDeliveryCents: 600, schedule: scheduleForNow() })
      await confirmLink(testDb, id, link.id)
      await startShift(testDb, id, link.id, { lat: -23.55, lng: -51.9 })
    }
    const { batch, ids } = await makeBatch()
    await broadcastBatch(testDb, storeId, batch.id, { target: 'SPECIFIC', requestedDriverId: driver1 })
    expect(await listShiftBatches(testDb, driver2)).toHaveLength(0)
    expect(await listShiftBatches(testDb, driver1)).toMatchObject([
      { batchId: batch.id, direct: true, estimatedExtraCents: 1_800 },
    ])
    await expect(refuseBatch(testDb, driver2, batch.id)).rejects.toMatchObject({ status: 409 })
    await refuseBatch(testDb, driver1, batch.id)
    expect(await listShiftBatches(testDb, driver1)).toHaveLength(0)

    await broadcastBatch(testDb, storeId, batch.id, { target: 'OWN' })
    const accepted = await acceptBatch(testDb, driver2, batch.id)
    expect(accepted.driverId).toBe(driver2)
    const [shift] = await testDb.select().from(driverShifts).where(eq(driverShifts.driverUserId, driver2))
    expect((await testDb.select().from(orders).where(inArray(orders.id, ids))).every((order) => order.shiftId === shift!.id)).toBe(true)

    await releaseBatch(testDb, driver2, batch.id)
    expect((await testDb.select().from(orders).where(inArray(orders.id, ids))).every((order) => order.shiftId == null)).toBe(true)

    await acceptBatch(testDb, driver1, batch.id)
    for (const id of ids) {
      await storeUpdateOrderStatus(testDb, storeId, id, 'PREPARING', customerId)
      await storeUpdateOrderStatus(testDb, storeId, id, 'READY', customerId)
    }
    await collectBatch(testDb, driver1, batch.id)
    for (const id of ids) await completeDelivery(testDb, driver1, id)
    const entries = await testDb.select().from(ledgerEntries).where(inArray(ledgerEntries.orderId, ids))
    expect(entries.filter((entry) => entry.type === 'DRIVER_PER_DELIVERY_CREDIT')).toHaveLength(3)
    expect(entries.filter((entry) => entry.type === 'STORE_PER_DELIVERY_DEBIT')).toHaveLength(3)
    expect(entries.filter((entry) => entry.type === 'DRIVER_DELIVERY_CREDIT')).toHaveLength(0)
  })
})

describe('driver-side batches', () => {
  it('only lists for available drivers and atomically lets exactly one accept', async () => {
    const { batch, ids } = await makeBatch()
    await broadcastBatch(testDb, storeId, batch.id)
    expect(await listAvailableBatches(testDb, driver1)).toEqual([])
    await expect(acceptBatch(testDb, driver1, batch.id)).rejects.toMatchObject({ status: 409 })
    await setAvailability(testDb, driver1, true)
    await setAvailability(testDb, driver2, true)
    expect(await listAvailableBatches(testDb, driver1)).toMatchObject([
      { batchId: batch.id, count: 3, feeTotalCents: 1500, storeName: 'Pizzaria' },
    ])

    const results = await Promise.allSettled([
      acceptBatch(testDb, driver1, batch.id),
      acceptBatch(testDb, driver2, batch.id),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(BatchError)
    expect(rejected.reason.status).toBe(409)
    const accepted = await testDb.select().from(deliveryBatches).where(eq(deliveryBatches.id, batch.id))
    const winner = accepted[0]!.driverId
    expect(winner).toBeTruthy()
    expect((await testDb.select().from(orders).where(inArray(orders.id, ids))).every((o) => o.driverId === winner)).toBe(true)
  })

  it('releases only the owner package back to the pool', async () => {
    const { batch, ids } = await makeBatch()
    await broadcastBatch(testDb, storeId, batch.id)
    await setAvailability(testDb, driver1, true)
    await acceptBatch(testDb, driver1, batch.id)
    await expect(releaseBatch(testDb, driver2, batch.id)).rejects.toMatchObject({ status: 409 })
    await releaseBatch(testDb, driver1, batch.id)
    expect((await testDb.select().from(orders).where(inArray(orders.id, ids))).every((o) => !o.driverId)).toBe(true)
    expect(await listAvailableBatches(testDb, driver1)).toHaveLength(1)
  })

  it('collects once only when every remaining order is READY and records events', async () => {
    const { batch, ids } = await makeBatch()
    await broadcastBatch(testDb, storeId, batch.id)
    await setAvailability(testDb, driver1, true)
    await acceptBatch(testDb, driver1, batch.id)
    await expect(collectBatch(testDb, driver2, batch.id)).rejects.toMatchObject({ status: 404 })
    await expect(collectBatch(testDb, driver1, batch.id)).rejects.toMatchObject({ status: 409 })

    for (const id of ids) {
      await storeUpdateOrderStatus(testDb, storeId, id, 'PREPARING', customerId)
      const ready = await storeUpdateOrderStatus(testDb, storeId, id, 'READY', customerId)
      expect(ready.status).toBe('READY')
    }
    const collected = await collectBatch(testDb, driver1, batch.id)
    expect(collected).toMatchObject({ status: 'COLLECTED', collected: 3 })
    expect((await testDb.select().from(orders).where(inArray(orders.id, ids))).every((o) => o.status === 'OUT_FOR_DELIVERY')).toBe(true)
    expect(await testDb.select().from(orderEvents).where(inArray(orderEvents.orderId, ids))).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'OUT_FOR_DELIVERY', actorRole: 'DRIVER' })]),
    )
    for (const id of ids) await completeDelivery(testDb, driver1, id)
    const ledger = await testDb.select().from(ledgerEntries).where(inArray(ledgerEntries.orderId, ids))
    expect(ledger).toHaveLength(6)
    expect(ledger.filter((entry) => entry.type === 'DRIVER_DELIVERY_CREDIT')).toHaveLength(3)
    expect(ledger.filter((entry) => entry.type === 'DRIVER_PER_DELIVERY_CREDIT')).toHaveLength(0)
  })

  it('a cancelled order leaves the package and the remaining READY order can be collected', async () => {
    const first = await makeEligible()
    const second = await makeEligible()
    const batch = await createBatch(testDb, storeId, [first, second])
    await broadcastBatch(testDb, storeId, batch.id)
    await setAvailability(testDb, driver1, true)
    await acceptBatch(testDb, driver1, batch.id)
    await storeUpdateOrderStatus(testDb, storeId, first, 'CANCELLED', customerId, 'sem estoque')
    await storeUpdateOrderStatus(testDb, storeId, second, 'PREPARING', customerId)
    await storeUpdateOrderStatus(testDb, storeId, second, 'READY', customerId)

    expect((await testDb.select().from(orders).where(eq(orders.id, first)))[0]!.batchId).toBeNull()
    await expect(collectBatch(testDb, driver1, batch.id)).resolves.toMatchObject({ collected: 1 })
  })
})

describe('individual dispatch isolation', () => {
  it('does not list or directly accept an order that belongs to a pending package', async () => {
    const { batch, ids } = await makeBatch()
    await broadcastBatch(testDb, storeId, batch.id)
    await setAvailability(testDb, driver1, true)
    expect(await listAvailableDeliveries(testDb, driver1)).toHaveLength(0)
    await expect(acceptDelivery(testDb, driver1, ids[0]!)).rejects.toMatchObject({ status: 409 })
  })
})

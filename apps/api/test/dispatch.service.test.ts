import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createActiveStoreTestFixture, type StoreFixtureInput, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import { updateStore } from '../src/services/store.service'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createAddress } from '../src/services/address.service'
import { createOrder, getCustomerOrder } from '../src/services/order.service'
import { requestDriver, storeUpdateOrderStatus } from '../src/services/order-status.service'
import {
  DispatchError,
  ensureDriverProfile,
  setAvailability,
  setFcmToken,
  listAvailableDeliveries,
  acceptDelivery,
  releaseDelivery,
  collectDelivery,
  completeDelivery,
  failDelivery,
  listDriverDeliveries,
} from '../src/services/dispatch.service'

const storeInput: StoreFixtureInput = {
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
const ana = {
  name: 'Ana',
  phone: '44999998888',
  password: 'senha123',
  role: 'CUSTOMER' as const,
  acceptedTerms: true as const,
}

let storeId: string
let customerId: string
let productId: string
let addressId: string
let driver1: string
let driver2: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createActiveStoreTestFixture(storeInput)
  storeId = store.id
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED',
    deliveryFixedFeeCents: 500,
  })
  const customer = await createVerifiedTestAccount(testDb, ana, 'test-secret')
  customerId = customer.user.id
  addressId = (await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })).id
  const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
  productId = (await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })).id
  const d1 = await createVerifiedTestAccount(testDb, { ...ana, name: 'Duda', phone: '44911111111', role: 'DRIVER' }, 'test-secret')
  const d2 = await createVerifiedTestAccount(testDb, { ...ana, name: 'Edu', phone: '44922222222', role: 'DRIVER' }, 'test-secret')
  driver1 = d1.user.id
  driver2 = d2.user.id
  const { users } = await import('../src/db/schema')
  const { inArray } = await import('drizzle-orm')
  await testDb.update(users).set({ status: 'ACTIVE' }).where(inArray(users.id, [driver1, driver2]))
})
afterAll(closeTestDb)

async function makeRequestedOrder() {
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY',
    addressId,
    paymentMethod: 'CASH',
    items: [{ productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
  })
  await storeUpdateOrderStatus(testDb, storeId, order.id, 'ACCEPTED', customerId)
  await requestDriver(testDb, storeId, order.id)
  await setAvailability(testDb, driver1, true)
  await setAvailability(testDb, driver2, true)
  return order
}

describe('profile + availability', () => {
  it('ensureDriverProfile is idempotent; availability toggles; fcm token saves', async () => {
    const p1 = await ensureDriverProfile(testDb, driver1)
    const p2 = await ensureDriverProfile(testDb, driver1)
    expect(p1.userId).toBe(p2.userId)
    expect(p1.isAvailable).toBe(false)
    const on = await setAvailability(testDb, driver1, true)
    expect(on.isAvailable).toBe(true)
    const tok = await setFcmToken(testDb, driver1, 'token-1234567890')
    expect(tok.fcmToken).toBe('token-1234567890')
  })
})

describe('listAvailableDeliveries', () => {
  it('shows requested unassigned DELIVERY orders with store info + fee, NO customer data', async () => {
    await makeRequestedOrder()
    const list = await listAvailableDeliveries(testDb, driver1)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ storeName: 'Pizzaria', deliveryFeeCents: 500 })
    expect(list[0]).not.toHaveProperty('customerName')
    expect(list[0]).not.toHaveProperty('addressText')
  })

  it('returns [] when the driver is unavailable', async () => {
    await makeRequestedOrder()
    await setAvailability(testDb, driver1, false)
    expect(await listAvailableDeliveries(testDb, driver1)).toHaveLength(0)
    expect(await listAvailableDeliveries(testDb, driver2)).toHaveLength(1)
  })

  it('rejects requestDriver on a PENDING order (must accept first)', async () => {
    const { order } = await createOrder(testDb, customerId, {
      storeSlug: 'pizzaria',
      fulfillment: 'DELIVERY',
      addressId,
      paymentMethod: 'CASH',
      items: [{ productId, quantity: 1, selections: [] }],
      idempotencyKey: crypto.randomUUID(),
    })
    await expect(requestDriver(testDb, storeId, order.id)).rejects.toThrow('Aceite o pedido')
  })

  it('hides orders not requested, already assigned, or PICKUP', async () => {
    const { order: notRequested } = await createOrder(testDb, customerId, {
      storeSlug: 'pizzaria',
      fulfillment: 'DELIVERY',
      addressId,
      paymentMethod: 'CASH',
      items: [{ productId, quantity: 1, selections: [] }],
      idempotencyKey: crypto.randomUUID(),
    })
    void notRequested
    const requested = await makeRequestedOrder()
    await acceptDelivery(testDb, driver1, requested.id)
    expect(await listAvailableDeliveries(testDb, driver1)).toHaveLength(0)
  })
})

describe('acceptDelivery - atomic lock', () => {
  it('first wins, second gets 409; status unchanged (accept != collect); detail has customer data', async () => {
    const order = await makeRequestedOrder()
    const results = await Promise.allSettled([
      acceptDelivery(testDb, driver1, order.id),
      acceptDelivery(testDb, driver2, order.id),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const fail = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(fail).toHaveLength(1)
    expect((fail[0] as PromiseRejectedResult).reason).toBeInstanceOf(DispatchError)
    const detail = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acceptDelivery>>>).value
    expect(detail.status).toBe('ACCEPTED')
    expect(detail.customerName).toBe('Ana')
    expect(detail.addressText).toBe('Rua B, 22')
    expect(detail.paymentMethod).toBe('CASH')
  })
})

describe('release / collect / deliver / fail', () => {
  it('release before collect returns order to pool; collect requires READY/AWAITING_DRIVER', async () => {
    const order = await makeRequestedOrder()
    await acceptDelivery(testDb, driver1, order.id)
    await expect(collectDelivery(testDb, driver1, order.id)).rejects.toThrow(DispatchError)
    await releaseDelivery(testDb, driver1, order.id)
    expect(await listAvailableDeliveries(testDb, driver1)).toHaveLength(1)
  })

  it('full happy path: accept -> (store readies) -> collect -> deliver, with events', async () => {
    const order = await makeRequestedOrder()
    await acceptDelivery(testDb, driver2, order.id)
    await storeUpdateOrderStatus(testDb, storeId, order.id, 'PREPARING', customerId)
    const ready = await storeUpdateOrderStatus(testDb, storeId, order.id, 'READY', customerId)
    expect(ready.status).toBe('READY')
    await collectDelivery(testDb, driver2, order.id)
    const collected = await getCustomerOrder(testDb, customerId, order.id)
    expect(collected!.status).toBe('OUT_FOR_DELIVERY')
    await completeDelivery(testDb, driver2, order.id)
    const done = await getCustomerOrder(testDb, customerId, order.id)
    expect(done!.status).toBe('DELIVERED')
    expect(done!.events.some((e) => e.actorRole === 'DRIVER')).toBe(true)
  })

  it('fail sets DELIVERY_FAILED with reason; only assigned driver can act', async () => {
    const order = await makeRequestedOrder()
    await acceptDelivery(testDb, driver1, order.id)
    await storeUpdateOrderStatus(testDb, storeId, order.id, 'PREPARING', customerId)
    await storeUpdateOrderStatus(testDb, storeId, order.id, 'READY', customerId)
    await expect(collectDelivery(testDb, driver2, order.id)).rejects.toThrow(DispatchError)
    await collectDelivery(testDb, driver1, order.id)
    await failDelivery(testDb, driver1, order.id, { reason: 'NO_ANSWER', note: 'liguei 3x' })
    const failed = await getCustomerOrder(testDb, customerId, order.id)
    expect(failed!.status).toBe('DELIVERY_FAILED')
    expect(failed!.failReason).toBe('NO_ANSWER')
  })

  it('listDriverDeliveries: active groups by store, done shows history', async () => {
    const o1 = await makeRequestedOrder()
    const o2 = await makeRequestedOrder()
    await acceptDelivery(testDb, driver1, o1.id)
    await acceptDelivery(testDb, driver1, o2.id)
    const active = await listDriverDeliveries(testDb, driver1, 'active')
    expect(active).toHaveLength(2)
    expect(active[0]).toHaveProperty('customerPhone')
    expect(active[0]).toHaveProperty('storeLat')
    expect(await listDriverDeliveries(testDb, driver2, 'active')).toHaveLength(0)
  })
})

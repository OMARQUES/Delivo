import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createActiveStoreTestFixture, type StoreFixtureInput, closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { updateStore } from '../src/services/store.service'
import { ledgerEntries, orders, stores, users } from '../src/db/schema'
import { recordOrderLedger } from '../src/services/finance.service'

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
const ana = { name: 'Ana', phone: '44999998888', password: 'senha123', role: 'CUSTOMER' as const, acceptedTerms: true as const }

let storeId: string
let customerId: string
let addressId: string
let productId: string
let driverId: string

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
  await testDb.update(stores).set({ commissionBps: 1000 }).where(eq(stores.id, storeId))
  const customer = await createVerifiedTestAccount(testDb, ana, 'test-secret')
  customerId = customer.user.id
  addressId = (await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })).id
  const cat = await createCategory(testDb, storeId, { name: 'Itens' })
  productId = (await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 10000, isAvailable: true })).id
  const driver = await createVerifiedTestAccount(testDb, { ...ana, name: 'Duda', phone: '44911111111', role: 'DRIVER' }, 'test-secret')
  driverId = driver.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverId))
})
afterAll(closeTestDb)

async function makeOrder() {
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY',
    addressId,
    paymentMethod: 'CASH',
    items: [{ productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
  })
  return order
}

async function entries(orderId: string) {
  return testDb.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId))
}

describe('recordOrderLedger', () => {
  it('online DELIVERED with driver credits store net subtotal and driver fee; idempotent', async () => {
    const order = await makeOrder()
    await testDb.update(orders).set({ paymentMethod: 'PIX_ONLINE', status: 'DELIVERED', driverId }).where(eq(orders.id, order.id))

    await recordOrderLedger(testDb, order.id)
    await recordOrderLedger(testDb, order.id)

    expect((await entries(order.id)).map((e) => ({ party: e.party, type: e.type, amountCents: e.amountCents }))).toEqual([
      { party: 'STORE', type: 'STORE_SALE_CREDIT', amountCents: 9000 },
      { party: 'DRIVER', type: 'DRIVER_DELIVERY_CREDIT', amountCents: 500 },
    ])
  })

  it('cash DELIVERED with driver debits store commission and driver fee; credits driver', async () => {
    const order = await makeOrder()
    await testDb.update(orders).set({ status: 'DELIVERED', driverId }).where(eq(orders.id, order.id))

    await recordOrderLedger(testDb, order.id)

    expect((await entries(order.id)).map((e) => ({ party: e.party, type: e.type, amountCents: e.amountCents }))).toEqual([
      { party: 'STORE', type: 'STORE_COMMISSION_DEBIT', amountCents: -1000 },
      { party: 'STORE', type: 'STORE_DRIVER_FEE_DEBIT', amountCents: -500 },
      { party: 'DRIVER', type: 'DRIVER_DELIVERY_CREDIT', amountCents: 500 },
    ])
  })

  it('DELIVERY_FAILED defers driver fee until return confirmation', async () => {
    const order = await makeOrder()
    await testDb.update(orders).set({ status: 'DELIVERY_FAILED', driverId }).where(eq(orders.id, order.id))

    await recordOrderLedger(testDb, order.id)

    expect(await entries(order.id)).toEqual([])
  })
})

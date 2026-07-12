import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'
import {
  driverPayoutItems,
  driverPayouts,
  ledgerEntries,
  storeInvoiceItems,
  storeInvoices,
  storePayoutItems,
  storePayouts,
  users,
} from '../src/db/schema'
import {
  closeFinancePeriod,
  markDriverPayoutPaid,
  markStoreInvoicePaid,
  markStorePayoutPaid,
} from '../src/services/finance-settlement.service'

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

let storeId: string
let customerId: string
let addressId: string
let productId: string
let driverId: string
let orderId: string

const periodStart = new Date('2026-07-01T00:00:00.000Z')
const periodEnd = new Date('2026-07-08T00:00:00.000Z')
const inside = new Date('2026-07-03T12:00:00.000Z')

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  storeId = store.id
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED',
    deliveryFixedFeeCents: 500,
  })
  const customer = await createVerifiedTestAccount(testDb, ana, 'test-secret')
  customerId = customer.user.id
  addressId = (await createAddress(testDb, customerId, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })).id
  const cat = await createCategory(testDb, storeId, { name: 'Itens' })
  productId = (await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 10000, isAvailable: true })).id
  const driver = await createVerifiedTestAccount(testDb, { ...ana, name: 'Duda', phone: '44911111111', role: 'DRIVER' }, 'test-secret')
  driverId = driver.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverId))
  const { order } = await createOrder(testDb, customerId, {
    storeSlug: 'pizzaria',
    fulfillment: 'DELIVERY',
    addressId,
    paymentMethod: 'CASH',
    items: [{ productId, quantity: 1, selections: [] }],
    idempotencyKey: crypto.randomUUID(),
  })
  orderId = order.id
})
afterAll(closeTestDb)

async function seedLedger() {
  await testDb.insert(ledgerEntries).values([
    {
      party: 'STORE',
      type: 'STORE_SALE_CREDIT',
      amountCents: 9000,
      description: 'Venda online',
      uniqueKey: `${orderId}:store-sale`,
      orderId,
      storeId,
      createdAt: inside,
    },
    {
      party: 'STORE',
      type: 'STORE_COMMISSION_DEBIT',
      amountCents: -1000,
      description: 'Comissão',
      uniqueKey: `${orderId}:commission`,
      orderId,
      storeId,
      createdAt: inside,
    },
    {
      party: 'STORE',
      type: 'STORE_DRIVER_FEE_DEBIT',
      amountCents: -500,
      description: 'Frete',
      uniqueKey: `${orderId}:driver-fee`,
      orderId,
      storeId,
      createdAt: inside,
    },
    {
      party: 'DRIVER',
      type: 'DRIVER_DELIVERY_CREDIT',
      amountCents: 500,
      description: 'Frete',
      uniqueKey: `${orderId}:driver-credit`,
      orderId,
      driverId,
      createdAt: inside,
    },
  ])
}

describe('closeFinancePeriod', () => {
  it('creates store invoices, store payouts and driver payouts once per ledger entry', async () => {
    await seedLedger()

    expect(await closeFinancePeriod(testDb, { periodStart, periodEnd })).toEqual({
      storeInvoices: 1,
      storePayouts: 1,
      driverPayouts: 1,
    })
    expect(await closeFinancePeriod(testDb, { periodStart, periodEnd })).toEqual({
      storeInvoices: 1,
      storePayouts: 1,
      driverPayouts: 1,
    })

    const [invoice] = await testDb.select().from(storeInvoices).where(eq(storeInvoices.storeId, storeId))
    const [storePayout] = await testDb.select().from(storePayouts).where(eq(storePayouts.storeId, storeId))
    const [driverPayout] = await testDb.select().from(driverPayouts).where(eq(driverPayouts.driverId, driverId))

    expect(invoice).toMatchObject({ status: 'OPEN', totalCents: 1500 })
    expect(storePayout).toMatchObject({ status: 'OPEN', totalCents: 9000 })
    expect(driverPayout).toMatchObject({ status: 'OPEN', totalCents: 500 })
    expect(await testDb.select().from(storeInvoiceItems)).toHaveLength(2)
    expect(await testDb.select().from(storePayoutItems)).toHaveLength(1)
    expect(await testDb.select().from(driverPayoutItems)).toHaveLength(1)
  })

  it('marks finance documents as paid manually', async () => {
    await seedLedger()
    await closeFinancePeriod(testDb, { periodStart, periodEnd })
    const [invoice] = await testDb.select().from(storeInvoices).where(eq(storeInvoices.storeId, storeId))
    const [storePayout] = await testDb.select().from(storePayouts).where(eq(storePayouts.storeId, storeId))
    const [driverPayout] = await testDb.select().from(driverPayouts).where(eq(driverPayouts.driverId, driverId))

    expect((await markStoreInvoicePaid(testDb, invoice!.id)).status).toBe('PAID')
    expect((await markStorePayoutPaid(testDb, storePayout!.id)).status).toBe('PAID')
    expect((await markDriverPayoutPaid(testDb, driverPayout!.id)).status).toBe('PAID')
  })
})

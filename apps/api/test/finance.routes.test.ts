import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActiveStoreTestFixture, type StoreFixtureInput, closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import { ledgerEntries, orders, users } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { createAddress } from '../src/services/address.service'
import { createVerifiedTestAccount } from './helpers/test-db'
import { createCategory, createProduct } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { updateStore } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

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
let storeToken: string
let driverId: string
let driverToken: string
let orderId: string

const periodStart = '2026-07-01T00:00:00.000Z'
const periodEnd = '2026-07-08T00:00:00.000Z'

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createActiveStoreTestFixture(storeInput)
  storeId = store.id
  storeToken = await createTestSession({ sub: store.ownerUserId, role: 'STORE', name: 'João' }, env.JWT_SECRET)
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'FIXED',
    deliveryFixedFeeCents: 500,
  })
  const customer = await createVerifiedTestAccount(testDb, ana, env.JWT_SECRET)
  const addressId = (await createAddress(testDb, customer.user.id, { addressText: 'Rua B, 22', lat: -23.56, lng: -51.9 })).id
  const cat = await createCategory(testDb, storeId, { name: 'Itens' })
  const productId = (await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 10000, isAvailable: true })).id
  const driver = await createVerifiedTestAccount(testDb, { ...ana, name: 'Duda', phone: '44911111111', role: 'DRIVER' }, env.JWT_SECRET)
  driverId = driver.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverId))
  driverToken = await createTestSession({ sub: driverId, role: 'DRIVER', name: 'Duda' }, env.JWT_SECRET)
  const { order } = await createOrder(testDb, customer.user.id, {
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

function adminToken() {
  return createTestSession({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Root' }, env.JWT_SECRET)
}

async function req(path: string, init: RequestInit = {}, token?: string) {
  const authToken = token ?? await adminToken()
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...(init.headers as Record<string, string>) },
  }, env)
}

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
      createdAt: new Date('2026-07-03T12:00:00.000Z'),
    },
    {
      party: 'STORE',
      type: 'STORE_COMMISSION_DEBIT',
      amountCents: -1000,
      description: 'Comissão',
      uniqueKey: `${orderId}:commission`,
      orderId,
      storeId,
      createdAt: new Date('2026-07-03T12:00:00.000Z'),
    },
    {
      party: 'DRIVER',
      type: 'DRIVER_DELIVERY_CREDIT',
      amountCents: 500,
      description: 'Frete',
      uniqueKey: `${orderId}:driver-credit`,
      orderId,
      driverId,
      createdAt: new Date('2026-07-03T12:00:00.000Z'),
    },
  ])
}

describe('finance routes', () => {
  it('admin closes period, sees documents and marks them paid', async () => {
    await seedLedger()

    const close = await req('/admin/finance/close', {
      method: 'POST',
      body: JSON.stringify({ periodStart, periodEnd }),
    })
    expect(close.status).toBe(200)
    expect(await close.json()).toEqual({ storeInvoices: 1, storePayouts: 1, driverPayouts: 1 })

    const list = await req('/admin/finance')
    const body = (await list.json()) as {
      storeInvoices: { id: string; totalCents: number; storeName: string }[]
      storePayouts: { id: string; totalCents: number; storeName: string }[]
      driverPayouts: { id: string; totalCents: number; driverName: string }[]
    }
    expect(body.storeInvoices[0]).toMatchObject({ totalCents: 1000, storeName: 'Pizzaria' })
    expect(body.storePayouts[0]).toMatchObject({ totalCents: 9000, storeName: 'Pizzaria' })
    expect(body.driverPayouts[0]).toMatchObject({ totalCents: 500, driverName: 'Duda' })

    expect((await req(`/admin/finance/store-invoices/${body.storeInvoices[0]!.id}/paid`, { method: 'PATCH' })).status).toBe(200)
    expect((await req(`/admin/finance/store-payouts/${body.storePayouts[0]!.id}/paid`, { method: 'PATCH' })).status).toBe(200)
    expect((await req(`/admin/finance/driver-payouts/${body.driverPayouts[0]!.id}/paid`, { method: 'PATCH' })).status).toBe(200)
    expect((await req('/admin/finance', {}, storeToken)).status).toBe(403)
  })

  it('store and driver see read-only own finance views', async () => {
    await seedLedger()
    await req('/admin/finance/close', { method: 'POST', body: JSON.stringify({ periodStart, periodEnd }) })

    const store = await req('/store/me/finance', {}, storeToken)
    expect(store.status).toBe(200)
    const storeBody = (await store.json()) as {
      ledger: { amountCents: number }[]
      invoices: { totalCents: number }[]
      payouts: { totalCents: number }[]
    }
    expect(storeBody.ledger.map((e) => e.amountCents).sort((a, b) => a - b)).toEqual([-1000, 9000])
    expect(storeBody.invoices[0]).toMatchObject({ totalCents: 1000 })
    expect(storeBody.payouts[0]).toMatchObject({ totalCents: 9000 })

    const driver = await req('/driver/me/finance', {}, driverToken)
    expect(driver.status).toBe(200)
    const driverBody = (await driver.json()) as { ledger: { amountCents: number }[]; payouts: { totalCents: number }[] }
    expect(driverBody.ledger.map((e) => e.amountCents)).toEqual([500])
    expect(driverBody.payouts[0]).toMatchObject({ totalCents: 500 })
  })

  it('expõe detalhe do ganho apenas ao entregador e sem dados do cliente', async () => {
    await testDb.update(orders).set({
      driverId,
      status: 'DELIVERED',
      note: 'não vazar esta observação',
      taxId: '12345678901',
    })
    await seedLedger()

    const response = await req(`/driver/earnings/orders/${orderId}`, {}, driverToken)
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown> & {
      items: Record<string, unknown>[]
      ledger: Record<string, unknown>[]
    }
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'items', 'ledger', 'orderId', 'status', 'storeName'])
    expect(body).toMatchObject({ orderId, status: 'DELIVERED', storeName: 'Pizzaria' })
    expect(body.items).toEqual([{ nameSnapshot: 'Pizza', quantity: 1 }])
    expect(Object.keys(body.ledger[0]!).sort()).toEqual(['amountCents', 'createdAt', 'description', 'type'])
    expect(body.ledger).toHaveLength(1)
    expect(JSON.stringify(body)).not.toContain('Rua B, 22')
    expect(JSON.stringify(body)).not.toContain('não vazar esta observação')
    expect(JSON.stringify(body)).not.toContain('12345678901')

    const other = await createVerifiedTestAccount(testDb, {
      ...ana, name: 'Outro', phone: '44922222222', role: 'DRIVER',
    }, env.JWT_SECRET)
    await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, other.user.id))
    const otherToken = await createTestSession({ sub: other.user.id, role: 'DRIVER', name: 'Outro' }, env.JWT_SECRET)
    expect((await req(`/driver/earnings/orders/${orderId}`, {}, otherToken)).status).toBe(404)
  })
})

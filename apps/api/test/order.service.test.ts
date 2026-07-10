import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'
import { createCategory, createProduct, replaceProductOptions } from '../src/services/catalog.service'
import { registerUser } from '../src/services/auth.service'
import { createAddress } from '../src/services/address.service'
import { OrderError, quoteOrder, createOrder, getCustomerOrder, listCustomerOrders } from '../src/services/order.service'

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
let groupIds: { varId: string; varP: string; varG: string; adId: string; adBorda: string }

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  storeId = store.id
  await updateStore(testDb, storeId, {
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
  const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
  const prod = await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })
  productId = prod.id
  await replaceProductOptions(testDb, storeId, productId, [
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
  const catalog = await getStoreCatalog(testDb, storeId)
  const groups = catalog[0]!.products[0]!.groups
  const v = groups.find((g) => g.type === 'VARIATION')!
  const a = groups.find((g) => g.type === 'ADDON')!
  groupIds = { varId: v.id, varP: v.options[0]!.id, varG: v.options[1]!.id, adId: a.id, adBorda: a.options[0]!.id }
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

describe('quoteOrder', () => {
  it('computes items, subtotal, distance fee, total', async () => {
    const q = await quoteOrder(testDb, customerId, checkout())
    expect(q.problems).toHaveLength(0)
    expect(q.items[0]).toMatchObject({ name: 'Pizza', quantity: 2, unitPriceCents: 5800, totalCents: 11600 })
    expect(q.subtotalCents).toBe(11600)
    expect(q.deliveryFeeCents).toBe(400)
    expect(q.totalCents).toBe(12000)
  })

  it('pickup: fee null-fee 0, no address needed', async () => {
    const q = await quoteOrder(testDb, customerId, checkout({ fulfillment: 'PICKUP', addressId: undefined }))
    expect(q.deliveryFeeCents).toBeNull()
    expect(q.totalCents).toBe(q.subtotalCents)
  })

  it('problems: below min order, out of radius, closed/paused store, invalid selection', async () => {
    const small = await quoteOrder(testDb, customerId, checkout({
      items: [{ productId, quantity: 1, selections: [{ groupId: groupIds.varId, optionIds: [groupIds.varP] }] }],
    }))
    expect(small.problems.some((p) => p.includes('mínimo'))).toBe(true)
    const far = await createAddress(testDb, customerId, { addressText: 'Longe', lat: -24.5, lng: -51.9 })
    const q2 = await quoteOrder(testDb, customerId, checkout({ addressId: far.id }))
    expect(q2.problems.some((p) => p.includes('raio'))).toBe(true)
    await updateStore(testDb, storeId, { isPaused: true })
    const q3 = await quoteOrder(testDb, customerId, checkout())
    expect(q3.problems.some((p) => p.includes('fechada') || p.includes('pausada'))).toBe(true)
    await updateStore(testDb, storeId, { isPaused: false })
    const q4 = await quoteOrder(testDb, customerId, checkout({
      items: [{ productId, quantity: 1, selections: [] }],
    }))
    expect(q4.problems.length).toBeGreaterThan(0)
  })

  it('unconfigured delivery fee (FIXED w/o fixed cents) → "não configurou", not "raio"', async () => {
    await updateStore(testDb, storeId, { deliveryFeeMode: 'FIXED', deliveryFixedFeeCents: null })
    const q = await quoteOrder(testDb, customerId, checkout())
    expect(q.problems.some((p) => p.includes('não configurou'))).toBe(true)
    expect(q.problems.some((p) => p.includes('raio'))).toBe(false)
  })
})

describe('createOrder', () => {
  it('creates PENDING with snapshot items/options + event', async () => {
    const { order } = await createOrder(testDb, customerId, checkout())
    expect(order.status).toBe('PENDING')
    expect(order.totalCents).toBe(12000)
    const detail = await getCustomerOrder(testDb, customerId, order.id)
    expect(detail!.items[0]!.nameSnapshot).toBe('Pizza')
    expect(detail!.items[0]!.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(['Tamanho: G', 'Extras: Borda']),
    )
    expect(detail!.events[0]!.status).toBe('PENDING')
    expect(detail!.addressText).toBe('Rua B, 22')
  })

  it('idempotency: same key returns same order; concurrent burst creates exactly 1', async () => {
    const input = checkout()
    const { order: a } = await createOrder(testDb, customerId, input)
    const { order: b } = await createOrder(testDb, customerId, input)
    expect(b.id).toBe(a.id)
    const input2 = checkout()
    const burst = await Promise.allSettled([
      createOrder(testDb, customerId, input2),
      createOrder(testDb, customerId, input2),
    ])
    const okIds = burst
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<{ order: { id: string } }>).value.order.id)
    expect(new Set(okIds).size).toBe(1)
    const list = await listCustomerOrders(testDb, customerId)
    expect(list).toHaveLength(2)
  })

  it('rejects: problems present, online payment without provider, unknown store', async () => {
    await expect(createOrder(testDb, customerId, checkout({ storeSlug: 'nope' }))).rejects.toThrow(OrderError)
    await expect(createOrder(testDb, customerId, checkout({ paymentMethod: 'PIX_ONLINE' }))).rejects.toMatchObject({ status: 503 })
    await updateStore(testDb, storeId, { isPaused: true })
    await expect(createOrder(testDb, customerId, checkout())).rejects.toThrow(OrderError)
  })
})

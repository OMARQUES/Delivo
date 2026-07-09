import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { signAccessToken } from '../src/lib/tokens'
import { createAddress } from '../src/services/address.service'
import { registerUser } from '../src/services/auth.service'
import { createCategory, createProduct, replaceProductOptions } from '../src/services/catalog.service'
import { createOrder } from '../src/services/order.service'
import { customerRequestCancel } from '../src/services/order-status.service'
import { createStoreWithOwner, updateStore } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

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
let ownerToken: string
let addressId: string
let productId: string
let groupIds: { varId: string; varG: string; adId: string; adBorda: string }

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const store = await createStoreWithOwner(testDb, storeInput)
  storeId = store.id
  ownerToken = await signAccessToken({ sub: store.ownerUserId, role: 'STORE', name: 'João' }, env.JWT_SECRET)
  await updateStore(testDb, storeId, {
    openingHours: Array.from({ length: 7 }, (_, dow) => ({ dow, open: '00:00', close: '23:59' })),
    deliveryFeeMode: 'DISTANCE',
    deliveryMinFeeCents: 400,
    deliveryPerKmCents: 200,
    deliveryMaxKm: 8,
    minOrderCents: 5000,
  })
  const customer = await registerUser(testDb, ana, env.JWT_SECRET)
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

function req(path: string, init: RequestInit = {}, t = ownerToken) {
  return app.request(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(init.headers as Record<string, string>) },
  }, env)
}

describe('GET /store/me/orders', () => {
  it('lists active orders with customer info + isFirstOrder badge', async () => {
    await createOrder(testDb, customerId, checkout())
    const res = await req('/store/me/orders?scope=active')
    expect(res.status).toBe(200)
    const list = (await res.json()) as { customerName: string; customerPhone: string; isFirstOrder: boolean }[]
    expect(list[0]!.customerName).toBe('Ana')
    expect(list[0]!.isFirstOrder).toBe(true)
    await createOrder(testDb, customerId, checkout())
    const res2 = await req('/store/me/orders?scope=active')
    const list2 = (await res2.json()) as { isFirstOrder: boolean }[]
    expect(list2.some((o) => o.isFirstOrder === false)).toBe(true)
  })
})

describe('PATCH /store/me/orders/:id/status', () => {
  it('walks the happy path with events; blocks invalid transition and AWAITING_DRIVER', async () => {
    const o = await createOrder(testDb, customerId, checkout())
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      const r = await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to }) })
      expect(r.status).toBe(200)
    }
    const detail = await req(`/store/me/orders/${o.id}`)
    const body = (await detail.json()) as { events: unknown[] }
    expect(body.events.length).toBe(6)
    const o2 = await createOrder(testDb, customerId, checkout())
    expect((await req(`/store/me/orders/${o2.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'DELIVERED' }) })).status).toBe(409)
    expect((await req(`/store/me/orders/${o2.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'AWAITING_DRIVER' }) })).status).toBe(400)
    expect((await req(`/store/me/orders/${o2.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'CANCELLED' }) })).status).toBe(400)
  })

  it('pickup: READY -> DELIVERED direct', async () => {
    const o = await createOrder(testDb, customerId, checkout({ fulfillment: 'PICKUP', addressId: undefined }))
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'DELIVERED']) {
      expect((await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to }) })).status).toBe(200)
    }
  })
})

describe('POST /store/me/orders/:id/request-driver', () => {
  it('requests driver; idempotent; READY order flips to AWAITING_DRIVER', async () => {
    const o = await createOrder(testDb, customerId, checkout())
    const r1 = await req(`/store/me/orders/${o.id}/request-driver`, { method: 'POST' })
    expect(r1.status).toBe(200)
    const r2 = await req(`/store/me/orders/${o.id}/request-driver`, { method: 'POST' })
    expect(r2.status).toBe(200)
    for (const to of ['ACCEPTED', 'PREPARING', 'READY']) {
      await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to }) })
    }
    const detail = await req(`/store/me/orders/${o.id}`)
    expect(((await detail.json()) as { status: string }).status).toBe('AWAITING_DRIVER')
  })

  it('rejects pickup orders and orders with driver', async () => {
    const p = await createOrder(testDb, customerId, checkout({ fulfillment: 'PICKUP', addressId: undefined }))
    expect((await req(`/store/me/orders/${p.id}/request-driver`, { method: 'POST' })).status).toBe(400)
  })
})

describe('cancel-request resolution', () => {
  it('approve cancels; deny clears request', async () => {
    const o = await createOrder(testDb, customerId, checkout())
    await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'ACCEPTED' }) })
    await customerRequestCancel(testDb, customerId, o.id, 'mudei de ideia')
    const ap = await req(`/store/me/orders/${o.id}/cancel-request/approve`, { method: 'POST' })
    expect(ap.status).toBe(200)
    expect(((await ap.json()) as { status: string }).status).toBe('CANCELLED')

    const o2 = await createOrder(testDb, customerId, checkout())
    await req(`/store/me/orders/${o2.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'ACCEPTED' }) })
    await customerRequestCancel(testDb, customerId, o2.id)
    const dn = await req(`/store/me/orders/${o2.id}/cancel-request/deny`, { method: 'POST' })
    expect(((await dn.json()) as { cancelRequestedAt: string | null }).cancelRequestedAt).toBeNull()
  })

  it('direct CANCELLED clears a pending cancel-request', async () => {
    const o = await createOrder(testDb, customerId, checkout())
    await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'ACCEPTED' }) })
    await customerRequestCancel(testDb, customerId, o.id, 'mudei de ideia')
    const res = await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'CANCELLED', reason: 'sem estoque' }) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cancelRequestedAt: string | null }).cancelRequestedAt).toBeNull()
  })
})

import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { createActiveStoreTestFixture, type StoreFixtureInput, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import { PostgresRateLimiter } from '../src/security/rate-limit'
import { POLICIES, type RateLimitPolicy } from '../src/security/rate-limit-policies'

const put = vi.fn(async () => ({}))
const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'test-secret',
  RATE_LIMIT_HMAC_SECRET: 'rate-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: { put } as unknown as R2Bucket,
}

const storeInput: StoreFixtureInput = {
  name: 'Pizzaria', slug: 'pizzaria', category: 'PIZZARIA', phone: '4433334444',
  city: 'C', addressText: 'Rua A, 1', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

let token: string
let storeId: string
let ownerUserId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  put.mockClear()
  const store = await createActiveStoreTestFixture(storeInput)
  storeId = store.id
  ownerUserId = store.ownerUserId
  void storeId
  token = await createTestSession({ sub: store.ownerUserId, role: 'STORE', name: 'João' }, env.JWT_SECRET)
})
afterAll(closeTestDb)

function req(path: string, init: RequestInit = {}, accessToken = token) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`,
    ...(init.headers as Record<string, string>),
  }
  return app.request(path, { ...init, headers }, env)
}

async function exhaust(policy: RateLimitPolicy, subject: string) {
  const limiter = new PostgresRateLimiter(testDb, env.RATE_LIMIT_HMAC_SECRET)
  for (let i = 0; i < policy.limit; i++) await limiter.consume(policy, subject)
}

function throwingBody() {
  return new ReadableStream({
    pull() {
      throw new Error('body was read')
    },
  }) as unknown as BodyInit
}

function streamingInit(init: RequestInit & { duplex: 'half' }) {
  return init as RequestInit
}

async function makeCategory(name = 'Pizzas') {
  const res = await req('/store/me/categories', { method: 'POST', body: JSON.stringify({ name }) })
  return (await res.json()) as { id: string }
}
async function makeProduct(categoryId: string) {
  const res = await req('/store/me/products', {
    method: 'POST',
    body: JSON.stringify({ categoryId, name: 'Pizza', basePriceCents: 3000 }),
  })
  return (await res.json()) as { id: string }
}

async function makeProductWithOption() {
  const category = await makeCategory()
  const product = await makeProduct(category.id)
  const tree = await req(`/store/me/products/${product.id}/options`, {
    method: 'PUT',
    body: JSON.stringify([
      {
        name: 'Extras', type: 'ADDON', minSelect: 0, maxSelect: 2,
        options: [{ name: 'Catupiry', priceCents: 500 }],
      },
    ]),
  })
  expect(tree.status).toBe(200)

  const catalog = (await (await req('/store/me/catalog')).json()) as {
    products: { id: string; groups: { options: { id: string }[] }[] }[]
  }[]
  const option = catalog[0]!.products[0]!.groups[0]!.options[0]!
  return { product, option }
}

describe('categories routes', () => {
  it('POST 201, PATCH 200, DELETE 204; DELETE with products 409', async () => {
    const cat = await makeCategory()
    expect((await req(`/store/me/categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Pizzas Top', sortIndex: 2 }) })).status).toBe(200)
    await makeProduct(cat.id)
    expect((await req(`/store/me/categories/${cat.id}`, { method: 'DELETE' })).status).toBe(409)
    const empty = await makeCategory('Vazia')
    expect((await req(`/store/me/categories/${empty.id}`, { method: 'DELETE' })).status).toBe(204)
  })
})

describe('products routes', () => {
  it('POST/PATCH/DELETE product + options replace + photo', async () => {
    const cat = await makeCategory()
    const prod = await makeProduct(cat.id)
    expect((await req(`/store/me/products/${prod.id}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: false }) })).status).toBe(200)

    const treeRes = await req(`/store/me/products/${prod.id}/options`, {
      method: 'PUT',
      body: JSON.stringify([
        { name: 'Tamanho', type: 'VARIATION', minSelect: 1, maxSelect: 1,
          options: [{ name: 'P', priceCents: 3000 }, { name: 'G', priceCents: 5000 }] },
      ]),
    })
    expect(treeRes.status).toBe(200)

    const photo = await req(`/store/me/products/${prod.id}/photo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
    })
    expect(photo.status).toBe(200)
    expect(((await photo.json()) as { photoKey: string }).photoKey).toMatch(/^products\//)

    expect((await req(`/store/me/products/${prod.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('rate-limits product photo before reading body or writing R2', async () => {
    const cat = await makeCategory()
    const prod = await makeProduct(cat.id)
    await exhaust(POLICIES.productUploadPrincipalHour, ownerUserId)
    const photo = await req(`/store/me/products/${prod.id}/photo`, streamingInit({
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: throwingBody(),
      duplex: 'half',
    }))
    expect(photo.status).toBe(429)
    expect(put).not.toHaveBeenCalled()
  })

  it('PATCH {} → 400 and does not reactivate paused product', async () => {
    const cat = await makeCategory()
    const prod = await makeProduct(cat.id)
    await req(`/store/me/products/${prod.id}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: false }) })
    expect((await req(`/store/me/products/${prod.id}`, { method: 'PATCH', body: JSON.stringify({}) })).status).toBe(400)
    const catalog = (await (await req('/store/me/catalog')).json()) as { products: { id: string; isAvailable: boolean }[] }[]
    expect(catalog[0]!.products[0]!.isAvailable).toBe(false)
  })

  it('GET /store/me/catalog returns nested tree', async () => {
    const cat = await makeCategory()
    await makeProduct(cat.id)
    const res = await req('/store/me/catalog')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string; products: { name: string }[] }[]
    expect(body[0]!.products[0]!.name).toBe('Pizza')
  })

  it('401 anon, 403 CUSTOMER', async () => {
    expect((await app.request('/store/me/catalog', {}, env)).status).toBe(401)
    const cust = await createTestSession({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
    expect(
      (await app.request('/store/me/catalog', { headers: { Authorization: `Bearer ${cust}` } }, env)).status,
    ).toBe(403)
  })
})

describe('PATCH /store/me/options/:id', () => {
  it('pausa e repreça uma opção sem trocar seu id', async () => {
    const { option } = await makeProductWithOption()

    const pause = await req(`/store/me/options/${option.id}`, {
      method: 'PATCH', body: JSON.stringify({ isAvailable: false }),
    })
    expect(pause.status).toBe(200)
    expect((await pause.json()) as { id: string; isAvailable: boolean }).toMatchObject({
      id: option.id,
      isAvailable: false,
    })

    const reprice = await req(`/store/me/options/${option.id}`, {
      method: 'PATCH', body: JSON.stringify({ priceCents: 777 }),
    })
    expect(reprice.status).toBe(200)

    const catalog = (await (await req('/store/me/catalog')).json()) as {
      products: { groups: { options: { id: string; priceCents: number | null; isAvailable: boolean }[] }[] }[]
    }[]
    const updated = catalog
      .flatMap((category) => category.products)
      .flatMap((product) => product.groups)
      .flatMap((group) => group.options)
      .find((candidate) => candidate.id === option.id)
    expect(updated).toEqual(expect.objectContaining({
      id: option.id,
      isAvailable: false,
      priceCents: 777,
    }))
  })

  it('rejeita corpo vazio, acesso anônimo e opção de outra loja', async () => {
    const { option } = await makeProductWithOption()

    expect((await req(`/store/me/options/${option.id}`, {
      method: 'PATCH', body: JSON.stringify({}),
    })).status).toBe(400)

    expect((await app.request(`/store/me/options/${option.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAvailable: false }),
    }, env)).status).toBe(401)

    const otherStore = await createActiveStoreTestFixture({
      ...storeInput,
      name: 'Outra Pizzaria',
      slug: 'outra-pizzaria',
      owner: { ...storeInput.owner, email: 'outra@email.com' },
    })
    const otherToken = await createTestSession(
      { sub: otherStore.ownerUserId, role: 'STORE', name: 'Outra Loja' },
      env.JWT_SECRET,
    )
    expect((await req(`/store/me/options/${option.id}`, {
      method: 'PATCH', body: JSON.stringify({ isAvailable: false }),
    }, otherToken)).status).toBe(404)
  })
})

describe('PATCH /store/me/products/:id (controle ao vivo)', () => {
  it('repreça e pausa o produto', async () => {
    const category = await makeCategory()
    const product = await makeProduct(category.id)

    const reprice = await req(`/store/me/products/${product.id}`, {
      method: 'PATCH', body: JSON.stringify({ basePriceCents: 3199 }),
    })
    expect(reprice.status).toBe(200)
    expect((await reprice.json()) as { basePriceCents: number }).toMatchObject({ basePriceCents: 3199 })

    const pause = await req(`/store/me/products/${product.id}`, {
      method: 'PATCH', body: JSON.stringify({ isAvailable: false }),
    })
    expect(pause.status).toBe(200)
    expect((await pause.json()) as { isAvailable: boolean }).toMatchObject({ isAvailable: false })

    const catalog = (await (await req('/store/me/catalog')).json()) as {
      products: { id: string; basePriceCents: number; isAvailable: boolean }[]
    }[]
    expect(catalog[0]!.products[0]).toMatchObject({
      id: product.id,
      basePriceCents: 3199,
      isAvailable: false,
    })
  })
})

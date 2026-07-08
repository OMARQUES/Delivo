import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import { createStoreWithOwner } from '../src/services/store.service'
import {
  CatalogError, createCategory, deleteCategory, deleteProduct, createProduct,
  updateProduct, replaceProductOptions, getStoreCatalog, getPublicMenu,
  searchProducts, importCsvCatalog, setProductPhoto,
} from '../src/services/catalog.service'

const storeInput: StoreCreateInput = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA', phone: '4433334444',
  city: 'Cidade Exemplo', addressText: 'Rua Central, 100', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

let storeId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  storeId = (await createStoreWithOwner(testDb, storeInput)).id
})
afterAll(closeTestDb)

async function makeProduct() {
  const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
  return createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza', basePriceCents: 3000, isAvailable: true })
}

describe('categories', () => {
  it('creates and blocks delete when products exist', async () => {
    const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
    await createProduct(testDb, storeId, { categoryId: cat.id, name: 'X', basePriceCents: 1000, isAvailable: true })
    await expect(deleteCategory(testDb, storeId, cat.id)).rejects.toThrow(CatalogError)
    await expect(deleteCategory(testDb, storeId, cat.id)).rejects.toMatchObject({ status: 409 })
  })
  it('scopes by store: cannot delete another store category', async () => {
    const other = await createStoreWithOwner(testDb, {
      ...storeInput, slug: 'outra', owner: { ...storeInput.owner, email: 'o@y.com' },
    })
    const cat = await createCategory(testDb, other.id, { name: 'Deles' })
    await expect(deleteCategory(testDb, storeId, cat.id)).rejects.toMatchObject({ status: 404 })
  })
})

describe('products + options tree', () => {
  it('replaceProductOptions swaps tree atomically and resolves matrix by option index', async () => {
    const p = await makeProduct()
    await replaceProductOptions(testDb, storeId, p.id, [
      { name: 'Tamanho', type: 'VARIATION', minSelect: 1, maxSelect: 1,
        options: [
          { name: 'P', priceCents: 3000, isAvailable: true },
          { name: 'G', priceCents: 5000, isAvailable: true },
        ] },
      { name: 'Sabores', type: 'FLAVOR', minSelect: 1, maxSelect: 2,
        options: [
          // variationPrices por ÍNDICE da opção do grupo VARIATION ("0"=P, "1"=G)
          { name: 'Calabresa', priceCents: null, isAvailable: true, variationPrices: { '0': 3200, '1': 5200 } },
        ] },
    ])
    const catalog = await getStoreCatalog(testDb, storeId)
    const prod = catalog[0]!.products[0]!
    expect(prod.groups).toHaveLength(2)
    const flavor = prod.groups.find((g) => g.type === 'FLAVOR')!.options[0]!
    const variation = prod.groups.find((g) => g.type === 'VARIATION')!
    expect(flavor.variationPrices).toEqual({
      [variation.options[0]!.id]: 3200,
      [variation.options[1]!.id]: 5200,
    })
    // replace de novo → árvore antiga some
    await replaceProductOptions(testDb, storeId, p.id, [])
    const after = await getStoreCatalog(testDb, storeId)
    expect(after[0]!.products[0]!.groups).toHaveLength(0)
  })

  it('concurrent replaceProductOptions never merges trees', async () => {
    const p = await makeProduct()
    const treeA = [
      { name: 'Tamanho', type: 'VARIATION' as const, minSelect: 1, maxSelect: 1,
        options: [{ name: 'P', priceCents: 3000, isAvailable: true }] },
    ]
    const treeB = [
      { name: 'Extras', type: 'ADDON' as const, minSelect: 0, maxSelect: 3,
        options: [{ name: 'Borda', priceCents: 800, isAvailable: true }] },
    ]
    for (let i = 0; i < 5; i++) {
      await Promise.all([
        replaceProductOptions(testDb, storeId, p.id, treeA),
        replaceProductOptions(testDb, storeId, p.id, treeB),
      ])
      const catalog = await getStoreCatalog(testDb, storeId)
      const groups = catalog[0]!.products[0]!.groups
      // exatamente UMA árvore vence — nunca a soma das duas
      expect(groups).toHaveLength(1)
      expect(['Tamanho', 'Extras']).toContain(groups[0]!.name)
    }
  })

  it('rejects matrix pointing at nonexistent variation index', async () => {
    const p = await makeProduct()
    await expect(
      replaceProductOptions(testDb, storeId, p.id, [
        { name: 'Sabores', type: 'FLAVOR', minSelect: 1, maxSelect: 2,
          options: [{ name: 'X', priceCents: null, isAvailable: true, variationPrices: { '5': 1000 } }] },
      ]),
    ).rejects.toThrow(CatalogError)
  })

  it('update product fields + photo + delete', async () => {
    const p = await makeProduct()
    const upd = await updateProduct(testDb, storeId, p.id, { isAvailable: false, basePriceCents: 3500 })
    expect(upd.isAvailable).toBe(false)
    await setProductPhoto(testDb, storeId, p.id, 'products/x.png')
    await deleteProduct(testDb, storeId, p.id)
    const catalog = await getStoreCatalog(testDb, storeId)
    expect(catalog[0]!.products).toHaveLength(0)
  })
})

describe('getPublicMenu', () => {
  it('returns nested menu for active store, null for inactive/unknown', async () => {
    const p = await makeProduct()
    void p
    const menu = await getPublicMenu(testDb, 'pizzaria-do-joao')
    expect(menu!.categories[0]!.products[0]!.name).toBe('Pizza')
    expect(await getPublicMenu(testDb, 'nao-existe')).toBeNull()
  })
})

describe('searchProducts', () => {
  it('finds by name across active stores, grouped by store', async () => {
    const cat = await createCategory(testDb, storeId, { name: 'Doces' })
    await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Brigadeiro Gourmet', basePriceCents: 500, isAvailable: true })
    const r = await searchProducts(testDb, 'brigadeiro')
    expect(r).toHaveLength(1)
    expect(r[0]!.store.slug).toBe('pizzaria-do-joao')
    expect(r[0]!.products[0]!.name).toBe('Brigadeiro Gourmet')
    expect(await searchProducts(testDb, 'zzzzz')).toHaveLength(0)
  })
  it('is accent-insensitive: "calabrésa" finds "Pizza Calabresa"', async () => {
    const cat = await createCategory(testDb, storeId, { name: 'Pizzas' })
    await createProduct(testDb, storeId, { categoryId: cat.id, name: 'Pizza Calabresa', basePriceCents: 3500, isAvailable: true })
    const r = await searchProducts(testDb, 'calabrésa')
    expect(r).toHaveLength(1)
    expect(r[0]!.products[0]!.name).toBe('Pizza Calabresa')
  })
})

describe('importCsvCatalog', () => {
  it('creates categories (get-or-create) and products; returns counts', async () => {
    const r = await importCsvCatalog(testDb, storeId, 'Pizzas;Mussarela;;30,00\nPizzas;Calabresa;;35,00\nBebidas;Coca;;10,00')
    expect(r).toEqual({ createdCategories: 2, createdProducts: 3, errors: [] })
    const again = await importCsvCatalog(testDb, storeId, 'Pizzas;Quatro Queijos;;40,00')
    expect(again.createdCategories).toBe(0) // reusa Pizzas
    expect(again.createdProducts).toBe(1)
  })
})

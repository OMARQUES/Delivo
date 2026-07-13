import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { createActiveStoreTestFixture, type StoreFixtureInput, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import {
  CatalogError, createCategory, deleteCategory, deleteProduct, createProduct,
  updateOption, updateProduct, replaceProductOptions, getStoreCatalog, getPublicMenu,
  searchProducts, importCsvCatalog, setProductPhoto, assertOwnedProduct,
} from '../src/services/catalog.service'

const storeInput: StoreFixtureInput = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA', phone: '4433334444',
  city: 'Cidade Exemplo', addressText: 'Rua Central, 100', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

let storeId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  storeId = (await createActiveStoreTestFixture(storeInput)).id
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
    const other = await createActiveStoreTestFixture({
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

  it('assertOwnedProduct allows own product and rejects another store product', async () => {
    const p = await makeProduct()
    await expect(assertOwnedProduct(testDb, storeId, p.id)).resolves.toMatchObject({ id: p.id })
    const other = await createActiveStoreTestFixture({
      ...storeInput,
      slug: 'outra-loja',
      owner: { ...storeInput.owner, email: 'outra-catalog@email.com' },
    })
    await expect(assertOwnedProduct(testDb, other.id, p.id)).rejects.toMatchObject({ status: 404 })
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

  it('omite produtos e opções pausados, incluindo categorias vazias', async () => {
    const product = await makeProduct()
    await replaceProductOptions(testDb, storeId, product.id, [
      { name: 'Extras', type: 'ADDON', minSelect: 0, maxSelect: 2,
        options: [
          { name: 'Catupiry', priceCents: 500, isAvailable: true },
          { name: 'Borda', priceCents: 800, isAvailable: true },
        ] },
    ])
    const storeCatalog = await getStoreCatalog(testDb, storeId)
    const catupiry = storeCatalog[0]!.products[0]!.groups[0]!.options[0]!
    await updateOption(testDb, storeId, catupiry.id, { isAvailable: false })

    const hiddenCategory = await createCategory(testDb, storeId, { name: 'Ocultos' })
    const hiddenProduct = await createProduct(testDb, storeId, {
      categoryId: hiddenCategory.id,
      name: 'Produto pausado',
      basePriceCents: 1000,
      isAvailable: true,
    })
    await updateProduct(testDb, storeId, hiddenProduct.id, { isAvailable: false })

    const menu = await getPublicMenu(testDb, 'pizzaria-do-joao')
    expect(menu!.categories).toHaveLength(1)
    expect(menu!.categories[0]!.products.map((item) => item.id)).toEqual([product.id])
    expect(menu!.categories[0]!.products[0]!.groups[0]!.options.map((option) => option.name)).toEqual(['Borda'])
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

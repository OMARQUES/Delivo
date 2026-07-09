import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { CategoryInput, ProductInput, ProductUpdateInput, OptionsTreeInput } from '@delivery/shared/schemas'
import { parseCatalogCsv } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import {
  optionGroups, options, optionVariationPrices, productCategories, products, stores,
} from '../db/schema'

export class CatalogError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

// ---------- categorias ----------

export async function createCategory(db: Db, storeId: string, input: CategoryInput) {
  const [row] = await db.insert(productCategories).values({ storeId, name: input.name }).returning()
  return row!
}

export async function updateCategory(db: Db, storeId: string, id: string, input: CategoryInput & { sortIndex?: number }) {
  const [row] = await db
    .update(productCategories)
    .set(input)
    .where(and(eq(productCategories.id, id), eq(productCategories.storeId, storeId)))
    .returning()
  if (!row) throw new CatalogError('Categoria não encontrada', 404)
  return row
}

export async function deleteCategory(db: Db, storeId: string, id: string) {
  const [cat] = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(and(eq(productCategories.id, id), eq(productCategories.storeId, storeId)))
  if (!cat) throw new CatalogError('Categoria não encontrada', 404)
  const [prod] = await db.select({ id: products.id }).from(products).where(eq(products.categoryId, id)).limit(1)
  if (prod) throw new CatalogError('Categoria tem produtos — mova-os antes', 409)
  await db.delete(productCategories).where(eq(productCategories.id, id))
}

// ---------- produtos ----------

async function assertOwnCategory(db: Db, storeId: string, categoryId: string) {
  const [cat] = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(and(eq(productCategories.id, categoryId), eq(productCategories.storeId, storeId)))
  if (!cat) throw new CatalogError('Categoria não encontrada', 404)
}

export async function createProduct(db: Db, storeId: string, input: ProductInput) {
  await assertOwnCategory(db, storeId, input.categoryId)
  const [row] = await db
    .insert(products)
    .values({ storeId, ...input, description: input.description ?? null })
    .returning()
  return row!
}

export async function updateProduct(db: Db, storeId: string, id: string, input: ProductUpdateInput) {
  if (Object.keys(input).length === 0) throw new CatalogError('Nada para atualizar', 400)
  if (input.categoryId) await assertOwnCategory(db, storeId, input.categoryId)
  const [row] = await db
    .update(products)
    .set(input)
    .where(and(eq(products.id, id), eq(products.storeId, storeId)))
    .returning()
  if (!row) throw new CatalogError('Produto não encontrado', 404)
  return row
}

export async function deleteProduct(db: Db, storeId: string, id: string) {
  const rows = await db
    .delete(products)
    .where(and(eq(products.id, id), eq(products.storeId, storeId)))
    .returning({ id: products.id })
  if (rows.length === 0) throw new CatalogError('Produto não encontrado', 404)
}

export async function setProductPhoto(db: Db, storeId: string, id: string, photoKey: string) {
  const [row] = await db
    .update(products)
    .set({ photoKey })
    .where(and(eq(products.id, id), eq(products.storeId, storeId)))
    .returning()
  if (!row) throw new CatalogError('Produto não encontrado', 404)
  return row
}

// ---------- árvore de opções (replace-all atômico) ----------

/**
 * Substitui grupos+opções+matriz do produto. variationPrices chega indexado pelo
 * ÍNDICE ("0","1"...) da opção dentro do grupo VARIATION da MESMA árvore.
 */
export async function replaceProductOptions(db: Db, storeId: string, productId: string, tree: OptionsTreeInput) {
  const [prod] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.storeId, storeId)))
  if (!prod) throw new CatalogError('Produto não encontrado', 404)

  const variationGroup = tree.find((g) => g.type === 'VARIATION')
  for (const g of tree) {
    for (const o of g.options) {
      if (!o.variationPrices) continue
      if (g.type !== 'FLAVOR') throw new CatalogError('variationPrices só em FLAVOR', 400)
      for (const idx of Object.keys(o.variationPrices)) {
        const i = Number(idx)
        if (!variationGroup || !Number.isInteger(i) || i < 0 || i >= variationGroup.options.length)
          throw new CatalogError(`Matriz aponta variação inexistente (índice ${idx})`, 400)
      }
    }
  }

  await db.transaction(async (tx) => {
    // Lock da linha do produto: serializa replaces concorrentes (evita merge de árvores)
    await tx.execute(sql`select id from products where id = ${productId} for update`)
    await tx.delete(optionGroups).where(eq(optionGroups.productId, productId)) // cascade limpa options+matriz
    const variationIds: string[] = []
    // 1º passo: VARIATION primeiro pra ter ids
    for (const [gi, g] of tree.entries()) {
      if (g.type !== 'VARIATION') continue
      const [group] = await tx
        .insert(optionGroups)
        .values({ productId, name: g.name, type: g.type, minSelect: g.minSelect, maxSelect: g.maxSelect, sortIndex: gi })
        .returning()
      for (const [oi, o] of g.options.entries()) {
        const [opt] = await tx
          .insert(options)
          .values({ groupId: group!.id, name: o.name, priceCents: o.priceCents, isAvailable: o.isAvailable, sortIndex: oi })
          .returning()
        variationIds.push(opt!.id)
      }
    }
    // 2º passo: demais grupos + matriz resolvida por índice → id
    for (const [gi, g] of tree.entries()) {
      if (g.type === 'VARIATION') continue
      const [group] = await tx
        .insert(optionGroups)
        .values({ productId, name: g.name, type: g.type, minSelect: g.minSelect, maxSelect: g.maxSelect, sortIndex: gi })
        .returning()
      for (const [oi, o] of g.options.entries()) {
        const [opt] = await tx
          .insert(options)
          .values({ groupId: group!.id, name: o.name, priceCents: o.priceCents, isAvailable: o.isAvailable, sortIndex: oi })
          .returning()
        if (o.variationPrices) {
          for (const [idx, price] of Object.entries(o.variationPrices)) {
            await tx.insert(optionVariationPrices).values({
              flavorOptionId: opt!.id,
              variationOptionId: variationIds[Number(idx)]!,
              priceCents: price,
            })
          }
        }
      }
    }
  })
}

// ---------- leitura aninhada ----------

type OptionOut = {
  id: string; name: string; priceCents: number | null; isAvailable: boolean; sortIndex: number
  variationPrices?: Record<string, number>
}
type GroupOut = {
  id: string; name: string; type: 'VARIATION' | 'ADDON' | 'FLAVOR'
  minSelect: number; maxSelect: number; sortIndex: number; options: OptionOut[]
}

async function loadGroupsForProducts(db: Db, productIds: string[]) {
  const byProduct = new Map<string, GroupOut[]>()
  if (productIds.length === 0) return byProduct
  const groups = await db
    .select()
    .from(optionGroups)
    .where(inArray(optionGroups.productId, productIds))
    .orderBy(asc(optionGroups.sortIndex))
  const groupIds = groups.map((g) => g.id)
  const opts = groupIds.length
    ? await db.select().from(options).where(inArray(options.groupId, groupIds)).orderBy(asc(options.sortIndex))
    : []
  const optIds = opts.map((o) => o.id)
  const matrix = optIds.length
    ? await db.select().from(optionVariationPrices).where(inArray(optionVariationPrices.flavorOptionId, optIds))
    : []
  const matrixByFlavor = new Map<string, Record<string, number>>()
  for (const m of matrix) {
    const rec = matrixByFlavor.get(m.flavorOptionId) ?? {}
    rec[m.variationOptionId] = m.priceCents
    matrixByFlavor.set(m.flavorOptionId, rec)
  }
  for (const g of groups) {
    const out: GroupOut = {
      id: g.id, name: g.name, type: g.type, minSelect: g.minSelect, maxSelect: g.maxSelect,
      sortIndex: g.sortIndex,
      options: opts
        .filter((o) => o.groupId === g.id)
        .map((o) => ({
          id: o.id, name: o.name, priceCents: o.priceCents, isAvailable: o.isAvailable, sortIndex: o.sortIndex,
          ...(matrixByFlavor.has(o.id) ? { variationPrices: matrixByFlavor.get(o.id) } : {}),
        })),
    }
    const list = byProduct.get(g.productId) ?? []
    list.push(out)
    byProduct.set(g.productId, list)
  }
  return byProduct
}

/** Produtos (com grupos/opções/matriz por id) de uma loja, por ids. Para o checkout. */
export async function getMenuProductsByIds(db: Db, storeId: string, ids: string[]) {
  if (ids.length === 0) return []
  const prods = await db.select().from(products).where(and(eq(products.storeId, storeId), inArray(products.id, ids)))
  const groupsByProduct = await loadGroupsForProducts(db, prods.map((p) => p.id))
  return prods.map((p) => ({ ...p, groups: groupsByProduct.get(p.id) ?? [] }))
}

/** Painel da loja: tudo aninhado (inclui indisponíveis). */
export async function getStoreCatalog(db: Db, storeId: string) {
  const cats = await db
    .select()
    .from(productCategories)
    .where(eq(productCategories.storeId, storeId))
    .orderBy(asc(productCategories.sortIndex), asc(productCategories.createdAt))
  const prods = await db
    .select()
    .from(products)
    .where(eq(products.storeId, storeId))
    .orderBy(asc(products.sortIndex), asc(products.createdAt))
  const groupsByProduct = await loadGroupsForProducts(db, prods.map((p) => p.id))
  return cats.map((c) => ({
    ...c,
    products: prods
      .filter((p) => p.categoryId === c.id)
      .map((p) => ({ ...p, groups: groupsByProduct.get(p.id) ?? [] })),
  }))
}

/** Cardápio público: loja ativa por slug. null = não encontrada. */
export async function getPublicMenu(db: Db, slug: string) {
  const [store] = await db
    .select({ id: stores.id })
    .from(stores)
    .where(sql`lower(${stores.slug}) = ${slug.toLowerCase()} and ${stores.isActive} = true`)
  if (!store) return null
  const categories = await getStoreCatalog(db, store.id)
  return { categories: categories.filter((c) => c.products.length > 0) }
}

// ---------- busca global ----------

export async function searchProducts(db: Db, q: string) {
  const query = q.trim()
  if (query.length < 2) return []
  const rows = await db
    .select({
      productId: products.id, productName: products.name, priceCents: products.basePriceCents,
      photoKey: products.photoKey,
      storeId: stores.id, storeName: stores.name, storeSlug: stores.slug, storeLogoKey: stores.logoKey,
    })
    .from(products)
    .innerJoin(stores, eq(products.storeId, stores.id))
    .where(
      sql`${stores.isActive} = true and ${products.isAvailable} = true and (
        to_tsvector('portuguese', ${products.name} || ' ' || coalesce(${products.description}, ''))
          @@ websearch_to_tsquery('portuguese', ${query})
        or unaccent(${products.name}) ilike unaccent(${'%' + query + '%'})
      )`,
    )
    .limit(30)
  const byStore = new Map<string, { store: { id: string; name: string; slug: string; logoKey: string | null }; products: { id: string; name: string; priceCents: number; photoKey: string | null }[] }>()
  for (const r of rows) {
    const entry = byStore.get(r.storeId) ?? {
      store: { id: r.storeId, name: r.storeName, slug: r.storeSlug, logoKey: r.storeLogoKey },
      products: [],
    }
    entry.products.push({ id: r.productId, name: r.productName, priceCents: r.priceCents, photoKey: r.photoKey })
    byStore.set(r.storeId, entry)
  }
  return [...byStore.values()]
}

// ---------- import CSV ----------

export async function importCsvCatalog(db: Db, storeId: string, csvText: string) {
  const { rows, errors } = parseCatalogCsv(csvText)
  let createdCategories = 0
  let createdProducts = 0
  const catIds = new Map<string, string>()

  // Import atômico: falhou no meio → nada persiste
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(productCategories)
      .where(eq(productCategories.storeId, storeId))
    for (const c of existing) catIds.set(c.name.toLowerCase(), c.id)

    for (const row of rows) {
      let catId = catIds.get(row.category.toLowerCase())
      if (!catId) {
        const [cat] = await tx.insert(productCategories).values({ storeId, name: row.category }).returning()
        catId = cat!.id
        catIds.set(row.category.toLowerCase(), catId)
        createdCategories++
      }
      await tx.insert(products).values({
        storeId, categoryId: catId, name: row.name, description: row.description, basePriceCents: row.priceCents,
      })
      createdProducts++
    }
  })
  return { createdCategories, createdProducts, errors }
}

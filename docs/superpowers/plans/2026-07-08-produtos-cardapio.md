# Produtos & Cardápio Implementation Plan (Plano 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catálogo completo — loja gerencia categorias/produtos com variações, adicionais e meio-a-meio (matriz sabor×variação), foto no R2; cardápio público com modal de produto calculando preço; busca global; import CSV.

**Architecture:** Grupos de opção **genéricos** (`option_groups.type = VARIATION | ADDON | FLAVOR`) cobrem os 3 mecanismos com um modelo só. `calcItemPrice` é função **pura em shared** (TDD pesado) — o checkout (Plano 5) reusa. Edição de grupos/opções = **replace-all atômico** (`PUT /store/me/products/:id/options` recebe a árvore inteira, delete+insert em tx) — sem CRUD granular; pedidos futuros snapshotam nome/preço, então regenerar ids de opção é seguro. Busca = tsvector português + pg_trgm (migration SQL custom). Fotos reusam o padrão R2 do logo.

**Tech Stack:** Drizzle (tx, migration custom), Zod, Postgres FTS + pg_trgm, R2, Vue (editor de árvore + modal com cálculo).

**Decisões fixas:**
- **VARIATION**: exatamente 1 escolha; `priceCents` da opção é **absoluto** (substitui `basePriceCents`; null = mantém base).
- **FLAVOR** (meio-a-meio): min/max configuráveis (ex. 1-2); preço de cada sabor segue fallback `variationPrices[variaçãoEscolhida] → option.priceCents → preçoDaVariação/base`; preço do produto = **maior sabor** (regra iFood). Máx 1 grupo FLAVOR e 1 VARIATION por produto (MVP).
- **ADDON**: delta **aditivo** (`priceCents` soma; null = grátis).
- Total = preçoProduto(pós variação/sabores) + soma addons. Quantidade multiplica no Plano 5.
- CSV: `categoria;nome;descricao;preco` com preço em **reais BR** ("12,50" ou "12.50") → centavos.
- DELETE categoria com produtos → 409. DELETE produto = hard delete (pedidos snapshotam depois).
- Ordenação: `sortIndex` int; UI usa setinhas (swap), sem drag-and-drop.
- Cardápio público retorna também indisponíveis (`isAvailable:false`) — front exibe acinzentado; modal bloqueia seleção.
- Botão "Adicionar ao carrinho" no modal: **desabilitado** com texto "Carrinho no próximo plano".

---

## Estrutura de arquivos

```
packages/shared/src/
├── catalog.schema.ts     # zod: CategorySchema, ProductSchema, OptionsTreeSchema
├── catalog-price.ts      # tipos MenuProduct/MenuGroup/MenuOption + calcItemPrice + minMenuPrice
├── catalog-csv.ts        # parseCatalogCsv (preço BR → centavos)
└── (constants.ts += catalog-price, catalog-csv; schemas.ts += catalog.schema)

apps/api/src/
├── db/schema/catalog.ts           # product_categories, products, option_groups, options, option_variation_prices
├── services/catalog.service.ts    # CRUD + replaceOptions tx + getMenu + search + importCsv
├── routes/store-catalog.ts        # /store/me/catalog|categories|products (+photo, +options)
├── routes/menu-public.ts          # GET /stores/:slug/menu, GET /search
└── routes/admin-stores.ts         # MOD: +POST /admin/stores/:id/catalog/import

apps/web/src/
├── views/store/StoreMenuView.vue        # painel: categorias + produtos (lista/toggles/setinhas)
├── views/store/ProductFormView.vue      # form produto + editor de grupos/opções/matriz
├── views/StoreCatalogView.vue           # MOD: cardápio real + filtro + modal
├── components/ProductModal.vue          # seletores + preço calculado
├── views/SearchView.vue                 # /busca?q= resultados por loja
├── views/HomeView.vue                   # MOD: campo busca global
└── router/index.ts                      # MOD: /loja/cardapio, /loja/cardapio/produto/:id?, /busca
```

---

### Task 1: shared — schemas do catálogo + parser CSV (TDD)

**Files:**
- Create: `packages/shared/src/catalog.schema.ts`, `packages/shared/src/catalog-csv.ts`
- Modify: `packages/shared/src/schemas.ts`, `packages/shared/src/constants.ts`
- Test: `packages/shared/src/catalog.schema.test.ts`, `packages/shared/src/catalog-csv.test.ts`

- [ ] **Step 1: Testes que falham**

`packages/shared/src/catalog.schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CategorySchema, ProductSchema, OptionsTreeSchema } from './catalog.schema'

describe('CategorySchema', () => {
  it('accepts name, rejects empty/long', () => {
    expect(CategorySchema.parse({ name: 'Pizzas' }).name).toBe('Pizzas')
    expect(() => CategorySchema.parse({ name: '' })).toThrow()
    expect(() => CategorySchema.parse({ name: 'x'.repeat(61) })).toThrow()
  })
})

describe('ProductSchema', () => {
  const valid = { categoryId: crypto.randomUUID(), name: 'Pizza Calabresa', basePriceCents: 3500 }
  it('accepts minimal product, defaults isAvailable', () => {
    const p = ProductSchema.parse(valid)
    expect(p.isAvailable).toBe(true)
    expect(p.description).toBeUndefined()
  })
  it('rejects negative price and bad uuid', () => {
    expect(() => ProductSchema.parse({ ...valid, basePriceCents: -1 })).toThrow()
    expect(() => ProductSchema.parse({ ...valid, categoryId: 'nope' })).toThrow()
  })
})

describe('OptionsTreeSchema', () => {
  const variation = {
    name: 'Tamanho', type: 'VARIATION', minSelect: 1, maxSelect: 1,
    options: [{ name: 'P', priceCents: 3000 }, { name: 'G', priceCents: 5000 }],
  }
  const flavor = {
    name: 'Sabores', type: 'FLAVOR', minSelect: 1, maxSelect: 2,
    options: [{ name: 'Calabresa', priceCents: 5000 }, { name: 'Portuguesa', priceCents: 5500 }],
  }
  const addon = {
    name: 'Extras', type: 'ADDON', minSelect: 0, maxSelect: 3,
    options: [{ name: 'Borda recheada', priceCents: 800 }, { name: 'Catupiry', priceCents: 400 }],
  }

  it('accepts full tree', () => {
    const t = OptionsTreeSchema.parse([variation, flavor, addon])
    expect(t).toHaveLength(3)
    expect(t[0]!.options[0]!.isAvailable).toBe(true)
  })
  it('rejects VARIATION with min/max != 1 and two VARIATION groups', () => {
    expect(() => OptionsTreeSchema.parse([{ ...variation, maxSelect: 2 }])).toThrow()
    expect(() => OptionsTreeSchema.parse([variation, { ...variation, name: 'T2' }])).toThrow()
  })
  it('rejects two FLAVOR groups and min>max', () => {
    expect(() => OptionsTreeSchema.parse([flavor, { ...flavor, name: 'S2' }])).toThrow()
    expect(() => OptionsTreeSchema.parse([{ ...addon, minSelect: 5, maxSelect: 3 }])).toThrow()
  })
  it('accepts flavor variationPrices record', () => {
    const vid = crypto.randomUUID()
    const t = OptionsTreeSchema.parse([
      { ...flavor, options: [{ name: 'Calabresa', priceCents: null, variationPrices: { [vid]: 4000 } }] },
    ])
    expect(t[0]!.options[0]!.variationPrices).toEqual({ [vid]: 4000 })
  })
})
```

`packages/shared/src/catalog-csv.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseCatalogCsv } from './catalog-csv'

describe('parseCatalogCsv', () => {
  it('parses BR prices (comma and dot) into cents', () => {
    const r = parseCatalogCsv('Pizzas;Calabresa;Deliciosa;35,50\nBebidas;Coca 2L;;12.00')
    expect(r.errors).toHaveLength(0)
    expect(r.rows).toEqual([
      { category: 'Pizzas', name: 'Calabresa', description: 'Deliciosa', priceCents: 3550 },
      { category: 'Bebidas', name: 'Coca 2L', description: null, priceCents: 1200 },
    ])
  })
  it('skips header line if present and blank lines', () => {
    const r = parseCatalogCsv('categoria;nome;descricao;preco\n\nPizzas;Mussarela;;30,00\n')
    expect(r.rows).toHaveLength(1)
  })
  it('reports per-line errors without aborting', () => {
    const r = parseCatalogCsv('Pizzas;SemPreco;;\n;SemCategoria;;10,00\nPizzas;Ok;;9,90')
    expect(r.rows).toHaveLength(1)
    expect(r.errors).toHaveLength(2)
    expect(r.errors[0]!.line).toBe(1)
  })
  it('rejects absurd prices', () => {
    const r = parseCatalogCsv('X;Caro;;100000,00')
    expect(r.errors).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Ver falhar** — `pnpm --filter @delivery/shared test catalog` → FAIL

- [ ] **Step 3: Criar `packages/shared/src/catalog.schema.ts`**

```ts
import { z } from 'zod'

const Cents = z.number().int().min(0).max(1_000_000)

export const CategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
})
export type CategoryInput = z.infer<typeof CategorySchema>

export const ProductSchema = z.object({
  categoryId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  basePriceCents: Cents,
  isAvailable: z.boolean().default(true),
})
export type ProductInput = z.infer<typeof ProductSchema>

export const ProductUpdateSchema = ProductSchema.partial().extend({
  sortIndex: z.number().int().min(0).optional(),
})
export type ProductUpdateInput = z.infer<typeof ProductUpdateSchema>

const OptionInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** VARIATION: preço absoluto; ADDON: delta; FLAVOR: preço cheio (fallback). null = herda/grátis */
  priceCents: Cents.nullable().default(null),
  isAvailable: z.boolean().default(true),
  /** Só FLAVOR: preço por opção de variação (chave = índice da opção no grupo VARIATION desta árvore, ou uuid quando editando produto existente) */
  variationPrices: z.record(z.string(), Cents).optional(),
})

const GroupInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(['VARIATION', 'ADDON', 'FLAVOR']),
  minSelect: z.number().int().min(0).max(20),
  maxSelect: z.number().int().min(1).max(20),
  options: z.array(OptionInputSchema).min(1).max(50),
})

export const OptionsTreeSchema = z
  .array(GroupInputSchema)
  .max(10)
  .refine((gs) => gs.every((g) => g.minSelect <= g.maxSelect), 'minSelect > maxSelect')
  .refine(
    (gs) => gs.every((g) => g.type !== 'VARIATION' || (g.minSelect === 1 && g.maxSelect === 1)),
    'VARIATION exige exatamente 1 escolha',
  )
  .refine((gs) => gs.filter((g) => g.type === 'VARIATION').length <= 1, 'Máximo 1 grupo VARIATION')
  .refine((gs) => gs.filter((g) => g.type === 'FLAVOR').length <= 1, 'Máximo 1 grupo FLAVOR')
export type OptionsTreeInput = z.infer<typeof OptionsTreeSchema>
```

- [ ] **Step 4: Criar `packages/shared/src/catalog-csv.ts`**

```ts
export type CsvRow = { category: string; name: string; description: string | null; priceCents: number }
export type CsvError = { line: number; message: string }

/** "35,50" | "35.50" | "35" → centavos. null = inválido. */
function parsePriceBR(raw: string): number | null {
  const s = raw.trim().replace(/\./g, (m, i, str) => (str.indexOf(',') > -1 ? '' : m)).replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const cents = Math.round(Number(s) * 100)
  if (!Number.isInteger(cents) || cents < 0 || cents > 1_000_000) return null
  return cents
}

/** Formato: categoria;nome;descricao;preco (preço em reais BR). Header opcional. */
export function parseCatalogCsv(text: string): { rows: CsvRow[]; errors: CsvError[] } {
  const rows: CsvRow[] = []
  const errors: CsvError[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const n = i + 1
    const trimmed = line.trim()
    if (!trimmed) return
    if (i === 0 && /^categoria;/i.test(trimmed)) return // header
    const parts = trimmed.split(';')
    const [category, name, description, price] = [parts[0]?.trim(), parts[1]?.trim(), parts[2]?.trim(), parts[3]?.trim()]
    if (!category) return errors.push({ line: n, message: 'categoria vazia' })
    if (!name) return errors.push({ line: n, message: 'nome vazio' })
    const priceCents = price ? parsePriceBR(price) : null
    if (priceCents == null) return errors.push({ line: n, message: 'preço inválido' })
    rows.push({ category, name, description: description || null, priceCents })
  })
  return { rows, errors }
}
```

- [ ] **Step 5: Barrels** — `schemas.ts` += `export * from './catalog.schema'`; `constants.ts` += `export * from './catalog-csv'`.

- [ ] **Step 6: Ver passar** — `pnpm --filter @delivery/shared test` → 33 + 12 = 45. Typecheck + lint.

- [ ] **Step 7: Commit** — `git add packages/shared && git commit -m "feat(shared): catalog schemas + BR-price csv parser"`

---

### Task 2: shared — calcItemPrice (TDD pesado — coração do domínio)

**Files:**
- Create: `packages/shared/src/catalog-price.ts`
- Modify: `packages/shared/src/constants.ts`
- Test: `packages/shared/src/catalog-price.test.ts`

- [ ] **Step 1: Teste que falha — `packages/shared/src/catalog-price.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { calcItemPrice, minMenuPrice, type MenuProduct } from './catalog-price'

const P = 'var-p', G = 'var-g', CAL = 'fl-cal', PORT = 'fl-port', BORDA = 'ad-borda', CAT = 'ad-cat'

const pizza: MenuProduct = {
  id: 'prod-1', name: 'Pizza', basePriceCents: 3000, isAvailable: true,
  groups: [
    { id: 'g-var', name: 'Tamanho', type: 'VARIATION', minSelect: 1, maxSelect: 1,
      options: [
        { id: P, name: 'P', priceCents: 3000, isAvailable: true },
        { id: G, name: 'G', priceCents: 5000, isAvailable: true },
      ] },
    { id: 'g-fl', name: 'Sabores', type: 'FLAVOR', minSelect: 1, maxSelect: 2,
      options: [
        { id: CAL, name: 'Calabresa', priceCents: null, isAvailable: true, variationPrices: { [P]: 3200, [G]: 5200 } },
        { id: PORT, name: 'Portuguesa', priceCents: 6000, isAvailable: true },
      ] },
    { id: 'g-ad', name: 'Extras', type: 'ADDON', minSelect: 0, maxSelect: 2,
      options: [
        { id: BORDA, name: 'Borda', priceCents: 800, isAvailable: true },
        { id: CAT, name: 'Catupiry', priceCents: null, isAvailable: true },
      ] },
  ],
}

const simple: MenuProduct = { id: 'prod-2', name: 'Coca', basePriceCents: 1200, isAvailable: true, groups: [] }

function sel(groupId: string, ...optionIds: string[]) {
  return { groupId, optionIds }
}

describe('calcItemPrice', () => {
  it('simple product, no groups: base price', () => {
    expect(calcItemPrice(simple, [])).toEqual({ ok: true, totalCents: 1200 })
  })

  it('variation replaces base; flavor matrix price per size; highest flavor wins', () => {
    // G + Calabresa (matriz G=5200) + Portuguesa (fixo 6000) → max = 6000
    const r = calcItemPrice(pizza, [sel('g-var', G), sel('g-fl', CAL, PORT)])
    expect(r).toEqual({ ok: true, totalCents: 6000 })
  })

  it('flavor matrix fallback chain: matrix → option price → variation price', () => {
    // P + só Calabresa → matriz P=3200
    expect(calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', CAL)])).toEqual({ ok: true, totalCents: 3200 })
    // sabor sem matriz nem preço → cai no preço da variação
    const noPrices: MenuProduct = {
      ...pizza,
      groups: pizza.groups.map((g) =>
        g.id === 'g-fl'
          ? { ...g, options: [{ id: 'fl-x', name: 'Mussarela', priceCents: null, isAvailable: true }] }
          : g,
      ),
    }
    expect(calcItemPrice(noPrices, [sel('g-var', G), sel('g-fl', 'fl-x')])).toEqual({ ok: true, totalCents: 5000 })
  })

  it('addons add on top; null addon price = free', () => {
    const r = calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', CAL), sel('g-ad', BORDA, CAT)])
    expect(r).toEqual({ ok: true, totalCents: 3200 + 800 })
  })

  it('validates: missing required variation/flavor, over max, unknown option, unavailable option', () => {
    expect(calcItemPrice(pizza, [sel('g-fl', CAL)]).ok).toBe(false) // sem variação
    expect(calcItemPrice(pizza, [sel('g-var', P)]).ok).toBe(false) // sem sabor (min 1)
    expect(calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', CAL, PORT), sel('g-ad', BORDA, CAT), sel('g-ad', BORDA)]).ok).toBe(false) // grupo duplicado na seleção
    expect(calcItemPrice(pizza, [sel('g-var', P, G), sel('g-fl', CAL)]).ok).toBe(false) // 2 variações
    expect(calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', 'ghost')]).ok).toBe(false) // opção inexistente
    const paused: MenuProduct = {
      ...pizza,
      groups: pizza.groups.map((g) =>
        g.id === 'g-fl'
          ? { ...g, options: g.options.map((o) => (o.id === CAL ? { ...o, isAvailable: false } : o)) }
          : g,
      ),
    }
    expect(calcItemPrice(paused, [sel('g-var', P), sel('g-fl', CAL)]).ok).toBe(false) // opção indisponível
    expect(calcItemPrice({ ...pizza, isAvailable: false }, [sel('g-var', P), sel('g-fl', CAL)]).ok).toBe(false) // produto indisponível
  })

  it('duplicate optionIds within a selection rejected', () => {
    expect(calcItemPrice(pizza, [sel('g-var', P), sel('g-fl', CAL, CAL)]).ok).toBe(false)
  })
})

describe('minMenuPrice', () => {
  it('no groups → base; with variation → cheapest variation', () => {
    expect(minMenuPrice(simple)).toBe(1200)
    expect(minMenuPrice(pizza)).toBe(3000)
  })
})
```

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `packages/shared/src/catalog-price.ts`**

```ts
export type MenuOption = {
  id: string
  name: string
  priceCents: number | null
  isAvailable: boolean
  /** FLAVOR: preço por id da opção de variação */
  variationPrices?: Record<string, number>
}
export type MenuGroup = {
  id: string
  name: string
  type: 'VARIATION' | 'ADDON' | 'FLAVOR'
  minSelect: number
  maxSelect: number
  options: MenuOption[]
}
export type MenuProduct = {
  id: string
  name: string
  basePriceCents: number
  isAvailable: boolean
  groups: MenuGroup[]
}

export type Selection = { groupId: string; optionIds: string[] }
export type PriceResult = { ok: true; totalCents: number } | { ok: false; error: string }

/**
 * Preço de 1 unidade validando a seleção contra o produto.
 * VARIATION substitui base; FLAVOR = max(matriz[variação] → preço → variação/base); ADDON soma.
 */
export function calcItemPrice(product: MenuProduct, selections: Selection[]): PriceResult {
  if (!product.isAvailable) return { ok: false, error: 'Produto indisponível' }

  const byGroup = new Map<string, string[]>()
  for (const s of selections) {
    if (byGroup.has(s.groupId)) return { ok: false, error: 'Grupo duplicado na seleção' }
    if (new Set(s.optionIds).size !== s.optionIds.length)
      return { ok: false, error: 'Opção duplicada' }
    byGroup.set(s.groupId, s.optionIds)
  }
  for (const gid of byGroup.keys()) {
    if (!product.groups.some((g) => g.id === gid)) return { ok: false, error: 'Grupo desconhecido' }
  }

  let variationOption: MenuOption | null = null
  const flavorOptions: MenuOption[] = []
  let addonsCents = 0

  for (const group of product.groups) {
    const chosenIds = byGroup.get(group.id) ?? []
    if (chosenIds.length < group.minSelect || chosenIds.length > group.maxSelect)
      return { ok: false, error: `Seleção inválida em ${group.name}` }
    const chosen: MenuOption[] = []
    for (const oid of chosenIds) {
      const opt = group.options.find((o) => o.id === oid)
      if (!opt) return { ok: false, error: 'Opção inexistente' }
      if (!opt.isAvailable) return { ok: false, error: `${opt.name} indisponível` }
      chosen.push(opt)
    }
    if (group.type === 'VARIATION') variationOption = chosen[0] ?? null
    else if (group.type === 'FLAVOR') flavorOptions.push(...chosen)
    else for (const o of chosen) addonsCents += o.priceCents ?? 0
  }

  const variationPrice = variationOption?.priceCents ?? product.basePriceCents
  let productCents = variationPrice
  if (flavorOptions.length > 0) {
    productCents = Math.max(
      ...flavorOptions.map((f) => {
        const matrix = variationOption ? f.variationPrices?.[variationOption.id] : undefined
        return matrix ?? f.priceCents ?? variationPrice
      }),
    )
  }
  return { ok: true, totalCents: productCents + addonsCents }
}

/** Menor preço exibível ("a partir de"): menor variação disponível, senão base. */
export function minMenuPrice(product: MenuProduct): number {
  const variation = product.groups.find((g) => g.type === 'VARIATION')
  const prices = variation?.options
    .filter((o) => o.isAvailable && o.priceCents != null)
    .map((o) => o.priceCents!) ?? []
  return prices.length > 0 ? Math.min(...prices) : product.basePriceCents
}
```

- [ ] **Step 4: Barrel** — `constants.ts` += `export * from './catalog-price'` (sem zod — vai pro bundle do web).

- [ ] **Step 5: Ver passar** — `pnpm --filter @delivery/shared test` → 45 + 8 = 53. Typecheck + lint + web build ainda zod-free.

- [ ] **Step 6: Commit** — `git add packages/shared && git commit -m "feat(shared): calcItemPrice — variation/flavor-matrix/addon pricing (pure)"`

---

### Task 3: db — tabelas do catálogo + migration

**Files:**
- Create: `apps/api/src/db/schema/catalog.ts`
- Modify: `apps/api/src/db/schema/index.ts`, `apps/api/test/helpers/test-db.ts`

- [ ] **Step 1: Criar `apps/api/src/db/schema/catalog.ts`**

```ts
import {
  boolean, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid,
} from 'drizzle-orm/pg-core'
import { stores } from './stores'

export const optionGroupType = pgEnum('option_group_type', ['VARIATION', 'ADDON', 'FLAVOR'])

export const productCategories = pgTable('product_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sortIndex: integer('sort_index').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => productCategories.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  basePriceCents: integer('base_price_cents').notNull(),
  photoKey: text('photo_key'),
  isAvailable: boolean('is_available').notNull().default(true),
  sortIndex: integer('sort_index').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
})

export const optionGroups = pgTable('option_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: optionGroupType('type').notNull(),
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select').notNull().default(1),
  sortIndex: integer('sort_index').notNull().default(0),
})

export const options = pgTable('options', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => optionGroups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priceCents: integer('price_cents'),
  isAvailable: boolean('is_available').notNull().default(true),
  sortIndex: integer('sort_index').notNull().default(0),
})

/** Matriz sabor×variação (só FLAVOR referencia VARIATION do mesmo produto) */
export const optionVariationPrices = pgTable(
  'option_variation_prices',
  {
    flavorOptionId: uuid('flavor_option_id').notNull().references(() => options.id, { onDelete: 'cascade' }),
    variationOptionId: uuid('variation_option_id').notNull().references(() => options.id, { onDelete: 'cascade' }),
    priceCents: integer('price_cents').notNull(),
  },
  (t) => [primaryKey({ columns: [t.flavorOptionId, t.variationOptionId] })],
)
```

- [ ] **Step 2: Barrel + truncate** — `schema/index.ts` += `export * from './catalog'`. `test-db.ts` truncateAll:
```ts
await testDb.execute(sql`TRUNCATE TABLE option_variation_prices, options, option_groups, products, product_categories, refresh_tokens, auth_providers, stores, users CASCADE`)
```

- [ ] **Step 3: Migration** — `pnpm --filter @delivery/api db:generate && pnpm --filter @delivery/api db:migrate` → `drizzle/0004_*.sql`. Verificar `\d products` no psql (flatpak-spawn).

- [ ] **Step 4: Suite** — api 53 verdes, typecheck.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): catalog tables — categories, products, generic option groups, flavor matrix"`

---

### Task 4: db — busca (pg_trgm + tsvector) via migration SQL custom

**Files:**
- Create: `apps/api/drizzle/0005_search_indexes.sql` (via drizzle-kit custom)

- [ ] **Step 1: Gerar migration vazia custom**

```bash
cd apps/api && pnpm drizzle-kit generate --custom --name search_indexes && cd ../..
```
Escrever no arquivo gerado (`drizzle/0005_search_indexes.sql`):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX products_fts_idx ON products USING gin (
  to_tsvector('portuguese', name || ' ' || coalesce(description, ''))
);
--> statement-breakpoint
CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops);
```

- [ ] **Step 2: Aplicar** — `pnpm --filter @delivery/api db:migrate`. Verificar índices: `\di products*` no psql.

- [ ] **Step 3: Suite** — api verde (migrateTestDb aplica no delivery_test; se `CREATE EXTENSION` falhar por permissão no container, é superuser postgres — deve passar; reporte se não).

- [ ] **Step 4: Commit** — `git add apps/api && git commit -m "feat(api): portuguese fts + trigram indexes for product search"`

---

### Task 5: catalog service (TDD contra Postgres real)

**Files:**
- Create: `apps/api/src/services/catalog.service.ts`
- Test: `apps/api/test/catalog.service.test.ts`

- [ ] **Step 1: Teste que falha — `apps/api/test/catalog.service.test.ts`**

```ts
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
```

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `apps/api/src/services/catalog.service.ts`**

```ts
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
        or ${products.name} ilike ${'%' + query + '%'}
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
  const existing = await db
    .select()
    .from(productCategories)
    .where(eq(productCategories.storeId, storeId))
  for (const c of existing) catIds.set(c.name.toLowerCase(), c.id)

  for (const row of rows) {
    let catId = catIds.get(row.category.toLowerCase())
    if (!catId) {
      const [cat] = await db.insert(productCategories).values({ storeId, name: row.category }).returning()
      catId = cat!.id
      catIds.set(row.category.toLowerCase(), catId)
      createdCategories++
    }
    await db.insert(products).values({
      storeId, categoryId: catId, name: row.name, description: row.description, basePriceCents: row.priceCents,
    })
    createdProducts++
  }
  return { createdCategories, createdProducts, errors }
}
```

- [ ] **Step 4: Ver passar** — `pnpm --filter @delivery/api test catalog.service` → PASS 8. Suite + typecheck + lint.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): catalog service — crud, atomic options tree, menu, fts search, csv import"`

---

### Task 6: rotas painel `/store/me/*` do catálogo (TDD)

**Files:**
- Create: `apps/api/src/routes/store-catalog.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/store-catalog.routes.test.ts`

- [ ] **Step 1: Teste que falha — `apps/api/test/store-catalog.routes.test.ts`**

```ts
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { signAccessToken } from '../src/lib/tokens'
import { createStoreWithOwner } from '../src/services/store.service'

const put = vi.fn(async () => ({}))
const env = {
  JWT_SECRET: 'test-secret', ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: { put } as unknown as R2Bucket,
}

const storeInput: StoreCreateInput = {
  name: 'Pizzaria', slug: 'pizzaria', category: 'PIZZARIA', phone: '4433334444',
  city: 'C', addressText: 'Rua A, 1', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

let token: string
let storeId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  put.mockClear()
  const store = await createStoreWithOwner(testDb, storeInput)
  storeId = store.id
  void storeId
  token = await signAccessToken({ sub: store.ownerUserId, role: 'STORE', name: 'João' }, env.JWT_SECRET)
})
afterAll(closeTestDb)

function req(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
    ...(init.headers as Record<string, string>),
  }
  return app.request(path, { ...init, headers }, env)
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
    const cust = await signAccessToken({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
    expect(
      (await app.request('/store/me/catalog', { headers: { Authorization: `Bearer ${cust}` } }, env)).status,
    ).toBe(403)
  })
})
```

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `apps/api/src/routes/store-catalog.ts`**

```ts
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { CategorySchema, OptionsTreeSchema, ProductSchema, ProductUpdateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware, requireRole } from '../middleware/auth'
import { getStoreByOwner, StoreError } from '../services/store.service'
import {
  CatalogError, createCategory, createProduct, deleteCategory, deleteProduct,
  getStoreCatalog, replaceProductOptions, setProductPhoto, updateCategory, updateProduct,
} from '../services/catalog.service'
import type { AppContext } from '../env'
import type { Context } from 'hono'

export const storeCatalogRoutes = createRouter()

storeCatalogRoutes.use('/store/*', authMiddleware, requireRole('STORE'))

function rethrow(e: unknown): never {
  if (e instanceof CatalogError || e instanceof StoreError)
    throw new HTTPException(e.status, { message: e.message })
  throw e
}

async function ownStoreId(c: Context<AppContext>): Promise<string> {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  return store.id
}

const IdParam = z.object({ id: z.uuid() })
const Out = z.object({ id: z.string() }).passthrough()

storeCatalogRoutes.openapi(
  createRoute({ method: 'get', path: '/store/me/catalog',
    responses: { 200: { description: 'Catálogo aninhado', content: { 'application/json': { schema: z.array(Out) } } } } }),
  async (c) => c.json(await getStoreCatalog(c.get('db'), await ownStoreId(c)), 200),
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'post', path: '/store/me/categories',
    request: { body: { content: { 'application/json': { schema: CategorySchema } } } },
    responses: { 201: { description: 'Criada', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await createCategory(c.get('db'), await ownStoreId(c), c.req.valid('json')).catch(rethrow), 201),
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'patch', path: '/store/me/categories/{id}',
    request: { params: IdParam, body: { content: { 'application/json': { schema: CategorySchema.partial().extend({ sortIndex: z.number().int().min(0).optional() }) } } } },
    responses: { 200: { description: 'Atualizada', content: { 'application/json': { schema: Out } } } } }),
  async (c) => {
    const body = c.req.valid('json')
    if (Object.keys(body).length === 0) throw new HTTPException(400, { message: 'Nada para atualizar' })
    const row = await updateCategory(c.get('db'), await ownStoreId(c), c.req.valid('param').id, body as { name: string; sortIndex?: number }).catch(rethrow)
    return c.json(row, 200)
  },
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'delete', path: '/store/me/categories/{id}',
    request: { params: IdParam },
    responses: { 204: { description: 'Removida' } } }),
  async (c) => {
    await deleteCategory(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow)
    return c.body(null, 204)
  },
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'post', path: '/store/me/products',
    request: { body: { content: { 'application/json': { schema: ProductSchema } } } },
    responses: { 201: { description: 'Criado', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await createProduct(c.get('db'), await ownStoreId(c), c.req.valid('json')).catch(rethrow), 201),
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'patch', path: '/store/me/products/{id}',
    request: { params: IdParam, body: { content: { 'application/json': { schema: ProductUpdateSchema } } } },
    responses: { 200: { description: 'Atualizado', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await updateProduct(c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json')).catch(rethrow), 200),
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'delete', path: '/store/me/products/{id}',
    request: { params: IdParam },
    responses: { 204: { description: 'Removido' } } }),
  async (c) => {
    await deleteProduct(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow)
    return c.body(null, 204)
  },
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'put', path: '/store/me/products/{id}/options',
    request: { params: IdParam, body: { content: { 'application/json': { schema: OptionsTreeSchema } } } },
    responses: { 200: { description: 'Árvore substituída', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } } }),
  async (c) => {
    await replaceProductOptions(c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json')).catch(rethrow)
    return c.json({ ok: true }, 200)
  },
)

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_PHOTO_BYTES = 2 * 1024 * 1024

storeCatalogRoutes.put('/store/me/products/:id/photo', async (c) => {
  const storeId = await ownStoreId(c)
  const id = c.req.param('id')
  const type = c.req.header('Content-Type') ?? ''
  if (!IMAGE_TYPES.includes(type)) throw new HTTPException(400, { message: 'Envie png, jpeg ou webp' })
  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0 || body.byteLength > MAX_PHOTO_BYTES)
    throw new HTTPException(400, { message: 'Imagem vazia ou maior que 2MB' })
  const key = `products/${crypto.randomUUID()}.${type.split('/')[1]}`
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: type } })
  await setProductPhoto(c.get('db'), storeId, id, key).catch(rethrow)
  return c.json({ photoKey: key }, 200)
})
```

- [ ] **Step 4: Montar** — `app.ts`: `app.route('/', storeCatalogRoutes)`.
ATENÇÃO: `storeMeRoutes` (Task 7 do plano de lojas) já monta `use('/store/*', authMiddleware, requireRole('STORE'))` — dois sub-apps com o mesmo `use` são independentes; sem conflito, cada sub-app aplica aos próprios paths. OK.

- [ ] **Step 5: Ver passar + suite** — 4 novos; total 65 (53+8 service+4). Typecheck + lint.

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): store catalog panel routes — categories, products, options tree, photo"`

---

### Task 7: rotas públicas — menu + busca (TDD)

**Files:**
- Create: `apps/api/src/routes/menu-public.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/menu-public.routes.test.ts`

- [ ] **Step 1: Teste que falha — `apps/api/test/menu-public.routes.test.ts`**

```ts
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createStoreWithOwner } from '../src/services/store.service'
import { createCategory, createProduct } from '../src/services/catalog.service'

const env = {
  JWT_SECRET: 'test-secret', ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const storeInput: StoreCreateInput = {
  name: 'Pizzaria', slug: 'pizzaria', category: 'PIZZARIA', phone: '4433334444',
  city: 'C', addressText: 'Rua A, 1', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

async function seedMenu() {
  const store = await createStoreWithOwner(testDb, storeInput)
  const cat = await createCategory(testDb, store.id, { name: 'Pizzas' })
  await createProduct(testDb, store.id, { categoryId: cat.id, name: 'Pizza Calabresa', basePriceCents: 3500, isAvailable: true })
  return store
}

describe('GET /stores/:slug/menu', () => {
  it('returns nested menu publicly; 404 unknown', async () => {
    await seedMenu()
    const res = await app.request('/stores/pizzaria/menu', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { categories: { name: string; products: { name: string; groups: unknown[] }[] }[] }
    expect(body.categories[0]!.products[0]!.name).toBe('Pizza Calabresa')
    expect((await app.request('/stores/nope/menu', {}, env)).status).toBe(404)
  })
})

describe('GET /search', () => {
  it('finds products grouped by store; empty q rejected', async () => {
    await seedMenu()
    const res = await app.request('/search?q=calabresa', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { store: { slug: string }; products: { name: string }[] }[]
    expect(body[0]!.store.slug).toBe('pizzaria')
    expect((await app.request('/search?q=a', {}, env)).status).toBe(200) // <2 chars → []
    expect(((await (await app.request('/search?q=a', {}, env)).json()) as unknown[]).length).toBe(0)
  })
})
```

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `apps/api/src/routes/menu-public.ts`**

```ts
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../app-factory'
import { getPublicMenu, searchProducts } from '../services/catalog.service'

export const menuPublicRoutes = createRouter()

menuPublicRoutes.openapi(
  createRoute({ method: 'get', path: '/stores/{slug}/menu',
    request: { params: z.object({ slug: z.string().min(1).max(60) }) },
    responses: { 200: { description: 'Cardápio', content: { 'application/json': { schema: z.object({ categories: z.array(z.object({}).passthrough()) }) } } } } }),
  async (c) => {
    const menu = await getPublicMenu(c.get('db'), c.req.valid('param').slug)
    if (!menu) throw new HTTPException(404, { message: 'Loja não encontrada' })
    return c.json(menu, 200)
  },
)

menuPublicRoutes.openapi(
  createRoute({ method: 'get', path: '/search',
    request: { query: z.object({ q: z.string().max(80).default('') }) },
    responses: { 200: { description: 'Resultados por loja', content: { 'application/json': { schema: z.array(z.object({}).passthrough()) } } } } }),
  async (c) => c.json(await searchProducts(c.get('db'), c.req.valid('query').q), 200),
)
```

- [ ] **Step 4: Montar** — `app.ts`: `app.route('/', menuPublicRoutes)`.
ATENÇÃO ordem de rotas: `publicStoreRoutes` tem `GET /stores/{slug}` — Hono resolve `/stores/pizzaria/menu` pro path mais específico registrado; como são sub-apps separados montados em sequência, registre `menuPublicRoutes` ANTES de `publicStoreRoutes` em app.ts se houver conflito (teste dirá — o Hono router é exato por segmentos, `/stores/:slug` NÃO captura `/stores/:slug/menu`, então ordem irrelevante; confirme pelo teste).

- [ ] **Step 5: Ver passar + suite** — 2 novos; total 67. Typecheck + lint.

- [ ] **Step 6: Commit + push + CI** — `git add apps/api && git commit -m "feat(api): public menu + global product search routes" && git push` + `gh run watch` verde.

---

### Task 8: rota admin — import CSV (TDD)

**Files:**
- Modify: `apps/api/src/routes/admin-stores.ts`
- Test: adicionar casos em `apps/api/test/admin-stores.routes.test.ts`

- [ ] **Step 1: Testes que falham** — adicionar no arquivo existente:

```ts
describe('POST /admin/stores/:id/catalog/import', () => {
  it('imports csv, returns counts + line errors', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { id } = (await create.json()) as { id: string }
    const csv = 'Pizzas;Mussarela;;30,00\nPizzas;SemPreco;;\nBebidas;Coca;;10,00'
    const res = await req(`/admin/stores/${id}/catalog/import`, {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv,
    }, await adminToken())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { createdCategories: number; createdProducts: number; errors: { line: number }[] }
    expect(body.createdCategories).toBe(2)
    expect(body.createdProducts).toBe(2)
    expect(body.errors).toHaveLength(1)
  })

  it('403 non-admin, 404 unknown store', async () => {
    expect((await req(`/admin/stores/${crypto.randomUUID()}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await customerToken())).status).toBe(403)
    expect((await req(`/admin/stores/${crypto.randomUUID()}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await adminToken())).status).toBe(404)
  })
})
```
(`req` helper do arquivo aceita token como 3º arg — conferir assinatura real e adaptar chamadas.)

- [ ] **Step 2: Ver falhar** — FAIL (404 rota inexistente)

- [ ] **Step 3: Implementar em `admin-stores.ts`** (rota crua — body text/csv, não JSON):

```ts
import { eq } from 'drizzle-orm'
import { stores } from '../db/schema'
import { importCsvCatalog } from '../services/catalog.service'

adminStoreRoutes.post('/admin/stores/:id/catalog/import', async (c) => {
  const id = c.req.param('id')
  const [store] = await c.get('db').select({ id: stores.id }).from(stores).where(eq(stores.id, id))
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  const csv = await c.req.text()
  if (!csv.trim()) throw new HTTPException(400, { message: 'CSV vazio' })
  const result = await importCsvCatalog(c.get('db'), id, csv)
  return c.json(result, 200)
})
```
(Middleware `use('/admin/*')` já cobre auth+role.)

- [ ] **Step 4: Ver passar + suite** — 2 novos; total 69. Typecheck + lint.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): admin csv catalog import"`

---

### Task 9: web — painel do cardápio (categorias + produtos)

**Files:**
- Create: `apps/web/src/views/store/StoreMenuView.vue`
- Modify: `apps/web/src/router/index.ts`, `apps/web/src/views/store/StoreLayout.vue`

- [ ] **Step 1: Router + nav** — children de `/loja` += :
```ts
        { path: 'cardapio', name: 'store-menu', component: () => import('../views/store/StoreMenuView.vue') },
        { path: 'cardapio/produto/:productId?', name: 'store-product-form', component: () => import('../views/store/ProductFormView.vue') },
```
`StoreLayout.vue` nav += `<RouterLink to="/loja/cardapio" class="underline">Cardápio</RouterLink>`.

- [ ] **Step 2: Criar `apps/web/src/views/store/StoreMenuView.vue`**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../lib/api'

type Product = { id: string; name: string; basePriceCents: number; isAvailable: boolean; sortIndex: number }
type Category = { id: string; name: string; sortIndex: number; products: Product[] }

const catalog = ref<Category[]>([])
const newCategory = ref('')
const error = ref('')

async function load() {
  catalog.value = await api<Category[]>('/store/me/catalog')
}
onMounted(() => load().catch((e) => (error.value = e.message)))

async function run(fn: () => Promise<unknown>) {
  error.value = ''
  try {
    await fn()
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

const addCategory = () =>
  run(async () => {
    await api('/store/me/categories', { method: 'POST', body: JSON.stringify({ name: newCategory.value }) })
    newCategory.value = ''
  })
const renameCategory = (c: Category) => {
  const name = prompt('Novo nome', c.name)
  if (name) run(() => api(`/store/me/categories/${c.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }))
}
const removeCategory = (c: Category) =>
  run(() => api(`/store/me/categories/${c.id}`, { method: 'DELETE' }))
const toggleProduct = (p: Product) =>
  run(() => api(`/store/me/products/${p.id}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: !p.isAvailable }) }))
const removeProduct = (p: Product) =>
  run(() => api(`/store/me/products/${p.id}`, { method: 'DELETE' }))

function swapCategory(i: number, j: number) {
  const a = catalog.value[i], b = catalog.value[j]
  if (!a || !b) return
  run(async () => {
    await api(`/store/me/categories/${a.id}`, { method: 'PATCH', body: JSON.stringify({ sortIndex: j }) })
    await api(`/store/me/categories/${b.id}`, { method: 'PATCH', body: JSON.stringify({ sortIndex: i }) })
  })
}

function swapProduct(c: Category, i: number, j: number) {
  const a = c.products[i], b = c.products[j]
  if (!a || !b) return
  run(async () => {
    await api(`/store/me/products/${a.id}`, { method: 'PATCH', body: JSON.stringify({ sortIndex: j }) })
    await api(`/store/me/products/${b.id}`, { method: 'PATCH', body: JSON.stringify({ sortIndex: i }) })
  })
}

const money = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
</script>

<template>
  <main class="mx-auto max-w-2xl space-y-4 p-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">Cardápio</h1>
      <RouterLink to="/loja/cardapio/produto" class="rounded bg-black px-3 py-1 text-white">Novo produto</RouterLink>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <form class="flex gap-2" @submit.prevent="addCategory">
      <input v-model="newCategory" required placeholder="Nova categoria" class="flex-1 rounded border p-2" />
      <button class="rounded border px-3">Criar</button>
    </form>

    <section v-for="(c, i) in catalog" :key="c.id" class="rounded border">
      <header class="flex items-center justify-between border-b bg-gray-50 p-2">
        <span class="font-semibold">{{ c.name }}</span>
        <span class="flex gap-2 text-sm">
          <button :disabled="i === 0" @click="swapCategory(i, i - 1)">↑</button>
          <button :disabled="i === catalog.length - 1" @click="swapCategory(i, i + 1)">↓</button>
          <button @click="renameCategory(c)">renomear</button>
          <button class="text-red-600" @click="removeCategory(c)">excluir</button>
        </span>
      </header>
      <ul class="divide-y">
        <li v-for="p in c.products" :key="p.id" class="flex items-center justify-between p-2" :class="!p.isAvailable && 'opacity-50'">
          <RouterLink :to="`/loja/cardapio/produto/${p.id}`" class="flex-1">
            {{ p.name }} <span class="text-sm text-gray-500">{{ money(p.basePriceCents) }}</span>
          </RouterLink>
          <span class="flex gap-2 text-sm">
            <button :disabled="c.products.indexOf(p) === 0" @click="swapProduct(c, c.products.indexOf(p), c.products.indexOf(p) - 1)">↑</button>
            <button :disabled="c.products.indexOf(p) === c.products.length - 1" @click="swapProduct(c, c.products.indexOf(p), c.products.indexOf(p) + 1)">↓</button>
            <button @click="toggleProduct(p)">{{ p.isAvailable ? 'pausar' : 'ativar' }}</button>
            <button class="text-red-600" @click="removeProduct(p)">excluir</button>
          </span>
        </li>
        <li v-if="c.products.length === 0" class="p-2 text-sm text-gray-400">Sem produtos</li>
      </ul>
    </section>
  </main>
</template>
```

- [ ] **Step 3: Stub do ProductFormView** (Task 10 implementa de verdade — mas o router referencia; crie o arquivo REAL na Task 10; nesta task crie versão mínima que compila):
`apps/web/src/views/store/ProductFormView.vue`:
```vue
<template>
  <main class="p-4">Form do produto na Task 10.</main>
</template>
```

- [ ] **Step 4: Verificar** — build + typecheck + lint + testes web (8).

- [ ] **Step 5: Commit** — `git add apps/web && git commit -m "feat(web): store menu panel — categories crud, product list/toggles"`

---

### Task 10: web — form do produto + editor de opções/matriz

**Files:**
- Rewrite: `apps/web/src/views/store/ProductFormView.vue`

- [ ] **Step 1: Reescrever `ProductFormView.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../lib/api'

type Opt = { name: string; priceCents: number | null; isAvailable: boolean; variationPrices?: Record<string, number> }
type Group = { name: string; type: 'VARIATION' | 'ADDON' | 'FLAVOR'; minSelect: number; maxSelect: number; options: Opt[] }
type CatalogCategory = { id: string; name: string; products: { id: string }[] }
type LoadedProduct = {
  id: string; categoryId: string; name: string; description: string | null
  basePriceCents: number; isAvailable: boolean; photoKey: string | null
  groups: { name: string; type: Group['type']; minSelect: number; maxSelect: number
    options: { id: string; name: string; priceCents: number | null; isAvailable: boolean; variationPrices?: Record<string, number> }[] }[]
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const route = useRoute()
const router = useRouter()
const productId = ref<string | null>((route.params.productId as string) || null)

const categories = ref<{ id: string; name: string }[]>([])
const form = reactive({ categoryId: '', name: '', description: '', basePriceCents: 0, isAvailable: true })
const groups = ref<Group[]>([])
const photoKey = ref<string | null>(null)
const msg = ref('')
const saving = ref(false)

onMounted(async () => {
  const catalog = await api<CatalogCategory[]>('/store/me/catalog')
  categories.value = catalog.map((c) => ({ id: c.id, name: c.name }))
  if (productId.value) {
    const prod = (catalog as unknown as (CatalogCategory & { products: LoadedProduct[] })[])
      .flatMap((c) => c.products)
      .find((p) => p.id === productId.value)
    if (prod) {
      Object.assign(form, {
        categoryId: prod.categoryId, name: prod.name, description: prod.description ?? '',
        basePriceCents: prod.basePriceCents, isAvailable: prod.isAvailable,
      })
      photoKey.value = prod.photoKey
      // matriz volta com chave = id da opção de variação; converter pra índice
      const varOptions = prod.groups.find((g) => g.type === 'VARIATION')?.options ?? []
      const idToIndex = new Map(varOptions.map((o, i) => [o.id, String(i)]))
      groups.value = prod.groups.map((g) => ({
        name: g.name, type: g.type, minSelect: g.minSelect, maxSelect: g.maxSelect,
        options: g.options.map((o) => ({
          name: o.name, priceCents: o.priceCents, isAvailable: o.isAvailable,
          ...(o.variationPrices
            ? { variationPrices: Object.fromEntries(Object.entries(o.variationPrices).map(([id, v]) => [idToIndex.get(id) ?? id, v])) }
            : {}),
        })),
      }))
    }
  } else if (categories.value[0]) {
    form.categoryId = categories.value[0].id
  }
})

const variationGroup = computed(() => groups.value.find((g) => g.type === 'VARIATION'))
const hasVariation = computed(() => Boolean(variationGroup.value))
const hasFlavor = computed(() => groups.value.some((g) => g.type === 'FLAVOR'))

function addGroup(type: Group['type']) {
  groups.value.push({
    name: type === 'VARIATION' ? 'Tamanho' : type === 'FLAVOR' ? 'Sabores' : 'Adicionais',
    type, minSelect: type === 'ADDON' ? 0 : 1, maxSelect: type === 'FLAVOR' ? 2 : 1,
    options: [{ name: '', priceCents: null, isAvailable: true }],
  })
}
const removeGroup = (gi: number) => groups.value.splice(gi, 1)
const addOption = (g: Group) => g.options.push({ name: '', priceCents: null, isAvailable: true })
const removeOption = (g: Group, oi: number) => g.options.splice(oi, 1)

function setMatrix(opt: Opt, varIndex: number, ev: Event) {
  const v = (ev.target as HTMLInputElement).value
  const rec = { ...(opt.variationPrices ?? {}) }
  if (v === '') delete rec[String(varIndex)]
  else rec[String(varIndex)] = Math.round(Number(v) * 100)
  opt.variationPrices = Object.keys(rec).length ? rec : undefined
}

async function save() {
  msg.value = ''
  saving.value = true
  try {
    let id = productId.value
    const payload = {
      categoryId: form.categoryId, name: form.name,
      description: form.description || undefined,
      basePriceCents: form.basePriceCents, isAvailable: form.isAvailable,
    }
    if (id) await api(`/store/me/products/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
    else id = ((await api<{ id: string }>('/store/me/products', { method: 'POST', body: JSON.stringify(payload) })) ).id
    await api(`/store/me/products/${id}/options`, { method: 'PUT', body: JSON.stringify(groups.value) })
    msg.value = 'Salvo!'
    if (!productId.value) await router.replace(`/loja/cardapio/produto/${id}`)
    productId.value = id
  } catch (e) {
    msg.value = e instanceof Error ? e.message : 'Erro ao salvar'
  } finally {
    saving.value = false
  }
}

async function uploadPhoto(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file || !productId.value) return
  try {
    const r = await api<{ photoKey: string }>(`/store/me/products/${productId.value}/photo`, {
      method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
    })
    photoKey.value = r.photoKey
    msg.value = 'Foto atualizada!'
  } catch (e) {
    msg.value = e instanceof Error ? e.message : 'Erro no upload'
  }
}
</script>

<template>
  <main class="mx-auto max-w-2xl space-y-4 p-4">
    <h1 class="text-xl font-bold">{{ productId ? 'Editar produto' : 'Novo produto' }}</h1>

    <section class="space-y-2">
      <select v-model="form.categoryId" required class="w-full rounded border p-2">
        <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <input v-model="form.name" required placeholder="Nome" class="w-full rounded border p-2" />
      <textarea v-model="form.description" placeholder="Descrição" class="w-full rounded border p-2"></textarea>
      <label class="block text-sm">Preço base (centavos)
        <input v-model.number="form.basePriceCents" type="number" min="0" class="w-full rounded border p-2" />
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="form.isAvailable" type="checkbox" /> Disponível
      </label>
      <div v-if="productId" class="space-y-1">
        <img v-if="photoKey" :src="`${API_URL}/media/${photoKey}`" class="h-24 w-24 rounded object-cover" alt="" />
        <input type="file" accept="image/png,image/jpeg,image/webp" @change="uploadPhoto" />
      </div>
      <p v-else class="text-xs text-gray-500">Salve o produto pra enviar foto.</p>
    </section>

    <section class="space-y-3">
      <div class="flex gap-2">
        <button v-if="!hasVariation" class="rounded border px-2 py-1 text-sm" @click="addGroup('VARIATION')">+ Variações</button>
        <button v-if="!hasFlavor" class="rounded border px-2 py-1 text-sm" @click="addGroup('FLAVOR')">+ Sabores (meio-a-meio)</button>
        <button class="rounded border px-2 py-1 text-sm" @click="addGroup('ADDON')">+ Adicionais</button>
      </div>

      <div v-for="(g, gi) in groups" :key="gi" class="space-y-2 rounded border p-3">
        <div class="flex items-center gap-2">
          <span class="rounded bg-gray-200 px-2 text-xs">{{ g.type }}</span>
          <input v-model="g.name" class="flex-1 rounded border p-1" />
          <button class="text-sm text-red-600" @click="removeGroup(gi)">remover grupo</button>
        </div>
        <div v-if="g.type !== 'VARIATION'" class="flex gap-2 text-sm">
          <label>mín <input v-model.number="g.minSelect" type="number" min="0" class="w-16 rounded border p-1" /></label>
          <label>máx <input v-model.number="g.maxSelect" type="number" min="1" class="w-16 rounded border p-1" /></label>
        </div>

        <div v-for="(o, oi) in g.options" :key="oi" class="space-y-1 rounded border p-2">
          <div class="flex items-center gap-2">
            <input v-model="o.name" placeholder="Nome da opção" class="flex-1 rounded border p-1" />
            <input
              :value="o.priceCents == null ? '' : o.priceCents / 100"
              type="number" step="0.01" min="0"
              :placeholder="g.type === 'ADDON' ? '+R$' : 'R$'"
              class="w-24 rounded border p-1"
              @input="(e) => { const v = (e.target as HTMLInputElement).value; o.priceCents = v === '' ? null : Math.round(Number(v) * 100) }"
            />
            <label class="text-xs"><input v-model="o.isAvailable" type="checkbox" /> disp.</label>
            <button class="text-sm text-red-600" @click="removeOption(g, oi)">×</button>
          </div>
          <div v-if="g.type === 'FLAVOR' && hasVariation" class="flex flex-wrap gap-2 pl-2 text-xs">
            <label v-for="(vo, vi) in variationGroup!.options" :key="vi" class="flex items-center gap-1">
              {{ vo.name || `variação ${vi + 1}` }}:
              <input
                :value="o.variationPrices?.[String(vi)] != null ? o.variationPrices![String(vi)]! / 100 : ''"
                type="number" step="0.01" min="0" placeholder="R$"
                class="w-20 rounded border p-1"
                @input="(e) => setMatrix(o, vi, e)"
              />
            </label>
          </div>
        </div>
        <button class="rounded border px-2 py-1 text-xs" @click="addOption(g)">+ opção</button>
      </div>
    </section>

    <p v-if="msg" class="text-sm" :class="['Salvo!', 'Foto atualizada!'].includes(msg) ? 'text-green-700' : 'text-red-600'">{{ msg }}</p>
    <div class="flex gap-2">
      <button :disabled="saving" class="flex-1 rounded bg-black p-2 text-white disabled:opacity-50" @click="save">
        {{ saving ? 'Salvando…' : 'Salvar' }}
      </button>
      <RouterLink to="/loja/cardapio" class="rounded border px-4 py-2">Voltar</RouterLink>
    </div>
  </main>
</template>
```

- [ ] **Step 2: Verificar** — build + typecheck + lint + testes web. E2E manual API-level: criar produto com variação+sabores+matriz via UI se possível, senão via curl replicando payload; conferir `GET /store/me/catalog` devolve matriz por id.

- [ ] **Step 3: Commit** — `git add apps/web && git commit -m "feat(web): product form with options tree + flavor-variation matrix editor"`

---

### Task 11: web — cardápio público + modal com cálculo + filtro

**Files:**
- Create: `apps/web/src/components/ProductModal.vue`
- Modify: `apps/web/src/views/StoreCatalogView.vue`

- [ ] **Step 1: Criar `apps/web/src/components/ProductModal.vue`**

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { calcItemPrice, type MenuProduct, type Selection } from '@delivery/shared/constants'

const props = defineProps<{ product: MenuProduct; photoUrl: string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const picked = ref<Record<string, string[]>>({})

function toggle(groupId: string, optionId: string, max: number, single: boolean) {
  const cur = picked.value[groupId] ?? []
  if (single) {
    picked.value = { ...picked.value, [groupId]: [optionId] }
    return
  }
  const has = cur.includes(optionId)
  if (has) picked.value = { ...picked.value, [groupId]: cur.filter((i) => i !== optionId) }
  else if (cur.length < max) picked.value = { ...picked.value, [groupId]: [...cur, optionId] }
}

const selections = computed<Selection[]>(() =>
  Object.entries(picked.value)
    .filter(([, ids]) => ids.length > 0)
    .map(([groupId, optionIds]) => ({ groupId, optionIds })),
)

const price = computed(() => calcItemPrice(props.product, selections.value))
const money = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
</script>

<template>
  <div class="fixed inset-0 z-10 flex items-end justify-center bg-black/40 sm:items-center" @click.self="emit('close')">
    <div class="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-lg bg-white p-4 sm:rounded-lg">
      <div class="flex items-start justify-between">
        <h2 class="text-lg font-bold">{{ product.name }}</h2>
        <button class="text-2xl leading-none" @click="emit('close')">×</button>
      </div>
      <img v-if="photoUrl" :src="photoUrl" class="mt-2 h-40 w-full rounded object-cover" alt="" />

      <section v-for="g in product.groups" :key="g.id" class="mt-4">
        <p class="font-semibold">
          {{ g.name }}
          <span class="text-xs font-normal text-gray-500">
            {{ g.type === 'VARIATION' ? 'escolha 1' : `escolha ${g.minSelect}-${g.maxSelect}` }}
          </span>
        </p>
        <label
          v-for="o in g.options"
          :key="o.id"
          class="mt-1 flex items-center gap-2 rounded border p-2"
          :class="!o.isAvailable && 'opacity-40'"
        >
          <input
            :type="g.type === 'VARIATION' ? 'radio' : 'checkbox'"
            :name="g.id"
            :disabled="!o.isAvailable"
            :checked="(picked[g.id] ?? []).includes(o.id)"
            @change="toggle(g.id, o.id, g.maxSelect, g.type === 'VARIATION')"
          />
          <span class="flex-1">{{ o.name }}</span>
          <span v-if="o.priceCents != null" class="text-sm text-gray-600">
            {{ g.type === 'ADDON' ? '+' : '' }}{{ money(o.priceCents) }}
          </span>
        </label>
      </section>

      <div class="mt-4 border-t pt-3">
        <p v-if="price.ok" class="text-lg font-bold">{{ money(price.totalCents) }}</p>
        <p v-else class="text-sm text-gray-500">{{ price.error }}</p>
        <button disabled class="mt-2 w-full rounded bg-gray-300 p-2 text-gray-600" title="Carrinho no próximo plano">
          Adicionar ao carrinho (em breve)
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Reescrever a parte de cardápio do `StoreCatalogView.vue`** — substituir o placeholder "Cardápio entra no plano de produtos" por menu real. Script setup ganha:

```ts
import ProductModal from '../components/ProductModal.vue'
import { minMenuPrice, type MenuProduct } from '@delivery/shared/constants'

type MenuCategory = { id: string; name: string; products: (MenuProduct & { description: string | null; photoKey: string | null })[] }

const menu = ref<MenuCategory[]>([])
const filter = ref('')
const selected = ref<(MenuProduct & { photoKey: string | null }) | null>(null)

// dentro de load(slug), após carregar store:
const m = await api<{ categories: MenuCategory[] }>(`/stores/${slug}/menu`)
menu.value = m.categories

const filteredMenu = computed(() =>
  menu.value
    .map((c) => ({
      ...c,
      products: c.products.filter(
        (p) => !filter.value || p.name.toLowerCase().includes(filter.value.toLowerCase()),
      ),
    }))
    .filter((c) => c.products.length > 0),
)
const money = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
```

Template (substituindo o placeholder):
```vue
      <input v-model="filter" placeholder="Buscar no cardápio…" class="mt-4 w-full rounded border p-2" />
      <section v-for="c in filteredMenu" :key="c.id" class="mt-4">
        <h2 class="font-semibold">{{ c.name }}</h2>
        <ul class="mt-1 space-y-1">
          <li
            v-for="p in c.products"
            :key="p.id"
            class="flex cursor-pointer items-center gap-3 rounded border p-2"
            :class="!p.isAvailable && 'opacity-50'"
            @click="selected = p"
          >
            <img v-if="p.photoKey" :src="`${API_URL}/media/${p.photoKey}`" class="h-12 w-12 rounded object-cover" alt="" />
            <div class="flex-1">
              <p>{{ p.name }}</p>
              <p v-if="p.description" class="text-xs text-gray-500">{{ p.description }}</p>
            </div>
            <span class="text-sm">{{ p.groups.length ? 'a partir de ' : '' }}{{ money(minMenuPrice(p)) }}</span>
          </li>
        </ul>
      </section>
      <p v-if="filteredMenu.length === 0" class="mt-6 text-gray-500">Nada no cardápio.</p>
      <ProductModal
        v-if="selected"
        :product="selected"
        :photo-url="selected.photoKey ? `${API_URL}/media/${selected.photoKey}` : null"
        @close="selected = null"
      />
```

- [ ] **Step 3: Verificar** — build + typecheck + lint + testes web. Bundle: `calcItemPrice` vem de `/constants` (sem zod) — grep zod nos chunks = 0.

- [ ] **Step 4: Commit** — `git add apps/web && git commit -m "feat(web): public menu with product modal price calc + in-menu filter"`

---

### Task 12: web — busca global (home + /busca)

**Files:**
- Create: `apps/web/src/views/SearchView.vue`
- Modify: `apps/web/src/views/HomeView.vue`, `apps/web/src/router/index.ts`

- [ ] **Step 1: Rota** — antes de `/:storeSlug`:
```ts
    { path: '/busca', name: 'search', component: () => import('../views/SearchView.vue') },
```

- [ ] **Step 2: Criar `apps/web/src/views/SearchView.vue`**

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../lib/api'

type Result = {
  store: { id: string; name: string; slug: string; logoKey: string | null }
  products: { id: string; name: string; priceCents: number; photoKey: string | null }[]
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const route = useRoute()
const router = useRouter()
const q = ref((route.query.q as string) ?? '')
const results = ref<Result[]>([])
const loading = ref(false)

async function search() {
  if (q.value.trim().length < 2) {
    results.value = []
    return
  }
  loading.value = true
  try {
    results.value = await api<Result[]>(`/search?q=${encodeURIComponent(q.value)}`)
  } finally {
    loading.value = false
  }
}

function submit() {
  router.replace({ name: 'search', query: { q: q.value } })
  search()
}

onMounted(search)
watch(() => route.query.q, (v) => { q.value = (v as string) ?? ''; search() })

const money = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <form class="flex gap-2" @submit.prevent="submit">
      <input v-model="q" placeholder="Buscar produto em todas as lojas…" class="flex-1 rounded border p-2" />
      <button class="rounded bg-black px-3 text-white">Buscar</button>
    </form>
    <p v-if="loading" class="mt-4 text-gray-500">Buscando…</p>
    <p v-else-if="q.length >= 2 && results.length === 0" class="mt-4 text-gray-500">Nada encontrado.</p>
    <section v-for="r in results" :key="r.store.id" class="mt-4 rounded border">
      <RouterLink :to="`/${r.store.slug}`" class="flex items-center gap-2 border-b bg-gray-50 p-2 font-semibold">
        <img v-if="r.store.logoKey" :src="`${API_URL}/media/${r.store.logoKey}`" class="h-8 w-8 rounded object-cover" alt="" />
        {{ r.store.name }}
      </RouterLink>
      <ul class="divide-y">
        <li v-for="p in r.products" :key="p.id" class="flex items-center gap-2 p-2">
          <img v-if="p.photoKey" :src="`${API_URL}/media/${p.photoKey}`" class="h-10 w-10 rounded object-cover" alt="" />
          <span class="flex-1">{{ p.name }}</span>
          <span class="text-sm">{{ money(p.priceCents) }}</span>
        </li>
      </ul>
    </section>
  </main>
</template>
```

- [ ] **Step 3: Home** — em `HomeView.vue`, acima do input de busca de loja, adicionar link/campo pra busca global:

```vue
    <RouterLink to="/busca" class="mt-3 block rounded border p-2 text-center text-sm text-gray-600">
      🔍 Buscar produto em todas as lojas
    </RouterLink>
```
(Manter o input de busca de loja existente como está.)

- [ ] **Step 4: Verificar** — build + typecheck + lint + testes web (8: guard test — /busca é público, sem impacto).

- [ ] **Step 5: Commit + push + CI** — `git add apps/web && git commit -m "feat(web): global product search view" && git push` + CI verde.

---

### Task 13: encerramento

**Files:**
- Modify: `docs/carry-forwards.md`, `README.md`

- [ ] **Step 1: carry-forwards** — ADICIONAR:

```markdown
| Fotos de produto: mesma nota do logo — órfãos no re-upload; volume maior que logos | Plano Produtos | Junto da limpeza de logos |
| Import CSV não importa variações/adicionais (só categoria+produto+preço) — ajuste fino manual | Plano Produtos T8 | Aceito (decisão de escopo) |
| Busca FTS sem paginação/ranking fino (limit 30) | Plano Produtos T7 | Quando catálogo crescer |
| Editor de opções: replace-all regenera ids de opção — inofensivo até Plano 5 snapshotar itens de pedido (CONFIRMAR snapshot no plano 5) | Plano Produtos | Plano Pedidos |
```

- [ ] **Step 2: README** — Roadmap: "4. ✅ Produtos & Cardápio". Dev: nota "cardápio da loja em /loja/cardapio; import CSV via POST /admin/stores/:id/catalog/import".

- [ ] **Step 3: Suite final completa** — `pnpm typecheck && pnpm test && pnpm lint && pnpm build` verde (esperado ~53 shared + 69 api + 8 web). Commit + push + CI verde:

```bash
git add docs/carry-forwards.md README.md
git commit -m "docs: products plan wrap-up"
git push
```

---

## Critério de sucesso

- Loja monta produto completo pela UI: categoria → produto → variações P/G + sabores com matriz por tamanho + adicionais → foto
- Cardápio público renderiza; modal calcula: G + Calabresa(matriz) + Portuguesa(fixo) mostra o MAIOR sabor + borda somada — igual aos testes de `calcItemPrice`
- Meio-a-meio: preço = sabor mais caro, com matriz por variação e fallbacks corretos (validado por 8 testes puros + e2e visual)
- Busca "calabresa" na home acha produtos agrupados por loja; filtro dentro do cardápio funciona
- Import CSV cria categorias/produtos com preço BR e reporta erros por linha
- Indisponível: produto/opção pausados aparecem acinzentados e são rejeitados no cálculo
- Suite completa + CI verdes

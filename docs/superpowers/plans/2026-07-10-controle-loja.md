# Plano — Controle da Loja (pausar item + preço ao vivo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar à loja controle rápido, ao vivo e em produção sobre o cardápio: pausar/despausar e repreçar **produtos E opções** (adicionais/variações/sabores) sem replace-all da árvore, sem pausar a loja.

**Architecture:** Produto já é pausável/repreçável via `PATCH /store/me/products/{id}` (parcial) — falta só edição inline de preço na tela do cardápio. Opções ganham endpoint granular novo `PATCH /store/me/options/{id}` (hoje só editáveis via `PUT .../options` que faz replace-all e regenera ids — ruim pra toggle diário). UI do cardápio ganha edição inline de preço do produto e um painel de opções com pausar/repreçar rápido.

**Tech Stack:** Hono + Drizzle (Postgres), Zod (@hono/zod-openapi + shared), Vue 3, Vitest contra Postgres real.

---

## Guardrails (leia antes de codar)

1. **NÃO usar replace-all pra pausar/repreçar opção.** O `PUT /store/me/products/{id}/options` regenera ids de opção (quebra referências da matriz sabor×variação e é lento). O endpoint novo faz `UPDATE` pontual, preservando ids.
2. **Tudo com escopo da loja dona (tenant).** Toda mutação de opção valida que a opção pertence a um produto da loja logada (`option → group → product.storeId`). Loja A não altera opção da loja B → 404.
3. **Dinheiro em centavos no storage/API; UI sempre em R$** via `formatBRL`. Input de preço na UI é em reais → converter pra centavos com `Math.round(reais * 100)`.
4. **Pedidos em andamento não quebram:** o checkout já snapshota nome/preço dos itens/opções no pedido (Plano 5). Pausar ou repreçar não afeta pedido já criado. Não mexer nisso.
5. **Item pausado some do cardápio público** (o filtro `isAvailable` no menu público já existe — não regredir).
6. **`priceCents` de opção é nullable** (VARIATION/FLAVOR podem ter preço via matriz; ADDON usa delta). Aceitar `null`.
7. Testes contra Postgres real (padrão `test/helpers/test-db.ts`, `vi.mock` de `createDb`→`testDb`). NUNCA mockar Drizzle.
8. TDD por task: teste falha → impl → teste passa → commit. Mensagens convencionais.
9. Gate final: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

---

### Task 1: Schema compartilhado de update de opção

**Files:**
- Modify: `packages/shared/src/catalog.schema.ts`
- Test: `packages/shared/src/catalog.schema.test.ts`

- [ ] **Step 1: Teste falhando**

Adicionar ao `packages/shared/src/catalog.schema.test.ts` (manter o resto):

```ts
import { OptionUpdateSchema } from './catalog.schema'

describe('OptionUpdateSchema', () => {
  it('aceita só isAvailable', () => {
    expect(OptionUpdateSchema.safeParse({ isAvailable: false }).success).toBe(true)
  })
  it('aceita só priceCents (inclusive null)', () => {
    expect(OptionUpdateSchema.safeParse({ priceCents: 500 }).success).toBe(true)
    expect(OptionUpdateSchema.safeParse({ priceCents: null }).success).toBe(true)
  })
  it('rejeita objeto vazio', () => {
    expect(OptionUpdateSchema.safeParse({}).success).toBe(false)
  })
  it('rejeita preço negativo', () => {
    expect(OptionUpdateSchema.safeParse({ priceCents: -1 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @delivery/shared test catalog.schema`
Expected: FAIL — `OptionUpdateSchema` não existe.

- [ ] **Step 3: Implementar**

Em `packages/shared/src/catalog.schema.ts`, localizar a constante `Cents` (já existe no arquivo; é `z.number().int().min(0).max(...)`). Adicionar ao final do arquivo:

```ts
export const OptionUpdateSchema = z
  .object({
    isAvailable: z.boolean().optional(),
    priceCents: Cents.nullable().optional(),
  })
  .refine((v) => v.isAvailable !== undefined || v.priceCents !== undefined, {
    message: 'Informe isAvailable e/ou priceCents',
  })
export type OptionUpdateInput = z.infer<typeof OptionUpdateSchema>
```

> Se `Cents` não estiver exportado/visível no escopo do final do arquivo, reutilize a mesma definição inline: `z.number().int().min(0).max(1_000_000)`.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @delivery/shared test catalog.schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/catalog.schema.ts packages/shared/src/catalog.schema.test.ts
git commit -m "feat(shared): OptionUpdateSchema for granular option pause/price"
```

---

### Task 2: Service `updateOption` (com tenant guard)

**Files:**
- Modify: `apps/api/src/services/catalog.service.ts`
- Test: `apps/api/test/store-catalog.routes.test.ts` (o teste de service vai junto na Task 4 via rota; aqui só a impl)

- [ ] **Step 1: Implementar `updateOption`**

Em `apps/api/src/services/catalog.service.ts`:

1. Garantir que `OptionUpdateInput` está importado do shared. No import existente de `@delivery/shared/schemas` (topo do arquivo) adicionar `OptionUpdateInput`:

```ts
import type { CategoryInput, ProductInput, ProductUpdateInput, OptionsTreeInput, OptionUpdateInput } from '@delivery/shared/schemas'
```

2. Adicionar a função (perto de `updateProduct`). Usa join option→group→product pra checar a loja dona:

```ts
export async function updateOption(db: Db, storeId: string, optionId: string, input: OptionUpdateInput) {
  if (input.isAvailable === undefined && input.priceCents === undefined)
    throw new CatalogError('Nada para atualizar', 400)
  // a opção pertence a um produto DESTA loja? (option → group → product.storeId)
  const [owned] = await db
    .select({ id: options.id })
    .from(options)
    .innerJoin(optionGroups, eq(optionGroups.id, options.groupId))
    .innerJoin(products, eq(products.id, optionGroups.productId))
    .where(and(eq(options.id, optionId), eq(products.storeId, storeId)))
  if (!owned) throw new CatalogError('Opção não encontrada', 404)

  const patch: Partial<{ isAvailable: boolean; priceCents: number | null }> = {}
  if (input.isAvailable !== undefined) patch.isAvailable = input.isAvailable
  if (input.priceCents !== undefined) patch.priceCents = input.priceCents

  const [row] = await db.update(options).set(patch).where(eq(options.id, optionId)).returning()
  return row!
}
```

> `options`, `optionGroups`, `products`, `and`, `eq` já estão importados no arquivo (conferir topo; se faltar algum, adicionar).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @delivery/api typecheck`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/catalog.service.ts
git commit -m "feat(api): updateOption service with tenant guard (no replace-all)"
```

---

### Task 3: Rota `PATCH /store/me/options/{id}`

**Files:**
- Modify: `apps/api/src/routes/store-catalog.ts`

- [ ] **Step 1: Implementar a rota**

Em `apps/api/src/routes/store-catalog.ts`:

1. Importar o schema e o service. No import de `@delivery/shared/schemas` adicionar `OptionUpdateSchema`; no import de `../services/catalog.service` adicionar `updateOption`.

2. Adicionar a rota (depois do bloco de `PUT .../options`, seguindo o padrão `ownStoreId(c)` + `.catch(rethrow)` usado nas outras). `IdParam` e `Out` já existem no arquivo:

```ts
storeCatalogRoutes.openapi(
  createRoute({ method: 'patch', path: '/store/me/options/{id}',
    request: { params: IdParam, body: { content: { 'application/json': { schema: OptionUpdateSchema } } } },
    responses: { 200: { description: 'Opção atualizada', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await updateOption(c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json')).catch(rethrow), 200),
)
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @delivery/api typecheck`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/store-catalog.ts
git commit -m "feat(api): PATCH /store/me/options/:id"
```

---

### Task 4: Testes de rota (opção + confirmação do produto)

**Files:**
- Modify: `apps/api/test/store-catalog.routes.test.ts`

Estude o topo do arquivo pra reusar os helpers existentes (`req`, token de loja, criação de loja+produto, `beforeEach(truncateAll)`). O teste abaixo assume os helpers já presentes; **adapte os nomes** aos que o arquivo já usa (ex.: como obtém `storeToken`, como cria produto e opções). Se o arquivo já cria um produto com árvore de opções em algum teste, reutilize esse setup.

- [ ] **Step 1: Escrever os testes**

Adicionar um `describe('PATCH /store/me/options/:id', ...)`:

```ts
describe('PATCH /store/me/options/:id', () => {
  it('pausa e repreça uma opção sem replace-all (id preservado)', async () => {
    // 1. cria loja + produto + árvore de opções (reusar helper/setup existente do arquivo)
    // 2. pega o catálogo pra descobrir um optionId real:
    const cat = await (await req('/store/me/catalog', {}, storeTok)).json() as any[]
    const opt = cat.flatMap((c) => c.products).flatMap((p: any) => p.groups).flatMap((g: any) => g.options)[0]
    expect(opt).toBeTruthy()

    const pause = await req(`/store/me/options/${opt.id}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: false }) }, storeTok)
    expect(pause.status).toBe(200)

    const price = await req(`/store/me/options/${opt.id}`, { method: 'PATCH', body: JSON.stringify({ priceCents: 777 }) }, storeTok)
    expect(price.status).toBe(200)

    const cat2 = await (await req('/store/me/catalog', {}, storeTok)).json() as any[]
    const opt2 = cat2.flatMap((c) => c.products).flatMap((p: any) => p.groups).flatMap((g: any) => g.options).find((o: any) => o.id === opt.id)
    expect(opt2.id).toBe(opt.id)          // id preservado (sem replace-all)
    expect(opt2.isAvailable).toBe(false)
    expect(opt2.priceCents).toBe(777)
  })

  it('400 corpo vazio, 404 opção de outra loja, 401 sem token', async () => {
    // cria opção da loja A (setup existente) -> optAId
    expect((await req(`/store/me/options/${optAId}`, { method: 'PATCH', body: JSON.stringify({}) }, storeTokA)).status).toBe(400)
    expect((await req(`/store/me/options/${optAId}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: false }) })).status).toBe(401)
    // loja B tenta alterar opção da loja A -> 404 (tenant)
    expect((await req(`/store/me/options/${optAId}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: false }) }, storeTokB)).status).toBe(404)
  })
})

describe('PATCH /store/me/products/:id (preço/pausa ao vivo — já suportado)', () => {
  it('repreça e pausa o produto', async () => {
    // productId da loja (setup existente)
    const p1 = await req(`/store/me/products/${productId}`, { method: 'PATCH', body: JSON.stringify({ basePriceCents: 3199 }) }, storeTok)
    expect(p1.status).toBe(200)
    const p2 = await req(`/store/me/products/${productId}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: false }) }, storeTok)
    expect(p2.status).toBe(200)
    expect((await p2.json()).isAvailable).toBe(false)
  })
})
```

> **Importante:** ajuste `storeTok`, `storeTokA`, `storeTokB`, `productId`, `optAId` aos helpers reais do arquivo. Se o arquivo não tem helper pra criar 2 lojas, crie a segunda loja no próprio teste (via `/admin/stores` com token admin, ou o helper que o arquivo usa pra loja). O objetivo dos casos é: pausar+repreçar com id preservado, tenant 404, vazio 400, sem token 401.

- [ ] **Step 2: Rodar**

Run: `pnpm --filter @delivery/api test store-catalog`
Expected: PASS (todos, incluindo os novos).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/store-catalog.routes.test.ts
git commit -m "test(api): option pause/price granular + product live edit"
```

---

### Task 5: UI do cardápio — preço inline do produto + painel de opções

**Files:**
- Modify: `apps/web/src/views/store/StoreMenuView.vue`

Contexto: a view já lista categorias→produtos, já tem toggle pausar/ativar produto (`toggleProduct`) e já recebe `groups[].options[]` no payload de `/store/me/catalog` (cada option tem `id, name, priceCents, isAvailable`). Falta: (a) editar preço do produto inline; (b) mostrar opções com pausar/repreçar rápido.

- [ ] **Step 1: Tipos + helpers no `<script setup>`**

Atualizar os tipos pra incluir opções e preço editável:

```ts
type Option = { id: string; name: string; priceCents: number | null; isAvailable: boolean }
type Group = { id: string; name: string; type: string; options: Option[] }
type Product = { id: string; name: string; basePriceCents: number; isAvailable: boolean; sortIndex: number; groups?: Group[] }
```

Adicionar helpers (perto de `toggleProduct`):

```ts
// preço em reais na UI -> centavos no PATCH
const saveProductPrice = (p: Product, reaisStr: string) => {
  const reais = Number(reaisStr.replace(',', '.'))
  if (Number.isNaN(reais) || reais < 0) { error.value = 'Preço inválido'; return }
  return run(() => api(`/store/me/products/${p.id}`, { method: 'PATCH', body: JSON.stringify({ basePriceCents: Math.round(reais * 100) }) }))
}
const toggleOption = (o: Option) =>
  run(() => api(`/store/me/options/${o.id}`, { method: 'PATCH', body: JSON.stringify({ isAvailable: !o.isAvailable }) }))
const saveOptionPrice = (o: Option, reaisStr: string) => {
  const reais = Number(reaisStr.replace(',', '.'))
  if (Number.isNaN(reais) || reais < 0) { error.value = 'Preço inválido'; return }
  return run(() => api(`/store/me/options/${o.id}`, { method: 'PATCH', body: JSON.stringify({ priceCents: Math.round(reais * 100) }) }))
}
```

- [ ] **Step 2: Template — preço inline do produto**

Na `<li>` do produto, trocar o preço somente-leitura por um input inline (mantendo o link pro form completo no nome). Substituir o bloco do `RouterLink` do produto por:

```html
<div class="flex flex-1 items-center gap-2">
  <RouterLink :to="`/loja/cardapio/produto/${p.id}`" class="flex-1">{{ p.name }}</RouterLink>
  <span class="text-xs text-gray-500">R$</span>
  <input
    type="number" min="0" step="0.01"
    :value="(p.basePriceCents / 100).toFixed(2)"
    class="w-20 rounded border p-1 text-sm"
    @change="saveProductPrice(p, ($event.target as HTMLInputElement).value)"
  />
</div>
```

- [ ] **Step 3: Template — opções colapsáveis com pausar/repreçar**

Logo abaixo da linha de ações do produto (dentro da `<li>` do produto), adicionar um `<details>` com as opções, quando houver:

```html
<details v-if="p.groups && p.groups.length" class="mt-1 w-full">
  <summary class="cursor-pointer text-xs text-gray-500">Opções ({{ p.groups.reduce((n, g) => n + g.options.length, 0) }})</summary>
  <div v-for="g in p.groups" :key="g.id" class="mt-1 pl-2">
    <p class="text-xs font-semibold text-gray-600">{{ g.name }}</p>
    <ul class="divide-y">
      <li v-for="o in g.options" :key="o.id" class="flex items-center gap-2 py-1 text-sm" :class="!o.isAvailable && 'opacity-50'">
        <span class="flex-1">{{ o.name }}</span>
        <template v-if="o.priceCents !== null">
          <span class="text-xs text-gray-500">R$</span>
          <input
            type="number" min="0" step="0.01"
            :value="(o.priceCents / 100).toFixed(2)"
            class="w-20 rounded border p-1 text-xs"
            @change="saveOptionPrice(o, ($event.target as HTMLInputElement).value)"
          />
        </template>
        <button class="rounded border px-2 py-0.5 text-xs" @click="toggleOption(o)">{{ o.isAvailable ? 'pausar' : 'ativar' }}</button>
      </li>
    </ul>
  </div>
</details>
```

> Nota: para opções com `priceCents === null` (variação/sabor com preço na matriz), não mostra input de preço — só pausar/ativar. Repreçar matriz sabor×variação continua no editor completo do produto (fora do escopo deste plano).

- [ ] **Step 4: Verificar**

Run: `pnpm --filter @delivery/web build && pnpm typecheck`
Expected: sem erros. Teste manual: abrir `/loja/cardapio`, mudar preço de produto e de opção (blur/enter), pausar/ativar opção — reflete após reload automático.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/store/StoreMenuView.vue
git commit -m "feat(web): inline product price + option pause/price in menu editor"
```

---

### Task 6: Docs + gate final

**Files:**
- Modify: `README.md`, `docs/carry-forwards.md`

- [ ] **Step 1: README**

No roadmap do `README.md`, adicionar uma linha marcando a feature (ex.: logo após o item 8, ou onde fizer sentido na numeração vigente):

```
- ✅ Controle da Loja — pausar/repreçar produto e opção ao vivo (sem replace-all), no cardápio da loja
```

- [ ] **Step 2: carry-forwards**

Adicionar linha em `docs/carry-forwards.md`:

```
| Repreço de matriz sabor×variação (FLAVOR×VARIATION) segue só no editor completo do produto (replace-all); pausar/repreçar granular cobre produto + opções de preço simples | Plano Controle da Loja | Se lojas pedirem edição rápida da matriz |
```

- [ ] **Step 3: Gate final**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`
Expected: tudo verde.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/carry-forwards.md
git commit -m "docs: controle da loja wrap-up"
```

---

## Resumo pro executor

- **Backend:** 1 schema (`OptionUpdateSchema`), 1 service (`updateOption` com tenant guard via join), 1 rota (`PATCH /store/me/options/:id`). Produto já era pausável/repreçável — sem mudança de backend nele.
- **Frontend:** `StoreMenuView.vue` ganha preço inline do produto + painel de opções (pausar/repreçar). Produto já tinha toggle pausar.
- **Não fazer:** replace-all pra opção; editar matriz sabor×variação (fica no editor completo); tocar em checkout/snapshot.
- **Invariantes:** tenant 404 cross-store; centavos no storage / R$ na UI; opção `priceCents` nullable.

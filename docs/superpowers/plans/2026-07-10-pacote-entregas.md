# Plano ③ — Pacote de Entregas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loja agrupa vários pedidos seus (1 ponto de coleta, vários destinos) num "pacote de entrega" e oferta ao pool de entregadores; o primeiro entregador disponível aceita o pacote inteiro, faz **1 coleta** e o pacote "quebra" em entregas individuais na lista dele.

**Architecture:** Nova tabela `delivery_batches` + `orders.batchId`. Pacote espelha o dispatch por-pedido existente, mas no nível do lote: aceite com lock atômico no batch (`WHERE driver_id IS NULL`), aceite≠coleta. Coleta do batch só quando TODOS os pedidos estão READY; ao coletar, cada pedido vira `OUT_FOR_DELIVERY` individual e segue o fluxo de entrega/falha já existente **sem alteração** (ledger por pedido intacto — cada pedido mantém seu frete).

**Tech Stack:** Hono + Drizzle (Postgres), Zod, Vue 3 (web loja + app driver), Vitest contra Postgres real.

---

## Decisões travadas (não desviar)

1. **Escopo do pacote:** só pedidos da **mesma loja**, **sem entregador** (`driverId null`), `fulfillment = DELIVERY`, ainda não coletados. Vários destinos, cada pedido com seu frete/pagamento/endereço.
2. **Só broadcast agora.** A loja monta o pacote e oferta ao pool (primeiro disponível leva tudo). "Escolher entregador específico" NÃO entra aqui — fica no Plano ④ (entregadores próprios).
3. **Coleta só quando TODOS os pedidos do pacote estão `READY`.** Botão "Coletei" do pacote bloqueado até lá.
4. **Pacote convive com entregas avulsas.** Aceitar um pacote não impede o entregador de pegar outras entregas avulsas. Pós-coleta, tudo é lista única de entregas individuais.
5. **Mínimo 2 pedidos** por pacote (senão é entrega avulsa normal).

---

## Guardrails (leia antes de codar)

1. **Aceite do batch é atômico:** `UPDATE delivery_batches SET driver_id=... WHERE id=? AND driver_id IS NULL AND status='PENDING'` — se 0 linhas, 409 "pacote já foi pego". Núcleo anti-corrida, nunca sem isso.
2. **Pedidos batchados somem do pool individual:** `listAvailableDeliveries` (dispatch) ganha `isNull(orders.batchId)`. Um pedido só aparece OU no pool individual OU num pacote, nunca nos dois.
3. **Não alterar o fluxo de entrega individual** (`completeDelivery`/`failDelivery`/ledger). Depois da coleta do pacote, os pedidos são entregas normais. Ledger por pedido (frete de cada um) fica intacto.
4. **Tenant:** loja só monta/cancela pacote com pedidos DELA; entregador só coleta pacote que aceitou. Cross-store/cross-driver → 404/409.
5. **Cancelamento de pedido que está em pacote:** ao cancelar (loja/cliente), zerar `batchId` do pedido (sai do pacote). A checagem "todos READY" da coleta ignora pedidos que saíram.
6. Dinheiro em centavos no storage/API; UI em R$ (`formatBRL`). Testes contra Postgres real (padrão `test/helpers/test-db.ts`). TDD por task, commits convencionais, **sem coautor**. Gate final `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

---

### Task 1: Schema — `delivery_batches` + `orders.batchId`

**Files:**
- Create: `apps/api/src/db/schema/batches.ts`
- Modify: `apps/api/src/db/schema/orders.ts`, `apps/api/src/db/schema/index.ts`
- Modify: `packages/shared/src/constants.ts` (ou onde ficam enums de status — seguir onde `ORDER_STATUSES` mora)

- [ ] **Step 1: Constante de status do batch (shared)**

Em `packages/shared/src/dispatch.ts` (mesmo módulo do dispatch; se não existir, criar em `constants.ts`) adicionar:

```ts
export const BATCH_STATUSES = ['OPEN', 'PENDING', 'ACCEPTED', 'COLLECTED', 'CANCELLED'] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  OPEN: 'Montando',
  PENDING: 'Aguardando entregador',
  ACCEPTED: 'Entregador a caminho da coleta',
  COLLECTED: 'Coletado',
  CANCELLED: 'Cancelado',
}
```

Garantir export no barrel `packages/shared/src/index.ts` (se `dispatch.ts` já é reexportado, nada a fazer).

- [ ] **Step 2: Tabela `delivery_batches`**

Criar `apps/api/src/db/schema/batches.ts`:

```ts
import { pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { BATCH_STATUSES } from '@delivery/shared/constants'
import { stores } from './stores'

export const batchStatus = pgEnum('batch_status', BATCH_STATUSES)

export const deliveryBatches = pgTable('delivery_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  /** entregador que aceitou o pacote (null enquanto OPEN/PENDING) */
  driverId: uuid('driver_id'),
  status: batchStatus('status').notNull().default('OPEN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
})
```

- [ ] **Step 3: `orders.batchId`**

Em `apps/api/src/db/schema/orders.ts`, adicionar a coluna dentro de `pgTable('orders', {...})` (perto de `driverId`):

```ts
    /** Plano ③: pacote de entregas (null = pedido avulso) */
    batchId: uuid('batch_id'),
```

> Não usar `.references()` inline pra evitar ciclo de import orders↔batches. A integridade é garantida no service. (Se preferir FK, declare via `index`/migration manual; o projeto já tem `driverId` sem FK — seguir esse mesmo padrão.)

- [ ] **Step 4: Barrel**

Em `apps/api/src/db/schema/index.ts`, adicionar `export * from './batches'`.

- [ ] **Step 5: Migration**

Run: `pnpm --filter @delivery/api db:generate` (confirmar o nome exato do script em `apps/api/package.json`; nos planos anteriores foi esse) e depois `pnpm --filter @delivery/api db:migrate` (ou o script equivalente usado no projeto).
Expected: migration criada com a tabela + coluna.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema packages/shared/src
git commit -m "feat(batch): delivery_batches table and orders.batchId"
```

---

### Task 2: Service do pacote — lado da loja

**Files:**
- Create: `apps/api/src/services/batch.service.ts`
- Test: `apps/api/test/batch.service.test.ts`

- [ ] **Step 1: Testes falhando**

Criar `apps/api/test/batch.service.test.ts` seguindo o padrão de `apps/api/test/*.service.test.ts` (mock de `createDb`→`testDb`, `beforeEach(truncateAll)`). Casos:

```ts
// setup: criar loja, 3 pedidos DELIVERY da loja sem driver (ACCEPTED), 1 pedido de OUTRA loja
describe('createBatch', () => {
  it('cria pacote OPEN com >=2 pedidos da loja e seta batchId', async () => { /* ... */ })
  it('rejeita <2 pedidos (400)', async () => { /* ... */ })
  it('rejeita pedido de outra loja (404/400)', async () => { /* ... */ })
  it('rejeita pedido que já tem driver ou já está em outro pacote (409)', async () => { /* ... */ })
})
describe('broadcastBatch', () => {
  it('OPEN -> PENDING e marca driverRequestedAt nos pedidos', async () => { /* ... */ })
})
describe('cancelBatch', () => {
  it('OPEN/PENDING -> CANCELLED e limpa batchId + driverRequestedAt dos pedidos', async () => { /* ... */ })
})
```

- [ ] **Step 2: Implementar `batch.service.ts`**

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { deliveryBatches, orders } from '../db/schema'
import { addEvent } from './order-status.service'

export class BatchError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400) {
    super(message)
  }
}

// pedidos elegíveis a pacote: mesma loja, sem driver, sem pacote, DELIVERY, não terminais
const BATCHABLE_STATUSES = ['ACCEPTED', 'PREPARING', 'READY'] as const

export async function createBatch(db: Db, storeId: string, orderIds: string[]) {
  const ids = [...new Set(orderIds)]
  if (ids.length < 2) throw new BatchError('Selecione ao menos 2 pedidos', 400)

  return db.transaction(async (tx) => {
    const rows = await tx.select().from(orders).where(inArray(orders.id, ids))
    if (rows.length !== ids.length) throw new BatchError('Pedido não encontrado', 404)
    for (const o of rows) {
      if (o.storeId !== storeId) throw new BatchError('Pedido de outra loja', 404)
      if (o.fulfillment !== 'DELIVERY') throw new BatchError('Só pedidos com entrega', 400)
      if (o.driverId) throw new BatchError('Pedido já tem entregador', 409)
      if (o.batchId) throw new BatchError('Pedido já está em um pacote', 409)
      if (!(BATCHABLE_STATUSES as readonly string[]).includes(o.status))
        throw new BatchError(`Pedido não pode ser agrupado (${o.status})`, 409)
    }
    const [batch] = await tx.insert(deliveryBatches).values({ storeId, status: 'OPEN' }).returning()
    await tx.update(orders).set({ batchId: batch!.id }).where(inArray(orders.id, ids))
    return batch!
  })
}

export async function broadcastBatch(db: Db, storeId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.storeId, storeId)))
    if (!batch) throw new BatchError('Pacote não encontrado', 404)
    if (batch.status !== 'OPEN') throw new BatchError('Pacote não está montando', 409)
    const batchOrders = await tx.select({ id: orders.id }).from(orders).where(eq(orders.batchId, batchId))
    if (batchOrders.length < 2) throw new BatchError('Pacote precisa de ao menos 2 pedidos', 400)
    await tx.update(deliveryBatches).set({ status: 'PENDING' }).where(eq(deliveryBatches.id, batchId))
    // entra no "radar" de dispatch (mas some do pool individual por causa do batchId — ver Task 5)
    await tx.update(orders).set({ driverRequestedAt: new Date() }).where(eq(orders.batchId, batchId))
    return { ...batch, status: 'PENDING' as const }
  })
}

export async function cancelBatch(db: Db, storeId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.storeId, storeId)))
    if (!batch) throw new BatchError('Pacote não encontrado', 404)
    if (batch.status !== 'OPEN' && batch.status !== 'PENDING')
      throw new BatchError('Pacote não pode ser cancelado agora', 409)
    await tx.update(orders).set({ batchId: null, driverRequestedAt: null }).where(eq(orders.batchId, batchId))
    await tx.update(deliveryBatches).set({ status: 'CANCELLED' }).where(eq(deliveryBatches.id, batchId))
    return { ...batch, status: 'CANCELLED' as const }
  })
}

/** Pacotes da loja com contagem/soma de frete (pra painel). */
export async function listStoreBatches(db: Db, storeId: string) {
  const batches = await db.select().from(deliveryBatches)
    .where(and(eq(deliveryBatches.storeId, storeId), inArray(deliveryBatches.status, ['OPEN', 'PENDING', 'ACCEPTED'])))
  const out = []
  for (const b of batches) {
    const os = await db.select({ id: orders.id, status: orders.status, deliveryFeeCents: orders.deliveryFeeCents, addressText: orders.addressText })
      .from(orders).where(eq(orders.batchId, b.id))
    out.push({ ...b, orders: os, feeTotalCents: os.reduce((s, o) => s + (o.deliveryFeeCents ?? 0), 0) })
  }
  return out
}
```

- [ ] **Step 3: Rodar testes**

Run: `pnpm --filter @delivery/api test batch.service`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/batch.service.ts apps/api/test/batch.service.test.ts
git commit -m "feat(batch): store-side batch build/broadcast/cancel service"
```

---

### Task 3: Service do pacote — lado do entregador

**Files:**
- Modify: `apps/api/src/services/batch.service.ts`
- Modify: `apps/api/src/services/dispatch.service.ts` (excluir batchados do pool individual)
- Test: `apps/api/test/batch.service.test.ts`

- [ ] **Step 1: Testes falhando** (adicionar)

```ts
describe('acceptBatch (corrida)', () => {
  it('primeiro driver leva o pacote inteiro; segundo recebe 409', async () => { /* 2 aceites concorrentes via Promise.allSettled */ })
  it('seta driverId no batch E em todos os pedidos', async () => { /* ... */ })
})
describe('collectBatch', () => {
  it('bloqueia se algum pedido não está READY (409)', async () => { /* ... */ })
  it('com todos READY: pedidos viram OUT_FOR_DELIVERY, batch COLLECTED', async () => { /* ... */ })
})
describe('pool individual', () => {
  it('pedido em pacote NÃO aparece em listAvailableDeliveries', async () => { /* ... */ })
})
```

- [ ] **Step 2: Implementar (adicionar ao `batch.service.ts`)**

```ts
import { ensureDriverProfile } from './dispatch.service'
// (adicionar ao topo; ensureDriverProfile já existe e é exportado)

export async function listAvailableBatches(db: Db, driverUserId: string) {
  const profile = await ensureDriverProfile(db, driverUserId)
  if (!profile.isAvailable) return []
  const batches = await db.select().from(deliveryBatches).where(eq(deliveryBatches.status, 'PENDING'))
  const out = []
  for (const b of batches) {
    const os = await db.select({ id: orders.id, deliveryFeeCents: orders.deliveryFeeCents, addressText: orders.addressText })
      .from(orders).where(eq(orders.batchId, b.id))
    out.push({ batchId: b.id, storeId: b.storeId, count: os.length, feeTotalCents: os.reduce((s, o) => s + (o.deliveryFeeCents ?? 0), 0) })
  }
  return out
}

export async function acceptBatch(db: Db, driverUserId: string, batchId: string) {
  await ensureDriverProfile(db, driverUserId)
  return db.transaction(async (tx) => {
    const claimed = await tx.update(deliveryBatches)
      .set({ driverId: driverUserId, status: 'ACCEPTED' })
      .where(and(eq(deliveryBatches.id, batchId), isNull(deliveryBatches.driverId), eq(deliveryBatches.status, 'PENDING')))
      .returning()
    if (claimed.length === 0) throw new BatchError('Pacote já foi pego ou não está disponível', 409)
    // assinala o entregador em todos os pedidos do pacote (aceite ≠ coleta: status não muda)
    await tx.update(orders).set({ driverId: driverUserId, driverAssignedAt: new Date() }).where(eq(orders.batchId, batchId))
    return claimed[0]!
  })
}

export async function releaseBatch(db: Db, driverUserId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.driverId, driverUserId), eq(deliveryBatches.status, 'ACCEPTED')))
    if (!batch) throw new BatchError('Pacote não pode ser liberado', 409)
    await tx.update(orders).set({ driverId: null, driverAssignedAt: null }).where(eq(orders.batchId, batchId))
    await tx.update(deliveryBatches).set({ driverId: null, status: 'PENDING' }).where(eq(deliveryBatches.id, batchId))
    return { ...batch, status: 'PENDING' as const }
  })
}

export async function collectBatch(db: Db, driverUserId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.driverId, driverUserId), eq(deliveryBatches.status, 'ACCEPTED')))
    if (!batch) throw new BatchError('Pacote não encontrado', 404)
    const os = await tx.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.batchId, batchId))
    const active = os.filter((o) => o.status !== 'CANCELLED')
    if (active.length === 0) throw new BatchError('Pacote sem pedidos ativos', 409)
    if (!active.every((o) => o.status === 'READY'))
      throw new BatchError('Aguarde todos os pedidos ficarem prontos', 409)
    for (const o of active) {
      await tx.update(orders).set({ status: 'OUT_FOR_DELIVERY' }).where(eq(orders.id, o.id))
      await addEvent(tx as unknown as Db, o.id, 'OUT_FOR_DELIVERY', 'DRIVER', driverUserId, 'coletado (pacote)')
    }
    await tx.update(deliveryBatches).set({ status: 'COLLECTED' }).where(eq(deliveryBatches.id, batchId))
    return { ...batch, status: 'COLLECTED' as const, collected: active.length }
  })
}
```

> Se `addEvent` não aceitar o handle de transação, chamar `addEvent(db, ...)` fora do `tx` após o commit, ou ajustar a assinatura. Conferir a assinatura real de `addEvent` em `order-status.service.ts` e seguir o que já é feito lá (ex.: `completeDelivery` chama `addEvent(db, ...)`).

- [ ] **Step 3: Excluir batchados do pool individual**

Em `apps/api/src/services/dispatch.service.ts`, na query de `listAvailableDeliveries`, adicionar ao `and(...)`:

```ts
      isNull(orders.batchId),
```

- [ ] **Step 4: Rodar**

Run: `pnpm --filter @delivery/api test batch.service dispatch`
Expected: PASS (incluindo corrida de aceite exatamente-um-vence).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/batch.service.ts apps/api/src/services/dispatch.service.ts apps/api/test/batch.service.test.ts
git commit -m "feat(batch): driver-side accept(atomic)/release/collect + exclude batched from individual pool"
```

---

### Task 4: Cancelamento tira o pedido do pacote

**Files:**
- Modify: `apps/api/src/services/order-status.service.ts` (e onde houver cancelamento: `customerCancelOrder`, `storeResolveCancelRequest`, `cancelStalePendingOrders`)
- Test: teste existente de cancelamento + novo caso

- [ ] **Step 1: Ao cancelar, zerar `batchId`**

Em cada caminho que seta `status: 'CANCELLED'` num pedido (grep por `'CANCELLED'` em `order-status.service.ts`), adicionar `batchId: null` no mesmo `.set({...})`. Ex.:

```ts
.set({ status: 'CANCELLED', batchId: null, /* ...campos existentes... */ })
```

- [ ] **Step 2: Teste**

Adicionar caso: pedido em pacote OPEN, cliente cancela → `batchId` fica null; `collectBatch` do restante (se ≥1 READY) funciona ignorando o cancelado.

- [ ] **Step 3: Rodar + commit**

Run: `pnpm --filter @delivery/api test`
```bash
git add apps/api/src/services/order-status.service.ts apps/api/test
git commit -m "fix(batch): cancelled order leaves its batch"
```

---

### Task 5: Rotas (loja + entregador)

**Files:**
- Modify: `apps/api/src/routes/store-orders.ts` (rotas da loja) e `apps/api/src/routes/driver.ts` (rotas do entregador)
- Modify: `apps/api/src/app.ts` se precisar (provavelmente não — rotas entram nos routers existentes)
- Test: `apps/api/test/batch.routes.test.ts`

- [ ] **Step 1: Rotas da loja** (em `store-orders.ts`, seguindo o padrão `ownStoreId(c)` + `createRouter`/`.openapi` já usados no arquivo):

```
POST   /store/me/batches            body { orderIds: string[] }   -> createBatch
POST   /store/me/batches/{id}/broadcast                            -> broadcastBatch
DELETE /store/me/batches/{id}                                      -> cancelBatch
GET    /store/me/batches                                           -> listStoreBatches
```

Schema do body: `z.object({ orderIds: z.array(z.uuid()).min(2).max(30) })`. Mapear `BatchError` no `rethrow` do arquivo (adicionar `if (e instanceof BatchError) throw new HTTPException(e.status, { message: e.message })`).

- [ ] **Step 2: Rotas do entregador** (em `driver.ts`, mesmo padrão das rotas `/driver/orders/{id}/...`):

```
GET  /driver/batches                       -> listAvailableBatches
POST /driver/batches/{id}/accept           -> acceptBatch
POST /driver/batches/{id}/release          -> releaseBatch
POST /driver/batches/{id}/collect          -> collectBatch
```

- [ ] **Step 3: Testes de rota** (`batch.routes.test.ts`) — seguir helpers de `store-orders.routes.test.ts` e `driver`? (usar o token de loja e de driver como nos testes existentes). Casos mínimos:
  - loja cria pacote (201/200), broadcast (200), aparece em `GET /driver/batches` só se driver disponível
  - driver aceita (200), segundo driver 409
  - collect bloqueado se nem todos READY (409); com todos READY 200 e pedidos viram OUT_FOR_DELIVERY (checar via `GET /driver/deliveries?scope=active`)
  - tenant: loja B não cancela pacote da loja A (404); driver não aceita sem estar disponível
  - requireRole: customer 403 nas rotas de loja e driver

- [ ] **Step 4: Rodar + commit**

Run: `pnpm --filter @delivery/api test batch`
```bash
git add apps/api/src/routes apps/api/test/batch.routes.test.ts
git commit -m "feat(api): batch routes for store and driver"
```

---

### Task 6: UI da loja — montar e ofertar pacote

**Files:**
- Modify: `apps/web/src/views/store/StoreOrdersView.vue`

Contexto: a view já lista pedidos agrupados por status com polling 1s. Adicionar seleção múltipla + painel de pacotes. Utilitário (Tailwind cru).

- [ ] **Step 1: Estado + ações** no `<script setup>`:

```ts
const selected = ref<Set<string>>(new Set())
const batches = ref<any[]>([])
function toggleSelect(id: string) { selected.value.has(id) ? selected.value.delete(id) : selected.value.add(id); selected.value = new Set(selected.value) }
async function loadBatches() { batches.value = await api('/store/me/batches') }
const createBatch = () => run(async () => { await api('/store/me/batches', { method: 'POST', body: JSON.stringify({ orderIds: [...selected.value] }) }); selected.value = new Set(); await loadBatches() })
const broadcastBatch = (id: string) => run(async () => { await api(`/store/me/batches/${id}/broadcast`, { method: 'POST' }); await loadBatches() })
const cancelBatch = (id: string) => run(async () => { await api(`/store/me/batches/${id}`, { method: 'DELETE' }); await loadBatches() })
```
Chamar `loadBatches()` no `onMounted` e no tick do polling existente.

- [ ] **Step 2: Template**
  - Em cada pedido **elegível** (fulfillment DELIVERY, sem driver, status ACCEPTED/PREPARING/READY, sem batchId), um checkbox `@change="toggleSelect(o.id)"`.
  - Botão "Criar pacote (N)" habilitado quando `selected.size >= 2`.
  - Seção "Pacotes": para cada batch, listar `count` pedidos, `feeTotalCents` (via `formatBRL`), `BATCH_STATUS_LABELS[status]`, botão "Enviar pra entregadores" (se OPEN) e "Cancelar" (se OPEN/PENDING).

- [ ] **Step 3: Build + commit**

Run: `pnpm --filter @delivery/web build && pnpm typecheck`
```bash
git add apps/web/src/views/store/StoreOrdersView.vue
git commit -m "feat(web): store builds and broadcasts delivery batches"
```

---

### Task 7: UI do entregador — pacote no pool e coleta única

**Files:**
- Modify: `apps/driver/src/views/AvailableView.vue`, `apps/driver/src/views/DeliveriesView.vue`

- [ ] **Step 1: AvailableView — seção de pacotes**

Buscar `GET /driver/batches` junto do `load()` (mesmo polling 1s). Renderizar cards de pacote: "📦 Pacote — {{ count }} entregas · frete total {{ formatBRL(feeTotalCents) }}", botão "Aceitar pacote" → `POST /driver/batches/{id}/accept` → recarrega e navega pra `/entregas`.

- [ ] **Step 2: DeliveriesView — pacote aceito, pré-coleta**

Incluir no payload de `/driver/deliveries?scope=active` a info de batch por pedido (adicionar `batchId` ao `select` de `listDriverDeliveries` no dispatch.service — a coluna já existe). Buscar também `GET /driver/batches`? Melhor: adicionar endpoint `GET /driver/batches/mine` (status ACCEPTED, driver dono) OU derivar do agrupamento por `batchId` nas entregas ativas. **Escolha simples:** agrupar as entregas ativas por `batchId`; pedidos com o mesmo `batchId` e batch ainda não coletado aparecem como **um card "Pacote (N) — coletar tudo"** com um único botão "Coletei tudo" (`POST /driver/batches/{id}/collect`), habilitado só quando todos os N estão READY (a UI já recebe o status de cada um). Erro 409 "aguarde todos prontos" é exibido.
  - Após a coleta, os pedidos ficam OUT_FOR_DELIVERY e caem na lista individual de "Entregar" já existente (nenhuma mudança nesse bloco).
  - Pedidos avulsos (batchId null) seguem exibidos como hoje.

> Para saber se o pacote já foi coletado a partir das entregas: se todos os pedidos do `batchId` estão OUT_FOR_DELIVERY, tratar como individuais (não mostrar card de coleta de pacote). Enquanto houver pedido do batch em status < OUT_FOR_DELIVERY, mostrar o card de coleta única.

- [ ] **Step 3: Build + commit**

Run: `pnpm --filter @delivery/driver build && pnpm typecheck`
```bash
git add apps/driver/src/views
git commit -m "feat(driver): batch in pool + single pickup that splits into deliveries"
```

---

### Task 8: Docs + gate final

**Files:** `README.md`, `docs/carry-forwards.md`

- [ ] **Step 1: README** — adicionar linha do Pacote de Entregas (perto do item Controle da Loja):

```
- ✅ Pacote de Entregas — loja agrupa pedidos (1 coleta, vários destinos) e oferta ao pool; entregador coleta 1x e quebra em entregas individuais
```

- [ ] **Step 2: carry-forwards** — registrar o que ficou de fora:

```
| Pacote: só broadcast (sem escolher entregador específico) — específico depende do Plano ④ (entregadores próprios) | Plano ③ | Plano ④ |
| Pacote: coleta exige TODOS os pedidos READY (sem coleta parcial) | Plano ③ | Se lojas pedirem coleta parcial |
| orders.batchId sem FK declarada (integridade no service, segue padrão de driverId) | Plano ③ | Hardening/deploy |
```

- [ ] **Step 3: Gate final**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`
Expected: tudo verde.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/carry-forwards.md
git commit -m "docs: pacote de entregas wrap-up"
```

---

## Resumo pro executor

- **Modelo:** `delivery_batches` (OPEN→PENDING→ACCEPTED→COLLECTED/CANCELLED) + `orders.batchId`.
- **Loja:** monta pacote (≥2 pedidos, mesma loja, sem driver) → broadcast → pool. Cancela enquanto OPEN/PENDING.
- **Entregador:** vê pacote no pool → aceita (lock atômico no batch) → 1 coleta quando **todos READY** → pacote quebra em entregas individuais (fluxo existente, ledger por pedido intacto).
- **Invariantes:** aceite atômico; pedido batchado some do pool individual; cancelar pedido tira do pacote; tenant 404; pacote convive com avulsas.
- **Fora de escopo (carry-forward):** escolher entregador específico (④), coleta parcial.

# Plano ④a — Entregadores Próprios (vínculo + turnos + financeiro) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loja cadastra/convida entregadores próprios (que confirmam no app), o entregador **inicia um turno** (no raio da loja) para ficar exclusivo daquela loja, e recebe **diária + extra por entrega** — pago pela plataforma, custeado pela loja no ledger. Enquanto em turno, recebe os pedidos que a loja mandar "aos meus entregadores".

**Architecture:** Duas tabelas novas (`store_drivers` = vínculo; `driver_shifts` = turno com valores congelados) + `orders.shiftId`. O turno controla exclusividade e financeiro. No `recordOrderLedger`, pedido com `shiftId` é tratado como **entrega própria da loja** (loja fica com o frete) e o entregador recebe **extra por entrega**; a **diária** entra no ledger no encerramento do turno. Dispatch direcionado fino (específico, sem-fallback) fica no ④b — aqui o alcance é broadcast aos próprios em turno ativo.

**Tech Stack:** Hono + Drizzle (Postgres), Zod, Vue 3 (web loja + app driver), Vitest contra Postgres real. `haversineKm` de `@delivery/shared/constants` para o raio.

---

## Decisões travadas (não desviar)

1. **Vínculo:** loja convida um entregador que **já tem conta ativa** (busca por telefone). Loja define agenda (referência), **diária** e **extra por entrega** como termos-padrão. Entregador **confirma** no app. Status: `INVITED` → `CONFIRMED` → `REMOVED`.
2. **Valores por turno (snapshot):** cada `driver_shift` congela `dailyRateCents` e `perDeliveryCents` no início. Mudar os termos do vínculo depois NÃO altera turnos passados.
3. **Início do turno:** entregador precisa estar **no raio da loja** (`haversineKm(store, gps) <= SHIFT_START_RADIUS_KM`, default 0.5). Manda lat/lng do device (browser). Anti-fraude GPS (mock/root) é **Plano 9** — aqui a localização é "confiável-pendente" (aceita o que o cliente enviar).
4. **Exclusividade:** turno ativo é de UMA loja. Enquanto ativo, o entregador só recebe pedidos daquela loja (não do pool geral). 1 turno ativo por vez por entregador; 1 turno por (driver, loja, dia).
5. **Encerramento:** entregador encerra o turno (NÃO precisa estar no raio — pode fazer a última entrega e ir). A loja também pode **liberar** o entregador antes (fecha a loja cedo) — **valores não mudam** (diária cheia). Se encerrar **antes do fim combinado** (`scheduledEndAt`), marcar `earlyClose = true` → alerta pra loja confirmar/reportar (registro; não muda pagamento).
6. **Diária garantida** mesmo com 0 entregas. Creditada no **encerramento** do turno (evita creditar turno aberto/abandonado); valor é o congelado no início.
7. **Financeiro (pedido de driver em turno = `order.shiftId` setado):**
   - **Loja fica com o frete** (lógica de entrega própria): online → `STORE_SALE_CREDIT = subtotal − comissão + frete`; cash → só `STORE_COMMISSION_DEBIT = −comissão`.
   - Driver **não** recebe `DRIVER_DELIVERY_CREDIT` (frete do pedido). Recebe `DRIVER_PER_DELIVERY_CREDIT = +extra` por entrega concluída; loja debitada `STORE_PER_DELIVERY_DEBIT = −extra`.
   - No encerramento do turno: `DRIVER_DAILY_RATE_CREDIT = +diária`; loja `STORE_DAILY_RATE_DEBIT = −diária`.
   - Plataforma nunca fica com frete nem diária — só comissão. Loja assume o P&L (frete cobrado − custo do entregador).
8. **Dispatch (nesta fase):** a loja manda o pedido "aos meus entregadores" → broadcast aos próprios com turno ativo naquela loja; o primeiro aceita (lock atômico, aceite≠coleta), setando `order.shiftId`. Escolher específico / não-cair-no-pool-sem-confirmação = **④b**.

---

## Guardrails

1. **Idempotência do ledger** por `uniqueKey` (padrão existente em `finance.service.ts`) — inclui os novos lançamentos (diária: `shift-<id>-daily`; extra: `<orderId>-per-delivery`).
2. **Aceite de pedido por driver em turno é atômico** (`WHERE driver_id IS NULL`), igual ao dispatch atual.
3. **Exclusividade no servidor:** driver com turno ativo NÃO aparece no pool geral (`listAvailableDeliveries`); um pedido do pool geral não é ofertado a quem está em turno.
4. **Tenant:** loja só gerencia vínculos/turnos/pedidos DELA; driver só encerra o próprio turno. Cross → 404/409.
5. **Não quebrar o fluxo freelance atual** — pedido sem `shiftId` mantém o comportamento e ledger existentes (auditados no Plano 8).
6. Dinheiro em centavos; UI em R$ (`formatBRL`). Testes contra Postgres real. TDD por task. **Sem coautor** (hook `.githooks/commit-msg` já garante). Gate final `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

---

### Task 1: Schema + constantes

**Files:**
- Create: `apps/api/src/db/schema/store-drivers.ts`
- Modify: `apps/api/src/db/schema/orders.ts`, `apps/api/src/db/schema/index.ts`
- Modify: `packages/shared/src/finance.ts` (novos LEDGER_ENTRY_TYPES + labels), `packages/shared/src/dispatch.ts` (constantes de vínculo/turno + `SHIFT_START_RADIUS_KM`)
- Test: `packages/shared/src/finance.test.ts` (só confirmar que os novos labels existem)

- [ ] **Step 1: Ledger types (shared)** — em `packages/shared/src/finance.ts`, adicionar ao array `LEDGER_ENTRY_TYPES` e ao `LEDGER_ENTRY_LABELS`:

```ts
// adicionar aos existentes:
  'STORE_PER_DELIVERY_DEBIT',
  'STORE_DAILY_RATE_DEBIT',
  'DRIVER_PER_DELIVERY_CREDIT',
  'DRIVER_DAILY_RATE_CREDIT',
```
```ts
  STORE_PER_DELIVERY_DEBIT: 'Extra por entrega (entregador fixo)',
  STORE_DAILY_RATE_DEBIT: 'Diária do entregador',
  DRIVER_PER_DELIVERY_CREDIT: 'Extra por entrega',
  DRIVER_DAILY_RATE_CREDIT: 'Diária do turno',
```

- [ ] **Step 2: Constantes de vínculo/turno (shared)** — em `packages/shared/src/dispatch.ts`:

```ts
export const STORE_DRIVER_STATUSES = ['INVITED', 'CONFIRMED', 'REMOVED'] as const
export type StoreDriverStatus = (typeof STORE_DRIVER_STATUSES)[number]
export const SHIFT_STATUSES = ['ACTIVE', 'CLOSED'] as const
export type ShiftStatus = (typeof SHIFT_STATUSES)[number]
/** raio (km) em que o entregador pode iniciar turno na loja */
export const SHIFT_START_RADIUS_KM = 0.5
```

- [ ] **Step 3: Tabelas** — criar `apps/api/src/db/schema/store-drivers.ts`:

```ts
import { boolean, integer, jsonb, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { STORE_DRIVER_STATUSES, SHIFT_STATUSES } from '@delivery/shared/constants'
import { stores } from './stores'
import { users } from './users'

export const storeDriverStatus = pgEnum('store_driver_status', STORE_DRIVER_STATUSES)
export const shiftStatus = pgEnum('shift_status', SHIFT_STATUSES)

/** Vínculo loja↔entregador próprio (termos-padrão; valores reais congelam no turno) */
export const storeDrivers = pgTable('store_drivers', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  driverUserId: uuid('driver_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: storeDriverStatus('status').notNull().default('INVITED'),
  /** termos-padrão sugeridos */
  dailyRateCents: integer('daily_rate_cents').notNull().default(0),
  perDeliveryCents: integer('per_delivery_cents').notNull().default(0),
  /** agenda informativa [{dow,start,end}] — não trava início (MVP) */
  schedule: jsonb('schedule').$type<{ dow: number; start: string; end: string }[]>().notNull().default([] as never),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('store_drivers_unique').on(t.storeId, t.driverUserId)])

/** Turno de trabalho: valores congelados, controla exclusividade + financeiro */
export const driverShifts = pgTable('driver_shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  driverUserId: uuid('driver_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: shiftStatus('status').notNull().default('ACTIVE'),
  dailyRateCents: integer('daily_rate_cents').notNull(),
  perDeliveryCents: integer('per_delivery_cents').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  earlyClose: boolean('early_close').notNull().default(false),
  closedBy: storeDriverStatus('closed_by'), // reaproveita enum? NÃO — ver nota
})
```
> **Nota:** `closedBy` deve ser um enum próprio `['DRIVER','STORE','SYSTEM']`. Criar `pgEnum('shift_closed_by', ['DRIVER','STORE','SYSTEM'])` e usar. Ajustar o import. (Não reaproveitar `storeDriverStatus`.)

- [ ] **Step 4: `orders.shiftId`** — em `orders.ts`, dentro do `pgTable`:

```ts
    /** Plano ④a: turno do entregador fixo (null = freelance/pool) */
    shiftId: uuid('shift_id'),
```
(sem FK inline, padrão do `driverId`/`batchId`.)

- [ ] **Step 5: Barrel + migration**

`index.ts`: `export * from './store-drivers'`. Depois `pnpm --filter @delivery/api db:generate && pnpm --filter @delivery/api db:migrate`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema packages/shared/src
git commit -m "feat(own-drivers): store_drivers + driver_shifts tables, orders.shiftId, ledger types"
```

---

### Task 2: Service de vínculo (loja + confirmação do driver)

**Files:** Create `apps/api/src/services/store-driver.service.ts`; Test `apps/api/test/store-driver.service.test.ts`

- [ ] **Step 1: Testes falhando** — casos:
  - `inviteDriver(storeId, phone, terms)`: cria vínculo INVITED; telefone inexistente → 404; usuário sem role DRIVER → 400; duplicado → 409.
  - `confirmLink(driverUserId, linkId)`: INVITED→CONFIRMED; só o próprio driver; 404 se não é dele.
  - `removeLink(storeId, linkId)`: → REMOVED.
  - `listStoreDrivers(storeId)` / `listDriverLinks(driverUserId)`.

- [ ] **Step 2: Implementar** (usar `users` para achar por telefone; validar `role==='DRIVER'`; `ensureDriverProfile` opcional). Erros via `class StoreDriverError { status }`. Seguir padrões de service do projeto. Termos (`dailyRateCents`, `perDeliveryCents`, `schedule`) vêm no invite e podem ser atualizados por um `updateLinkTerms(storeId, linkId, terms)`.

- [ ] **Step 3: rodar + commit** — `git commit -m "feat(own-drivers): store-driver link service (invite/confirm/remove/terms)"`

---

### Task 3: Service de turno (início no raio, encerrar, liberar)

**Files:** Create `apps/api/src/services/shift.service.ts`; Test `apps/api/test/shift.service.test.ts`

- [ ] **Step 1: Testes falhando** — casos:
  - `startShift(driverUserId, storeId, gps)`: exige vínculo CONFIRMED; exige `haversineKm(store, gps) <= SHIFT_START_RADIUS_KM` senão 409 "fora do raio da loja"; congela `dailyRateCents`/`perDeliveryCents` do vínculo; recusa 2º turno ativo (409) e 2º turno no mesmo dia/loja (409). Retorna shift ACTIVE.
  - `endShift(driverUserId, shiftId)`: ACTIVE→CLOSED, `endedAt=now`, `earlyClose = scheduledEndAt ? now < scheduledEndAt : false`, `closedBy='DRIVER'`; **lança diária no ledger** (ver Task 4). Sem checar raio.
  - `releaseShift(storeId, shiftId)`: loja libera; mesma coisa, `closedBy='STORE'`, `earlyClose` conforme horário; diária cheia.
  - `getActiveShift(driverUserId)`.

- [ ] **Step 2: Implementar** — `haversineKm` de `@delivery/shared/constants`. Guardas atômicas (`WHERE status='ACTIVE'` no update de encerramento). Diária: chamar `recordShiftDaily(db, shift)` (Task 4) dentro/depois da tx (idempotente).

- [ ] **Step 3: rodar + commit** — `git commit -m "feat(own-drivers): shift lifecycle (start-in-radius/end/release)"`

---

### Task 4: Financeiro — extra por entrega + diária + frete fica com a loja

**Files:** Modify `apps/api/src/services/finance.service.ts`; Test `apps/api/test/finance.service.test.ts`

- [ ] **Step 1: Testes falhando** — cobrir:
  - Pedido DELIVERED **com `shiftId`** (online): loja `STORE_SALE_CREDIT = subtotal − comissão + frete` (loja fica com frete); driver `DRIVER_PER_DELIVERY_CREDIT = +extra`; loja `STORE_PER_DELIVERY_DEBIT = −extra`; **nenhum** `DRIVER_DELIVERY_CREDIT`.
  - Pedido DELIVERED com `shiftId` (cash): loja só `STORE_COMMISSION_DEBIT`; driver `+extra`; loja `−extra`.
  - Encerrar turno com 2 entregas: `DRIVER_DAILY_RATE_CREDIT +diária`, `STORE_DAILY_RATE_DEBIT −diária` (uma vez, idempotente); extras já lançados por pedido.
  - Pedido SEM `shiftId` (freelance): comportamento atual inalterado (teste de regressão).

- [ ] **Step 2: Implementar** — em `recordOrderLedger`, no topo carregar `perDeliveryCents` do turno se `order.shiftId`:

```ts
  const shift = order.shiftId
    ? (await db.select().from(driverShifts).where(eq(driverShifts.id, order.shiftId)).limit(1))[0]
    : null
```
Ramo DELIVERED:
- Se `shift` (entregador fixo): tratar frete como entrega própria (loja fica com o frete) → **use `order.driverId ? shift : self` NÃO**; regra: com shift, o `deliveryFee` vai pra loja como se fosse self-delivery. Ou seja, calcular `storeCredit`/débitos como se `order.driverId` fosse null PARA FINS DE FRETE:
  - online: `STORE_SALE_CREDIT = subtotal − comissão + deliveryFee`
  - cash: `STORE_COMMISSION_DEBIT = −comissão` (loja fica com o frete em caixa)
  - **não** emitir `DRIVER_DELIVERY_CREDIT` nem `STORE_DRIVER_FEE_DEBIT`.
  - emitir `DRIVER_PER_DELIVERY_CREDIT = +shift.perDeliveryCents` (party DRIVER, driverId=order.driverId, uniqueKey `${order.id}:driver-per-delivery`) e `STORE_PER_DELIVERY_DEBIT = −shift.perDeliveryCents` (party STORE, uniqueKey `${order.id}:store-per-delivery`) — só se `perDeliveryCents > 0`.
- Se **não** shift: manter exatamente a lógica atual (freelance).

Nova função `recordShiftDaily(db, shift)` (chamada no encerramento):
```ts
export async function recordShiftDaily(db: Db, shift: { id: string; storeId: string; driverUserId: string; dailyRateCents: number }) {
  if (shift.dailyRateCents <= 0) return
  await db.insert(ledgerEntries).values({
    party: 'DRIVER', type: 'DRIVER_DAILY_RATE_CREDIT', amountCents: shift.dailyRateCents,
    description: 'Diária do turno', uniqueKey: `${shift.id}:driver-daily`,
    orderId: null as unknown as string, // ver nota
    driverId: shift.driverUserId,
  }).onConflictDoNothing()
  await db.insert(ledgerEntries).values({
    party: 'STORE', type: 'STORE_DAILY_RATE_DEBIT', amountCents: -shift.dailyRateCents,
    description: 'Diária do entregador', uniqueKey: `${shift.id}:store-daily`,
    orderId: null as unknown as string, storeId: shift.storeId,
  }).onConflictDoNothing()
}
```
> **Nota importante — `ledger_entries.orderId` é NOT NULL hoje.** A diária não tem pedido. **Alterar o schema** para `orderId` **nullable** (migration) e ajustar. Fazer isso nesta task (é o único lançamento sem pedido). Conferir `apps/api/src/db/schema/finance.ts` linha do `orderId`.

- [ ] **Step 3: rodar + commit** — `git commit -m "feat(own-drivers): ledger — per-delivery extra, shift daily rate, store keeps fee"`

---

### Task 5: Dispatch — pedido "aos meus entregadores" (broadcast a quem está em turno)

**Files:** Modify `apps/api/src/services/dispatch.service.ts`, `apps/api/src/services/order-status.service.ts` (ou onde mora `requestDriver`); Test correspondente

- [ ] **Step 1: Exclusividade no pool geral** — em `listAvailableDeliveries`, excluir drivers com turno ativo (eles não veem o pool geral):

```ts
// não listar se o driver tem turno ACTIVE
const active = await getActiveShift(db, driverUserId)
if (active) return []   // em turno = só recebe pedidos da loja do turno (via listShiftDeliveries)
```

- [ ] **Step 2: `requestDriverOwn(storeId, orderId)`** — marca o pedido como direcionado aos próprios (broadcast). MVP simples: setar `driverRequestedAt` + um flag/campo indicando alvo. **Para não inflar o schema agora**, reutilizar: criar `listShiftDeliveries(driverUserId)` que lista pedidos da loja do turno ativo com `driverRequestedAt` setado, `driverId null`, `batchId null`, status ACCEPTABLE. E `acceptShiftDelivery(driverUserId, orderId)`: aceite atômico (`WHERE driver_id IS NULL`) que **também seta `order.shiftId = <turno ativo>`**.

> O campo de "alvo" (OWN/SPECIFIC/GENERAL) e o fluxo sem-fallback-com-confirmação são do ④b. Aqui: a loja tem um botão "Chamar meus entregadores" que faz `requestDriverOwn`; os próprios em turno veem e pegam.

- [ ] **Step 3: `acceptShiftDelivery`** — atômico, seta `driverId` + `shiftId` + `driverAssignedAt`. Coleta/entrega seguem o fluxo existente (`collectDelivery`/`completeDelivery`); no `completeDelivery` o `recordOrderLedger` já enxerga o `shiftId` e aplica o financeiro fixo.

- [ ] **Step 4: rodar + commit** — `git commit -m "feat(own-drivers): shift-scoped dispatch (request own, accept sets shiftId, pool exclusivity)"`

---

### Task 6: Rotas (loja + entregador)

**Files:** Modify `apps/api/src/routes/store-orders.ts` / novo `store-drivers.ts`, `apps/api/src/routes/driver.ts`; Test `apps/api/test/own-drivers.routes.test.ts`

- [ ] **Loja:**
```
GET    /store/me/drivers                        listStoreDrivers
POST   /store/me/drivers            {phone, dailyRateCents, perDeliveryCents, schedule}   inviteDriver
PATCH  /store/me/drivers/{id}       {dailyRateCents?, perDeliveryCents?, schedule?}       updateLinkTerms
DELETE /store/me/drivers/{id}                    removeLink
POST   /store/me/orders/{id}/request-own          requestDriverOwn
POST   /store/me/shifts/{id}/release              releaseShift
```
- [ ] **Entregador:**
```
GET    /driver/links                             listDriverLinks
POST   /driver/links/{id}/confirm                confirmLink
POST   /driver/shifts        {storeId, lat, lng} startShift
POST   /driver/shifts/{id}/end                   endShift
GET    /driver/shifts/active                     getActiveShift
GET    /driver/shift-deliveries                  listShiftDeliveries
POST   /driver/orders/{id}/accept-shift          acceptShiftDelivery
```
- [ ] Autorização: requireRole STORE/DRIVER; tenant; mapear os novos `*Error` no rethrow. Testes cobrindo: invite→confirm→start(raio 409 fora)→request-own→accept(seta shiftId)→deliver→ledger extra→end→ledger diária; tenant/roles; regressão freelance.
- [ ] Commit: `git commit -m "feat(api): own-driver + shift routes for store and driver"`

---

### Task 7: UI do entregador — vínculos e turno

**Files:** Modify `apps/driver/src/views/*` + `apps/driver/src/components/DriverLayout.vue` (+ nova view de vínculos/turno)

- [ ] Tela "Minhas lojas": lista `GET /driver/links`; convite INVITED com botão "Confirmar".
- [ ] Barra de turno no layout: se sem turno ativo e há vínculo CONFIRMED, botão "Iniciar turno" (pede geolocalização do browser → envia lat/lng; erro de raio exibido). Se em turno, mostra loja + "Encerrar turno".
- [ ] Em turno: a lista de "Disponíveis" mostra os pedidos da loja do turno (`/driver/shift-deliveries`) em vez do pool geral; "Aceitar" chama `accept-shift`. Fora de turno: pool geral como hoje.
- [ ] Build + commit: `git commit -m "feat(driver): store links, shift start/end, shift-scoped deliveries"`

---

### Task 8: UI da loja — cadastrar entregadores e chamar

**Files:** Modify web store views (+ nova `StoreDriversView.vue` e link no `StoreLayout`)

- [ ] `/loja/entregadores`: lista vínculos (status, diária R$, extra R$), form de convite (telefone + valores em R$ → centavos), editar termos, remover, e mostrar turnos ativos com botão "Liberar".
- [ ] Em `StoreOrdersView`: botão "Chamar meus entregadores" no pedido (request-own) — além do "Solicitar entregador" (pool) existente.
- [ ] Build + commit: `git commit -m "feat(web): store manages own drivers and calls them"`

---

### Task 9: Docs + gate final

- [ ] README: linha ④a (entregadores próprios + turno + diária). carry-forwards: registrar o que ficou pro ④b (dispatch específico/sem-fallback) e pro Plano 9 (anti-fraude GPS; localização confiável-pendente) e pra emenda de devolução (falha+meia-taxa não cobertos aqui).
- [ ] Gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.
- [ ] Commit: `git commit -m "docs: own-drivers (plano 4a) wrap-up"`

---

## Resumo pro executor

- **Tabelas:** `store_drivers` (vínculo + termos), `driver_shifts` (turno, valores congelados), `orders.shiftId`, `ledger_entries.orderId` vira nullable.
- **Turno:** inicia no raio (haversine, 0.5km), encerra livre (driver) ou loja libera; diária no encerramento (cheia mesmo se cedo; `earlyClose` só alerta).
- **Ledger fixo:** loja fica com o frete (self-delivery); driver recebe extra/entrega + diária; loja debitada desses; plataforma só comissão. Freelance inalterado.
- **Dispatch:** em turno = só pedidos da loja (exclusividade); "chamar meus entregadores" → aceite atômico seta `shiftId`.
- **Fora de escopo (④b / Plano 9 / emenda):** escolher específico, sem-fallback-com-confirmação, anti-fraude GPS, fluxo de devolução + meia-taxa. Registrar em carry-forwards.
- **Invariantes:** aceite atômico; exclusividade no servidor; idempotência do ledger (incl. diária por turno); tenant; freelance intacto.

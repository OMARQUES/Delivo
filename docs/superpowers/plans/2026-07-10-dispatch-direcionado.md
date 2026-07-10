# Plano ④b — Dispatch Direcionado (específico, próprios×pacote, escalada) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loja escolhe o destino de cada pedido E de cada pacote: um entregador **específico** em turno, **todos os próprios** em turno, ou o **pool geral** — com recusa pelo específico (loja avisada e redireciona) e escalada sempre explícita (sem fallback automático).

**Architecture:** Reusa a máquina existente: `driver_request_target` ganha `SPECIFIC`; `orders.requestedDriverId` guarda o alvo; recusa marca `driverRequestRefusedAt` (pedido/pacote fica visível pra loja como "recusado" até ela redirecionar). Pacote ganha os mesmos campos (`target`, `requestedDriverId`, `refusedAt`) e o aceite de pacote por entregador em turno passa a **setar `orders.shiftId`** (financeiro do fixo: extra por entrega + frete fica com a loja — já implementado no ledger, nada muda lá). Push FCM direcionado (só próprios em turno / só o específico).

**Tech Stack:** Hono + Drizzle (Postgres), Zod, Vue 3 (web loja + driver), Vitest contra Postgres real.

---

## Decisões travadas (não desviar)

1. **Específico pode RECUSAR.** Recusa não devolve automático pra ninguém: loja vê "recusado por X" e escolhe de novo (outro específico / todos os próprios / pool geral).
2. **Sem fallback automático em nenhum caminho.** Escalada é sempre ação da loja. Transições permitidas enquanto sem entregador: `SPECIFIC ↔ OWN` (livre), `SPECIFIC|OWN → GENERAL` (um caminho só — GENERAL não regride; regra já existente).
3. **Específico/próprios só alcançam quem está em TURNO ATIVO naquela loja** (decisão do ④a).
4. **Pacote aceito por entregador em turno** = pedidos do pacote ganham `shiftId` → ledger do fixo (extra/entrega; frete fica com a loja). Pacote GENERAL aceito por freelance = comportamento atual (frete pro driver). **Não mexer em `finance.service`** — ele já resolve pelos campos do pedido.
5. Entregador em turno **continua bloqueado** de pacotes/pedidos GENERAL de qualquer loja (exclusividade); a exceção nova é pacote/pedido da PRÓPRIA loja do turno com target OWN/SPECIFIC.

## Guardrails

1. Aceites continuam **atômicos** (`WHERE driver_id IS NULL` + guards de target). Corrida específico×própria×escalada: quem commitou primeiro vence, resto 409.
2. Recusa só pelo entregador ALVO (`requestedDriverId = eu`), enquanto sem `driverId`. Tenant em tudo (loja só no que é dela) → 404.
3. **Não tocar** em: finance.service (ledger já cobre), fluxo freelance GENERAL, aceite avulso existente, coleta/entrega.
4. Testes contra Postgres real. TDD. **Sem coautor** (hook garante). Gate final `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

---

### Task 1: Schema — SPECIFIC + alvo/recusa em pedido e pacote

**Files:** Modify `apps/api/src/db/schema/orders.ts`, `apps/api/src/db/schema/batches.ts`; migration.

- [ ] **Step 1:** enum: `driver_request_target` ganha `'SPECIFIC'`. No Drizzle o enum vem de `pgEnum('driver_request_target', [...])` — adicionar `'SPECIFIC'` ao array (migration gera `ALTER TYPE ... ADD VALUE 'SPECIFIC'`).
- [ ] **Step 2:** `orders` ganha:
```ts
    /** ④b: alvo quando driverRequestTarget = SPECIFIC */
    requestedDriverId: uuid('requested_driver_id'),
    /** ④b: específico recusou — loja precisa redirecionar */
    driverRequestRefusedAt: timestamp('driver_request_refused_at', { withTimezone: true }),
```
- [ ] **Step 3:** `deliveryBatches` ganha:
```ts
    /** ④b: destino do broadcast (GENERAL | OWN | SPECIFIC) */
    target: driverRequestTarget('target').notNull().default('GENERAL'),
    requestedDriverId: uuid('requested_driver_id'),
    refusedAt: timestamp('refused_at', { withTimezone: true }),
```
> Importar o `driverRequestTarget` pgEnum de `orders.ts` (exportá-lo de lá se ainda não é exportado). Cuidado com ciclo de import: se necessário, mover o pgEnum pra um módulo comum (ex.: `schema/enums.ts`) e reexportar.
- [ ] **Step 4:** `pnpm --filter @delivery/api db:generate && pnpm --filter @delivery/api db:migrate`.
- [ ] **Step 5:** commit `feat(dispatch): SPECIFIC target + refusal fields on orders and batches`.

---

### Task 2: Service — pedido específico + recusa + re-alvo

**Files:** Modify `apps/api/src/services/order-status.service.ts`, `apps/api/src/services/dispatch.service.ts`; Test `apps/api/test/own-drivers.service.test.ts` (ou novo `dispatch-target.service.test.ts`).

- [ ] **Step 1: Testes falhando**
  - `requestDriverSpecific(storeId, orderId, driverUserId)`: exige turno ATIVO do driver NAQUELA loja (senão 409 "entregador não está em turno"); seta `SPECIFIC` + `requestedDriverId` + `driverRequestedAt`, limpa `driverRequestRefusedAt`. READY → AWAITING_DRIVER (mesmo padrão do own).
  - Só o específico vê/aceita: `listShiftDeliveries` do driver alvo inclui o pedido (flag `direct: true`); outro driver em turno na mesma loja NÃO vê; `acceptShiftDelivery` do não-alvo → 409.
  - `refuseDirectDelivery(driverUserId, orderId)`: só o alvo, enquanto sem driver; marca `driverRequestRefusedAt` + `addEvent` "entregador recusou o direcionamento"; pedido some da lista do driver (`listShiftDeliveries` exclui recusado); loja vê o refusedAt.
  - Re-alvo: após recusa, `requestDriverSpecific` pra OUTRO driver funciona (limpa refusedAt); `requestDriverOwn` vira OWN (limpa specific/refusal); `requestDriver` → GENERAL (um caminho, não volta).
  - Corrida: específico aceita ↔ loja re-alveja — atômica (guards por target no UPDATE de aceite).

- [ ] **Step 2: Implementar**
  - `requestDriverSpecific` em `order-status.service.ts` (modelar em `requestDriverOwn`, com validação de turno via select em `driverShifts` ACTIVE por storeId+driverUserId).
  - `requestDriverOwn`/`requestDriver`: ao mudar de alvo, limpar `requestedDriverId` e `driverRequestRefusedAt`. Regra de transição: se `driverRequestTarget === 'GENERAL'` → 409 pra own/specific (não regride).
  - `listShiftDeliveries` (dispatch.service): incluir pedidos `SPECIFIC` com `requestedDriverId = eu` e sem `driverRequestRefusedAt`; manter os `OWN`. Expor `direct: orders.driverRequestTarget === 'SPECIFIC'` — na prática selecionar `driverRequestTarget` e `requestedDriverId` e deixar a UI decidir.
  - `acceptShiftDelivery`: aceitar quando `(target = 'OWN')` OU `(target = 'SPECIFIC' AND requestedDriverId = eu)` — no WHERE do UPDATE atômico.
  - `refuseDirectDelivery` em dispatch.service:
```ts
export async function refuseDirectDelivery(db: Db, driverUserId: string, orderId: string) {
  const rows = await db.update(orders)
    .set({ driverRequestRefusedAt: new Date() })
    .where(and(
      eq(orders.id, orderId),
      eq(orders.driverRequestTarget, 'SPECIFIC'),
      eq(orders.requestedDriverId, driverUserId),
      isNull(orders.driverId),
      isNull(orders.driverRequestRefusedAt),
    )).returning({ id: orders.id, status: orders.status })
  if (!rows[0]) throw new DispatchError('Pedido não está direcionado a você', 409)
  await addEvent(db, orderId, rows[0].status, 'DRIVER', driverUserId, 'entregador recusou o direcionamento')
  return rows[0]
}
```
- [ ] **Step 3:** rodar + commit `feat(dispatch): specific-driver targeting with refusal and explicit retarget`.

---

### Task 3: Service — pacote com alvo (próprios/específico) + aceite em turno seta shiftId

**Files:** Modify `apps/api/src/services/batch.service.ts`; Test `apps/api/test/batch.service.test.ts`.

- [ ] **Step 1: Testes falhando**
  - `broadcastBatch(storeId, batchId, { target: 'OWN' })`: pedidos do pacote ganham `driverRequestTarget='OWN'`; pool geral (`listAvailableBatches`) NÃO lista; novo `listShiftBatches(driverUserId)` lista pro driver em turno da loja.
  - `broadcastBatch(..., { target: 'SPECIFIC', requestedDriverId })`: exige turno ativo do driver na loja; só ele vê.
  - `acceptBatch` por driver EM TURNO: permitido quando pacote é da loja do turno com target OWN (ou SPECIFIC=eu); seta `driverId` E **`shiftId`** em todos os pedidos; pacotes GENERAL continuam 409 pra quem está em turno.
  - Ledger (regressão + novo): pacote OWN aceito por fixo → cada pedido DELIVERED credita `DRIVER_PER_DELIVERY_CREDIT` (não o frete; frete no `STORE_SALE_CREDIT` online / fica com a loja no cash). Pacote GENERAL por freelance → `DRIVER_DELIVERY_CREDIT` (regressão intacta).
  - `refuseBatch(driverUserId, batchId)`: só o específico alvo, enquanto PENDING sem driver; marca `refusedAt`; some da lista dele; loja vê.
  - Re-broadcast com outro target enquanto PENDING: atualiza pacote + pedidos (limpa refusedAt). GENERAL não regride.

- [ ] **Step 2: Implementar**
  - `broadcastBatch(db, storeId, batchId, opts: { target: 'GENERAL' | 'OWN' | 'SPECIFIC'; requestedDriverId?: string })` — validar turno ativo quando SPECIFIC; gravar target/requestedDriverId no pacote; `orders.driverRequestTarget` = target (e `requestedDriverId` nos pedidos? NÃO — pedidos de pacote são aceitos via pacote; basta o target no pacote e nos pedidos o target pra manter o pool individual limpo. Manter simples: pedidos recebem o MESMO target, sem requestedDriverId).
  - Aceitar re-broadcast: permitir chamar de novo enquanto `status='PENDING'` e `driverId IS NULL` (muda target; limpa `refusedAt`); bloquear se atual é GENERAL e novo não é (não regride).
  - `listShiftBatches(db, driverUserId)`: turno ativo → pacotes `PENDING` da loja do turno com `(target='OWN') OR (target='SPECIFIC' AND requestedDriverId=eu AND refusedAt IS NULL)`, com count + feeTotal + **extra estimado** (`count × shift.perDeliveryCents`) pra UI.
  - `acceptBatch`: substituir o bloqueio atual ("Encerre o turno...") por lógica dupla:
    - driver SEM turno: só pacotes `target='GENERAL'` (comportamento atual).
    - driver COM turno: só pacotes da loja do turno com `target='OWN'` ou `SPECIFIC`=eu; no claim atômico incluir os guards de target; após claim, `UPDATE orders SET driverId, driverAssignedAt, shiftId = <turno ativo>`.
  - `listAvailableBatches` (pool geral): filtrar `eq(deliveryBatches.target, 'GENERAL')`.
  - `refuseBatch`: análogo ao refuseDirectDelivery (marca `refusedAt` no pacote, evento em cada pedido é opcional — 1 evento no primeiro pedido basta? NÃO: sem evento de pedido; loja vê pelo refusedAt do pacote).
- [ ] **Step 3:** rodar + commit `feat(batch): targeted broadcast (own/specific) and shift-aware accept setting shiftId`.

---

### Task 4: Push direcionado (FCM)

**Files:** Modify `apps/api/src/services/order-status.service.ts` (ou dispatch.service), rotas que disparam push; Test unitário leve (tokens certos).

- [ ] **Step 1:** novo helper:
```ts
/** Tokens dos entregadores em turno ATIVO na loja (ou só o específico). */
export async function listShiftDriverTokens(db: Db, storeId: string, driverUserId?: string): Promise<string[]> {
  const rows = await db.select({ fcmToken: drivers.fcmToken })
    .from(driverShifts)
    .innerJoin(drivers, eq(drivers.userId, driverShifts.driverUserId))
    .where(and(
      eq(driverShifts.storeId, storeId),
      eq(driverShifts.status, 'ACTIVE'),
      isNotNull(drivers.fcmToken),
      ...(driverUserId ? [eq(driverShifts.driverUserId, driverUserId)] : []),
    ))
  return rows.map((r) => r.fcmToken!).filter(Boolean)
}
```
- [ ] **Step 2:** nas rotas: request-own / request-specific / broadcast own-specific → `sendPushToTokens(env, tokens, ...)` fire-and-forget, mesmo padrão da rota `request-driver` existente (GENERAL continua usando `listAvailableDriverTokens`).
- [ ] **Step 3:** commit `feat(dispatch): targeted fcm push for own and specific`.

---

### Task 5: Rotas

**Files:** Modify `apps/api/src/routes/store-orders.ts`, `apps/api/src/routes/driver.ts`; Test `apps/api/test/batch.routes.test.ts` / `own-drivers.routes.test.ts`.

- [ ] Loja:
```
POST /store/me/orders/{id}/request-specific   body { driverUserId: uuid }
POST /store/me/batches/{id}/broadcast          body { target: 'GENERAL'|'OWN'|'SPECIFIC', driverUserId? }  (substitui o broadcast sem corpo; corpo default GENERAL mantém compat)
```
- [ ] Driver:
```
GET  /driver/shift-batches
POST /driver/orders/{id}/refuse-direct
POST /driver/batches/{id}/accept                (mesma rota, service agora shift-aware)
POST /driver/batches/{id}/refuse
```
- [ ] Testes de rota: RBAC (customer 403), tenant (loja B 404), fluxo: request-specific → alvo vê `direct` → recusa → loja vê refused → re-alveja OWN → outro aceita; pacote OWN aceito por fixo → pedidos com shiftId.
- [ ] Commit `feat(api): routes for specific targeting, refusals and shift batches`.

---

### Task 6: UI da loja

**Files:** Modify `apps/web/src/views/store/StoreOrdersView.vue`.

- [ ] Carregar turnos ativos (`GET /store/me/shifts`) junto do load (nome+driverUserId).
- [ ] No card do pedido elegível (sem driver): além dos botões existentes ("🛵 Solicitar entregador" GENERAL, "🏪 Chamar meus entregadores" OWN), um `<select>` "Enviar para..." com os entregadores em turno → `request-specific`. Esconder select se nenhum turno ativo.
- [ ] Badges: `driverRequestTarget==='SPECIFIC' && !driverRequestRefusedAt` → "aguardando <nome>…"; `driverRequestRefusedAt` → "❌ recusado — escolha outro destino" + reexibir os 3 controles (own/specific/pool). (O payload da listagem precisa expor `requestedDriverId`/`driverRequestRefusedAt` — conferir a query de listagem da loja e adicionar os campos.)
- [ ] Pacotes: no card do pacote OPEN, trocar o botão único por 3 ações ("Enviar ao pool geral" / "Meus entregadores" / select específico). PENDING com `refusedAt` → badge + re-opções (re-broadcast).
- [ ] Build + commit `feat(web): store picks delivery target for orders and batches`.

---

### Task 7: UI do driver

**Files:** Modify `apps/driver/src/views/AvailableView.vue` (ou onde estiver a lista de turno).

- [ ] Pedidos do turno com `driverRequestTarget==='SPECIFIC'`: destacar "📍 Direcionado a você" + botões **Aceitar** / **Recusar** (`refuse-direct`). OWN segue só "Aceitar".
- [ ] Seção "Pacotes da loja" quando em turno (`GET /driver/shift-batches`): card "📦 N entregas · extra estimado R$X" + Aceitar (e Recusar quando específico). Aceite → `/entregas` (coleta única já existente).
- [ ] Build + commit `feat(driver): direct assignments with refuse + shift batches`.

---

### Task 8: Docs + gate

- [ ] README: ④b ✅ (específico, próprios×pacote, recusa+escalada explícita). carry-forwards: remover linha "Pacote: só broadcast (sem escolher entregador específico)"; manter/ajustar o que restou (④c ofertas; emenda devolução).
- [ ] Gate `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.
- [ ] Commit `docs: dispatch direcionado (plano 4b) wrap-up`.

---

## Resumo pro executor

- **Pedido:** loja escolhe GENERAL | OWN | SPECIFIC(driver em turno). Específico pode recusar → loja vê e redireciona. GENERAL não regride.
- **Pacote:** mesmos 3 alvos no broadcast; aceite por driver em turno seta `orders.shiftId` (financeiro do fixo automático — NÃO mexer no finance.service); GENERAL por freelance intacto.
- **Exclusividade mantida:** em turno não vê/aceita GENERAL; vê OWN/SPECIFIC da própria loja do turno.
- **Push:** OWN → tokens dos em-turno da loja; SPECIFIC → só o alvo; GENERAL → todos disponíveis (atual).
- **Invariantes:** aceites atômicos com guards de target; recusa só pelo alvo; tenant; ledger intacto (testes de regressão do freelance e do fixo).

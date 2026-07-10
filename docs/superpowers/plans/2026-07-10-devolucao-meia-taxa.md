# Plano — Devolução de Entrega Falhada + Meia-taxa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Entrega falhada exige **devolução do produto na loja**: o pagamento do entregador (frete no freelance; extra no fixo) só é lançado quando a loja **confirma a devolução**. Pedido online é **estornado na falha** (imediato). Devolução parada gera **alerta** (loja + admin; suporte confirma manualmente). (B) **Meia-taxa**: entregador freelance confirma **"Cheguei na loja"**; se a loja **desvincular** o entregador depois disso, ele recebe **50% do frete**, debitado da loja.

**Architecture:** DELIVERY_FAILED continua status terminal — devolução vira **campos no pedido** (`returnPendingAt`, `returnedAt`) + chegada (`driverArrivedAt`). O ledger da falha muda: nada é pago na falha; `confirmOrderReturn` lança o pagamento (frete freelance / extra fixo). Meia-taxa = novos tipos de lançamento no ledger. GPS da chegada é **logado best-effort** (coords no evento) — validação dura mock/root fica no Plano 9.

**Tech Stack:** Hono + Drizzle (Postgres), Zod, Vue 3, Vitest contra Postgres real.

---

## Decisões travadas (não deviar)

1. **Sem status novo.** `DELIVERY_FAILED` permanece; devolução por campos. Máquina de estados intacta.
2. **Estorno online: na falha, imediato** (cliente não espera devolução). Já existe `refundOrderPaymentIfAny` — chamar no `failDelivery`.
3. **Pagamento do entregador GATED na devolução** — vale pra freelance (frete) E fixo (extra por entrega). MUDA o comportamento atual (hoje freelance recebe o frete na hora da falha).
4. **Meia-taxa: só freelance** (fixo tem diária). Gatilho: loja desvincula APÓS `driverArrivedAt`. 50% de `deliveryFeeCents` (arredondar `Math.round(fee/2)`). Antes da chegada confirmada → desvincula sem custo.
5. **Devolução parada:** alerta visual (loja + admin) com idade; admin/suporte pode confirmar manualmente. Sem auto-confirmação, sem punição automática.
6. **Plataforma continua absorvendo o frete da falha no cash** (regra atual: loja não é debitada do frete em DELIVERY_FAILED) — só muda o MOMENTO do crédito (devolução), não o rateio. Documentado em carry-forwards, não mexer.

## Guardrails

1. Ledger imutável e idempotente por `uniqueKey`. Lançamentos novos: devolução `${orderId}:...-on-return`, meia-taxa `${orderId}:half-fee:${driverUserId}`.
2. Ações atômicas com guards (`WHERE` por status/campos), tenant em tudo (loja só nos pedidos dela; driver só nos dele).
3. Não mexer em: fluxo DELIVERED (ledger na entrega), settlement, dispatch de aceite, turnos.
4. Testes contra Postgres real; ATUALIZAR os testes existentes de DELIVERY_FAILED (o crédito imediato do frete sai — é intencional). TDD. **Sem coautor** (hook garante). Gate final `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

---

### Task 1: Schema + tipos de ledger

**Files:** Modify `apps/api/src/db/schema/orders.ts`, `packages/shared/src/finance.ts`; migration.

- [ ] **Step 1:** `orders` ganha:
```ts
    /** devolução de entrega falhada (produto volta pra loja) */
    driverArrivedAt: timestamp('driver_arrived_at', { withTimezone: true }),
    returnPendingAt: timestamp('return_pending_at', { withTimezone: true }),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnConfirmedBy: uuid('return_confirmed_by'),
```
- [ ] **Step 2:** `LEDGER_ENTRY_TYPES` += `'DRIVER_HALF_FEE_CREDIT'`, `'STORE_HALF_FEE_DEBIT'`; labels: `'Meia-taxa (deslocamento)'` / `'Meia-taxa do entregador (deslocamento)'`. Teste de labels no shared.
- [ ] **Step 3:** `db:generate` + `db:migrate`. Commit `feat(returns): return/arrival fields + half-fee ledger types`.

---

### Task 2: Falha para de pagar na hora; estorna online; marca devolução pendente

**Files:** Modify `apps/api/src/services/dispatch.service.ts` (`failDelivery`), `apps/api/src/services/finance.service.ts` (`recordOrderLedger`); Test finance + dispatch existentes.

- [ ] **Step 1: Testes (atualizar + novos)**
  - `failDelivery`: seta `returnPendingAt`; pedido online → payment REFUNDED (provider chamado); **nenhum** crédito de frete/extra no ledger na falha (freelance E fixo).
  - Regressão: DELIVERED continua igual (frete freelance / extra fixo pagos na entrega).
- [ ] **Step 2: Implementar**
  - `failDelivery`: no `.set(...)` incluir `returnPendingAt: new Date()`. Após o update: `await refundOrderPaymentIfAny(db, provider ?? null, orderId)` — a assinatura precisa receber `provider` (seguir o padrão das rotas de cancelamento; a rota `/driver/orders/{id}/fail` passa `providerFromEnv(c)` como as demais — conferir helper usado nas rotas de pagamento).
  - `recordOrderLedger`: no bloco `DELIVERY_FAILED`, **remover** o crédito de frete do freelance (o `if (order.driverId && !shift && deliveryFee > 0)` que roda pra FAILED). Estrutura sugerida: condicionar os créditos de driver a `order.status === 'DELIVERED'` OU à confirmação de devolução (Task 3 chama com flag). Manter os lançamentos de DELIVERED intocados.
- [ ] **Step 3:** rodar + commit `feat(returns): fail marks return pending, refunds online, defers driver pay`.

---

### Task 3: Confirmação de devolução paga o entregador

**Files:** Modify `apps/api/src/services/finance.service.ts` (nova `recordReturnLedger`), novo service ou em `order-status.service.ts` (`confirmOrderReturn`); Tests.

- [ ] **Step 1: Testes falhando**
  - `confirmOrderReturn(storeId, orderId, actorId)`: exige `status='DELIVERY_FAILED'` + `returnPendingAt` + `returnedAt IS NULL`; seta `returnedAt`/`returnConfirmedBy`; ledger:
    - freelance (sem shiftId): `DRIVER_DELIVERY_CREDIT +fee` (uniqueKey `${orderId}:driver-delivery-credit-on-return`) — plataforma absorve (sem débito da loja), regra atual mantida.
    - fixo (com shiftId): `DRIVER_PER_DELIVERY_CREDIT +extra` / `STORE_PER_DELIVERY_DEBIT −extra` (uniqueKeys `...:driver-per-delivery-on-return` / `...:store-per-delivery-on-return`).
  - Idempotente (2ª confirmação → 409; ledger não duplica).
  - `adminConfirmOrderReturn(orderId, actorId)`: mesma coisa sem tenant de loja (suporte).
- [ ] **Step 2: Implementar** — tx + guard atômico no UPDATE (`WHERE returned_at IS NULL AND return_pending_at IS NOT NULL AND status='DELIVERY_FAILED'`); `recordReturnLedger(tx, order)` lê shift como o `recordOrderLedger` faz (mesma validação storeId/driverId). `addEvent` "devolução confirmada pela loja".
- [ ] **Step 3:** rodar + commit `feat(returns): store/admin confirm return releases driver pay`.

---

### Task 4: Chegada na loja + desvincular com meia-taxa

**Files:** Modify `apps/api/src/services/dispatch.service.ts`; Tests.

- [ ] **Step 1: Testes falhando**
  - `confirmArrival(driverUserId, orderId, gps?)`: só o driver do pedido, status ACCEPTED..AWAITING_DRIVER (pré-coleta); seta `driverArrivedAt`; evento com coords no note (`chegou na loja (lat,lng)` — best-effort, GPS opcional).
  - `storeReleaseDriver(storeId, orderId, actorId)`: pedido da loja com driver e ainda NÃO coletado (status != OUT_FOR_DELIVERY+); limpa `driverId/driverAssignedAt/shiftId/driverArrivedAt`; se **freelance** (shiftId null) E `driverArrivedAt` setado → ledger `DRIVER_HALF_FEE_CREDIT +round(fee/2)` / `STORE_HALF_FEE_DEBIT −round(fee/2)` (uniqueKey com driverUserId); fixo → sem meia-taxa; sem chegada → sem meia-taxa. Evento registrado.
  - Corrida: driver coleta ↔ loja desvincula — atômico (guard de status no UPDATE).
- [ ] **Step 2: Implementar** — `confirmArrival` update atômico; `storeReleaseDriver` em tx (lock do pedido, ler driver/shift/arrived antes de limpar, lançar meia-taxa via helper novo `recordHalfFee(tx, {...})` em finance.service). Pedido volta sem alvo (`driverRequestedAt` mantém? NÃO — limpar chamado: `driverRequestedAt/Target/requestedDriverId/refusedAt = null` pra loja redirecionar do zero, consistente com o withdraw).
- [ ] **Step 3:** rodar + commit `feat(returns): arrival confirmation and store release with half fee`.

---

### Task 5: Rotas

**Files:** `apps/api/src/routes/driver.ts`, `store-orders.ts`, `admin-*.ts` (ou novo `admin-returns.ts`); Tests de rota.

```
POST /driver/orders/{id}/arrived            body { lat?, lng? }        confirmArrival
POST /store/me/orders/{id}/confirm-return                              confirmOrderReturn
POST /store/me/orders/{id}/release-driver                              storeReleaseDriver
GET  /admin/returns                          (pendentes, com idade)    lista DELIVERY_FAILED com returnPendingAt e sem returnedAt (+ dados loja/driver)
POST /admin/orders/{id}/confirm-return                                 adminConfirmOrderReturn
```
- [ ] RBAC/tenant testados (customer 403; loja B 404). `fail` já existente agora recebe provider (estorno). Commit `feat(api): return and half-fee routes`.

---

### Task 6: UIs

**Files:** driver `DeliveriesView.vue`; web `StoreOrdersView.vue`; web admin (novo `AdminReturnsView.vue` + nav).

- [ ] **Driver:** botão **"📍 Cheguei na loja"** no card de coleta (aceito, pré-coleta; envia GPS se disponível — `navigator.geolocation`, falha silenciosa). Pós-falha: aviso no card/histórico "⚠️ Devolva o produto na loja — pagamento liberado após a loja confirmar".
- [ ] **Loja:** pedido DELIVERY_FAILED com devolução pendente → destaque "📦 Devolução pendente há Xh" + botão **"Confirmar devolução"**. Pedido com driver pré-coleta → botão **"Desvincular entregador"** (confirm(); avisa que pós-chegada gera meia-taxa). Badge "entregador chegou" quando `driverArrivedAt`.
- [ ] **Admin:** `/admin/devolucoes` — lista pendentes (loja, driver, idade, valor), botão "Confirmar devolução" (suporte). Nav no AdminLayout.
- [ ] Builds + commit `feat(web,driver): return flow and half-fee UI`.

---

### Task 7: Docs + gate

- [ ] carry-forwards: REMOVER/ajustar linhas antigas de DELIVERY_FAILED (política agora definida: estorno na falha, pagamento na devolução); ADICIONAR: "GPS da chegada é best-effort (coords logadas) — validação mock/root no Plano 9"; "meia-taxa só freelance"; "sem auto-confirmação de devolução (suporte manual)".
- [ ] README: linha da emenda ✅.
- [ ] Gate `pnpm typecheck && pnpm test && pnpm lint && pnpm build`. Commit `docs: return + half-fee wrap-up`.

---

## Resumo pro executor

- **Falha:** `returnPendingAt` + estorno online imediato + **nada pago ao driver**.
- **Devolução confirmada (loja ou admin):** paga freelance (frete, plataforma absorve) ou fixo (extra, loja debitada). Idempotente.
- **Meia-taxa:** driver confirma chegada (GPS logado best-effort) → loja desvincula depois → freelance ganha 50% do frete, loja debitada. Fixo não (tem diária). Desvincular limpa driver+chamado (loja redireciona do zero).
- **Alertas:** loja vê devoluções pendentes com idade; admin tem lista + confirmação manual.
- **Invariantes:** ledger imutável/idempotente; ações atômicas; DELIVERED intocado; tenant.

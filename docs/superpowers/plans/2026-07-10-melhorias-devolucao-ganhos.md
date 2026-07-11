# Plano — Melhorias Devolução (destaque + fotos) e Ganhos do Entregador Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Pedido com devolução pendente ganha **seção própria "Devoluções" no topo** das telas da loja e do entregador (hoje se esconde no histórico). (B) Entregador marca **"Devolvi na loja"** com **até 2 fotos opcionais** (recibo + panorâmica) como evidência — a loja **continua** sendo quem confirma e libera o pagamento. (C) Tela de **Ganhos** mostra **data/hora** de cada lançamento e abre **detalhe do pedido** (loja, itens, tipo do ganho, valores) **sem nenhum dado do cliente**.

**Architecture:** `orders` ganha `driverReturnedAt` + `returnPhotoKeys jsonb` (máx 2 chaves R2). Upload segue o padrão do logo (`PUT` binário → `BUCKET.put` → key; exibição via `/media/:key`). Ganhos: `getDriverFinance` já retorna `createdAt` dos lançamentos — UI passa a exibir; novo endpoint de detalhe sanitizado `GET /driver/earnings/orders/{id}` (itens/loja/valores, sem cliente).

**Tech Stack:** Hono + Drizzle, R2 (binding `BUCKET`), Vue 3, Vitest contra Postgres real.

---

## Decisões travadas (não desviar)

1. **Fotos opcionais, máx 2.** Sem foto também vale. Fotos são evidência pra loja/admin (disputa via suporte).
2. **Gatilho do pagamento NÃO muda:** só a confirmação da loja (ou admin) libera. "Devolvi" + fotos = evidência + destaque pra loja confirmar.
3. **Detalhe de ganhos sem dados do cliente:** nome/telefone/endereço/nota do cliente NUNCA aparecem. Mostrar: data/hora, loja, itens (nome/qtd), tipo do ganho, valores.
4. **Devoluções em seção própria no topo** (loja e driver); some ao confirmar (vai pro histórico normal).

## Guardrails

1. Upload: só o driver DO pedido, só com devolução pendente (`status=DELIVERY_FAILED`, `returnedAt IS NULL`); máx 2 fotos por pedido; validar content-type imagem e tamanho (máx 5MB, padrão do logo se houver); keys `returns/<uuid>.<ext>`.
2. Endpoint de detalhe de ganhos: driver só vê pedido em que ELE foi o entregador (`driverId = eu`) → 404 caso contrário. **Selecionar campos explicitamente** — nunca `select().from(orders)` inteiro (vaza endereço).
3. Não mexer em: gatilho de pagamento, ledger, confirmação da loja/admin (fluxos prontos).
4. Testes contra Postgres real; TDD; **sem coautor** (hook garante). Gate final `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

---

### Task 1: Schema

**Files:** Modify `apps/api/src/db/schema/orders.ts`; migration.

- [ ] `orders` ganha:
```ts
    /** driver declarou devolução (evidência; pagamento segue gated na loja) */
    driverReturnedAt: timestamp('driver_returned_at', { withTimezone: true }),
    /** até 2 fotos-comprovante no R2 (returns/<uuid>.<ext>) */
    returnPhotoKeys: jsonb('return_photo_keys').$type<string[]>().notNull().default([] as never),
```
- [ ] `db:generate` + `db:migrate`. Commit `feat(returns): driver-returned mark and photo keys`.

---

### Task 2: Service + rotas do driver (devolvi + foto)

**Files:** Modify `apps/api/src/services/return.service.ts`, `apps/api/src/routes/driver.ts`; Tests.

- [ ] **Testes:** `markDriverReturned(driverUserId, orderId)`: só o driver do pedido, só com devolução pendente e `returnedAt IS NULL`; seta `driverReturnedAt`; idempotente (2ª chamada 409 ou no-op — escolher 409); evento "entregador declarou devolução". Upload: adiciona key ao array (máx 2 → 400 na 3ª); só driver do pedido; só pendente.
- [ ] **Implementar:**
  - `markDriverReturned` em return.service (update atômico com guards).
  - Rota `POST /driver/orders/{id}/returned` → markDriverReturned.
  - Rota `PUT /driver/orders/{id}/return-photo` (binário, padrão do logo em `store-me.ts:48-60`): valida driver do pedido + pendente + `returnPhotoKeys.length < 2` + content-type `image/*` + tamanho; `BUCKET.put('returns/<uuid>.<ext>', ...)`; append no array (UPDATE com guard de tamanho pra corrida). Retorna `{ key }`.
- [ ] Commit `feat(returns): driver marks returned with up to 2 photo proofs`.

---

### Task 3: Loja/admin veem evidência

**Files:** Modify listagens da loja (query de pedidos — expor `driverReturnedAt`/`returnPhotoKeys`) e `listPendingReturns` (admin já retorna o pedido inteiro — conferir que os campos novos passam); Tests leves.

- [ ] Loja: payload dos pedidos inclui os 2 campos novos. Admin `/admin/returns` idem.
- [ ] Commit `feat(returns): expose driver return evidence to store and admin`.

---

### Task 4: Ganhos com hora + detalhe sanitizado

**Files:** Modify `apps/api/src/services/finance-settlement.service.ts` (ou novo service), `apps/api/src/routes/driver.ts`; Tests.

- [ ] **Endpoint novo** `GET /driver/earnings/orders/{id}`:
```ts
// select EXPLÍCITO — nunca a linha inteira do pedido (privacidade do cliente)
{
  orderId, createdAt, deliveredAt?/status, storeName,
  items: [{ nameSnapshot, quantity }],
  ledger: [{ type, amountCents, description, createdAt }],  // só entries do driver logado neste pedido
}
```
  Guards: `orders.driverId = eu` senão 404. **Proibido**: addressText, customerName/Phone, note, taxId, lat/lng.
- [ ] **Teste:** driver vê o próprio; outro driver 404; payload NÃO contém campos de cliente (assert de ausência).
- [ ] Commit `feat(driver): sanitized earning order detail`.

---

### Task 5: UI driver

**Files:** `apps/driver/src/views/DeliveriesView.vue`, `apps/driver/src/views/FinanceView.vue`.

- [ ] **DeliveriesView:** seção **"📦 Devolver na loja"** ACIMA de tudo, com os pedidos `DELIVERY_FAILED` + devolução pendente do driver (endpoint: incluir no `scope=active` ou novo scope `returns` — escolher o mais simples e documentar). Card mostra loja/endereço da loja, botão **"Devolvi na loja"** e **"📷 Anexar foto"** (input file capture=camera, até 2; mostra miniaturas via `/media/:key`). Após `driverReturnedAt`: "aguardando a loja confirmar".
- [ ] **FinanceView (Ganhos):** cada lançamento mostra **data e hora** (`toLocaleString pt-BR`); lançamento com `orderId` vira clicável → modal com o detalhe sanitizado (loja, itens, tipo, valores). Diária (sem orderId) mostra só data/hora.
- [ ] Build + commit `feat(driver): returns section with photos + timestamped earnings detail`.

---

### Task 6: UI loja

**Files:** `apps/web/src/views/store/StoreOrdersView.vue`.

- [ ] Seção **"📦 Devoluções pendentes"** no TOPO (antes da fila), com: idade (`returnAge` já existe), badge "entregador declarou devolução" quando `driverReturnedAt`, miniaturas das fotos (link `/media/:key`, abre em nova aba), botão **"Confirmar devolução"** (já existe — mover pra cá). Pedido sai da seção quando confirmado.
- [ ] Remover o destaque antigo de dentro da lista (evitar duplicação).
- [ ] Build + commit `feat(web): returns section on top with photo evidence`.

---

### Task 7: Docs + gate

- [ ] carry-forwards: "fotos de devolução são públicas por key não-adivinhável via /media (sem ACL) — revisar no deploy"; README se fizer sentido.
- [ ] Gate `pnpm typecheck && pnpm test && pnpm lint && pnpm build`. Commit `docs: return evidence + earnings detail wrap-up`.

---

## Resumo pro executor

- **Devoluções em seção própria no topo** (loja e driver); some ao confirmar.
- **"Devolvi na loja"** + até **2 fotos opcionais** (R2, padrão do logo) = evidência; **pagamento continua gated na confirmação da loja**.
- **Ganhos:** hora em tudo; clique abre detalhe **sem dados do cliente** (select explícito + teste de ausência).
- Não tocar: ledger, gatilho de pagamento, confirmação loja/admin.

# Financeiro Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar ledger financeiro idempotente por pedido terminal, gerar faturas/payouts manuais por período, e expor extratos read-only para loja/entregador.

**Architecture:** Ledger imutável com valores assinados: positivo = plataforma deve à parte, negativo = parte deve à plataforma. Fechamento manual agrega entradas não fechadas em documentos (`store_invoices`, `store_payouts`, `driver_payouts`) e marca itens por vínculo; marcar pago só altera status/`paidAt`. Comissão por loja em `stores.commissionBps`, default `0`.

**Tech Stack:** Drizzle/Postgres, Hono routes, Vue 3, Vitest, sem SDK novo, sem payout automático, sem split MP.

---

## Guardrails

1. TDD por task: teste falha → impl → teste passa.
2. Sem alterar state machine.
3. Sem chamada real PIX/banco/gateway; sistema calcula e marca pago manualmente.
4. Sem netting automático entre fatura da loja e payout da loja.
5. `amountCents` signed: positivo = crédito da parte; negativo = débito da parte.
6. Fechamento por período é idempotente por unique keys.
7. 1 commit por task.

---

### Task 1: shared + DB

**Files:** `packages/shared/src/finance.ts`, `packages/shared/src/constants.ts`, `apps/api/src/db/schema/finance.ts`, `apps/api/src/db/schema/stores.ts`, schema barrel, truncate helper.

- [ ] Testar/exportar `LEDGER_ENTRY_TYPES`, `FINANCE_DOCUMENT_STATUSES`, labels.
- [ ] Criar `stores.commissionBps integer not null default 0`.
- [ ] Criar tabelas: `ledger_entries`, `store_invoices`, `store_invoice_items`, `store_payouts`, `store_payout_items`, `driver_payouts`, `driver_payout_items`.
- [ ] Índices/unique:
  - `ledger_entries.uniqueKey` unique.
  - item tables unique por `ledgerEntryId`.
  - documents unique por `periodStart`, `periodEnd`, parte.
- [ ] Migration + `db:migrate`.
- [ ] Commit: `feat(finance): ledger and settlement tables`.

### Task 2: ledger service

**Files:** `apps/api/src/services/finance.service.ts`, `apps/api/test/finance.service.test.ts`.

- [ ] Testar `recordOrderLedger`:
  - online DELIVERED com driver, comissão 10%: loja crédito subtotal-comissão; driver crédito frete.
  - cash DELIVERED com driver: loja débito comissão+frete; driver crédito frete.
  - DELIVERY_FAILED com driver: só driver crédito frete.
  - idempotente ao rodar 2x.
- [ ] Implementar tipos:
  - `STORE_SALE_CREDIT`, `STORE_COMMISSION_DEBIT`, `STORE_DRIVER_FEE_DEBIT`, `DRIVER_DELIVERY_CREDIT`.
- [ ] Commit: `feat(finance): idempotent order ledger service`.

### Task 3: integrar ledger nos finais de pedido

**Files:** `apps/api/src/services/order-status.service.ts`, `apps/api/src/services/dispatch.service.ts`, testes existentes.

- [ ] Após loja marcar `PICKUP` como `DELIVERED`, registrar ledger.
- [ ] Após driver `deliver`, registrar ledger.
- [ ] Após driver `fail`, registrar ledger.
- [ ] Garantir idempotência se rota repetir/concorrer.
- [ ] Commit: `feat(finance): record ledger when orders become terminal`.

### Task 4: settlement service

**Files:** `apps/api/src/services/finance-settlement.service.ts`, `apps/api/test/finance-settlement.service.test.ts`.

- [ ] `createFinanceSettlement(db, { periodStart, periodEnd })`:
  - cria faturas de loja com soma negativa invertida para cobrança.
  - cria payouts de loja com soma positiva.
  - cria payouts de driver com soma positiva.
  - ignora entradas já vinculadas.
  - rodar 2x não duplica.
- [ ] `markStoreInvoicePaid`, `markStorePayoutPaid`, `markDriverPayoutPaid`.
- [ ] Commit: `feat(finance): manual weekly settlement generation`.

### Task 5: API routes

**Files:** `apps/api/src/routes/finance.ts`, `apps/api/src/app.ts`, tests em `apps/api/test/finance.routes.test.ts`.

- [ ] Admin:
  - `POST /admin/finance/settlements` body `{ periodStart, periodEnd }`.
  - `GET /admin/finance/settlements`.
  - `PATCH /admin/finance/store-invoices/:id/paid`.
  - `PATCH /admin/finance/store-payouts/:id/paid`.
  - `PATCH /admin/finance/driver-payouts/:id/paid`.
- [ ] Store:
  - `GET /store/me/finance`.
- [ ] Driver:
  - `GET /driver/me/finance`.
- [ ] Autorização: admin/store/driver isolados; customer 403.
- [ ] Commit: `feat(api): finance settlement and statement routes`.

### Task 6: admin/store/driver UI

**Files:** web router/layout/views, driver router/layout/view.

- [ ] Web admin `/admin/financeiro`: período, gerar fechamento, listas faturas/payouts, botões marcar pago.
- [ ] Loja `/loja/financeiro`: fatura aberta, payout aberto, últimos lançamentos.
- [ ] Driver `/financeiro`: payout aberto/pago, últimos lançamentos.
- [ ] Build web/driver + typecheck.
- [ ] Commit: `feat(web): finance admin and statements`.

### Task 7: docs + final

- [ ] Atualizar `README.md`: Plano 8 como ✅.
- [ ] Atualizar `docs/runbooks/repasse-semanal.md`: agora usar tela admin/financeiro; SQL vira fallback.
- [ ] Atualizar `docs/carry-forwards.md`: remover “Plano 8 ledger”; adicionar “payout real PIX/banco fora do sistema”.
- [ ] Gate final: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.
- [ ] Commit: `docs: finance ledger wrap-up`.


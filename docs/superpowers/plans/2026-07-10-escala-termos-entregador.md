# Plano ④a-2 — Termos do vínculo (proposta+confirmação) e ajuste de turno ativo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Alterar valores/dias de um vínculo vira **proposta que o entregador precisa confirmar** — a loja não muda o combinado sem o entregador ver; termos antigos valem até o aceite. (B) A loja pode **reajustar o turno em andamento** (diária/extra) e, opcionalmente, **aplicar o novo extra às entregas já feitas** naquele turno (via lançamentos de ajuste no ledger imutável).

**Architecture:** `store_drivers` ganha campos `pending*` (proposta de termos); `updateLinkTerms` vira `proposeLinkTerms` (não altera os ativos) + `confirmLinkTermsChange`/`rejectLinkTermsChange` (entregador). `driver_shifts` ganha `adjustmentSeq`; novo `updateActiveShift` altera o turno ativo e, se `applyRetroactive`, insere entradas de ajuste (delta) por pedido já entregue. Entregas futuras do turno já usam o novo extra automaticamente (o ledger lê `shift.perDeliveryCents` ao vivo em cada entrega). Diária alterada vale no encerramento.

**Tech Stack:** Hono + Drizzle (Postgres), Zod, Vue 3 (web loja + app driver), Vitest contra Postgres real.

---

## Contexto verificado (não regredir)

- O turno **congela** `dailyRateCents`/`perDeliveryCents` em `driver_shifts` no início. `recordOrderLedger` lê `shift.perDeliveryCents` (do turno) na entrega; `recordShiftDaily` usa `shift.dailyRateCents` no encerramento. `updateLinkTerms` hoje só toca `store_drivers`. **Logo: mudar termos do vínculo NÃO afeta turno feito/em andamento** — este plano preserva isso.
- Ledger é **imutável** (insert-only, `uniqueKey`). Ajustes retroativos = NOVAS entradas de delta, nunca UPDATE.

## Guardrails

1. **Termos ativos só mudam com aceite do entregador.** `proposeLinkTerms` escreve em `pending*`; os campos ativos (`dailyRateCents`/`perDeliveryCents`/`schedule`) só mudam em `confirmLinkTermsChange`. Turnos futuros usam sempre o ativo confirmado.
2. **Convite inicial inalterado:** `inviteDriver` (INVITED) + `confirmLink` (INVITED→CONFIRMED) seguem como estão. Proposta de termos só existe em vínculo já CONFIRMED.
3. **Ajuste de turno é imutável-safe:** nunca alterar entradas do ledger; retroativo insere delta com `uniqueKey` versionado (`adjustmentSeq`).
4. **Tenant:** loja só propõe/ajusta no que é dela; entregador só confirma/recusa proposta dele. Cross → 404.
5. **Turnos e ledger existentes intactos.** Freelance intacto. Testes contra Postgres real. TDD. **Sem coautor** (hook garante). Gate final `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

---

### Task 1: Schema — proposta de termos + seq de ajuste

**Files:** Modify `apps/api/src/db/schema/store-drivers.ts`; migration.

- [ ] **Step 1:** em `storeDrivers`, adicionar:
```ts
  pendingDailyRateCents: integer('pending_daily_rate_cents'),
  pendingPerDeliveryCents: integer('pending_per_delivery_cents'),
  pendingSchedule: jsonb('pending_schedule').$type<{ dow: number; start: string; end: string }[]>(),
  pendingProposedAt: timestamp('pending_proposed_at', { withTimezone: true }),
```
em `driverShifts`, adicionar:
```ts
  adjustmentSeq: integer('adjustment_seq').notNull().default(0),
```
- [ ] **Step 2:** `pnpm --filter @delivery/api db:generate && db:migrate`.
- [ ] **Step 3:** commit `feat(own-drivers): pending terms fields + shift adjustment seq`.

---

### Task 2: Service — proposta e confirmação de termos

**Files:** Modify `apps/api/src/services/store-driver.service.ts`; Test `apps/api/test/own-drivers.service.test.ts`.

- [ ] **Step 1: Testes falhando**
  - `proposeLinkTerms(storeId, linkId, terms)` em vínculo CONFIRMED: NÃO muda `dailyRateCents`/`perDeliveryCents`/`schedule` ativos; grava `pending*` + `pendingProposedAt`.
  - `confirmLinkTermsChange(driverUserId, linkId)`: aplica pending→ativo, limpa pending. Só o próprio entregador; 404 se não é dele; 409 se não há proposta.
  - `rejectLinkTermsChange(driverUserId, linkId)`: limpa pending sem alterar ativo.
  - Propor de novo antes de confirmar: sobrescreve o pending.

- [ ] **Step 2: Implementar** — substituir `updateLinkTerms` por `proposeLinkTerms` (mesma assinatura, mas grava em `pending*`; aceita terms parciais → pending recebe o valor proposto ou o ativo atual quando ausente). Adicionar as duas funções do entregador (guardam `driverUserId` + `status='CONFIRMED'`). `listStoreDrivers` e `listDriverLinks` passam a devolver os `pending*` (pra UI mostrar “aguardando confirmação” / “termos alterados”).

```ts
export async function proposeLinkTerms(db: Db, storeId: string, linkId: string, terms: Partial<StoreDriverTerms>) {
  const [link] = await db.select().from(storeDrivers)
    .where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.storeId, storeId), eq(storeDrivers.status, 'CONFIRMED')))
    .limit(1)
  if (!link) throw new StoreDriverError('Vínculo confirmado não encontrado', 404)
  const [row] = await db.update(storeDrivers).set({
    pendingDailyRateCents: terms.dailyRateCents ?? link.dailyRateCents,
    pendingPerDeliveryCents: terms.perDeliveryCents ?? link.perDeliveryCents,
    pendingSchedule: terms.schedule ?? link.schedule,
    pendingProposedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(storeDrivers.id, linkId)).returning()
  return row!
}

export async function confirmLinkTermsChange(db: Db, driverUserId: string, linkId: string) {
  const [link] = await db.select().from(storeDrivers)
    .where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.driverUserId, driverUserId))).limit(1)
  if (!link || link.pendingProposedAt == null) throw new StoreDriverError('Sem alteração pendente', 409)
  const [row] = await db.update(storeDrivers).set({
    dailyRateCents: link.pendingDailyRateCents!, perDeliveryCents: link.pendingPerDeliveryCents!,
    schedule: link.pendingSchedule!,
    pendingDailyRateCents: null, pendingPerDeliveryCents: null, pendingSchedule: null, pendingProposedAt: null,
    updatedAt: new Date(),
  }).where(eq(storeDrivers.id, linkId)).returning()
  return row!
}

export async function rejectLinkTermsChange(db: Db, driverUserId: string, linkId: string) {
  const [row] = await db.update(storeDrivers).set({
    pendingDailyRateCents: null, pendingPerDeliveryCents: null, pendingSchedule: null, pendingProposedAt: null,
    updatedAt: new Date(),
  }).where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.driverUserId, driverUserId))).returning()
  if (!row) throw new StoreDriverError('Vínculo não encontrado', 404)
  return row
}
```
> Ajustar imports (`jsonb` type já existe via schema). Remover/renomear referências a `updateLinkTerms` (rota + testes).

- [ ] **Step 3:** rodar + commit `feat(own-drivers): terms change is a proposal the driver confirms`.

---

### Task 3: Service — ajuste do turno em andamento (+ retroativo)

**Files:** Modify `apps/api/src/services/shift.service.ts`, `apps/api/src/services/finance.service.ts`; Test `apps/api/test/own-drivers.service.test.ts`.

- [ ] **Step 1: Testes falhando**
  - `updateActiveShift(storeId, shiftId, { perDeliveryCents: 700, applyRetroactive: true })` num turno com 2 entregas já feitas a 500: turno passa a 700; ledger ganha ajuste +200 (driver) / −200 (store) por pedido entregue; próxima entrega credita 700.
  - `applyRetroactive: false`: turno vira 700, entregas antigas ficam 500, próximas 700.
  - Alterar `dailyRateCents` do turno ativo → diária no encerramento usa o novo.
  - Só turno ACTIVE da loja; 404 caso contrário.
  - Idempotente: rodar o mesmo ajuste 2x (mesmo `adjustmentSeq`) não duplica.

- [ ] **Step 2: Implementar `updateActiveShift`** (em `shift.service.ts`):
```ts
export async function updateActiveShift(
  db: Db, storeId: string, shiftId: string,
  input: { dailyRateCents?: number; perDeliveryCents?: number; applyRetroactive?: boolean },
) {
  return db.transaction(async (tx) => {
    const [shift] = await tx.select().from(driverShifts)
      .where(and(eq(driverShifts.id, shiftId), eq(driverShifts.storeId, storeId), eq(driverShifts.status, 'ACTIVE')))
      .for('update')
    if (!shift) throw new ShiftError('Turno ativo não encontrado', 404)
    const oldPer = shift.perDeliveryCents
    const newPer = input.perDeliveryCents ?? oldPer
    const newDaily = input.dailyRateCents ?? shift.dailyRateCents
    const seq = shift.adjustmentSeq + 1
    const [updated] = await tx.update(driverShifts)
      .set({ perDeliveryCents: newPer, dailyRateCents: newDaily, adjustmentSeq: seq })
      .where(eq(driverShifts.id, shiftId)).returning()
    if (input.applyRetroactive && newPer !== oldPer) {
      const delta = newPer - oldPer
      const delivered = await tx.select({ id: orders.id }).from(orders)
        .where(and(eq(orders.shiftId, shiftId), eq(orders.status, 'DELIVERED')))
      await recordPerDeliveryAdjustment(tx, { shiftId, seq, storeId, driverUserId: shift.driverUserId, orderIds: delivered.map((o) => o.id), delta })
    }
    return updated!
  })
}
```
- [ ] **Step 3: `recordPerDeliveryAdjustment`** (em `finance.service.ts`) — insere delta por pedido, idempotente por `seq`:
```ts
export async function recordPerDeliveryAdjustment(
  db: LedgerWriter,
  p: { shiftId: string; seq: number; storeId: string; driverUserId: string; orderIds: string[]; delta: number },
) {
  if (p.delta === 0) return
  const entries: LedgerInput[] = []
  for (const orderId of p.orderIds) {
    entries.push(
      { party: 'DRIVER', type: 'DRIVER_PER_DELIVERY_CREDIT', amountCents: p.delta,
        description: 'Ajuste de extra por entrega', uniqueKey: `${orderId}:driver-per-delivery-adj:v${p.seq}`,
        orderId, driverId: p.driverUserId },
      { party: 'STORE', type: 'STORE_PER_DELIVERY_DEBIT', amountCents: -p.delta,
        description: 'Ajuste de extra por entrega (entregador fixo)', uniqueKey: `${orderId}:store-per-delivery-adj:v${p.seq}`,
        orderId, storeId: p.storeId },
    )
  }
  await insertEntries(db, entries)
}
```
> Reaproveita os tipos `DRIVER_PER_DELIVERY_CREDIT`/`STORE_PER_DELIVERY_DEBIT` com valor = delta (pode ser negativo se a loja reduzir). Entregas futuras do turno já pegam `newPer` porque `recordOrderLedger` lê `shift.perDeliveryCents` ao vivo — nenhuma mudança lá.

- [ ] **Step 4:** rodar + commit `feat(own-drivers): adjust active shift pay with optional retroactive ledger delta`.

---

### Task 4: Rotas

**Files:** Modify `apps/api/src/routes/store-drivers.ts`, `apps/api/src/routes/driver.ts`, `apps/api/src/routes/store-orders.ts` (onde estiver a rota de shift); Test `apps/api/test/own-drivers.routes.test.ts`.

- [ ] Loja: trocar `PATCH /store/me/drivers/{id}` para chamar `proposeLinkTerms` (agora é proposta). Nova: `PATCH /store/me/shifts/{id}` body `{ dailyRateCents?, perDeliveryCents?, applyRetroactive? }` → `updateActiveShift`.
- [ ] Entregador: `POST /driver/links/{id}/terms/confirm` → `confirmLinkTermsChange`; `POST /driver/links/{id}/terms/reject` → `rejectLinkTermsChange`.
- [ ] Testes: propor→ativo inalterado→driver confirma→ativo muda; ajuste retroativo reflete no ledger; tenant/roles.
- [ ] Commit `feat(api): routes for term proposals and active-shift adjustment`.

---

### Task 5: UI loja

**Files:** Modify `apps/web/src/views/store/StoreDriversView.vue`.

- [ ] "Editar" agora **propõe** (aviso: "o entregador precisa confirmar"). Mostrar badge "⏳ aguardando confirmação" quando `pendingProposedAt` != null (exibir de/para).
- [ ] Nos **turnos ativos**: botão "Reajustar" → mini-form (nova diária / novo extra em R$ + checkbox "aplicar às entregas já feitas") → `PATCH /store/me/shifts/{id}`.
- [ ] Build + commit `feat(web): propose terms + adjust active shift`.

---

### Task 6: UI entregador

**Files:** Modify `apps/driver/src/views/StoresView.vue` (+ barra do layout se quiser sinalizar).

- [ ] Quando `pendingProposedAt` != null: card mostra "🔔 A loja propôs novos termos" com de/para (diária, extra, dias) e botões **Aceitar** / **Recusar** (`/driver/links/{id}/terms/confirm|reject`). Após ação, recarrega (e a barra via `reloadDriverBar`).
- [ ] Build + commit `feat(driver): accept or reject store term changes`.

---

### Task 7: Docs + gate

- [ ] README/carry-forwards: registrar (a) termos agora exigem confirmação do entregador; (b) ajuste de turno ativo com retroativo; (c) **escala avançada por dia (valor/horário por dia) = plano futuro** (schema: valor por item da agenda).
- [ ] Gate `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.
- [ ] Commit `docs: terms proposal + shift adjustment wrap-up`.

---

## Resumo pro executor

- **Termos = proposta:** editar valores/dias grava `pending*`; entregador aceita/recusa; ativo só muda no aceite; turnos futuros usam o ativo confirmado.
- **Turno ativo:** loja reajusta diária/extra; futuras entregas já usam o novo (ledger lê o turno ao vivo); retroativo opcional insere delta por pedido entregue (ledger imutável, `uniqueKey` versionado por `adjustmentSeq`).
- **Preservar:** snapshot do turno; imutabilidade do ledger; freelance; convite inicial.
- **Fora de escopo (futuro):** escala com valor/horário DIFERENTE por dia (precisa valor por item da agenda + editor rico).

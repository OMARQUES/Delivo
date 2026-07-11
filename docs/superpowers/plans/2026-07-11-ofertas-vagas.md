# Plano ④c — Ofertas/Vagas de Trabalho Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Loja publica **vagas de trabalho** (diária + extra/entrega, N vagas, recorrência: datas específicas OU dias da semana) numa aba de **Ofertas** do app do entregador; ele vê detalhes e **aceita/dispensa**. Aceitar exige **não sobrepor horário** com agenda já existente (outras lojas) e cria automaticamente o **vínculo confirmado** com a agenda da oferta — datas específicas geram **vínculo temporário que expira sozinho**.

**Architecture:** Nova tabela `driver_offers` (+ `offer_acceptances`). Recorrência em 2 formas: `{ kind: 'DATES', dates: ['2026-07-18', ...] }` e `{ kind: 'WEEKLY', days: [1,5] }` ("toda segunda do mês" = WEEKLY com [1]) — mesma janela `start`/`end` (overnight suportado: end ≤ start = vira o dia). Aceite atômico por vagas (`WHERE accepted_count < slots`). Conflito de horário = **funções puras em shared** (interseção de janelas com overnight + expansão dow×datas) com testes pesados. Aceite cria/reativa `store_drivers` CONFIRMED com os termos da oferta; agenda ganha suporte a item por **data concreta** (`{ date, start, end }` além de `{ dow, start, end }`) e o vínculo temporário ganha `expiresAt` (lazy: vínculo expirado é tratado como REMOVED nos guards).

**Tech Stack:** Hono + Drizzle (Postgres), Zod, Vue 3 (web loja + driver), Vitest contra Postgres real.

---

## Decisões travadas (não desviar)

1. **N vagas por oferta.** Loja define `slots`; cada aceite ocupa 1 (atômico); oferta fecha ao preencher ou quando a loja encerra.
2. **Recorrência do MVP:** datas específicas (1..N datas) OU dias da semana. "Toda segunda do mês" = WEEKLY `[1]`. Sem regra "1ª segunda do mês" (carry-forward se pedirem).
3. **Data única/específicas → vínculo temporário:** agenda com as datas concretas; `expiresAt` = último dia + 1; expirado = não inicia turno, some das listas (lazy, sem cron novo).
4. **Conflito de horário bloqueia o aceite** (409 com mensagem clara): sobreposição contra TODA agenda ativa do driver (vínculos CONFIRMED não expirados, dow e datas), janelas overnight incluídas. Ex.: seg 11–15h numa loja × seg 13–19h noutra = conflito.
5. **Aceite = vínculo CONFIRMED direto** (a loja já declarou os termos ao publicar; não há segunda confirmação). Reaproveita `store_drivers`; se já existe vínculo com a loja → 409 "já vinculado" (loja edita termos pelo fluxo de proposta existente).
6. **Dispensar** oferta = some da lista daquele driver (tabela de dismissals ou coluna no acceptance com status) — não gasta vaga.
7. **Turnos/dinheiro NÃO mudam:** turno continua congelando valores do vínculo; diária/extra/ledger prontos. Oferta é só porta de entrada.

## Guardrails

1. Aceite atômico: `UPDATE driver_offers SET accepted_count = accepted_count + 1 WHERE id=? AND status='OPEN' AND accepted_count < slots` — 0 linhas = 409 "vagas esgotadas". Corrida N drivers × últimas vagas testada com `Promise.allSettled`.
2. Funções puras de conflito em `packages/shared` com testes exaustivos (overnight, dow×data, datas×datas, bordas exatas — fim 15:00 + início 15:00 NÃO conflita).
3. Vínculo expirado (`expiresAt < hoje` em SP): `startShift` recusa, listas filtram, dispatch OWN/SPECIFIC não alcança. Um helper único `isLinkActive(link, todaySP)` usado em todos.
4. Tenant/RBAC: loja só gerencia ofertas dela; driver vê ofertas OPEN de qualquer loja; customer 403.
5. Dinheiro: centavos storage / R$ UI (`formatBRL`/`parseBRLToCents`). Datas de agenda no fuso **America/Sao_Paulo** (helpers existentes em shift.service — reusar padrão `saoPauloParts`).
6. Testes contra Postgres real; TDD; **sem coautor**; gate final `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

---

### Task 1: Shared — tipos de recorrência + funções puras de conflito

**Files:** Create `packages/shared/src/offers.ts` + `offers.test.ts`; export no barrel `constants`; schemas zod em `packages/shared/src/offer.schema.ts` (+ barrel `schemas`).

- [ ] **Step 1: Testes falhando** (`offers.test.ts`) — cobrir no mínimo:
```ts
// occursOnDow / expansão
expect(offerOccursOnDow({ kind: 'WEEKLY', days: [1, 5] }, 5)).toBe(true)
expect(offerDates({ kind: 'DATES', dates: ['2026-07-18'] })).toEqual(['2026-07-18'])
// janelas: overlap simples, borda exata NÃO conflita, overnight
expect(windowsOverlap({ start: '11:00', end: '15:00' }, { start: '13:00', end: '19:00' })).toBe(true)
expect(windowsOverlap({ start: '11:00', end: '15:00' }, { start: '15:00', end: '19:00' })).toBe(false)
expect(windowsOverlap({ start: '17:00', end: '03:00' }, { start: '01:00', end: '05:00' })).toBe(true)  // overnight
// conflito agenda × oferta (dow×dow, dow×data — data cai no dow, data×data)
const agenda = [{ dow: 1, start: '11:00', end: '15:00' }]
expect(scheduleConflicts(agenda, weeklyOffer([1], '13:00', '19:00'))).toBe(true)
expect(scheduleConflicts(agenda, weeklyOffer([2], '13:00', '19:00'))).toBe(false)
expect(scheduleConflicts(agenda, datesOffer(['2026-07-13'], '13:00', '19:00'))).toBe(true) // 13/07/2026 = segunda
expect(scheduleConflicts([{ date: '2026-07-18', start: '10:00', end: '14:00' }], datesOffer(['2026-07-18'], '12:00', '16:00'))).toBe(true)
```
- [ ] **Step 2: Implementar** — tipos:
```ts
export type OfferRecurrence =
  | { kind: 'DATES'; dates: string[] }        // 'YYYY-MM-DD', 1..30 datas
  | { kind: 'WEEKLY'; days: number[] }        // 0..6, 1..7 dias
export type ScheduleWindow = { start: string; end: string } // HH:MM; end<=start = overnight
export type ScheduleItem = ({ dow: number } | { date: string }) & ScheduleWindow
```
Funções puras: `windowsOverlap` (minutos, overnight = end+1440; comparar também o overflow do dia anterior), `dateToDowSP(dateStr)` (dow de uma data — cálculo civil puro, sem TZ do runtime), `scheduleConflicts(existing: ScheduleItem[], offer: { recurrence, start, end }): boolean` — expande e compara: dow×dow (mesmo dow OU dow adjacente com overnight), dow×date (data→dow), date×date (mesmo dia OU adjacente com overnight). **Documentar** a regra de adjacência overnight nos comentários.
Zod: `OfferCreateSchema` (dailyRateCents/perDeliveryCents Cents, slots 1..20, recurrence union com refine — DATES: datas válidas futuras ≥ hoje, max 30; WEEKLY: days únicos 0..6 —, start/end HH:MM).
- [ ] **Step 3:** rodar + commit `feat(shared): offer recurrence types and pure schedule-conflict functions`.

---

### Task 2: Schema DB

**Files:** Create `apps/api/src/db/schema/offers.ts`; modify `store-drivers.ts` (agenda com datas + expiresAt), `index.ts`; migration.

- [ ] `driver_offers`: id, storeId FK, status enum `('OPEN','CLOSED')` default OPEN, dailyRateCents, perDeliveryCents, slots int, acceptedCount int default 0, recurrence jsonb `$type<OfferRecurrence>`, startTime text, endTime text, note text null, createdAt/updatedAt. Index (status), (storeId, status).
- [ ] `offer_acceptances`: id, offerId FK cascade, driverUserId FK, status enum `('ACCEPTED','DISMISSED')`, createdAt; unique (offerId, driverUserId).
- [ ] `store_drivers`: `schedule` passa a `$type<ScheduleItem[]>` (shape novo do shared — retrocompatível: itens antigos têm `dow`); adicionar `expiresAt: timestamp nullable` (+ mesmo em `pendingSchedule` type).
- [ ] Migration + commit `feat(offers): driver_offers and acceptances tables, dated schedule + link expiry`.

---

### Task 3: Service — publicar/gerenciar ofertas (loja)

**Files:** Create `apps/api/src/services/offer.service.ts`; Test `apps/api/test/offers.service.test.ts`.

- [ ] Testes → impl: `createOffer(db, storeId, input)` (valida via schema na rota; service assume validado); `closeOffer(db, storeId, offerId)` (OPEN→CLOSED, tenant 404); `listStoreOffers(db, storeId)` (com aceites: nome/telefone dos drivers ACCEPTED); `listOpenOffers(db, driverUserId)` (status OPEN, `accepted_count < slots`, exclui ofertas que o driver já aceitou/dispensou, inclui nome/endereço da loja).
- [ ] Commit `feat(offers): store publishes and manages job offers`.

---

### Task 4: Service — aceite com conflito + vínculo automático; dispensa

**Files:** Modify `offer.service.ts`; Test.

- [ ] **Testes falhando:**
  - Aceite feliz: cria `offer_acceptances` ACCEPTED, incrementa `acceptedCount`, cria `store_drivers` **CONFIRMED** com termos da oferta e agenda expandida (WEEKLY → itens `{dow,start,end}`; DATES → itens `{date,start,end}` + `expiresAt` = última data +1d em SP).
  - Conflito: driver com vínculo seg 11–15h aceita oferta seg 13–19h → 409 com "conflito de horário"; sem gasto de vaga.
  - Corrida: oferta com 1 vaga, 2 drivers aceitam simultâneo (`Promise.allSettled`) → exatamente 1 sucesso, 1 409 "esgotadas".
  - Já vinculado à loja → 409; re-aceitar → 409 (unique).
  - `dismissOffer`: marca DISMISSED, some de `listOpenOffers` daquele driver, não gasta vaga.
  - Vínculo REMOVED prévio com a loja → aceite **reativa** (mesmo padrão do reinvite) com termos/agenda da oferta.
- [ ] **Implementar `acceptOffer(db, driverUserId, offerId)`** — tx:
  1. `SELECT ... FROM driver_offers WHERE id=? AND status='OPEN' FOR UPDATE`; 404 se não.
  2. Carregar agenda ativa do driver: vínculos CONFIRMED não expirados (todas as lojas) → `ScheduleItem[]`; `scheduleConflicts(existing, offer)` → 409.
  3. Claim de vaga: `UPDATE driver_offers SET accepted_count = accepted_count + 1 WHERE id=? AND accepted_count < slots AND status='OPEN' RETURNING` → 0 linhas = 409 esgotadas. Se encheu (`accepted_count === slots`), `status='CLOSED'` no mesmo UPDATE ou em seguida.
  4. `INSERT offer_acceptances` (unique 409 → mapear "você já respondeu esta oferta").
  5. Vínculo: se existe REMOVED → reativar (CONFIRMED, termos+agenda+expiresAt da oferta, pending* limpos); se existe ativo → throw 409 (feito ANTES do claim, no passo 2); senão INSERT CONFIRMED.
- [ ] **`isLinkActive` + expiry lazy:** helper em `store-driver.service.ts`:
```ts
export function isLinkExpired(link: { expiresAt: Date | null }, now = new Date()) {
  return link.expiresAt != null && link.expiresAt <= now
}
```
Aplicar: `startShift` (409 "vínculo expirado"), `listDriverLinks`/`listStoreDrivers` (filtrar expirados), `listShiftDriverTokens` e validação SPECIFIC (não alcançar expirado). Testes de cada guard.
- [ ] Commit `feat(offers): atomic slot accept with schedule-conflict guard and auto link`.

---

### Task 5: Rotas

**Files:** `apps/api/src/routes/store-drivers.ts` (ou novo `offers.ts`), `driver.ts`; Test rotas.

```
POST   /store/me/offers          body OfferCreateSchema      createOffer
GET    /store/me/offers                                       listStoreOffers
POST   /store/me/offers/{id}/close                            closeOffer
GET    /driver/offers                                         listOpenOffers
POST   /driver/offers/{id}/accept                             acceptOffer
POST   /driver/offers/{id}/dismiss                            dismissOffer
```
- [ ] RBAC/tenant; mapear `OfferError` no rethrow. Testes: fluxo completo, 409s, customer 403. Commit `feat(api): offer routes`.

---

### Task 6: UI loja — publicar e acompanhar vagas

**Files:** Modify `apps/web/src/views/store/StoreDriversView.vue` (nova seção "Vagas") — ou nova view `/loja/vagas` + nav se a tela ficar grande (decisão do implementador; manter padrão utilitário).

- [ ] Form publicar: diária R$, extra R$, vagas (número), tipo de recorrência (radio: "Datas específicas" → input múltiplo de datas; "Dias da semana" → checkboxes Dom..Sáb), horário início/fim, observação. Validação de conflito NÃO é da loja (é do aceite).
- [ ] Lista de ofertas: status, vagas `aceitas/total`, recorrência legível ("Sex, Sáb · 17:00–01:00" / "18/07, 25/07 · ..."), aceites (nomes), botão "Encerrar".
- [ ] Build + commit `feat(web): store publishes job offers`.

---

### Task 7: UI driver — aba Ofertas

**Files:** Create `apps/driver/src/views/OffersView.vue`; modify router + `DriverLayout.vue` (nav "Vagas").

- [ ] Lista de ofertas abertas: loja, endereço, diária/extra em R$, recorrência legível, vagas restantes, observação. Botões **Aceitar** (confirm com resumo; erro 409 de conflito exibido claro) e **Dispensar**.
- [ ] Pós-aceite: mensagem "vínculo criado — veja em Minhas lojas" (agenda aparece lá; datas concretas mostram `dd/mm`).
- [ ] `StoresView`/`daysLabel`: suportar itens `{date}` além de `{dow}` (mostrar `18/07` etc.). Barra de turno (`DriverLayout`): contador do próximo turno também entende itens com `date` (data concreta → minutos até ela; ignora datas passadas).
- [ ] Build + commit `feat(driver): offers tab with accept/dismiss`.

---

### Task 8: Docs + gate

- [ ] README: ④c ✅. carry-forwards: "recorrência avançada (1ª segunda do mês etc.) fora do MVP"; "ofertas não notificam push (driver descobre pela aba) — avaliar FCM"; remover linhas obsoletas de ofertas se houver.
- [ ] Gate completo. Commit `docs: ofertas/vagas (plano 4c) wrap-up`.

---

## Resumo pro executor

- **Oferta:** N vagas, DATES ou WEEKLY, janela com overnight; aceite atômico por vaga; fecha ao encher/encerrar.
- **Aceite:** conflito de horário bloqueia (funções puras shared, testes pesados); cria vínculo CONFIRMED com termos/agenda da oferta; DATES → vínculo temporário com `expiresAt` (lazy expiry em turno/listas/dispatch).
- **Não mexer:** turnos, diária/extra/ledger, proposta de termos (fluxos prontos — oferta só cria o vínculo).
- **Invariantes:** vaga nunca ultrapassa `slots` (corrida testada); borda exata de horário não conflita; expirado não trabalha; tenant.

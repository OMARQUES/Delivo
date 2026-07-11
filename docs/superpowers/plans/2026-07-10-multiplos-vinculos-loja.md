# Múltiplos vínculos por loja + turno por vínculo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que um entregador tenha **N vínculos CONFIRMED na mesma loja** (fixo + ofertas), cada um com seus termos e agenda própria, restritos apenas a **não sobrepor horário**; e corrigir o guard de início de turno que hoje bloqueia um segundo turno na mesma loja no mesmo dia mesmo sem interseção de horário.

**Architecture:** O turno passa a apontar para o vínculo de origem (`driver_shifts.store_driver_id` FK). Isso (1) desfaz a ambiguidade "qual vínculo/termos usar" ao iniciar turno — o entregador escolhe o vínculo (`storeDriverId`) — e (2) mantém os JOINs de dispatch 1:1 (hoje eles casam `store_drivers` por `(store_id, driver_user_id)` e passariam a fanout com múltiplos vínculos). A não-sobreposição de horário vira **um único helper** (`schedulesConflict` no shared) aplicado em todos os pontos que criam/ativam um vínculo CONFIRMED (aceite de oferta, convite, confirmação de convite, confirmação de novos termos). O unique `(driver, store, work_date)` do turno é **substituído** por `(store_driver_id, work_date)`; o unique global "um turno ativo por entregador" é mantido.

**Tech Stack:** Hono + Drizzle (Postgres/Neon), Zod, Vue 3 (web loja + driver), Vitest contra Postgres real. Dinheiro em centavos (storage/API) / R$ (UI).

---

## Decisões travadas (não desviar)

1. **Múltiplos vínculos CONFIRMED por (loja, entregador).** O unique `store_drivers_unique (store_id, driver_user_id)` é **removido**. A única regra que limita vínculos é **não haver sobreposição de horário** contra a agenda ativa (CONFIRMED, não expirada) do entregador em **qualquer** loja.
2. **Turno escolhe o vínculo explicitamente.** `POST /driver/shifts` passa `storeDriverId` (não mais `storeId`). O turno grava `store_driver_id` (FK) e congela termos/agenda **daquele** vínculo.
3. **Regra de turno = global + janelas não sobrepostas.** Mantém `driver_shifts_one_active_per_driver` (um ativo por entregador). **Remove** `driver_shifts_driver_store_day_unique`. **Adiciona** `driver_shifts_link_day_unique (store_driver_id, work_date)` (um turno por vínculo por dia). No início do turno, recusa se a janela-de-hoje do vínculo sobrepõe a de outro turno do mesmo dia (defesa em profundidade).
4. **2 diárias cheias.** Dois turnos no mesmo dia (mesma loja ou não) pagam cada um sua diária congelada. **Não** adicionar dedupe de diária. Comportamento existente do `recordShiftDaily` fica intacto.
5. **Convite sempre cria vínculo novo** (§Task 3). Some a lógica "reconvidar reativa o mesmo registro REMOVED"; um novo convite cria um novo `store_drivers` INVITED; REMOVED vira histórico. Bloqueio só por sobreposição de horário contra vínculos CONFIRMED.
6. **Aceite de oferta sempre INSERE vínculo novo** (§Task 5). Remove o guard "Você já está vinculado a esta loja" e o upsert por `storeId`.
7. **Fuso America/Sao_Paulo** para toda comparação de data/dia (reusar helpers existentes: `saoPauloParts` em shift.service; `todaySP` padrão de offer.service).

## Guardrails

1. **Sem coautor Claude** em nenhum commit (padrão do repo).
2. **TDD**: teste falhando → implementação mínima → verde → commit. Testes contra Postgres real via `test/helpers/test-db` (`migrateTestDb`, `truncateAll`, `testDb`).
3. **Migration com backfill à mão** (Task 2): `store_driver_id` é NOT NULL numa tabela com linhas → o SQL gerado precisa ser editado para (a) adicionar coluna nullable, (b) backfill, (c) `SET NOT NULL`. O snapshot/journal do drizzle descrevem o estado final (NOT NULL) — editar só o `.sql` é seguro (o migrate roda o SQL, não re-difa).
4. **Rodar `pnpm --filter @delivery/api db:migrate` no banco de dev** após gerar a migration (senão a API dá 500 — ver `docs/migration-dev-db-gotcha`).
5. **Não** tocar em: finance/ledger (diária/extra), fluxo de proposta de termos além do que este plano especifica, ofertas (schema/recorrência), dispatch além dos 3 JOINs listados na Task 6.
6. Gate final: `pnpm typecheck && pnpm test && pnpm lint && pnpm build` a partir da raiz.

## Blast radius (mapeado — mexer só nestes)

- `packages/shared/src/offers.ts` — novo `schedulesConflict`.
- `apps/api/src/db/schema/store-drivers.ts` — FK + swap de índices + drop unique.
- `apps/api/drizzle/<nova>.sql` (+ `meta/`) — migration.
- `apps/api/src/services/store-driver.service.ts` — helper de conflito + invite/confirm/propose/confirmTerms.
- `apps/api/src/services/shift.service.ts` — `startShift` por `storeDriverId` + guard de janela + FK + remap de erro.
- `packages/shared/src/store-driver.schema.ts` — `StartShiftSchema`.
- `apps/api/src/routes/driver.ts` — rota `POST /driver/shifts`.
- `apps/api/src/services/offer.service.ts` — `acceptOffer` (remove guard/ upsert).
- `apps/api/src/services/batch.service.ts` + `apps/api/src/services/order-status.service.ts` — 3 JOINs por `store_driver_id`.
- `apps/driver/src/components/DriverLayout.vue` — botões por vínculo.
- `apps/web/src/views/store/StoreDriversView.vue` — rótulo de agenda por linha.
- Testes: `packages/shared/src/offers.test.ts`, `apps/api/test/offers.service.test.ts`, novos `apps/api/test/store-driver.service.test.ts` e `apps/api/test/shift.service.test.ts`, `apps/api/test/driver.routes.test.ts`.

---

### Task 1: Shared — `schedulesConflict` (ScheduleItem[] × ScheduleItem[])

**Files:**
- Modify: `packages/shared/src/offers.ts`
- Test: `packages/shared/src/offers.test.ts`

Contexto: hoje existe `scheduleConflicts(existing: ScheduleItem[], offer: OfferSchedule)`. Precisamos comparar **duas listas de ScheduleItem** (agenda × agenda), reutilizando o motor `itemsConflict` já testado (overnight, dow×data, data×data).

- [ ] **Step 1: Teste falhando** — anexar ao final do `describe` existente em `packages/shared/src/offers.test.ts`:

```ts
describe('schedulesConflict (agenda × agenda)', () => {
  it('detecta sobreposição simples no mesmo dow', () => {
    expect(schedulesConflict([{ dow: 1, start: '11:00', end: '15:00' }], [{ dow: 1, start: '13:00', end: '19:00' }])).toBe(true)
  })
  it('borda exata não conflita', () => {
    expect(schedulesConflict([{ dow: 1, start: '11:00', end: '15:00' }], [{ dow: 1, start: '15:00', end: '19:00' }])).toBe(false)
  })
  it('cauda overnight ocupa o dia seguinte', () => {
    expect(schedulesConflict([{ dow: 5, start: '17:00', end: '03:00' }], [{ dow: 6, start: '01:00', end: '05:00' }])).toBe(true)
  })
  it('data × data no mesmo dia', () => {
    expect(schedulesConflict([{ date: '2026-07-18', start: '10:00', end: '14:00' }], [{ date: '2026-07-18', start: '12:00', end: '16:00' }])).toBe(true)
  })
  it('dow × data (13/07/2026 é segunda)', () => {
    expect(schedulesConflict([{ dow: 1, start: '11:00', end: '15:00' }], [{ date: '2026-07-13', start: '13:00', end: '19:00' }])).toBe(true)
  })
  it('dias diferentes não conflitam', () => {
    expect(schedulesConflict([{ dow: 1, start: '11:00', end: '15:00' }], [{ dow: 2, start: '13:00', end: '19:00' }])).toBe(false)
  })
})
```

Garantir que `schedulesConflict` esteja no import do topo do arquivo de teste (junto de `scheduleConflicts`, `windowsOverlap`, etc.).

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @delivery/shared test -- offers`
Expected: FAIL — `schedulesConflict is not a function` / import não resolvido.

- [ ] **Step 3: Implementar** — em `packages/shared/src/offers.ts`, adicionar a função e refatorar `scheduleConflicts` para reusá-la (mantendo assinatura pública atual):

```ts
/** Conflito entre duas agendas concretas (mesma engine de overnight/dow×data). */
export function schedulesConflict(a: ScheduleItem[], b: ScheduleItem[]) {
  return a.some((left) => b.some((right) => itemsConflict(left, right)))
}
/** Overnight ocupa o dia adjacente; bordas são semiabertas e não conflitam. */
export function scheduleConflicts(existing: ScheduleItem[], offer: OfferSchedule) {
  return schedulesConflict(existing, offerScheduleItems(offer))
}
```

Confirmar que `packages/shared/src/index.ts` (barrel) reexporta `./offers` (já reexporta — `scheduleConflicts` é importado de `@delivery/shared` no offer.service). Nenhuma mudança de barrel se já houver `export * from './offers'`.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @delivery/shared test -- offers`
Expected: PASS (inclusive os testes já existentes).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/offers.ts packages/shared/src/offers.test.ts
git commit -m "feat(shared): schedulesConflict for agenda-vs-agenda overlap"
```

---

### Task 2: Schema DB — FK do turno + swap de índices + drop unique do vínculo

**Files:**
- Modify: `apps/api/src/db/schema/store-drivers.ts`
- Create: `apps/api/drizzle/<gerado>.sql` (+ `apps/api/drizzle/meta/*` via generate)

- [ ] **Step 1: Editar o schema (estado final).** Em `apps/api/src/db/schema/store-drivers.ts`:

Adicionar a coluna FK em `driverShifts` (logo após `driverUserId`):

```ts
    storeDriverId: uuid('store_driver_id').notNull().references(() => storeDrivers.id, { onDelete: 'restrict' }),
```

Trocar o bloco de índices de `driverShifts` para:

```ts
  (t) => [
    uniqueIndex('driver_shifts_link_day_unique').on(t.storeDriverId, t.workDate),
    uniqueIndex('driver_shifts_one_active_per_driver')
      .on(t.driverUserId)
      .where(sql`${t.status} = 'ACTIVE'`),
    index('driver_shifts_store_status_idx').on(t.storeId, t.status),
  ],
```

Remover, em `storeDrivers`, a linha do unique:

```ts
    uniqueIndex('store_drivers_unique').on(t.storeId, t.driverUserId),
```

(Manter o `check('store_drivers_pending_terms_complete', ...)`.)

- [ ] **Step 2: Gerar a migration**

Run: `pnpm --filter @delivery/api db:generate`
Expected: cria `apps/api/drizzle/00XX_*.sql` e atualiza `apps/api/drizzle/meta/`.

- [ ] **Step 3: Editar o `.sql` gerado para backfill seguro.** Abrir o novo arquivo em `apps/api/drizzle/`. Ele conterá (nomes podem variar) um `ADD COLUMN "store_driver_id" uuid NOT NULL` (que falharia em linhas existentes), o `ADD CONSTRAINT` da FK, os `DROP INDEX`/`CREATE INDEX` e o `DROP INDEX "store_drivers_unique"`. **Substituir todo o conteúdo do arquivo** por esta sequência (mantendo os `--> statement-breakpoint` entre statements):

```sql
DROP INDEX "store_drivers_unique";--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD COLUMN "store_driver_id" uuid;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_store_driver_id_store_drivers_id_fk" FOREIGN KEY ("store_driver_id") REFERENCES "public"."store_drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
UPDATE "driver_shifts" ds SET "store_driver_id" = sd."id" FROM "store_drivers" sd WHERE sd."store_id" = ds."store_id" AND sd."driver_user_id" = ds."driver_user_id";--> statement-breakpoint
ALTER TABLE "driver_shifts" ALTER COLUMN "store_driver_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "driver_shifts_driver_store_day_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "driver_shifts_link_day_unique" ON "driver_shifts" USING btree ("store_driver_id","work_date");
```

Observações:
- O backfill é determinístico porque, **antes** desta migration, `store_drivers_unique` garante 1:1 por `(store_id, driver_user_id)` — inclusive para vínculos REMOVED (não são apagados). Fazer o `DROP INDEX "store_drivers_unique"` antes do backfill não afeta a unicidade histórica.
- Não alterar `apps/api/drizzle/meta/` (ele já reflete o estado final NOT NULL).

- [ ] **Step 4: Migrar o banco de dev** (obrigatório — senão a API dá 500):

Run: `pnpm --filter @delivery/api db:migrate`
Expected: aplica sem erro; `\d driver_shifts` mostra `store_driver_id NOT NULL` e o índice `driver_shifts_link_day_unique`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/store-drivers.ts apps/api/drizzle
git commit -m "feat(shifts): link shifts to store_drivers; multi-link per store"
```

---

### Task 3: store-driver.service — helper de conflito + convite/confirmação sem assumir 1 vínculo

**Files:**
- Modify: `apps/api/src/services/store-driver.service.ts`
- Test: `apps/api/test/store-driver.service.test.ts` (Create)

- [ ] **Step 1: Testes falhando.** Criar `apps/api/test/store-driver.service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'
import { createStoreWithOwner } from '../src/services/store.service'
import { registerUser } from '../src/services/auth.service'
import { users } from '../src/db/schema'
import {
  StoreDriverError, confirmLink, inviteDriver, listStoreDrivers,
} from '../src/services/store-driver.service'

let storeA: string
let storeB: string
let driverPhone: string
let driverId: string

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  const base = { category: 'RESTAURANTE' as const, city: 'Maringá', addressText: 'Rua A', lat: -23.4, lng: -51.9 }
  storeA = (await createStoreWithOwner(testDb, { ...base, phone: '4433334444', name: 'A', slug: 'link-a', owner: { name: 'A', email: 'a@link.test', password: 'senha123' } })).id
  storeB = (await createStoreWithOwner(testDb, { ...base, phone: '4433335555', name: 'B', slug: 'link-b', owner: { name: 'B', email: 'b@link.test', password: 'senha123' } })).id
  driverPhone = '44911112222'
  const reg = await registerUser(testDb, { name: 'Driver', phone: driverPhone, password: 'senha123', role: 'DRIVER', acceptedTerms: true }, 'secret')
  driverId = reg.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverId))
})
afterAll(closeTestDb)

const terms = (schedule: object[]) => ({ dailyRateCents: 8_000, perDeliveryCents: 700, schedule: schedule as never })

describe('múltiplos vínculos por loja', () => {
  it('cria um segundo vínculo na MESMA loja quando não há sobreposição', async () => {
    const first = await inviteDriver(testDb, storeA, driverPhone, terms([{ dow: 1, start: '08:00', end: '12:00' }]))
    await confirmLink(testDb, driverId, first.id)
    const second = await inviteDriver(testDb, storeA, driverPhone, terms([{ dow: 1, start: '18:00', end: '22:00' }]))
    await confirmLink(testDb, driverId, second.id)
    const links = await listStoreDrivers(testDb, storeA)
    expect(links).toHaveLength(2)
  })

  it('bloqueia convite com horário sobreposto a vínculo CONFIRMED (qualquer loja)', async () => {
    const first = await inviteDriver(testDb, storeA, driverPhone, terms([{ dow: 1, start: '08:00', end: '12:00' }]))
    await confirmLink(testDb, driverId, first.id)
    await expect(inviteDriver(testDb, storeB, driverPhone, terms([{ dow: 1, start: '10:00', end: '14:00' }])))
      .rejects.toMatchObject({ status: 409 })
  })

  it('bloqueia confirmar convite se a agenda passou a sobrepor outro CONFIRMED', async () => {
    const fixed = await inviteDriver(testDb, storeA, driverPhone, terms([{ dow: 1, start: '10:00', end: '14:00' }]))
    // convite B criado quando ainda não havia CONFIRMED sobreposto...
    const invited = await inviteDriver(testDb, storeB, driverPhone, terms([{ dow: 1, start: '11:00', end: '15:00' }]))
    await confirmLink(testDb, driverId, fixed.id) // agora A está CONFIRMED e sobrepõe B
    await expect(confirmLink(testDb, driverId, invited.id)).rejects.toBeInstanceOf(StoreDriverError)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @delivery/api test -- store-driver.service`
Expected: FAIL — hoje o segundo `inviteDriver` na mesma loja lança "Entregador já vinculado à loja" (409) e `confirmLink` não checa conflito.

- [ ] **Step 3: Implementar.** Em `apps/api/src/services/store-driver.service.ts`:

Ajustar imports do topo (adicionar `schedulesConflict` e `ScheduleItem`; `inArray`/`ne` continuam):

```ts
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { normalizePhone } from '@delivery/shared/schemas'
import { schedulesConflict, type ScheduleItem } from '@delivery/shared'
import type { Db } from '../db/client'
import { storeDrivers, stores, users, type DriverSchedule } from '../db/schema'
```

Adicionar helpers (após `isLinkActive`):

```ts
function todaySP(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Agenda ativa (CONFIRMED, não expirada) do entregador em todas as lojas; itens datados passados removidos. */
export async function driverActiveSchedule(db: Db, driverUserId: string, excludeLinkId?: string): Promise<ScheduleItem[]> {
  const links = await db.select().from(storeDrivers).where(and(
    eq(storeDrivers.driverUserId, driverUserId), eq(storeDrivers.status, 'CONFIRMED'),
  ))
  const today = todaySP()
  return links
    .filter((link) => link.id !== excludeLinkId && !isLinkExpired(link))
    .flatMap((link) => link.schedule)
    .filter((item) => !('date' in item) || item.date >= today)
}

/** Lança 409 se `candidate` sobrepõe a agenda ativa do entregador. Passar `tx` quando dentro de transação. */
export async function assertNoScheduleConflict(db: Db, driverUserId: string, candidate: ScheduleItem[], excludeLinkId?: string) {
  const today = todaySP()
  const future = candidate.filter((item) => !('date' in item) || item.date >= today)
  const existing = await driverActiveSchedule(db, driverUserId, excludeLinkId)
  if (schedulesConflict(existing, future)) throw new StoreDriverError('Conflito de horário com a agenda do entregador', 409)
}
```

Substituir `inviteDriver` inteiro (remove reativação/unique-catch; sempre cria novo; checa conflito). Também **remover** a função `isUniqueViolation` se ficar sem uso após esta troca:

```ts
export async function inviteDriver(db: Db, storeId: string, phone: string, terms: StoreDriverTerms) {
  const normalized = normalizePhone(phone)
  const [driver] = await db.select().from(users).where(eq(users.phone, normalized)).limit(1)
  if (!driver) throw new StoreDriverError('Entregador não encontrado', 404)
  if (driver.role !== 'DRIVER' || driver.status !== 'ACTIVE') {
    throw new StoreDriverError('A conta informada não é de um entregador ativo', 400)
  }
  await assertNoScheduleConflict(db, driver.id, terms.schedule)
  const [link] = await db.insert(storeDrivers).values({ storeId, driverUserId: driver.id, ...terms }).returning()
  return link!
}
```

Substituir `confirmLink` (checa conflito antes de CONFIRMAR; vira transação):

```ts
export async function confirmLink(db: Db, driverUserId: string, linkId: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(storeDrivers).where(and(
      eq(storeDrivers.id, linkId),
      eq(storeDrivers.driverUserId, driverUserId),
      eq(storeDrivers.status, 'INVITED'),
    )).for('update')
    if (!link) throw new StoreDriverError('Convite não encontrado', 404)
    await assertNoScheduleConflict(tx, driverUserId, link.schedule, linkId)
    const [confirmed] = await tx.update(storeDrivers)
      .set({ status: 'CONFIRMED', updatedAt: new Date() })
      .where(and(eq(storeDrivers.id, linkId), eq(storeDrivers.status, 'INVITED')))
      .returning()
    if (!confirmed) throw new StoreDriverError('Convite mudou — recarregue', 409)
    return confirmed
  })
}
```

Em `proposeLinkTerms`, após carregar `link` e antes do `update`, inserir o pré-check (candidato = schedule proposto ou o atual):

```ts
    if (!link) throw new StoreDriverError('Vínculo confirmado não encontrado', 404)
    await assertNoScheduleConflict(tx, link.driverUserId, terms.schedule ?? link.schedule, linkId)
```

Em `confirmLinkTermsChange`, após validar que há pendência (o bloco `if (link.pendingProposedAt == null || ...)`) e antes do `update`, inserir:

```ts
    ) throw new StoreDriverError('Sem alteração pendente', 409)
    await assertNoScheduleConflict(tx, driverUserId, link.pendingSchedule, linkId)
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @delivery/api test -- store-driver.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/store-driver.service.ts apps/api/test/store-driver.service.test.ts
git commit -m "feat(links): allow multiple non-overlapping links per store"
```

---

### Task 4: shift.service — iniciar turno por `storeDriverId`, guard de janela, FK e erros claros

**Files:**
- Modify: `packages/shared/src/store-driver.schema.ts` (StartShiftSchema)
- Modify: `apps/api/src/services/shift.service.ts`
- Modify: `apps/api/src/routes/driver.ts` (rota `POST /driver/shifts`)
- Test: `apps/api/test/shift.service.test.ts` (Create)

- [ ] **Step 1: Teste falhando (reproduz o bug relatado).** Criar `apps/api/test/shift.service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'
import { createStoreWithOwner } from '../src/services/store.service'
import { registerUser } from '../src/services/auth.service'
import { confirmLink, inviteDriver } from '../src/services/store-driver.service'
import { endShift, startShift } from '../src/services/shift.service'
import { driverShifts, users } from '../src/db/schema'

const GPS = { lat: -23.4, lng: -51.9 } // = coordenadas da loja
let storeId: string
let driverId: string
let driverPhone: string

// dow de hoje em São Paulo (para agendar janelas "de hoje")
function todayDowSP() {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date())
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  storeId = (await createStoreWithOwner(testDb, {
    category: 'RESTAURANTE', phone: '4433334444', name: 'A', slug: 'shift-a',
    city: 'Maringá', addressText: 'Rua A', lat: GPS.lat, lng: GPS.lng,
    owner: { name: 'A', email: 'a@shift.test', password: 'senha123' },
  })).id
  driverPhone = '44911113333'
  const reg = await registerUser(testDb, { name: 'Driver', phone: driverPhone, password: 'senha123', role: 'DRIVER', acceptedTerms: true }, 'secret')
  driverId = reg.user.id
  await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, driverId))
})
afterAll(closeTestDb)

describe('início de turno com múltiplos vínculos', () => {
  it('permite 2 turnos sequenciais na mesma loja no mesmo dia (sem sobreposição)', async () => {
    const dow = todayDowSP()
    const manha = await inviteDriver(testDb, storeId, driverPhone, { dailyRateCents: 8_000, perDeliveryCents: 700, schedule: [{ dow, start: '00:00', end: '00:01' }] as never })
    await confirmLink(testDb, driverId, manha.id)
    const noite = await inviteDriver(testDb, storeId, driverPhone, { dailyRateCents: 9_000, perDeliveryCents: 800, schedule: [{ dow, start: '23:58', end: '23:59' }] as never })
    await confirmLink(testDb, driverId, noite.id)

    const s1 = await startShift(testDb, driverId, manha.id, GPS)
    await endShift(testDb, driverId, s1.id)
    const s2 = await startShift(testDb, driverId, noite.id, GPS) // ANTES: 409 "turno nesta loja hoje"
    expect(s2.storeDriverId).toBe(noite.id)
    const all = await testDb.select().from(driverShifts).where(eq(driverShifts.driverUserId, driverId))
    expect(all).toHaveLength(2)
  })

  it('recusa iniciar o mesmo vínculo duas vezes no mesmo dia', async () => {
    const dow = todayDowSP()
    const link = await inviteDriver(testDb, storeId, driverPhone, { dailyRateCents: 8_000, perDeliveryCents: 700, schedule: [{ dow, start: '00:00', end: '23:59' }] as never })
    await confirmLink(testDb, driverId, link.id)
    const s1 = await startShift(testDb, driverId, link.id, GPS)
    await endShift(testDb, driverId, s1.id)
    await expect(startShift(testDb, driverId, link.id, GPS)).rejects.toMatchObject({ status: 409 })
  })
})
```

Nota sobre janelas `00:00–00:01` / `23:58–23:59`: são propositalmente curtas e disjuntas para não sobrepor entre si nem exigir horário-de-parede específico (o guard de janela só compara janelas do mesmo dia entre si; iniciar fora da janela **não** é bloqueado — a barra do app só avisa).

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @delivery/api test -- shift.service`
Expected: FAIL — assinatura antiga `startShift(db, driverUserId, storeId, gps)` + unique `(driver, store, day)` barra o segundo turno; `s2.storeDriverId` não existe.

- [ ] **Step 3a: StartShiftSchema.** Em `packages/shared/src/store-driver.schema.ts`, trocar:

```ts
export const StartShiftSchema = z.object({
  storeDriverId: z.uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})
```

- [ ] **Step 3b: shift.service.** Em `apps/api/src/services/shift.service.ts`:

Adicionar import de `windowsOverlap`. Ele é exportado por `packages/shared/src/offers.ts` e reexportado pelo barrel **raiz** `@delivery/shared` (NÃO por `@delivery/shared/constants`). Manter a linha de `constants` existente e **adicionar** uma nova linha:

```ts
import { haversineKm, SHIFT_START_RADIUS_KM } from '@delivery/shared/constants'
import { windowsOverlap } from '@delivery/shared'
```

Adicionar helpers (perto de `scheduledEnd`) e **substituir** `isUniqueViolation` por `uniqueConstraint`:

```ts
function windowForDay(schedule: DriverSchedule, dateStr: string, weekday: number): { start: string; end: string } | null {
  const item = schedule.find((entry) => ('date' in entry ? entry.date === dateStr : entry.dow === weekday))
  return item ? { start: item.start, end: item.end } : null
}

function uniqueConstraint(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === '23505') {
      return 'constraint' in current && typeof current.constraint === 'string' ? current.constraint : ''
    }
    current = 'cause' in current ? current.cause : null
  }
  return null
}
```

Substituir a função `startShift` inteira por:

```ts
export async function startShift(db: Db, driverUserId: string, storeDriverId: string, gps: { lat: number; lng: number }) {
  const [link] = await db.select().from(storeDrivers).where(and(
    eq(storeDrivers.id, storeDriverId),
    eq(storeDrivers.driverUserId, driverUserId),
    eq(storeDrivers.status, 'CONFIRMED'),
  )).limit(1)
  if (!link) throw new ShiftError('Vínculo confirmado não encontrado', 404)
  if (isLinkExpired(link)) throw new ShiftError('Vínculo expirado', 409)
  const [store] = await db.select({ lat: stores.lat, lng: stores.lng }).from(stores).where(eq(stores.id, link.storeId)).limit(1)
  if (!store) throw new ShiftError('Loja não encontrada', 404)
  if (haversineKm(store, gps) > SHIFT_START_RADIUS_KM) throw new ShiftError('Você está fora do raio da loja', 409)

  const now = new Date()
  const { date: workDate, weekday } = saoPauloParts(now)
  const candidateWindow = windowForDay(link.schedule, workDate, weekday)
  try {
    return await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
      const [generalAssignment] = await tx.select({ id: orders.id }).from(orders).where(and(
        eq(orders.driverId, driverUserId),
        isNull(orders.shiftId),
        inArray(orders.status, ['ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER', 'OUT_FOR_DELIVERY']),
      )).limit(1)
      if (generalAssignment) throw new ShiftError('Finalize as entregas do pool geral antes de iniciar o turno', 409)
      if (candidateWindow) {
        const todays = await tx.select({ schedule: storeDrivers.schedule })
          .from(driverShifts)
          .innerJoin(storeDrivers, eq(storeDrivers.id, driverShifts.storeDriverId))
          .where(and(eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.workDate, workDate)))
        for (const row of todays) {
          const other = windowForDay(row.schedule, workDate, weekday)
          if (other && windowsOverlap(candidateWindow, other)) {
            throw new ShiftError('Sobreposição de horário com outro turno de hoje', 409)
          }
        }
      }
      const [shift] = await tx.insert(driverShifts).values({
        storeId: link.storeId,
        storeDriverId: link.id,
        driverUserId,
        dailyRateCents: link.dailyRateCents,
        perDeliveryCents: link.perDeliveryCents,
        workDate,
        scheduledEndAt: scheduledEnd(link.schedule, now),
        startedAt: now,
      }).returning()
      return shift!
    })
  } catch (error) {
    const constraint = uniqueConstraint(error)
    if (constraint === 'driver_shifts_link_day_unique') throw new ShiftError('Você já iniciou um turno deste vínculo hoje', 409)
    if (constraint === 'driver_shifts_one_active_per_driver') throw new ShiftError('Você já tem um turno ativo', 409)
    throw error
  }
}
```

(Não mexer em `getActiveShift`, `closeShift`, `endShift`, `releaseShift`, `updateActiveShift`, `listActiveStoreShifts`.)

- [ ] **Step 3c: Rota.** Em `apps/api/src/routes/driver.ts`, na rota `POST /driver/shifts`:

```ts
}), async (c) => {
  const { storeDriverId, lat, lng } = c.req.valid('json')
  return c.json(await startShift(c.get('db'), c.get('auth')!.sub, storeDriverId, { lat, lng }).catch(rethrow), 201)
})
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @delivery/api test -- shift.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/store-driver.schema.ts apps/api/src/services/shift.service.ts apps/api/src/routes/driver.ts apps/api/test/shift.service.test.ts
git commit -m "feat(shifts): start shift by store_driver_id; clearer conflicts"
```

---

### Task 5: offer.service — aceite cria vínculo novo (remove guard/upsert por loja)

**Files:**
- Modify: `apps/api/src/services/offer.service.ts`
- Test: `apps/api/test/offers.service.test.ts`

- [ ] **Step 1: Teste falhando.** Adicionar ao `describe('serviço de ofertas', ...)` em `apps/api/test/offers.service.test.ts`:

```ts
it('aceitar oferta cria um SEGUNDO vínculo na loja onde já há vínculo fixo (sem sobreposição)', async () => {
  // vínculo fixo manhã na loja A
  const fixed = await inviteDriver(testDb, storeA, '44911114444', { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: [{ dow: 1, start: '08:00', end: '10:00' }] as never })
  // registrar/ativar esse driver com esse telefone
  // (reaproveita helper de registro do arquivo se houver; senão registrar inline)
  await confirmLink(testDb, fixedDriverId, fixed.id)
  const offer = await weekly(storeA, 1, '18:00', '22:00') // mesma loja, horário disjunto
  const res = await acceptOffer(testDb, fixedDriverId, offer.id)
  expect(res.link.storeId).toBe(storeA)
  const links = await listStoreDrivers(testDb, storeA)
  expect(links.filter((l) => l.driverUserId === fixedDriverId)).toHaveLength(2)
})

it('aceite conflitante com vínculo existente é bloqueado (409)', async () => {
  const fixed = await inviteDriver(testDb, storeA, '44911114444', { dailyRateCents: 5_000, perDeliveryCents: 500, schedule: [{ dow: 1, start: '10:00', end: '14:00' }] as never })
  await confirmLink(testDb, fixedDriverId, fixed.id)
  const offer = await weekly(storeA, 1, '11:00', '15:00') // sobrepõe
  await expect(acceptOffer(testDb, fixedDriverId, offer.id)).rejects.toMatchObject({ status: 409 })
})
```

> Ajuste de setup: importar `inviteDriver, confirmLink, listStoreDrivers` de `../src/services/store-driver.service` (já há import de `listStoreDrivers`); registrar um driver dedicado com telefone `44911114444` no `beforeEach` (ou reusar `drivers[0]` obtendo seu phone). Nomeie a var `fixedDriverId`. Mantenha o padrão de registro já usado no arquivo.

> **Migração de testes existentes (obrigatório):** o arquivo já importa e usa `startShift`. Após a Task 4, a assinatura é `startShift(db, driverUserId, storeDriverId, gps)`. Localizar toda chamada existente do tipo `startShift(testDb, driverX, storeA, gps)` e trocar o 3º argumento pelo **id do vínculo** (ex.: `accepted.link.id` de `acceptOffer`, ou o `id` do vínculo criado no setup). Sem isso os testes de oferta quebram aqui.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @delivery/api test -- offers.service`
Expected: FAIL — hoje o aceite lança "Você já está vinculado a esta loja" (409) e faz upsert no vínculo fixo.

- [ ] **Step 3: Implementar.** Em `apps/api/src/services/offer.service.ts`, dentro de `acceptOffer`:

Remover a linha do guard de loja:

```ts
      if (activeLinks.some((link) => link.storeId === offer.storeId)) throw new OfferError('Você já está vinculado a esta loja', 409)
```

(Manter o `const activeLinks = ...` e o cálculo de `confirmedSchedule`/`scheduleConflicts` logo abaixo — a checagem de conflito continua valendo.)

Trocar o bloco de upsert (busca `existing` + update/insert) por **insert sempre**:

```ts
      const schedule = offerScheduleItems({ recurrence: offer.recurrence, start: offer.startTime, end: offer.endTime })
      const expiresAt = offer.recurrence.kind === 'DATES' ? expiresAfterLastDate(offer.recurrence.dates) : null
      const terms = { status: 'CONFIRMED' as const, dailyRateCents: offer.dailyRateCents, perDeliveryCents: offer.perDeliveryCents,
        schedule, expiresAt, pendingDailyRateCents: null, pendingPerDeliveryCents: null, pendingSchedule: null,
        pendingProposedAt: null, updatedAt: new Date(),
      }
      const [link] = await tx.insert(storeDrivers).values({ storeId: offer.storeId, driverUserId, ...terms }).returning()
      return { offer: claimed, link: link! }
```

(Apagar as linhas antigas: `const existing = links.find(...)` e o ternário `existing ? update : insert`.)

Ajustar a mensagem do catch de unique-violation (não há mais unique de vínculo; sobra só `offer_acceptances`):

```ts
    if (uniqueViolation(error)) throw new OfferError('Você já respondeu esta oferta', 409)
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @delivery/api test -- offers.service`
Expected: PASS (inclusive os testes de oferta já existentes, que criam o primeiro vínculo via insert normalmente).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/offer.service.ts apps/api/test/offers.service.test.ts
git commit -m "feat(offers): accept always creates a new link (multi-link per store)"
```

---

### Task 6: Dispatch — JOINs de `store_drivers` por `store_driver_id` (1:1)

**Files:**
- Modify: `apps/api/src/services/batch.service.ts:62-71`
- Modify: `apps/api/src/services/order-status.service.ts:89-98` e `:170-174`
- Test: `apps/api/test/batch.service.test.ts` (adicionar 1 caso)

Motivo: os 3 JOINs casam `store_drivers` por `(store_id, driver_user_id)`. Com múltiplos vínculos por loja isso retorna N linhas por turno. O turno já tem `store_driver_id` — casar por ele restaura 1:1 e mantém a semântica "o vínculo daquele turno está CONFIRMED e não expirado".

- [ ] **Step 1: Teste falhando (regressão de fanout).** Em `apps/api/test/batch.service.test.ts`, adicionar um teste que: cria 2 vínculos CONFIRMED disjuntos do mesmo driver na mesma loja, inicia turno em um deles, e verifica que `broadcastBatch(..., { target: 'SPECIFIC', requestedDriverId })` **sucede** (sem erro de "não está em turno") e que o pacote fica direcionado. Seguir o padrão de setup já existente no arquivo (reusar helpers locais de criação de loja/driver/pedidos/pacote). Asserção mínima:

```ts
// ...após criar 2 links disjuntos, iniciar turno em link A e montar um pacote com 2 pedidos:
const updated = await broadcastBatch(testDb, storeId, batchId, { target: 'SPECIFIC', requestedDriverId: driverId })
expect(updated.target).toBe('SPECIFIC')
```

- [ ] **Step 2: Rodar e ver falhar/passar-por-acaso**

Run: `pnpm --filter @delivery/api test -- batch.service`
Expected: Pode passar mesmo antes (o `.limit(1)` mascara o fanout), mas serve de trava de regressão. Se o setup expuser duplicidade (ex.: contagem), deve falhar.

- [ ] **Step 3: Implementar.** Trocar o predicado de JOIN nos 3 pontos.

`apps/api/src/services/batch.service.ts` (dentro de `broadcastBatch`, bloco `SPECIFIC`):

```ts
      const [active] = await tx.select({ id: driverShifts.id }).from(driverShifts)
        .innerJoin(storeDrivers, eq(storeDrivers.id, driverShifts.storeDriverId))
        .where(and(
        eq(driverShifts.storeId, storeId),
        eq(driverShifts.driverUserId, opts.requestedDriverId),
        eq(driverShifts.status, 'ACTIVE'),
        eq(storeDrivers.status, 'CONFIRMED'),
        or(isNull(storeDrivers.expiresAt), gt(storeDrivers.expiresAt, new Date())),
      )).limit(1)
```

`apps/api/src/services/order-status.service.ts` (dentro de `setDriverRequestTarget`, bloco `SPECIFIC`):

```ts
      const [active] = await tx.select({ id: driverShifts.id }).from(driverShifts)
        .innerJoin(storeDrivers, eq(storeDrivers.id, driverShifts.storeDriverId))
        .where(and(
        eq(driverShifts.storeId, storeId),
        eq(driverShifts.driverUserId, requestedDriverId),
        eq(driverShifts.status, 'ACTIVE'),
        eq(storeDrivers.status, 'CONFIRMED'),
        or(isNull(storeDrivers.expiresAt), gt(storeDrivers.expiresAt, new Date())),
      )).limit(1)
```

`apps/api/src/services/order-status.service.ts` (`listShiftDriverTokens`):

```ts
  const rows = await db.select({ fcmToken: drivers.fcmToken }).from(driverShifts)
    .innerJoin(drivers, eq(drivers.userId, driverShifts.driverUserId))
    .innerJoin(storeDrivers, eq(storeDrivers.id, driverShifts.storeDriverId))
    .where(and(...filters, eq(storeDrivers.status, 'CONFIRMED'), or(isNull(storeDrivers.expiresAt), gt(storeDrivers.expiresAt, new Date()))))
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @delivery/api test -- batch.service order-status`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/batch.service.ts apps/api/src/services/order-status.service.ts apps/api/test/batch.service.test.ts
git commit -m "fix(dispatch): join store_drivers by store_driver_id to avoid fanout"
```

---

### Task 7: Driver UI — iniciar turno por vínculo (não por loja)

**Files:**
- Modify: `apps/driver/src/components/DriverLayout.vue`

- [ ] **Step 1: Tipo + carregamento.** Trocar o tipo `Link` e manter o filtro CONFIRMED:

```ts
type Link = { id: string; storeId: string; storeName: string; status: string; schedule: ScheduleItem[] }
```

(`loadShift` já traz `id` no payload de `/driver/links`; nenhuma mudança na chamada.)

- [ ] **Step 2: Rótulo de janela por vínculo.** Adicionar (perto de `nextLabel`):

```ts
function linkWindowLabel(link: Link) {
  const items = link.schedule ?? []
  if (!items.length) return ''
  const first = items[0]!
  const when = 'date' in first ? first.date.split('-').reverse().slice(0, 2).join('/') : DOW[first.dow]
  return `${when} ${first.start}–${first.end}${items.length > 1 ? '…' : ''}`
}
```

- [ ] **Step 3: `start` por `storeDriverId`.** Trocar a função `start`:

```ts
async function start(storeDriverId: string) {
  shiftBusy.value = true
  shiftMsg.value = ''
  try {
    const gps = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15_000 }),
    )
    await api('/driver/shifts', { method: 'POST', body: JSON.stringify({ storeDriverId, lat: gps.coords.latitude, lng: gps.coords.longitude }) })
    await loadShift()
  } catch (e) { shiftMsg.value = e instanceof Error ? e.message : 'Não foi possível obter sua localização' }
  finally { shiftBusy.value = false }
}
```

- [ ] **Step 4: Template — um botão por vínculo (key por id, label com janela).** Trocar a linha do `v-for`:

```html
          <button v-for="link in links" :key="link.id" class="rounded border bg-white px-3 py-1 disabled:opacity-50" :disabled="shiftBusy" @click="start(link.id)">{{ link.storeName }} · {{ linkWindowLabel(link) }}</button>
```

- [ ] **Step 5: Build + commit**

Run: `pnpm --filter @delivery/driver build`
Expected: build OK.

```bash
git add apps/driver/src/components/DriverLayout.vue
git commit -m "feat(driver): start shift per link (id) with window label"
```

---

### Task 8: Store UI — distinguir múltiplos vínculos do mesmo entregador

**Files:**
- Modify: `apps/web/src/views/store/StoreDriversView.vue`

Objetivo (utilitário, sem redesign): a lista de entregadores já é keyed por `link.id`, então múltiplas linhas do mesmo entregador aparecem naturalmente. Falta **rotular cada linha com a agenda** para o lojista distinguir os vínculos.

- [ ] **Step 1: Formatter.** Adicionar no `<script setup>` (adaptar ao helper de dias já existente se houver `daysLabel`; senão criar):

```ts
const DOW_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
function scheduleLabel(schedule: Array<{ dow?: number; date?: string; start: string; end: string }>) {
  if (!schedule?.length) return 'sem agenda'
  return schedule.map((i) => {
    const when = 'date' in i && i.date ? i.date.split('-').reverse().slice(0, 2).join('/') : DOW_LABELS[i.dow ?? 0]
    return `${when} ${i.start}–${i.end}`
  }).join(' · ')
}
```

- [ ] **Step 2: Renderizar o rótulo** na linha/card do entregador (onde já se mostra nome/telefone), ex.:

```html
        <span class="text-xs text-gray-500">{{ scheduleLabel(link.schedule) }}</span>
```

(Adaptar ao markup existente — objetivo é apenas exibir a agenda de cada `link`. Não alterar o botão de convite/edição.)

- [ ] **Step 3: Build + commit**

Run: `pnpm --filter @delivery/web build`
Expected: build OK.

```bash
git add apps/web/src/views/store/StoreDriversView.vue
git commit -m "feat(store): show link schedule to distinguish multiple links"
```

---

### Task 9: Rota — teste de `POST /driver/shifts` com `storeDriverId` + docs + gate

**Files:**
- Modify: `apps/api/test/driver.routes.test.ts`
- Modify: `docs/ofertas-vagas-review.md` (nota de carry) **ou** README, conforme padrão do repo

- [ ] **Step 1: Ajustar teste de rota.** Onde `driver.routes.test.ts` inicia turno via `POST /driver/shifts`, trocar o corpo de `{ storeId, lat, lng }` para `{ storeDriverId, lat, lng }`, usando o `id` do vínculo CONFIRMED criado no setup. Se não houver ainda um caso de start-shift na rota, adicionar um: confirmar convite → `POST /driver/shifts` com `storeDriverId` → 201.

- [ ] **Step 2: Rodar**

Run: `pnpm --filter @delivery/api test -- driver.routes`
Expected: PASS.

- [ ] **Step 3: Doc curta.** Registrar em `docs/ofertas-vagas-review.md` (append) um parágrafo: "Vínculo passou a ser múltiplo por loja; turno referencia `store_driver_id`; guard antigo `(driver, store, dia)` substituído por `(store_driver_id, dia)`; início de turno exige `storeDriverId`."

- [ ] **Step 4: Gate completo (raiz)**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`
Expected: tudo verde.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/driver.routes.test.ts docs/ofertas-vagas-review.md
git commit -m "test(driver): start shift via storeDriverId; docs"
```

---

## Resumo pro executor

- **Modelo:** N vínculos CONFIRMED por (loja, entregador); só barra **sobreposição de horário** (helper único `schedulesConflict`, aplicado em convite/confirmação/proposta/aceite).
- **Turno:** aponta o vínculo (`store_driver_id` FK); inicia por `storeDriverId`; unique `(driver, store, dia)` → `(store_driver_id, dia)`; mantém "um ativo por entregador"; guard de janela sobreposta no start; erros específicos (não mais o catch-all).
- **Dispatch:** 3 JOINs de `store_drivers` passam a casar por `store_driver_id` (1:1, sem fanout).
- **Dinheiro:** 2 turnos = 2 diárias (sem mudança no finance).
- **Migration:** editar o `.sql` gerado p/ backfill + `SET NOT NULL`; rodar `db:migrate` no dev.
- **Invariantes:** borda exata de horário não conflita; expirado não inicia turno; tenant/RBAC intactos; sem coautor Claude nos commits.

## Limites — proibido desviar

1. Não reintroduzir nenhum unique/guard "um vínculo por loja" nem "um turno por loja por dia".
2. Não mudar schema/recorrência de ofertas, nem finance/ledger, nem o fluxo de proposta de termos além dos pré-checks de conflito especificados.
3. `startShift` recebe **`storeDriverId`** — não voltar a resolver vínculo por `(store, driver)` com `.limit(1)`.
4. Todo JOIN novo/alterado de `store_drivers` a partir de `driver_shifts` usa `store_driver_id` — nunca `(store_id, driver_user_id)`.
5. Migration: **não** deixar `ADD COLUMN store_driver_id NOT NULL` sem backfill (quebra em banco com dados). Seguir a sequência SQL da Task 2 exatamente.
6. TDD por task; commits pequenos; sem `Co-Authored-By: Claude`.
7. Não criar cron/notificação/novas rotas fora das listadas. Não refatorar arquivos fora do blast radius.
</content>
</invoke>

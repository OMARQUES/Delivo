# Amendment — Alteração de Pedido (Plano 5b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Loja com item em falta propõe alteração (reduzir/remover itens, novo total), cliente aprova ou recusa no tracking — aprovado: pedido segue ajustado com **estorno parcial** automático se pago online; recusado: pedido cancela com estorno total.

**Architecture:** `order_amendments` (1 proposta PROPOSED por pedido) + `order_amendment_items` (novas quantidades por item, **só redução**). Totais novos calculados e **congelados na proposta** (preços unitários do snapshot não mudam). Aprovação = tx atômica: ajusta `order_items` (0 = remove), atualiza totais do pedido, marca APPROVED, estorna a diferença via `refundPartial` (novo método no `PaymentProvider`). Recusa = cancela pedido + estorno total (reusa `refundOrderPaymentIfAny`). Enquanto houver proposta pendente, a loja **não avança status** (409) — resolve, retira ou cancela; cancelamento expira a proposta junto. Sem WebSocket: cliente vê a proposta pelo polling do tracking (15s).

**Tech Stack:** Drizzle (tx), Zod, MP refund parcial (`POST /v1/payments/:id/refunds` com `amount`), padrões do repo.

---

## ⚠️ REGRAS PARA O IMPLEMENTADOR

1. **Plano é literal.** Arquivos/nomes/rotas/códigos HTTP exatos. Testes são contrato — teste vence código do plano; nunca enfraqueça teste. TDD sempre (vermelho→verde).
2. **NÃO faça:** permitir ADICIONAR itens ou AUMENTAR quantidade (só redução — MVP); alterar preços unitários do snapshot; mexer na máquina de estados do shared; segunda proposta com uma PROPOSED aberta; refactor fora dos arquivos listados; dependência nova (nenhuma).
3. **Padrões do repo:** `createRouter()`/defaultHook; erros = classe com `status` + `rethrow`→HTTPException; testes api contra Postgres real (helpers `test-db.ts`, `vi.mock` de createDb, fakeProvider como em payment.service.test); UI dinheiro SEMPRE R$ via `formatBRL`; guarda atômica `UPDATE ... WHERE status=<lido>`.
4. **Cada task:** suítes+typecheck+lint verdes (build web quando tocar), 1 commit com a mensagem dada. Docker via `flatpak-spawn --host`. gh: `~/.local/bin/gh` + `GH_CONFIG_DIR=$HOME/.config/gh`.
5. Bloqueado → PARE e reporte.

## Regras de negócio (fixadas)

- Propor: pedido DA loja, status `ACCEPTED` ou `PREPARING`, sem proposta PROPOSED aberta. Pelo menos 1 item reduzido; `newQuantity` entre 0 e a quantidade atual; **não pode zerar todos** (isso é cancelamento, não amendment).
- Frete não muda. Pedido mínimo NÃO é revalidado (a loja é quem propôs).
- Aprovar (cliente dono): itens com `newQuantity=0` são removidos; demais têm `quantity` e `totalCents` recalculados (`unitPriceCents` intacto); `orders.subtotalCents/totalCents` = valores congelados na proposta; se houver payment APPROVED → **estorno parcial** de `refundCents`; evento `nota "pedido ajustado (−R$ X,XX)"`. Pedido permanece no MESMO status.
- Recusar: proposta REJECTED + pedido `CANCELLED` (reason "Cliente recusou a alteração proposta") + **estorno total** + eventos.
- Retirar (loja): proposta → EXPIRED; pedido segue intocado.
- Loja tentando avançar status com proposta PROPOSED → 409 "Resolva a alteração pendente antes"; EXCEÇÃO: `CANCELLED` é permitido e expira a proposta junto. Cancelamento pelo cliente/cron idem (expira proposta).
- Pagamento na entrega (CASH/CARD_MACHINE): sem estorno — total novo é o cobrado na porta (`refundCents` fica registrado só como diferença informativa).

---

## Estrutura de arquivos

```
packages/shared/src/
└── amendment.schema.ts        # AmendmentProposalSchema (→ schemas barrel)

apps/api/src/
├── db/schema/amendments.ts    # order_amendments + order_amendment_items
├── lib/payment-provider.ts    # MOD: +refundPartial na interface
├── lib/mercadopago.ts         # MOD: +refundPartial impl
├── services/amendment.service.ts  # propose/withdraw/approve/reject + gate helper
├── services/order-status.service.ts  # MOD: gate de proposta pendente + expirar em cancelamentos
├── services/order.service.ts  # MOD: amendment pendente nos detalhes (cliente+loja)
├── routes/store-orders.ts     # MOD: POST/DELETE amendments
└── routes/orders.ts           # MOD: approve/reject

apps/web/src/
├── views/store/StoreOrdersView.vue   # MOD: propor/retirar no modal de detalhe
└── views/OrderTrackingView.vue       # MOD: banner aprovar/recusar
```

---

### Task 1: shared — schema da proposta (TDD)

**Files:**
- Create: `packages/shared/src/amendment.schema.ts`
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/amendment.schema.test.ts`

- [ ] **Step 1: Teste que falha — `packages/shared/src/amendment.schema.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { AmendmentProposalSchema } from './amendment.schema'

const item = { orderItemId: crypto.randomUUID(), newQuantity: 1 }

describe('AmendmentProposalSchema', () => {
  it('accepts items with optional note', () => {
    const r = AmendmentProposalSchema.parse({ items: [item], note: 'acabou o catupiry' })
    expect(r.items).toHaveLength(1)
    expect(AmendmentProposalSchema.parse({ items: [item] }).note).toBeUndefined()
  })
  it('bounds: 1-50 items, quantity 0-50, note 280', () => {
    expect(() => AmendmentProposalSchema.parse({ items: [] })).toThrow()
    expect(() => AmendmentProposalSchema.parse({ items: [{ ...item, newQuantity: -1 }] })).toThrow()
    expect(() => AmendmentProposalSchema.parse({ items: [{ ...item, newQuantity: 51 }] })).toThrow()
    expect(() => AmendmentProposalSchema.parse({ items: [item], note: 'x'.repeat(281) })).toThrow()
  })
  it('rejects duplicate orderItemIds', () => {
    expect(() => AmendmentProposalSchema.parse({ items: [item, { ...item }] })).toThrow()
  })
})
```

- [ ] **Step 2: Ver falhar** — `pnpm --filter @delivery/shared test amendment` → FAIL

- [ ] **Step 3: Criar `packages/shared/src/amendment.schema.ts`**

```ts
import { z } from 'zod'

export const AmendmentProposalSchema = z.object({
  note: z.string().trim().max(280).optional(),
  items: z
    .array(
      z.object({
        orderItemId: z.uuid(),
        /** 0 = remover o item. Só REDUÇÃO é aceita (validado no service contra a quantidade atual). */
        newQuantity: z.number().int().min(0).max(50),
      }),
    )
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.orderItemId)).size === items.length, {
      message: 'Item duplicado na proposta',
    }),
})
export type AmendmentProposalInput = z.infer<typeof AmendmentProposalSchema>
```

- [ ] **Step 4: Barrel** — `schemas.ts` += `export * from './amendment.schema'`.

- [ ] **Step 5: Ver passar** — shared 68 + 3 = 71. Typecheck + lint.

- [ ] **Step 6: Commit** — `git add packages/shared && git commit -m "feat(shared): amendment proposal schema"`

---

### Task 2: db — tabelas de amendment

**Files:**
- Create: `apps/api/src/db/schema/amendments.ts`
- Modify: `apps/api/src/db/schema/index.ts`, `apps/api/test/helpers/test-db.ts`

- [ ] **Step 1: Criar `apps/api/src/db/schema/amendments.ts`**

```ts
import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { orders, orderItems } from './orders'
import { users } from './users'

export const amendmentStatus = pgEnum('amendment_status', ['PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED'])

/** Proposta de alteração da loja (1 PROPOSED por pedido — garantido no service) */
export const orderAmendments = pgTable('order_amendments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  status: amendmentStatus('status').notNull().default('PROPOSED'),
  proposedByUserId: uuid('proposed_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  note: text('note'),
  /** valores CONGELADOS no momento da proposta */
  newSubtotalCents: integer('new_subtotal_cents').notNull(),
  newTotalCents: integer('new_total_cents').notNull(),
  /** diferença a estornar (subtotal antigo − novo); informativo em pagamento na entrega */
  refundCents: integer('refund_cents').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})

export const orderAmendmentItems = pgTable('order_amendment_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  amendmentId: uuid('amendment_id').notNull().references(() => orderAmendments.id, { onDelete: 'cascade' }),
  orderItemId: uuid('order_item_id').notNull().references(() => orderItems.id, { onDelete: 'cascade' }),
  /** snapshot pro diff na UI */
  nameSnapshot: text('name_snapshot').notNull(),
  oldQuantity: integer('old_quantity').notNull(),
  newQuantity: integer('new_quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
})
```

- [ ] **Step 2: Barrel + truncate** — `index.ts` += `export * from './amendments'`. `test-db.ts`: adicionar `order_amendment_items, order_amendments` no TRUNCATE (antes de `payments`).

- [ ] **Step 3: Migration** — `pnpm --filter @delivery/api db:generate && pnpm --filter @delivery/api db:migrate` → `drizzle/0011_*.sql`. psql `\d order_amendments`.

- [ ] **Step 4: Suite** — api 144 verdes, typecheck.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): order amendment tables"`

---

### Task 3: provider — refundPartial (TDD fetch-mock)

**Files:**
- Modify: `apps/api/src/lib/payment-provider.ts`, `apps/api/src/lib/mercadopago.ts`
- Test: casos em `apps/api/test/mercadopago.test.ts`

- [ ] **Step 1: Interface** — `payment-provider.ts`, na interface `PaymentProvider`, após `refundPayment`:

```ts
  /** Estorno PARCIAL (amount em centavos). Idempotente por (payment, amount). */
  refundPartial(providerPaymentId: string, amountCents: number): Promise<void>
```
ATENÇÃO: todo fake provider nos testes existentes implementa a interface — adicionar `refundPartial: vi.fn(async () => {})` ao helper `fakeProvider` de CADA arquivo de teste que o define (payment.service.test, webhooks.routes.test, store-orders.routes.test etc. — grep `fakeProvider`).

- [ ] **Step 2: Teste que falha** — em `mercadopago.test.ts`:

```ts
it('refundPartial POSTs amount in reais with idempotency key', async () => {
  const fn = mockFetch(201, { id: 1 })
  await provider.refundPartial('999', 450)
  const [url, init] = fn.mock.calls[0]! as [string, RequestInit]
  expect(url).toBe('https://api.mercadopago.com/v1/payments/999/refunds')
  expect(JSON.parse(String(init.body)).amount).toBe(4.5)
  expect((init.headers as Record<string, string>)['X-Idempotency-Key']).toBe('refund-999-450')
})
```

- [ ] **Step 3: Implementar** — `mercadopago.ts`:

```ts
  async refundPartial(providerPaymentId: string, amountCents: number): Promise<void> {
    await this.request(`/v1/payments/${providerPaymentId}/refunds`, {
      method: 'POST',
      body: JSON.stringify({ amount: centsToReais(amountCents) }),
      idempotencyKey: `refund-${providerPaymentId}-${amountCents}`,
    })
  }
```

- [ ] **Step 4: Ver passar + suite inteira** (fakes atualizados). Typecheck + lint.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): partial refund on payment provider"`

---

### Task 4: amendment.service + gate de status (TDD pg real — CORE)

**Files:**
- Create: `apps/api/src/services/amendment.service.ts`
- Modify: `apps/api/src/services/order-status.service.ts`
- Test: `apps/api/test/amendment.service.test.ts`

- [ ] **Step 1: Teste que falha — `apps/api/test/amendment.service.test.ts`** (seed padrão dos testes de pedido: store 24/7 FIXED 500 + customer + address + 2 produtos "Pizza" 3000 e "Coca" 1000; `makeOrder()` cria pedido CASH DELIVERY com 2×Pizza + 1×Coca via createOrder → destructure `{order}`; avançar pra ACCEPTED via storeUpdateOrderStatus; fakeProvider copiado do payment.service.test — COM refundPartial):

```ts
import {
  AmendmentError, proposeAmendment, withdrawAmendment,
  approveAmendment, rejectAmendment, getPendingAmendment,
} from '../src/services/amendment.service'

// helpers do seed + itens: const items = detail.items (getCustomerOrder) — pizzaItemId, cocaItemId

describe('proposeAmendment', () => {
  it('freezes new totals and refund diff; stores item diff snapshots', async () => {
    const { orderId, pizzaItemId } = await makeAcceptedOrder() // subtotal 7000 (2×3000+1000), fee 500, total 7500
    const a = await proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      note: 'acabou massa', items: [{ orderItemId: pizzaItemId, newQuantity: 1 }],
    })
    expect(a).toMatchObject({ status: 'PROPOSED', newSubtotalCents: 4000, newTotalCents: 4500, refundCents: 3000 })
    const pending = await getPendingAmendment(testDb, orderId)
    expect(pending!.items[0]).toMatchObject({ oldQuantity: 2, newQuantity: 1, nameSnapshot: 'Pizza' })
  })

  it('rejects: wrong status, increase, zero-all, duplicate pending, foreign store/item', async () => {
    const { orderId, pizzaItemId, cocaItemId } = await makeAcceptedOrder()
    // aumento
    await expect(proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 3 }],
    })).rejects.toMatchObject({ status: 400 })
    // zerar tudo
    await expect(proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 0 }, { orderItemId: cocaItemId, newQuantity: 0 }],
    })).rejects.toMatchObject({ status: 400 })
    // pendente duplicada
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    await expect(proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 1 }],
    })).rejects.toMatchObject({ status: 409 })
    // status errado (pedido PENDING novo)
    const fresh = await makeOrder()
    await expect(proposeAmendment(testDb, storeId, ownerUserId, fresh.orderId, {
      items: [{ orderItemId: fresh.pizzaItemId, newQuantity: 1 }],
    })).rejects.toMatchObject({ status: 409 })
    // loja errada → 404
    await expect(proposeAmendment(testDb, crypto.randomUUID(), ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 1 }],
    })).rejects.toMatchObject({ status: 404 })
  })
})

describe('approveAmendment', () => {
  it('applies quantities atomically (0 removes), updates order totals, keeps status; partial refund when paid', async () => {
    const { orderId, pizzaItemId, cocaItemId } = await makeAcceptedPaidOrder() // igual makeAcceptedOrder mas com payment APPROVED (helper: SQL payment_method PIX_ONLINE + insert payments row APPROVED mp-9)
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, {
      items: [{ orderItemId: pizzaItemId, newQuantity: 1 }, { orderItemId: cocaItemId, newQuantity: 0 }],
    })
    const provider = fakeProvider()
    const r = await approveAmendment(testDb, provider, customerId, orderId)
    expect(r.status).toBe('APPROVED')
    const detail = await getCustomerOrder(testDb, customerId, orderId)
    expect(detail!.status).toBe('ACCEPTED') // status intacto
    expect(detail!.items).toHaveLength(1) // coca removida
    expect(detail!.items[0]).toMatchObject({ quantity: 1, totalCents: 3000 })
    expect(detail!.subtotalCents).toBe(3000)
    expect(detail!.totalCents).toBe(3500)
    expect(provider.refundPartial).toHaveBeenCalledWith('mp-9', 4000) // 7000−3000
    expect(detail!.events.some((e) => (e.note ?? '').includes('ajustado'))).toBe(true)
  })

  it('cash order: no gateway call, totals still applied', async () => {
    const { orderId, cocaItemId } = await makeAcceptedOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    const provider = fakeProvider()
    await approveAmendment(testDb, provider, customerId, orderId)
    expect(provider.refundPartial).not.toHaveBeenCalled()
    expect((await getCustomerOrder(testDb, customerId, orderId))!.subtotalCents).toBe(6000)
  })

  it('guards: wrong customer 404, no pending 409, double approve 409', async () => {
    const { orderId, cocaItemId } = await makeAcceptedOrder()
    await expect(approveAmendment(testDb, fakeProvider(), customerId, orderId)).rejects.toMatchObject({ status: 409 })
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    await expect(approveAmendment(testDb, fakeProvider(), crypto.randomUUID(), orderId)).rejects.toMatchObject({ status: 404 })
    await approveAmendment(testDb, fakeProvider(), customerId, orderId)
    await expect(approveAmendment(testDb, fakeProvider(), customerId, orderId)).rejects.toMatchObject({ status: 409 })
  })
})

describe('rejectAmendment', () => {
  it('cancels order with full refund when paid', async () => {
    const { orderId, cocaItemId } = await makeAcceptedPaidOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    const provider = fakeProvider()
    await rejectAmendment(testDb, provider, customerId, orderId)
    const detail = await getCustomerOrder(testDb, customerId, orderId)
    expect(detail!.status).toBe('CANCELLED')
    expect(provider.refundPayment).toHaveBeenCalledWith('mp-9') // estorno TOTAL
  })
})

describe('withdraw + status gate', () => {
  it('withdraw expires proposal; store status change blocked while pending except CANCELLED', async () => {
    const { orderId, cocaItemId } = await makeAcceptedOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, orderId, { items: [{ orderItemId: cocaItemId, newQuantity: 0 }] })
    // avançar bloqueado
    await expect(storeUpdateOrderStatus(testDb, storeId, orderId, 'PREPARING', ownerUserId))
      .rejects.toMatchObject({ status: 409 })
    // retirar libera
    await withdrawAmendment(testDb, storeId, orderId)
    expect(await getPendingAmendment(testDb, orderId)).toBeNull()
    await storeUpdateOrderStatus(testDb, storeId, orderId, 'PREPARING', ownerUserId) // ok agora
    // cancelar com pendente expira a proposta
    const o2 = await makeAcceptedOrder()
    await proposeAmendment(testDb, storeId, ownerUserId, o2.orderId, { items: [{ orderItemId: o2.cocaItemId, newQuantity: 0 }] })
    await storeUpdateOrderStatus(testDb, storeId, o2.orderId, 'CANCELLED', ownerUserId, 'sem estoque')
    expect(await getPendingAmendment(testDb, o2.orderId)).toBeNull()
  })
})
```

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `apps/api/src/services/amendment.service.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import type { AmendmentProposalInput } from '@delivery/shared/schemas'
import type { Db } from '../db/client'
import { orderAmendmentItems, orderAmendments, orderItems, orders } from '../db/schema'
import type { PaymentProvider } from '../lib/payment-provider'
import { addEvent } from './order-events'
import { getOrderPayment } from './payment.service'
import { formatBRL } from '@delivery/shared/constants'

export class AmendmentError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

const PROPOSABLE = ['ACCEPTED', 'PREPARING'] as const

export async function getPendingAmendment(db: Db, orderId: string) {
  const [a] = await db.select().from(orderAmendments)
    .where(and(eq(orderAmendments.orderId, orderId), eq(orderAmendments.status, 'PROPOSED')))
  if (!a) return null
  const items = await db.select().from(orderAmendmentItems).where(eq(orderAmendmentItems.amendmentId, a.id))
  return { ...a, items }
}

export async function proposeAmendment(
  db: Db, storeId: string, proposedByUserId: string, orderId: string, input: AmendmentProposalInput,
) {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
  if (!order) throw new AmendmentError('Pedido não encontrado', 404)
  if (!(PROPOSABLE as readonly string[]).includes(order.status))
    throw new AmendmentError('Alteração só antes do pedido ficar pronto (aceito/em preparo)', 409)
  if (await getPendingAmendment(db, orderId))
    throw new AmendmentError('Já existe uma alteração aguardando o cliente', 409)

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
  const byId = new Map(items.map((i) => [i.id, i]))

  let reduced = false
  for (const change of input.items) {
    const item = byId.get(change.orderItemId)
    if (!item) throw new AmendmentError('Item não pertence ao pedido', 400)
    if (change.newQuantity > item.quantity) throw new AmendmentError('Só é possível reduzir quantidades', 400)
    if (change.newQuantity < item.quantity) reduced = true
  }
  if (!reduced) throw new AmendmentError('Nenhuma redução na proposta', 400)

  // novo subtotal = itens com quantidades novas (não listados = mantidos)
  const changes = new Map(input.items.map((i) => [i.orderItemId, i.newQuantity]))
  const newSubtotalCents = items.reduce((acc, item) => {
    const qty = changes.get(item.id) ?? item.quantity
    return acc + item.unitPriceCents * qty
  }, 0)
  if (newSubtotalCents === 0) throw new AmendmentError('Não é possível remover todos os itens — cancele o pedido', 400)

  const newTotalCents = newSubtotalCents + (order.deliveryFeeCents ?? 0)
  const refundCents = order.totalCents - newTotalCents

  return db.transaction(async (tx) => {
    const [amendment] = await tx.insert(orderAmendments).values({
      orderId, proposedByUserId, note: input.note ?? null,
      newSubtotalCents, newTotalCents, refundCents,
    }).returning()
    for (const change of input.items) {
      const item = byId.get(change.orderItemId)!
      if (change.newQuantity === item.quantity) continue // sem mudança, não registra
      await tx.insert(orderAmendmentItems).values({
        amendmentId: amendment!.id, orderItemId: item.id, nameSnapshot: item.nameSnapshot,
        oldQuantity: item.quantity, newQuantity: change.newQuantity, unitPriceCents: item.unitPriceCents,
      })
    }
    return amendment!
  })
}

export async function withdrawAmendment(db: Db, storeId: string, orderId: string) {
  const [order] = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
  if (!order) throw new AmendmentError('Pedido não encontrado', 404)
  const rows = await db.update(orderAmendments)
    .set({ status: 'EXPIRED', resolvedAt: new Date() })
    .where(and(eq(orderAmendments.orderId, orderId), eq(orderAmendments.status, 'PROPOSED')))
    .returning()
  if (rows.length === 0) throw new AmendmentError('Sem alteração pendente', 409)
  return rows[0]!
}

/** Chamado pelos fluxos de cancelamento — expira proposta pendente sem erro se não houver. */
export async function expirePendingAmendment(db: Db, orderId: string) {
  await db.update(orderAmendments)
    .set({ status: 'EXPIRED', resolvedAt: new Date() })
    .where(and(eq(orderAmendments.orderId, orderId), eq(orderAmendments.status, 'PROPOSED')))
}

export async function approveAmendment(db: Db, provider: PaymentProvider | null, customerId: string, orderId: string) {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
  if (!order) throw new AmendmentError('Pedido não encontrado', 404)
  const pending = await getPendingAmendment(db, orderId)
  if (!pending) throw new AmendmentError('Sem alteração pendente', 409)

  await db.transaction(async (tx) => {
    // guarda atômica na proposta (double-approve/corrida com withdraw)
    const claimed = await tx.update(orderAmendments)
      .set({ status: 'APPROVED', resolvedAt: new Date() })
      .where(and(eq(orderAmendments.id, pending.id), eq(orderAmendments.status, 'PROPOSED')))
      .returning()
    if (claimed.length === 0) throw new AmendmentError('Alteração não está mais pendente', 409)
    for (const change of pending.items) {
      if (change.newQuantity === 0) {
        await tx.delete(orderItems).where(eq(orderItems.id, change.orderItemId))
      } else {
        await tx.update(orderItems)
          .set({ quantity: change.newQuantity, totalCents: change.unitPriceCents * change.newQuantity })
          .where(eq(orderItems.id, change.orderItemId))
      }
    }
    await tx.update(orders)
      .set({ subtotalCents: pending.newSubtotalCents, totalCents: pending.newTotalCents })
      .where(eq(orders.id, orderId))
  })

  await addEvent(db, orderId, order.status, 'CUSTOMER', customerId,
    `pedido ajustado (−${formatBRL(pending.refundCents)})`)

  // estorno parcial só se pagamento online APROVADO
  const payment = await getOrderPayment(db, orderId)
  if (payment?.status === 'APPROVED' && pending.refundCents > 0) {
    if (provider) await provider.refundPartial(payment.providerPaymentId, pending.refundCents)
    await addEvent(db, orderId, order.status, 'SYSTEM', null,
      `estorno parcial de ${formatBRL(pending.refundCents)}`)
  }
  return { ...pending, status: 'APPROVED' as const }
}

export async function rejectAmendment(db: Db, provider: PaymentProvider | null, customerId: string, orderId: string) {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
  if (!order) throw new AmendmentError('Pedido não encontrado', 404)
  const pending = await getPendingAmendment(db, orderId)
  if (!pending) throw new AmendmentError('Sem alteração pendente', 409)

  const claimed = await db.update(orderAmendments)
    .set({ status: 'REJECTED', resolvedAt: new Date() })
    .where(and(eq(orderAmendments.id, pending.id), eq(orderAmendments.status, 'PROPOSED')))
    .returning()
  if (claimed.length === 0) throw new AmendmentError('Alteração não está mais pendente', 409)

  const rows = await db.update(orders)
    .set({ status: 'CANCELLED', cancelReason: 'Cliente recusou a alteração proposta' })
    .where(and(eq(orders.id, orderId), eq(orders.status, order.status)))
    .returning()
  if (rows.length > 0) {
    await addEvent(db, orderId, 'CANCELLED', 'CUSTOMER', customerId, 'recusou alteração')
    const { refundOrderPaymentIfAny } = await import('./payment.service')
    await refundOrderPaymentIfAny(db, provider, orderId)
  }
  return { ...pending, status: 'REJECTED' as const }
}
```
NOTA de import: `formatBRL` vem de `@delivery/shared/constants` (uso backend ok). O import dinâmico de `refundOrderPaymentIfAny` evita ciclo payment↔amendment — se não houver ciclo real (payment.service não importa amendment), troque por import estático no topo (preferido; verifique).

- [ ] **Step 4: Gate em `order-status.service.ts`** — no `storeUpdateOrderStatus`, logo após carregar o pedido (antes de `canTransition`):

```ts
import { expirePendingAmendment, getPendingAmendment } from './amendment.service'
// ...
  if (to !== 'CANCELLED' && (await getPendingAmendment(db, orderId)))
    throw new OrderError('Resolva a alteração pendente antes de avançar o pedido', 409)
```
E em TODOS os pontos que setam `CANCELLED` (storeUpdateOrderStatus quando to===CANCELLED, storeResolveCancelRequest approve, customerCancelOrder, cancelStalePendingOrders, e `expireStaleAwaitingPayment` no payment.service): após o update bem-sucedido, `await expirePendingAmendment(db, orderId)`.
ATENÇÃO ciclo: amendment.service importa `addEvent` de `./order-events` (não de order-status) — sem ciclo. order-status importa amendment.service — ok, amendment NÃO importa order-status.

- [ ] **Step 5: Ver passar** — 6 testes novos verdes + suite inteira. Typecheck + lint.

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): amendment service — propose, approve with partial refund, reject, status gate"`

---

### Task 5: rotas — loja propõe/retira, cliente resolve (TDD)

**Files:**
- Modify: `apps/api/src/routes/store-orders.ts`, `apps/api/src/routes/orders.ts`, `apps/api/src/services/order.service.ts`
- Test: casos em `apps/api/test/store-orders.routes.test.ts` e `apps/api/test/orders.routes.test.ts`

- [ ] **Step 1: Detalhes incluem amendment.** Em `order.service.ts`, `getCustomerOrder` e `getStoreOrder`: adicionar
```ts
import { getPendingAmendment } from './amendment.service'
// no objeto retornado de ambos:
  amendment: await getPendingAmendment(db, order.id),
```

- [ ] **Step 2: Rotas loja** — `store-orders.ts`:

```ts
import { AmendmentProposalSchema } from '@delivery/shared/schemas'
import { AmendmentError, proposeAmendment, withdrawAmendment } from '../services/amendment.service'
// rethrow ganha AmendmentError:
//   if (e instanceof OrderError || e instanceof AmendmentError) ...

storeOrderRoutes.openapi(
  createRoute({ method: 'post', path: '/store/me/orders/{id}/amendments',
    request: { params: IdParam, body: { content: { 'application/json': { schema: AmendmentProposalSchema } } } },
    responses: { 201: { description: 'Proposta criada', content: { 'application/json': { schema: Out } } } } }),
  async (c) => {
    const storeId = await ownStoreId(c)
    const a = await proposeAmendment(c.get('db'), storeId, c.get('auth')!.sub, c.req.valid('param').id, c.req.valid('json')).catch(rethrow)
    return c.json(a, 201)
  },
)

storeOrderRoutes.openapi(
  createRoute({ method: 'delete', path: '/store/me/orders/{id}/amendments/current',
    request: { params: IdParam },
    responses: { 200: { description: 'Proposta retirada', content: { 'application/json': { schema: Out } } } } }),
  async (c) =>
    c.json(await withdrawAmendment(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow), 200),
)
```

- [ ] **Step 3: Rotas cliente** — `orders.ts`:

```ts
import { AmendmentError, approveAmendment, rejectAmendment } from '../services/amendment.service'
import { createPaymentProvider } from '../lib/mercadopago' // já importado
// rethrow ganha AmendmentError

orderRoutes.openapi(
  createRoute({ method: 'post', path: '/orders/{id}/amendments/current/approve',
    request: { params: IdParam },
    responses: { 200: { description: 'Aprovada', content: { 'application/json': { schema: Out } } } } }),
  async (c) =>
    c.json(await approveAmendment(c.get('db'), createPaymentProvider(c.env), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)

orderRoutes.openapi(
  createRoute({ method: 'post', path: '/orders/{id}/amendments/current/reject',
    request: { params: IdParam },
    responses: { 200: { description: 'Recusada', content: { 'application/json': { schema: Out } } } } }),
  async (c) =>
    c.json(await rejectAmendment(c.get('db'), createPaymentProvider(c.env), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)
```

- [ ] **Step 4: Testes HTTP** (escrever ANTES das rotas, ver falhar; padrão dos arquivos):

store-orders.routes.test.ts:
```ts
describe('amendments (store)', () => {
  it('proposes on accepted order; withdraw clears; status advance blocked while pending', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'ACCEPTED' }) }, ownerToken)
    const detail = await req(`/store/me/orders/${o.id}`, {}, ownerToken)
    const itemId = ((await detail.json()) as { items: { id: string }[] }).items[0]!.id
    const propose = await req(`/store/me/orders/${o.id}/amendments`, {
      method: 'POST', body: JSON.stringify({ note: 'faltou', items: [{ orderItemId: itemId, newQuantity: 1 }] }),
    }, ownerToken)
    expect(propose.status).toBe(201)
    // avanço bloqueado
    expect((await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'PREPARING' }) }, ownerToken)).status).toBe(409)
    // detalhe da loja expõe amendment
    const d2 = await req(`/store/me/orders/${o.id}`, {}, ownerToken)
    expect(((await d2.json()) as { amendment: unknown }).amendment).not.toBeNull()
    // retirar
    expect((await req(`/store/me/orders/${o.id}/amendments/current`, { method: 'DELETE' }, ownerToken)).status).toBe(200)
    expect((await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'PREPARING' }) }, ownerToken)).status).toBe(200)
  })
})
```
(checkout() do arquivo cria 1 item quantity 2? conferir helper — se quantity 1, proposta newQuantity 0 zera tudo → 400. AJUSTE: use quantity 2 no helper local do teste ou proponha newQuantity 1 sobre quantity 2. Garanta pedido com item quantity ≥2 OU 2 itens.)

orders.routes.test.ts:
```ts
describe('amendments (customer)', () => {
  it('approve applies totals; reject cancels', async () => {
    // pedido ACCEPTED com proposta (helpers via services: proposeAmendment direto)
    // approve → 200; GET detail: totalCents reduzido, status ACCEPTED, amendment null
    // segundo pedido: reject → 200; GET detail: CANCELLED
    // outro cliente tentando approve → 404
  })
})
```
(Escreva o corpo COMPLETO seguindo o padrão do arquivo — criar pedido, avançar ACCEPTED via storeUpdateOrderStatus service, propor via proposeAmendment service, agir via HTTP com customerToken, assertar via GET /orders/:id.)

- [ ] **Step 5: Ver passar + suite.** Typecheck + lint.

- [ ] **Step 6: Commit + push + CI** — `git add apps/api && git commit -m "feat(api): amendment routes for store and customer" && git push` + CI verde.

---

### Task 6: web loja — propor/retirar no modal

**Files:**
- Modify: `apps/web/src/views/store/StoreOrdersView.vue`

- [ ] **Step 1: Types** — `Detail` += `amendment: { id: string; note: string | null; refundCents: number; newTotalCents: number; items: { nameSnapshot: string; oldQuantity: number; newQuantity: number }[] } | null`; `OrderRow` não muda (badge usa detail).

- [ ] **Step 2: Estado + ações no script**

```ts
const amending = ref(false)
const amendQty = ref<Record<string, number>>({})
const amendNote = ref('')

function startAmend() {
  if (!detail.value) return
  amendQty.value = Object.fromEntries(detail.value.items.map((i) => [i.id, i.quantity]))
  amendNote.value = ''
  amending.value = true
}

async function submitAmend() {
  if (!detail.value) return
  const items = detail.value.items
    .filter((i) => (amendQty.value[i.id] ?? i.quantity) < i.quantity)
    .map((i) => ({ orderItemId: i.id, newQuantity: amendQty.value[i.id] ?? i.quantity }))
  if (items.length === 0) {
    error.value = 'Reduza a quantidade de pelo menos um item'
    return
  }
  try {
    await api(`/store/me/orders/${detail.value.id}/amendments`, {
      method: 'POST', body: JSON.stringify({ note: amendNote.value || undefined, items }),
    })
    amending.value = false
    await openDetail(detail.value)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}

async function withdrawAmend() {
  if (!detail.value) return
  await api(`/store/me/orders/${detail.value.id}/amendments/current`, { method: 'DELETE' })
  await openDetail(detail.value)
  await load()
}
```
(`openDetail` já refaz o GET — confira a assinatura real e reuse.)
`Detail.items` precisa de `quantity` e `id` — já tem.

- [ ] **Step 3: Template do modal de detalhe** — após a lista de itens:

```vue
      <div v-if="detail.amendment" class="mt-2 rounded bg-yellow-50 p-2 text-sm">
        ⏳ Alteração aguardando o cliente
        (novo total {{ formatBRL(detail.amendment.newTotalCents) }})
        <button class="ml-2 underline" @click="withdrawAmend">Retirar proposta</button>
      </div>
      <button
        v-else-if="['ACCEPTED', 'PREPARING'].includes(detail.status)"
        class="mt-2 rounded border px-2 py-1 text-sm"
        @click="startAmend"
      >Propor alteração (item em falta)</button>

      <div v-if="amending" class="mt-2 space-y-2 rounded border p-2">
        <p class="text-sm font-semibold">Reduza as quantidades (0 = remover):</p>
        <div v-for="i in detail.items" :key="i.id" class="flex items-center gap-2 text-sm">
          <span class="flex-1">{{ i.nameSnapshot }} (atual: {{ i.quantity }})</span>
          <input
            type="number" :max="i.quantity" min="0"
            :value="amendQty[i.id]"
            class="w-16 rounded border p-1"
            @input="(e) => (amendQty[i.id] = Number((e.target as HTMLInputElement).value))"
          />
        </div>
        <input v-model="amendNote" placeholder="Motivo (ex.: acabou o catupiry)" class="w-full rounded border p-2 text-sm" />
        <div class="flex gap-2">
          <button class="flex-1 rounded border p-1 text-sm" @click="amending = false">Voltar</button>
          <button class="flex-1 rounded bg-black p-1 text-sm text-white" @click="submitAmend">Enviar ao cliente</button>
        </div>
      </div>
```
(Se cast inline no @input quebrar vue-tsc, extrair função no script — padrão do arquivo.)

- [ ] **Step 4: Verificar** — build + typecheck + lint + testes web (13).

- [ ] **Step 5: Commit** — `git add apps/web && git commit -m "feat(web): store proposes order amendment from detail modal"`

---

### Task 7: web cliente — banner aprovar/recusar no tracking

**Files:**
- Modify: `apps/web/src/views/OrderTrackingView.vue`

- [ ] **Step 1: Type** — `Order` += `amendment: { note: string | null; refundCents: number; newTotalCents: number; items: { nameSnapshot: string; oldQuantity: number; newQuantity: number }[] } | null`.

- [ ] **Step 2: Ações**

```ts
async function resolveAmendment(action: 'approve' | 'reject') {
  if (!order.value) return
  const label = action === 'approve' ? 'Aprovar a alteração?' : 'Recusar? O pedido será CANCELADO.'
  if (!confirm(label)) return
  try {
    await api(`/orders/${order.value.id}/amendments/current/${action}`, { method: 'POST' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  }
}
```

- [ ] **Step 3: Template** — logo após o bloco de cancelamento-solicitado (antes dos itens):

```vue
      <section v-if="order.amendment && !isFinal" class="space-y-2 rounded border border-orange-300 bg-orange-50 p-3">
        <p class="font-semibold">⚠️ A loja propôs uma alteração</p>
        <p v-if="order.amendment.note" class="text-sm italic">"{{ order.amendment.note }}"</p>
        <ul class="text-sm">
          <li v-for="(i, idx) in order.amendment.items" :key="idx">
            {{ i.nameSnapshot }}: {{ i.oldQuantity }}× →
            <strong>{{ i.newQuantity === 0 ? 'remover' : `${i.newQuantity}×` }}</strong>
          </li>
        </ul>
        <p class="text-sm">
          Novo total: <strong>{{ formatBRL(order.amendment.newTotalCents) }}</strong>
          <span v-if="order.amendment.refundCents > 0" class="text-green-700">
            (−{{ formatBRL(order.amendment.refundCents) }}<template v-if="order.paymentMethod.includes('ONLINE')"> — estorno automático</template>)
          </span>
        </p>
        <div class="flex gap-2">
          <button class="flex-1 rounded bg-green-600 p-2 text-white" @click="resolveAmendment('approve')">Aprovar</button>
          <button class="flex-1 rounded border border-red-400 p-2 text-red-600" @click="resolveAmendment('reject')">Recusar (cancela)</button>
        </div>
      </section>
```

- [ ] **Step 4: Verificar** — build + typecheck + lint + testes.

- [ ] **Step 5: Commit** — `git add apps/web && git commit -m "feat(web): customer approves or rejects amendment on tracking"`

---

### Task 8: e2e + encerramento

- [ ] **Step 1: E2E curl** (wrangler dev + postgres): pedido 2×pizza+1×coca CASH → loja aceita → propõe (pizza 2→1, coca remover) → loja tenta PREPARING → 409 → cliente GET detail vê amendment → approve → totais novos + status ACCEPTED + PREPARING agora passa. Segundo ciclo: reject → CANCELLED. Terceiro: withdraw. Se MP sandbox configurado (`.dev.vars`): quarto ciclo com PIX pago → approve → conferir `refundPartial` (log do MP ou GET payment no sandbox mostra refund parcial). Reportar códigos.

- [ ] **Step 2: carry-forwards** — REMOVER linha "Estorno parcial (amendment) pendente | Plano 7". ADICIONAR:
```markdown
| Amendment só REDUZ itens (não adiciona/troca) — adicionar item = pedido novo | Plano 5b | Se lojas pedirem |
| Amendment em pedido cash: diferença só informativa (cobra novo total na porta) | Plano 5b | Aceito |
```

- [ ] **Step 3: README** — Roadmap: "5b. ✅ Amendment — proposta da loja, aprovação do cliente, estorno parcial".

- [ ] **Step 4: Suite final + push + CI** — `pnpm typecheck && pnpm test && pnpm lint && pnpm build` verdes (~71 shared, ~155 api, 13 web); commit `docs: amendment plan wrap-up`; push; CI verde.

---

## Critério de sucesso

- Loja propõe redução em pedido ACEITO/EM PREPARO; não consegue propor 2ª com uma aberta, nem aumentar, nem zerar tudo
- Enquanto pendente: loja não avança status (409); pode retirar; cancelar expira a proposta
- Cliente vê diff claro no tracking (polling), aprova → itens/totais ajustados atomicamente, status intacto, **estorno parcial** automático se pago online (valor exato = diferença congelada)
- Recusa → pedido cancelado + estorno total
- Cash: totais ajustam, zero chamadas de gateway
- Corrida approve×withdraw: guarda atômica — só um vence
- Suite completa + CI verdes; nenhum teste toca API real do MP

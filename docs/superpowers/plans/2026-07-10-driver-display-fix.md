# Correção Exibição Driver (pagamento + endereço) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App do entregador mostra método de pagamento correto (pedido pago online NUNCA aparece como "maquininha"/"receber") e deixa claro qual endereço é coleta e qual é entrega.

**Architecture:** Labels de método de pagamento centralizados em `packages/shared` (novo `PAYMENT_METHODS`/`PAYMENT_METHOD_LABELS`/`isPaidOnline`), consumidos por driver e web (remove duplicação). Views do driver ganham rótulos explícitos "Coleta"/"Entrega" e linha de pagamento condicional.

**Tech Stack:** TypeScript, Vue 3, Vitest (shared), pnpm monorepo.

---

## Análise de causas (contexto pro implementador)

Bug reportado: pedido pago com **PIX** apareceu pro entregador como "**maquininha**" e com "endereço errado" (endereço da loja).

**Causa 1 — pagamento (bug real, grave):** `apps/driver/src/views/DeliveriesView.vue` linhas 109 e 133 usam ternário binário:

```
o.paymentMethod === 'CASH' ? `dinheiro...` : 'maquininha'
```

Qualquer método ≠ CASH (incluindo `PIX_ONLINE` e `CARD_ONLINE`, **já pagos online**) exibe "Receber: R$X (maquininha)" — instrui o entregador a **cobrar um pedido já pago**. O type local `Delivery` (linha 16) nem declara `CARD_ONLINE`.

**Causa 2 — endereço (não é bug de dados; é rótulo ausente):** a API retorna os dados corretos (`storeAddressText` = coleta, `addressText` = snapshot do endereço de entrega do cliente — conferido em `dispatch.service.ts` e `order.service.ts`). Mas:
- `AvailableView.vue` (pré-aceite) mostra **só** o endereço da loja, sem rótulo — parece endereço de entrega. (Endereço do cliente é ocultado pré-aceite por privacidade, by design.)
- `DeliveriesView.vue` card "Coletar na loja" mostra **só** o endereço da loja; o endereço de entrega só aparece depois do "Coletei" (seção "Entregar"). Pós-aceite não há motivo pra esconder — o payload já traz `addressText`.

**Varredura de placeholders no resto do app:** nenhum outro achado. `apps/web` trata os 4 métodos (`StoreOrdersView.paymentLabel`), API não retorna dado fake. Único placeholder real era o "maquininha" acima.

---

## Guardrails (leia antes de codar)

1. **NÃO** mexer em API/rotas/services — payload já está correto. Mudança é só shared + 2 views do driver + refactor de 1 função no web.
2. Dinheiro em UI sempre `formatBRL` (R$). Nunca exibir centavos crus.
3. Labels pt-BR.
4. Pedido pago online NUNCA pode exibir a palavra "Receber" nem "maquininha" — regra de negócio: se chegou ao dispatch, pagamento online já foi APROVADO.
5. Rodar `pnpm typecheck && pnpm test && pnpm lint && pnpm build` antes do commit final.
6. Commits frequentes, mensagens convencionais.

---

### Task 1: Constantes de método de pagamento em shared

**Files:**
- Modify: `packages/shared/src/payment.ts`
- Test: `packages/shared/src/payment.test.ts`

- [ ] **Step 1: Teste falhando**

Adicionar ao `packages/shared/src/payment.test.ts` (manter testes existentes):

```ts
import { describe, expect, it } from 'vitest'
import {
  isPaidOnline,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
} from './payment'

describe('payment methods', () => {
  it('lista os 4 métodos', () => {
    expect(PAYMENT_METHODS).toEqual(['CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE'])
  })

  it('labels pt-BR para todos os métodos', () => {
    expect(PAYMENT_METHOD_LABELS.CASH).toBe('Dinheiro')
    expect(PAYMENT_METHOD_LABELS.CARD_MACHINE).toBe('Maquininha')
    expect(PAYMENT_METHOD_LABELS.PIX_ONLINE).toBe('PIX pago online')
    expect(PAYMENT_METHOD_LABELS.CARD_ONLINE).toBe('Cartão pago online')
  })

  it('isPaidOnline: só métodos online', () => {
    expect(isPaidOnline('PIX_ONLINE')).toBe(true)
    expect(isPaidOnline('CARD_ONLINE')).toBe(true)
    expect(isPaidOnline('CASH')).toBe(false)
    expect(isPaidOnline('CARD_MACHINE')).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @delivery/shared test`
Expected: FAIL — `PAYMENT_METHODS` não exportado.

- [ ] **Step 3: Implementar**

Adicionar ao final de `packages/shared/src/payment.ts`:

```ts
export const PAYMENT_METHODS = ['CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Dinheiro',
  CARD_MACHINE: 'Maquininha',
  PIX_ONLINE: 'PIX pago online',
  CARD_ONLINE: 'Cartão pago online',
}

/** true = pagamento já capturado online (se o pedido chegou ao dispatch, está APROVADO) — entregador NÃO cobra */
export const isPaidOnline = (m: PaymentMethod) => m === 'PIX_ONLINE' || m === 'CARD_ONLINE'
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @delivery/shared test`
Expected: PASS (71 + 3 novos).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/payment.ts packages/shared/src/payment.test.ts
git commit -m "feat(shared): payment method constants, labels and isPaidOnline"
```

---

### Task 2: DeliveriesView — linha de pagamento correta + endereço de entrega no card de coleta

**Files:**
- Modify: `apps/driver/src/views/DeliveriesView.vue`

- [ ] **Step 1: Corrigir type e imports**

No `<script setup>`, trocar a linha 16 do type `Delivery`:

```ts
// ANTES
paymentMethod: 'CASH' | 'CARD_MACHINE' | 'PIX_ONLINE'
// DEPOIS
paymentMethod: PaymentMethod
```

E adicionar ao import de `@delivery/shared/constants` (import existente nas linhas 3-10): `isPaidOnline` e `type PaymentMethod`.

- [ ] **Step 2: Helper de linha de pagamento**

Adicionar no `<script setup>` (perto dos helpers `waze`/`wa`, ~linha 87):

```ts
function paymentLine(o: Delivery) {
  if (isPaidOnline(o.paymentMethod)) return `✅ Pago online — não cobrar (total ${formatBRL(o.totalCents)})`
  const how = o.paymentMethod === 'CASH'
    ? `dinheiro${o.changeForCents ? `, troco p/ ${formatBRL(o.changeForCents)}` : ''}`
    : 'maquininha'
  return `Receber: ${formatBRL(o.totalCents)} (${how})`
}
```

- [ ] **Step 3: Usar o helper nos DOIS cards**

Substituir a linha de pagamento no card "Coletar na loja" (linhas 107-110):

```html
<!-- ANTES -->
<p class="text-xs">
  Receber: <strong>{{ formatBRL(o.totalCents) }}</strong>
  ({{ o.paymentMethod === 'CASH' ? `dinheiro${o.changeForCents ? `, troco p/ ${formatBRL(o.changeForCents)}` : ''}` : 'maquininha' }})
</p>
<!-- DEPOIS -->
<p class="text-xs" :class="isPaidOnline(o.paymentMethod) ? 'font-semibold text-green-700' : ''">{{ paymentLine(o) }}</p>
```

Mesma substituição no card "Entregar" (linhas 131-134).

- [ ] **Step 4: Rótulos de endereço + entrega visível no card de coleta**

No card "Coletar na loja", trocar a linha do endereço (linha 106) e adicionar a linha de entrega logo abaixo:

```html
<!-- ANTES -->
<p class="text-xs text-gray-500">{{ o.storeAddressText }} · {{ ORDER_STATUS_LABELS[o.status] }}</p>
<!-- DEPOIS -->
<p class="text-xs text-gray-500">Coleta: {{ o.storeAddressText }} · {{ ORDER_STATUS_LABELS[o.status] }}</p>
<p v-if="o.addressText" class="text-xs text-gray-500">Entrega: {{ o.addressText }}<template v-if="o.addressReference"> · {{ o.addressReference }}</template></p>
```

No card "Entregar", rotular o endereço (linhas 128-130):

```html
<!-- ANTES -->
<p class="text-xs text-gray-500">
  {{ o.addressText }}<template v-if="o.addressReference"> · {{ o.addressReference }}</template>
</p>
<!-- DEPOIS -->
<p class="text-xs text-gray-500">
  Entrega: {{ o.addressText }}<template v-if="o.addressReference"> · {{ o.addressReference }}</template>
</p>
```

- [ ] **Step 5: Verificar**

Run: `pnpm --filter @delivery/driver build && pnpm typecheck`
Expected: sem erros. (App driver não tem suite de testes — verificação é typecheck + build + teste manual do usuário.)

- [ ] **Step 6: Commit**

```bash
git add apps/driver/src/views/DeliveriesView.vue
git commit -m "fix(driver): correct payment line for online-paid orders, label pickup vs delivery address"
```

---

### Task 3: AvailableView — rotular endereço de coleta (pré-aceite)

**Files:**
- Modify: `apps/driver/src/views/AvailableView.vue`

- [ ] **Step 1: Rotular endereço**

Trocar a linha 94:

```html
<!-- ANTES -->
<p class="text-xs text-gray-500">{{ o.storeAddressText }}</p>
<!-- DEPOIS -->
<p class="text-xs text-gray-500">Coleta: {{ o.storeAddressText }}</p>
<p class="text-xs text-gray-400">Endereço de entrega liberado após aceitar</p>
```

(O endereço do cliente é ocultado pré-aceite por privacidade — comportamento correto, só faltava dizer isso.)

- [ ] **Step 2: Verificar**

Run: `pnpm --filter @delivery/driver build`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add apps/driver/src/views/AvailableView.vue
git commit -m "fix(driver): label pickup address on available pool, note delivery address unlocks after accept"
```

---

### Task 4: Web — usar labels compartilhados (remover duplicação)

**Files:**
- Modify: `apps/web/src/views/store/StoreOrdersView.vue`

- [ ] **Step 1: Refatorar `paymentLabel`**

A função local (~linhas 205-210) vira consumidora do shared. Adicionar `PAYMENT_METHOD_LABELS` e `type PaymentMethod` ao import existente de `@delivery/shared/constants` e trocar:

```ts
// ANTES
function paymentLabel(o: { paymentMethod: string; changeForCents: number | null }) {
  if (o.paymentMethod === 'CASH') return `Dinheiro${o.changeForCents ? ` (troco p/ ${formatBRL(o.changeForCents)})` : ''}`
  if (o.paymentMethod === 'CARD_MACHINE') return 'Maquininha'
  if (o.paymentMethod === 'PIX_ONLINE') return '✅ PIX pago'
  return '✅ Cartão pago'
}
// DEPOIS
function paymentLabel(o: { paymentMethod: PaymentMethod; changeForCents: number | null }) {
  if (o.paymentMethod === 'CASH') return `Dinheiro${o.changeForCents ? ` (troco p/ ${formatBRL(o.changeForCents)})` : ''}`
  if (o.paymentMethod === 'PIX_ONLINE' || o.paymentMethod === 'CARD_ONLINE') return `✅ ${PAYMENT_METHOD_LABELS[o.paymentMethod]}`
  return PAYMENT_METHOD_LABELS[o.paymentMethod]
}
```

Se o type do pedido na view declarar `paymentMethod: string`, ajustar para `PaymentMethod` (verificar o type local `OrderRow`/similar no topo do script e alinhar).

- [ ] **Step 2: Verificar**

Run: `pnpm --filter @delivery/web test && pnpm --filter @delivery/web build && pnpm typecheck`
Expected: 13 testes PASS, build OK.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/views/store/StoreOrdersView.vue
git commit -m "refactor(web): payment labels from shared constants"
```

---

### Task 5: Semântica de entrega — loja não finaliza DELIVERY

**Files:**
- Modify: `apps/api/src/services/order-status.service.ts`
- Test: `apps/api/test/store-orders.routes.test.ts`
- Modify: `apps/web/src/views/store/StoreOrdersView.vue`

- [ ] **Step 1: Teste falhando**

Adicionar em `apps/api/test/store-orders.routes.test.ts`:

```ts
  it('delivery com entregador: loja não finaliza cliente; pickup continua finalizável', async () => {
    const { order: o } = await createOrder(testDb, customerId, checkout())
    await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'ACCEPTED' }) })
    await requestDriver(testDb, storeId, o.id)
    const { acceptDelivery, collectDelivery } = await import('../src/services/dispatch.service')
    await acceptDelivery(testDb, driverUserId, o.id)
    expect((await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'OUT_FOR_DELIVERY' }) })).status).toBe(409)
    for (const to of ['PREPARING', 'READY']) await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to }) })
    await collectDelivery(testDb, driverUserId, o.id)
    expect((await req(`/store/me/orders/${o.id}/status`, { method: 'PATCH', body: JSON.stringify({ to: 'DELIVERED' }) })).status).toBe(409)

    const { order: p } = await createOrder(testDb, customerId, checkout({ fulfillment: 'PICKUP', addressId: undefined }))
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'DELIVERED']) {
      expect((await req(`/store/me/orders/${p.id}/status`, { method: 'PATCH', body: JSON.stringify({ to }) })).status).toBe(200)
    }
  })
```

- [ ] **Step 2: Rodar RED**

Run: `pnpm --filter @delivery/api test store-orders.routes`
Expected: FAIL — loja ainda consegue `OUT_FOR_DELIVERY`/`DELIVERED` em delivery.

- [ ] **Step 3: Guard API**

Em `storeUpdateOrderStatus`, depois de carregar `order` e antes de `canTransition`:

```ts
  if (order.fulfillment === 'DELIVERY' && to === 'DELIVERED')
    throw new OrderError('Entrega ao cliente só pode ser finalizada pelo entregador', 409)
  if (order.fulfillment === 'DELIVERY' && order.driverId && to === 'OUT_FOR_DELIVERY')
    throw new OrderError('Pedido com entregador deve ser coletado pelo app do entregador', 409)
```

- [ ] **Step 4: UI loja**

Em `actionsFor(o)` de `StoreOrdersView.vue`:

```ts
    if (a.to === 'OUT_FOR_DELIVERY' && (o.fulfillment === 'PICKUP' || Boolean(o.driverId))) return false
    if (a.to === 'DELIVERED' && o.fulfillment === 'DELIVERY') return false
```

No bloco de badges do entregador:

```html
<span v-else-if="o.driverId && o.status === 'OUT_FOR_DELIVERY'" class="rounded bg-green-100 px-2 py-1 text-xs">
  entregue ao entregador
</span>
<span v-else-if="o.driverId" class="rounded bg-green-100 px-2 py-1 text-xs">entregador a caminho</span>
```

- [ ] **Step 5: Verificar**

Run: `pnpm --filter @delivery/api test store-orders.routes && pnpm --filter @delivery/web build && pnpm typecheck && pnpm lint`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/order-status.service.ts apps/api/test/store-orders.routes.test.ts apps/web/src/views/store/StoreOrdersView.vue
git commit -m "fix(delivery): only driver finalizes delivery orders"
```

---

### Task 6: Verificação final

- [ ] **Step 1: Suite completa**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`
Expected: tudo verde (shared 74, api 159, web 13; builds web/driver OK).

- [ ] **Step 2: Checklist manual (reportar ao usuário para validar)**

1. Pedido PIX pago → tela do entregador mostra "✅ Pago online — não cobrar (total R$X)" nos cards de coleta E entrega.
2. Pedido CASH com troco → "Receber: R$X (dinheiro, troco p/ R$Y)".
3. Pedido CARD_MACHINE → "Receber: R$X (maquininha)".
4. Card de coleta mostra "Coleta: <endereço loja>" E "Entrega: <endereço cliente>".
5. Pool (disponíveis) mostra "Coleta: <endereço loja>" + aviso de liberação pós-aceite.

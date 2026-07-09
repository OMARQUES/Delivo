# Pagamentos Online — Mercado Pago Centralizado (Plano 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PIX e cartão de crédito online no checkout, 100% centralizado na conta Mercado Pago da plataforma — pedido online nasce `AWAITING_PAYMENT`, confirma via webhook (PIX) ou sync (cartão), estorno automático em cancelamento, chave PIX de loja/entregador cadastrada para o repasse manual semanal (runbook).

**Architecture:** Gateway atrás da interface `PaymentProvider` (troca futura de gateway/split = trocar 1 arquivo). Implementação `MercadoPagoProvider` com `fetch` puro (sem SDK no backend): `POST /v1/payments` (PIX gera QR/copia-e-cola com expiração 15min; cartão usa token gerado pelo Payment Brick no front e resolve síncrono), `GET /v1/payments/:id`, `POST /v1/payments/:id/refunds`. Webhook `POST /webhooks/mercadopago` valida assinatura HMAC (`x-signature`) e **sempre re-consulta o pagamento na API** antes de confiar. Confirmação de PIX = transição `AWAITING_PAYMENT→PENDING` (a máquina de estados já tem esse arco desde a fundação). Cron expira `AWAITING_PAYMENT` >15min. Estorno total automático quando pedido pago online é cancelado. Repasse: manual semanal (runbook + chaves PIX cadastradas); automação/split = fases futuras já documentadas.

**Tech Stack:** Mercado Pago Payments API (fetch puro + `X-Idempotency-Key`), Payment Brick (SDK JS `@mercadopago/sdk-js` — SÓ no front, cartão), WebCrypto HMAC-SHA256 (webhook), Drizzle, Zod.

---

## ⚠️ REGRAS PARA O IMPLEMENTADOR (leia antes de qualquer task)

1. **Siga o plano literalmente.** Arquivos, nomes, rotas, status HTTP e mensagens são EXATOS. Não renomeie, não "melhore", não mova.
2. **Testes são o contrato.** TDD: teste → falha → implementação → verde. Se código do plano e teste divergirem, o teste vence. Nunca enfraqueça teste.
3. **NÃO faça:** instalar SDK do Mercado Pago no backend (é `fetch` puro; a única dep nova é `@mercadopago/sdk-js` em `apps/web`); split/marketplace_fee (fase futura); estorno parcial (Plano 5b); repasse automatizado (Plano 8); tocar na máquina de estados do shared; refactor fora dos arquivos listados; logar `MP_ACCESS_TOKEN`/`MP_WEBHOOK_SECRET` ou corpo de webhook com dados sensíveis.
4. **Padrões do repo:** rotas via `createRouter()` (`app-factory`); erros de serviço = classe com `status` + `rethrow`→HTTPException; testes api contra Postgres real (`test/helpers/test-db.ts`, `vi.mock` de `createDb`); dinheiro UI SEMPRE R$ via `formatBRL`; guarda atômica = `UPDATE ... WHERE status=<lido>`; `.dev.vars` nunca commitado.
5. **MP nos testes: SEMPRE mockado.** Serviços recebem o provider por parâmetro (injeção) — testes passam um fake; o provider real é testado à parte com `fetch` mockado. NENHUM teste chama a API real do MP.
6. **Cada task termina com:** suítes verdes, `pnpm typecheck && pnpm lint` verdes (build web quando tocado), 1 commit com a mensagem dada.
7. Docker via `flatpak-spawn --host docker ...`. gh: `~/.local/bin/gh` + `GH_CONFIG_DIR=$HOME/.config/gh`.
8. Bloqueado de verdade → PARE e reporte. Não improvise.

---

## Contexto de negócio (fixado)

- **Centralizado:** todo pagamento online cai na conta MP da PLATAFORMA. Loja/entregador recebem por repasse semanal (PIX comum) — fora deste sistema por enquanto; aqui só cadastramos as **chaves PIX** e escrevemos o **runbook**.
- Métodos no checkout: `CASH` e `CARD_MACHINE` (na entrega — inalterados, fora do gateway), `PIX_ONLINE` (novo fluxo real), `CARD_ONLINE` (novo, Payment Brick).
- Pedido online: nasce `AWAITING_PAYMENT` → só aparece pra loja após confirmação (`PENDING`). PIX expira em **15 minutos** (spec §5.1). Cartão resolve na hora: aprovado → `PENDING`; recusado → pedido `CANCELLED` + HTTP 402 (front não limpa o carrinho, cliente tenta de novo).
- Cancelamento de pedido **pago** (loja cancela, aprovação de cancel-request, timeout): **estorno total automático** + evento.
- Valores: banco em **centavos**; API MP em **reais decimal** — conversão só na borda do provider (`centsToReais`).

---

## Estrutura de arquivos

```
packages/shared/src/
├── payment.ts                # PAYMENT_STATUSES + labels (zod-free → constants)
└── order.schema.ts           # MOD: CARD_ONLINE + cardToken/installments/payerEmail

apps/api/src/
├── db/schema/payments.ts     # tabela payments
├── db/schema/stores.ts       # MOD: +pixKey
├── db/schema/drivers.ts      # MOD: +pixKey
├── lib/payment-provider.ts   # interface PaymentProvider + tipos
├── lib/mercadopago.ts        # MercadoPagoProvider (fetch puro) + factory por env
├── services/payment.service.ts   # criar/confirmar/estornar/expirar (recebe provider)
├── services/order.service.ts # MOD: PIX_ONLINE/CARD_ONLINE no createOrder
├── services/order-status.service.ts  # MOD: estorno nos cancelamentos
├── routes/webhooks.ts        # POST /webhooks/mercadopago (HMAC + re-fetch)
├── routes/orders.ts          # MOD: response do create inclui payment
├── routes/driver.ts          # MOD: +PATCH /driver/me/pix-key
├── index.ts                  # MOD: cron += expirar AWAITING_PAYMENT
└── env.ts                    # MOD: +MP_ACCESS_TOKEN, MP_PUBLIC_KEY, MP_WEBHOOK_SECRET

apps/web/src/
├── views/OrderTrackingView.vue   # MOD: bloco "pague com PIX" (QR + copia-e-cola + countdown)
├── views/CheckoutView.vue        # MOD: PIX_ONLINE habilitado + CARD_ONLINE via Payment Brick (gated)
├── views/store/StoreProfileView.vue  # MOD: campo chave PIX
└── lib/mp-brick.ts               # carga do SDK MP + montagem do brick (gated)

apps/driver/src/components/DriverLayout.vue  # MOD: campo chave PIX

docs/runbooks/repasse-semanal.md  # runbook do repasse manual
```

---

### Task 1: shared — status de pagamento + schema do checkout (TDD)

**Files:**
- Create: `packages/shared/src/payment.ts`
- Modify: `packages/shared/src/order.schema.ts`, `packages/shared/src/constants.ts`
- Test: `packages/shared/src/payment.test.ts`, casos novos em `packages/shared/src/order.schema.test.ts`

- [ ] **Step 1: Testes que falham**

`packages/shared/src/payment.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PAYMENT_STATUSES, PAYMENT_STATUS_LABELS } from './payment'

describe('payment constants', () => {
  it('exposes statuses with PT-BR labels', () => {
    expect(PAYMENT_STATUSES).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED'])
    expect(PAYMENT_STATUS_LABELS.APPROVED).toBe('Pago')
    expect(PAYMENT_STATUS_LABELS.EXPIRED).toBe('Expirado')
  })
})
```

Adicionar em `order.schema.test.ts` (describe CheckoutSchema):
```ts
  it('CARD_ONLINE requires cardToken; PIX_ONLINE does not', () => {
    expect(() => CheckoutSchema.parse({ ...base, paymentMethod: 'CARD_ONLINE' })).toThrow()
    const card = CheckoutSchema.parse({
      ...base, paymentMethod: 'CARD_ONLINE',
      cardToken: 'tok_abc123', cardPaymentMethodId: 'master', installments: 1,
    })
    expect(card.cardToken).toBe('tok_abc123')
    expect(CheckoutSchema.parse({ ...base, paymentMethod: 'PIX_ONLINE' }).cardToken).toBeUndefined()
  })
```

- [ ] **Step 2: Ver falhar** — `pnpm --filter @delivery/shared test payment order.schema` → FAIL

- [ ] **Step 3: Criar `packages/shared/src/payment.ts`** (zod-free)

```ts
export const PAYMENT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'Aguardando pagamento',
  APPROVED: 'Pago',
  REJECTED: 'Recusado',
  CANCELLED: 'Cancelado',
  EXPIRED: 'Expirado',
  REFUNDED: 'Estornado',
}

/** Janela do PIX (spec §5.1) */
export const PIX_EXPIRATION_MINUTES = 15
```

- [ ] **Step 4: Modificar `packages/shared/src/order.schema.ts`** — no `CheckoutSchema`:
- `paymentMethod: z.enum(['CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE'])`
- adicionar campos:
```ts
    /** CARD_ONLINE: token do Payment Brick */
    cardToken: z.string().min(8).max(120).optional(),
    /** CARD_ONLINE: bandeira retornada pelo Brick (ex: 'master', 'visa') */
    cardPaymentMethodId: z.string().min(2).max(40).optional(),
    /** CARD_ONLINE: parcelas (MVP: só 1) */
    installments: z.number().int().min(1).max(1).optional(),
```
- adicionar refine (encadeado após o refine de DELIVERY existente):
```ts
  .refine((v) => v.paymentMethod !== 'CARD_ONLINE' || (Boolean(v.cardToken) && Boolean(v.cardPaymentMethodId)), {
    message: 'Cartão online exige token do cartão',
  })
```

- [ ] **Step 5: Barrel** — `constants.ts` += `export * from './payment'`.

- [ ] **Step 6: Ver passar** — `pnpm --filter @delivery/shared test` → 66 + 2 = 68. Typecheck + lint + web build zod-free.

- [ ] **Step 7: Commit** — `git add packages/shared && git commit -m "feat(shared): payment statuses + online card checkout fields"`

---

### Task 2: db — tabela payments, enum CARD_ONLINE, chaves PIX

**Files:**
- Create: `apps/api/src/db/schema/payments.ts`
- Modify: `apps/api/src/db/schema/stores.ts`, `apps/api/src/db/schema/drivers.ts`, `apps/api/src/db/schema/index.ts`, `apps/api/test/helpers/test-db.ts`

- [ ] **Step 1: Criar `apps/api/src/db/schema/payments.ts`**

```ts
import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { PAYMENT_STATUSES } from '@delivery/shared/constants'
import { orders } from './orders'

export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES)
export const paymentGatewayMethod = pgEnum('payment_gateway_method', ['PIX', 'CARD'])

/** Pagamentos online (1 linha por tentativa; pedido pode ter várias tentativas de cartão) */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull().default('MERCADO_PAGO'),
    /** id do pagamento no gateway */
    providerPaymentId: text('provider_payment_id').notNull(),
    status: paymentStatus('status').notNull().default('PENDING'),
    method: paymentGatewayMethod('method').notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** PIX: copia-e-cola */
    qrCode: text('qr_code'),
    /** PIX: imagem base64 (sem prefixo data:) */
    qrCodeBase64: text('qr_code_base64'),
    ticketUrl: text('ticket_url'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('payments_provider_id_unique').on(t.provider, t.providerPaymentId)],
)
```

- [ ] **Step 2: Chaves PIX** — `stores.ts`: após `logoKey`, adicionar `pixKey: text('pix_key'),`. `drivers.ts`: após `fcmToken`, adicionar `pixKey: text('pix_key'),`.

- [ ] **Step 3: Barrel + truncate** — `index.ts` += `export * from './payments'`. `test-db.ts`: adicionar `payments` ao TRUNCATE (antes de `order_events`).

- [ ] **Step 4: Migrations** — DUAS:
1. `pnpm --filter @delivery/api db:generate` → `0009_*.sql` (payments + pixKey cols).
2. Enum novo valor não pode via ADD VALUE dentro de transação (o migrator roda em tx). Gerar custom: `cd apps/api && pnpm drizzle-kit generate --custom --name card_online_enum && cd ../..` e escrever em `drizzle/0010_card_online_enum.sql`:
```sql
ALTER TYPE payment_method RENAME TO payment_method_old;
--> statement-breakpoint
CREATE TYPE payment_method AS ENUM ('CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE');
--> statement-breakpoint
ALTER TABLE orders ALTER COLUMN payment_method TYPE payment_method USING payment_method::text::payment_method;
--> statement-breakpoint
DROP TYPE payment_method_old;
```
E atualizar `db/schema/orders.ts`: `paymentMethod` pgEnum ganha `'CARD_ONLINE'` na lista (pra o snapshot do drizzle bater).
3. `pnpm --filter @delivery/api db:migrate` → aplica 0009+0010. Verificar psql: `\d payments`, `\dT+ payment_method` (4 valores), `\d stores` (pix_key), `\d drivers` (pix_key).

- [ ] **Step 5: Suite** — api 116 verdes (nada quebra), typecheck.

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): payments table, CARD_ONLINE enum, pix keys for store/driver"`

---

### Task 3: PaymentProvider + MercadoPagoProvider (TDD com fetch mockado)

**Files:**
- Create: `apps/api/src/lib/payment-provider.ts`, `apps/api/src/lib/mercadopago.ts`
- Modify: `apps/api/src/env.ts`, `apps/api/.dev.vars.example`, `apps/api/wrangler.jsonc`
- Test: `apps/api/test/mercadopago.test.ts`

- [ ] **Step 1: Criar `apps/api/src/lib/payment-provider.ts`** (a interface que isola o gateway)

```ts
export type PixPaymentResult = {
  providerPaymentId: string
  status: 'PENDING'
  qrCode: string
  qrCodeBase64: string
  ticketUrl: string | null
  expiresAt: Date
}

export type CardPaymentResult = {
  providerPaymentId: string
  /** MP resolve cartão sincronamente */
  status: 'APPROVED' | 'REJECTED' | 'PENDING'
  statusDetail: string
}

export type ProviderPaymentStatus = {
  providerPaymentId: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REFUNDED' | 'EXPIRED'
}

export interface PaymentProvider {
  createPixPayment(input: {
    orderId: string
    amountCents: number
    description: string
    payerEmail: string
    expiresAt: Date
    notificationUrl: string | null
  }): Promise<PixPaymentResult>

  createCardPayment(input: {
    orderId: string
    amountCents: number
    description: string
    payerEmail: string
    cardToken: string
    cardPaymentMethodId: string
    installments: number
  }): Promise<CardPaymentResult>

  getPayment(providerPaymentId: string): Promise<ProviderPaymentStatus>

  /** Estorno TOTAL. Idempotente no gateway. */
  refundPayment(providerPaymentId: string): Promise<void>

  /** Cancela pagamento pendente (PIX expirado). Best-effort. */
  cancelPayment(providerPaymentId: string): Promise<void>
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    public status: 400 | 402 | 502 = 502,
  ) {
    super(message)
  }
}
```

- [ ] **Step 2: Teste que falha — `apps/api/test/mercadopago.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MercadoPagoProvider } from '../src/lib/mercadopago'

const provider = new MercadoPagoProvider('TEST-token-abc')

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('createPixPayment', () => {
  it('POSTs /v1/payments with pix method, idempotency key, amount in reais; maps QR fields', async () => {
    const fn = mockFetch(201, {
      id: 123456, status: 'pending',
      point_of_interaction: { transaction_data: { qr_code: 'copia-e-cola', qr_code_base64: 'b64==', ticket_url: 'https://mp/t' } },
    })
    const expiresAt = new Date('2026-07-10T12:15:00Z')
    const r = await provider.createPixPayment({
      orderId: 'order-1', amountCents: 6400, description: 'Pedido Pizzaria',
      payerEmail: 'a@b.com', expiresAt, notificationUrl: 'https://api/webhooks/mercadopago',
    })
    expect(r).toMatchObject({ providerPaymentId: '123456', status: 'PENDING', qrCode: 'copia-e-cola', qrCodeBase64: 'b64==' })
    const [url, init] = fn.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://api.mercadopago.com/v1/payments')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer TEST-token-abc')
    expect(headers['X-Idempotency-Key']).toBe('order-1-pix')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.transaction_amount).toBe(64) // reais, não centavos
    expect(body.payment_method_id).toBe('pix')
    expect(body.external_reference).toBe('order-1')
    expect(body.notification_url).toBe('https://api/webhooks/mercadopago')
    expect(String(body.date_of_expiration)).toContain('2026-07-10')
  })

  it('throws PaymentProviderError 502 on gateway failure', async () => {
    mockFetch(500, { message: 'boom' })
    await expect(provider.createPixPayment({
      orderId: 'o', amountCents: 100, description: 'x', payerEmail: 'a@b.com',
      expiresAt: new Date(), notificationUrl: null,
    })).rejects.toMatchObject({ status: 502 })
  })
})

describe('createCardPayment', () => {
  it('maps approved and rejected sync results', async () => {
    mockFetch(201, { id: 777, status: 'approved', status_detail: 'accredited' })
    const ok = await provider.createCardPayment({
      orderId: 'o1', amountCents: 5000, description: 'Pedido', payerEmail: 'a@b.com',
      cardToken: 'tok', cardPaymentMethodId: 'master', installments: 1,
    })
    expect(ok).toMatchObject({ providerPaymentId: '777', status: 'APPROVED' })

    mockFetch(201, { id: 778, status: 'rejected', status_detail: 'cc_rejected_insufficient_amount' })
    const bad = await provider.createCardPayment({
      orderId: 'o2', amountCents: 5000, description: 'Pedido', payerEmail: 'a@b.com',
      cardToken: 'tok2', cardPaymentMethodId: 'visa', installments: 1,
    })
    expect(bad).toMatchObject({ status: 'REJECTED', statusDetail: 'cc_rejected_insufficient_amount' })
  })
})

describe('getPayment / refund / cancel', () => {
  it('maps MP statuses to internal', async () => {
    mockFetch(200, { id: 123, status: 'approved' })
    expect((await provider.getPayment('123')).status).toBe('APPROVED')
    mockFetch(200, { id: 123, status: 'cancelled' })
    expect((await provider.getPayment('123')).status).toBe('CANCELLED')
    mockFetch(200, { id: 123, status: 'refunded' })
    expect((await provider.getPayment('123')).status).toBe('REFUNDED')
  })

  it('refund POSTs to /refunds with idempotency; cancel PUTs status cancelled', async () => {
    const fn = mockFetch(201, { id: 1 })
    await provider.refundPayment('999')
    expect(String(fn.mock.calls[0]![0])).toBe('https://api.mercadopago.com/v1/payments/999/refunds')
    const fn2 = mockFetch(200, { id: 999, status: 'cancelled' })
    await provider.cancelPayment('999')
    const [url, init] = fn2.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://api.mercadopago.com/v1/payments/999')
    expect(init.method).toBe('PUT')
  })
})
```

- [ ] **Step 3: Ver falhar** — FAIL (no module)

- [ ] **Step 4: Criar `apps/api/src/lib/mercadopago.ts`**

```ts
import type {
  CardPaymentResult, PaymentProvider, PixPaymentResult, ProviderPaymentStatus,
} from './payment-provider'
import { PaymentProviderError } from './payment-provider'
import type { Env } from '../env'

const BASE = 'https://api.mercadopago.com'

/** centavos → reais com 2 casas (MP usa decimal) */
function centsToReais(cents: number): number {
  return Math.round(cents) / 100
}

function mapStatus(mp: string): ProviderPaymentStatus['status'] {
  switch (mp) {
    case 'approved': return 'APPROVED'
    case 'rejected': return 'REJECTED'
    case 'cancelled': return 'CANCELLED'
    case 'refunded': case 'charged_back': return 'REFUNDED'
    case 'expired': return 'EXPIRED'
    default: return 'PENDING' // pending, in_process, authorized...
  }
}

export class MercadoPagoProvider implements PaymentProvider {
  constructor(private accessToken: string) {}

  private async request<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
    }
    const res = await fetch(`${BASE}${path}`, { ...init, headers })
    if (!res.ok) {
      // NÃO logar body inteiro (pode ter dados do pagador); só status
      throw new PaymentProviderError(`Gateway de pagamento indisponível (${res.status})`, 502)
    }
    return (await res.json()) as T
  }

  async createPixPayment(input: Parameters<PaymentProvider['createPixPayment']>[0]): Promise<PixPaymentResult> {
    type MpPayment = {
      id: number; status: string
      point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } }
    }
    const body = {
      transaction_amount: centsToReais(input.amountCents),
      description: input.description,
      payment_method_id: 'pix',
      external_reference: input.orderId,
      date_of_expiration: input.expiresAt.toISOString(),
      ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
      payer: { email: input.payerEmail },
    }
    const mp = await this.request<MpPayment>('/v1/payments', {
      method: 'POST', body: JSON.stringify(body), idempotencyKey: `${input.orderId}-pix`,
    })
    const td = mp.point_of_interaction?.transaction_data
    if (!td?.qr_code || !td.qr_code_base64) throw new PaymentProviderError('Gateway não retornou QR do PIX', 502)
    return {
      providerPaymentId: String(mp.id), status: 'PENDING',
      qrCode: td.qr_code, qrCodeBase64: td.qr_code_base64, ticketUrl: td.ticket_url ?? null,
      expiresAt: input.expiresAt,
    }
  }

  async createCardPayment(input: Parameters<PaymentProvider['createCardPayment']>[0]): Promise<CardPaymentResult> {
    type MpPayment = { id: number; status: string; status_detail?: string }
    const body = {
      transaction_amount: centsToReais(input.amountCents),
      description: input.description,
      token: input.cardToken,
      payment_method_id: input.cardPaymentMethodId,
      installments: input.installments,
      external_reference: input.orderId,
      payer: { email: input.payerEmail },
    }
    const mp = await this.request<MpPayment>('/v1/payments', {
      method: 'POST', body: JSON.stringify(body), idempotencyKey: `${input.orderId}-card-${input.cardToken.slice(0, 12)}`,
    })
    const status = mapStatus(mp.status)
    return {
      providerPaymentId: String(mp.id),
      status: status === 'APPROVED' ? 'APPROVED' : status === 'REJECTED' ? 'REJECTED' : 'PENDING',
      statusDetail: mp.status_detail ?? mp.status,
    }
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    const mp = await this.request<{ id: number; status: string }>(`/v1/payments/${providerPaymentId}`)
    return { providerPaymentId: String(mp.id), status: mapStatus(mp.status) }
  }

  async refundPayment(providerPaymentId: string): Promise<void> {
    await this.request(`/v1/payments/${providerPaymentId}/refunds`, {
      method: 'POST', body: JSON.stringify({}), idempotencyKey: `refund-${providerPaymentId}`,
    })
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    try {
      await this.request(`/v1/payments/${providerPaymentId}`, {
        method: 'PUT', body: JSON.stringify({ status: 'cancelled' }),
      })
    } catch {
      // best-effort: pagamento pode já estar expirado/pago no gateway
    }
  }
}

/** Factory: null quando não configurado (checkout online responde 503 nesse caso). */
export function createPaymentProvider(env: Env): PaymentProvider | null {
  if (!env.MP_ACCESS_TOKEN) return null
  return new MercadoPagoProvider(env.MP_ACCESS_TOKEN)
}
```

- [ ] **Step 5: Env** — `env.ts` Env += :
```ts
  MP_ACCESS_TOKEN?: string
  MP_PUBLIC_KEY?: string
  MP_WEBHOOK_SECRET?: string
  /** URL pública da API (webhook). Vazio em dev sem tunnel. */
  PUBLIC_API_URL?: string
```
`.dev.vars.example` += :
```
# Mercado Pago (opcional — sem MP_ACCESS_TOKEN o checkout online responde 503)
MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=
PUBLIC_API_URL=
```
`wrangler.jsonc` vars += `"MP_PUBLIC_KEY": ""` (público; preencher depois).

- [ ] **Step 6: Ver passar** — mercadopago.test 6 verdes. Suite + typecheck + lint.

- [ ] **Step 7: Commit** — `git add apps/api && git commit -m "feat(api): payment provider interface + mercado pago implementation"`

---

### Task 4: payment.service (TDD contra Postgres real, provider fake)

**Files:**
- Create: `apps/api/src/services/payment.service.ts`
- Test: `apps/api/test/payment.service.test.ts`

- [ ] **Step 1: Teste que falha — `apps/api/test/payment.service.test.ts`** (seed = padrão dos testes de order: store 24/7 FIXED 500 + customer + address + produto; `makeOrder(paymentMethod)` cria pedido direto via `createOrder` para CASH e via SQL update pra simular AWAITING_PAYMENT quando precisar):

```ts
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
// seed helpers iguais aos de order.service.test.ts (createStoreWithOwner/updateStore/registerUser/createAddress/createCategory/createProduct/createOrder)
import type { PaymentProvider } from '../src/lib/payment-provider'
import {
  PaymentError, createPixPaymentForOrder, confirmPaymentApproved,
  refundOrderPaymentIfAny, expireStaleAwaitingPayment, getOrderPayment,
} from '../src/services/payment.service'

function fakeProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    createPixPayment: vi.fn(async (i) => ({
      providerPaymentId: 'mp-1', status: 'PENDING' as const, qrCode: 'copia', qrCodeBase64: 'b64',
      ticketUrl: null, expiresAt: i.expiresAt,
    })),
    createCardPayment: vi.fn(async () => ({ providerPaymentId: 'mp-c', status: 'APPROVED' as const, statusDetail: 'accredited' })),
    getPayment: vi.fn(async (id) => ({ providerPaymentId: id, status: 'APPROVED' as const })),
    refundPayment: vi.fn(async () => {}),
    cancelPayment: vi.fn(async () => {}),
    ...overrides,
  }
}

// beforeAll/beforeEach/afterAll padrão + seed

describe('createPixPaymentForOrder', () => {
  it('creates payment row with QR data and 15min expiry', async () => {
    const order = await makeAwaitingPaymentOrder() // pedido PIX_ONLINE em AWAITING_PAYMENT (ver helper abaixo)
    const provider = fakeProvider()
    const p = await createPixPaymentForOrder(testDb, provider, order, 'cliente@x.com', null)
    expect(p).toMatchObject({ providerPaymentId: 'mp-1', status: 'PENDING', method: 'PIX', qrCode: 'copia' })
    expect(p.amountCents).toBe(order.totalCents)
    const mins = (p.expiresAt!.getTime() - Date.now()) / 60000
    expect(mins).toBeGreaterThan(13)
    expect(mins).toBeLessThan(16)
  })
})

describe('confirmPaymentApproved', () => {
  it('flips order AWAITING_PAYMENT→PENDING, marks payment APPROVED, adds SYSTEM event; idempotent', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, order, 'c@x.com', null)
    const r1 = await confirmPaymentApproved(testDb, 'mp-1')
    expect(r1).toBe(true)
    const after = await getCustomerOrder(testDb, customerId, order.id)
    expect(after!.status).toBe('PENDING')
    expect(after!.events.some((e) => e.actorRole === 'SYSTEM' && (e.note ?? '').includes('agamento'))).toBe(true)
    expect((await getOrderPayment(testDb, order.id))!.status).toBe('APPROVED')
    // segunda confirmação (webhook duplicado) → no-op
    const r2 = await confirmPaymentApproved(testDb, 'mp-1')
    expect(r2).toBe(false)
  })

  it('unknown providerPaymentId → false (no throw)', async () => {
    expect(await confirmPaymentApproved(testDb, 'ghost')).toBe(false)
  })

  it('LATE payment on already-CANCELLED order → automatic refund', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, order, 'c@x.com', null)
    // cron expira o pedido antes do pagamento chegar
    await testDb.execute(sql`update orders set status='CANCELLED', cancel_reason='Pagamento não realizado a tempo' where id = ${order.id}`)
    const r = await confirmPaymentApproved(testDb, 'mp-1', provider)
    expect(r).toBe(false)
    expect(provider.refundPayment).toHaveBeenCalledWith('mp-1')
    expect((await getOrderPayment(testDb, order.id))!.status).toBe('REFUNDED')
  })
})

describe('refundOrderPaymentIfAny', () => {
  it('refunds APPROVED payment, marks REFUNDED, adds event; no-op without payment', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, order, 'c@x.com', null)
    await confirmPaymentApproved(testDb, 'mp-1')
    const refunded = await refundOrderPaymentIfAny(testDb, provider, order.id)
    expect(refunded).toBe(true)
    expect(provider.refundPayment).toHaveBeenCalledWith('mp-1')
    expect((await getOrderPayment(testDb, order.id))!.status).toBe('REFUNDED')
    // pedido CASH sem payment → false, sem chamada
    const cash = await createOrder(testDb, customerId, checkout())
    expect(await refundOrderPaymentIfAny(testDb, provider, cash.id)).toBe(false)
  })

  it('PENDING (não pago) → cancela no gateway em vez de estornar', async () => {
    const order = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, order, 'c@x.com', null)
    const r = await refundOrderPaymentIfAny(testDb, provider, order.id)
    expect(r).toBe(false)
    expect(provider.cancelPayment).toHaveBeenCalledWith('mp-1')
    expect((await getOrderPayment(testDb, order.id))!.status).toBe('CANCELLED')
  })
})

describe('expireStaleAwaitingPayment', () => {
  it('cancels AWAITING_PAYMENT orders older than 15min + their payments; leaves fresh ones', async () => {
    const stale = await makeAwaitingPaymentOrder()
    const provider = fakeProvider()
    await createPixPaymentForOrder(testDb, provider, stale, 'c@x.com', null)
    await testDb.execute(sql`update orders set created_at = now() - interval '20 minutes' where id = ${stale.id}`)
    const fresh = await makeAwaitingPaymentOrder()
    const n = await expireStaleAwaitingPayment(testDb, provider, 15)
    expect(n).toBe(1)
    expect((await getCustomerOrder(testDb, customerId, stale.id))!.status).toBe('CANCELLED')
    expect((await getOrderPayment(testDb, stale.id))!.status).toBe('EXPIRED')
    expect((await getCustomerOrder(testDb, customerId, fresh.id))!.status).toBe('AWAITING_PAYMENT')
  })
})
```
Helper `makeAwaitingPaymentOrder` (definir no teste): cria pedido CASH via `createOrder`, depois `await testDb.execute(sql\`update orders set status='AWAITING_PAYMENT', payment_method='PIX_ONLINE' where id=${o.id}\`)` e retorna o objeto com `status/payment_method` corrigidos (re-select). (Na Task 5 o createOrder passa a criar isso naturalmente; aqui o service é testado isolado.)

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `apps/api/src/services/payment.service.ts`**

```ts
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { PIX_EXPIRATION_MINUTES } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { orders, payments } from '../db/schema'
import type { PaymentProvider } from '../lib/payment-provider'
import { addEvent } from './order-status.service'

export class PaymentError extends Error {
  constructor(
    message: string,
    public status: 400 | 402 | 409 | 503 = 400,
  ) {
    super(message)
  }
}

type OrderRow = typeof orders.$inferSelect

export async function getOrderPayment(db: Db, orderId: string) {
  const [row] = await db.select().from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(sql`${payments.createdAt} desc`)
    .limit(1)
  return row ?? null
}

/** Cria pagamento PIX no gateway + linha local. Pedido deve estar AWAITING_PAYMENT. */
export async function createPixPaymentForOrder(
  db: Db, provider: PaymentProvider, order: OrderRow, payerEmail: string, publicApiUrl: string | null,
) {
  const expiresAt = new Date(Date.now() + PIX_EXPIRATION_MINUTES * 60_000)
  const pix = await provider.createPixPayment({
    orderId: order.id,
    amountCents: order.totalCents,
    description: `Pedido Delivo`,
    payerEmail,
    expiresAt,
    notificationUrl: publicApiUrl ? `${publicApiUrl}/webhooks/mercadopago` : null,
  })
  const [row] = await db.insert(payments).values({
    orderId: order.id, providerPaymentId: pix.providerPaymentId, method: 'PIX',
    amountCents: order.totalCents, qrCode: pix.qrCode, qrCodeBase64: pix.qrCodeBase64,
    ticketUrl: pix.ticketUrl, expiresAt,
  }).returning()
  return row!
}

/** Registra tentativa de cartão (linha local) com resultado sync do gateway. */
export async function recordCardPayment(
  db: Db, orderId: string, amountCents: number, providerPaymentId: string, approved: boolean,
) {
  const [row] = await db.insert(payments).values({
    orderId, providerPaymentId, method: 'CARD', amountCents,
    status: approved ? 'APPROVED' : 'REJECTED',
  }).returning()
  return row!
}

/**
 * Confirmação (webhook/reconsulta): paga o pedido.
 * Retorna true se transicionou agora; false se já confirmado/inexistente (idempotente).
 * EDGE DE DINHEIRO: se o pagamento chega DEPOIS do pedido ter sido cancelado
 * (ex.: PIX pago no minuto 16, cron já expirou o pedido) → estorno automático imediato.
 */
export async function confirmPaymentApproved(
  db: Db, providerPaymentId: string, provider?: PaymentProvider | null,
): Promise<boolean> {
  const [payment] = await db.select().from(payments)
    .where(eq(payments.providerPaymentId, providerPaymentId))
  if (!payment) return false
  if (payment.status === 'APPROVED' || payment.status === 'REFUNDED') return false

  await db.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, payment.id))
  // guarda atômica: só transiciona se ainda AWAITING_PAYMENT
  const rows = await db.update(orders)
    .set({ status: 'PENDING' })
    .where(and(eq(orders.id, payment.orderId), eq(orders.status, 'AWAITING_PAYMENT')))
    .returning({ id: orders.id })
  if (rows.length === 0) {
    // pedido não estava mais aguardando — se foi CANCELADO, devolve o dinheiro
    const [order] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, payment.orderId))
    if (order?.status === 'CANCELLED') {
      if (provider) await provider.refundPayment(providerPaymentId)
      await db.update(payments).set({ status: 'REFUNDED', refundedAt: new Date() }).where(eq(payments.id, payment.id))
      await addEvent(db, payment.orderId, 'CANCELLED', 'SYSTEM', null, 'pagamento tardio estornado automaticamente')
    }
    return false
  }
  await addEvent(db, payment.orderId, 'PENDING', 'SYSTEM', null, 'pagamento confirmado')
  return true
}

/**
 * Cancelamento de pedido: estorna se pago; cancela no gateway se pendente.
 * Retorna true se ESTORNOU (pagamento aprovado existia).
 */
export async function refundOrderPaymentIfAny(db: Db, provider: PaymentProvider | null, orderId: string): Promise<boolean> {
  const payment = await getOrderPayment(db, orderId)
  if (!payment) return false
  if (payment.status === 'APPROVED') {
    if (provider) await provider.refundPayment(payment.providerPaymentId)
    await db.update(payments)
      .set({ status: 'REFUNDED', refundedAt: new Date() })
      .where(eq(payments.id, payment.id))
    await addEvent(db, orderId, 'CANCELLED', 'SYSTEM', null, 'pagamento estornado')
    return true
  }
  if (payment.status === 'PENDING') {
    if (provider) await provider.cancelPayment(payment.providerPaymentId)
    await db.update(payments).set({ status: 'CANCELLED' }).where(eq(payments.id, payment.id))
  }
  return false
}

/** Cron: AWAITING_PAYMENT velhos → CANCELLED + payment EXPIRED. */
export async function expireStaleAwaitingPayment(db: Db, provider: PaymentProvider | null, olderThanMinutes = PIX_EXPIRATION_MINUTES) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const stale = await db.update(orders)
    .set({ status: 'CANCELLED', cancelReason: 'Pagamento não realizado a tempo' })
    .where(and(eq(orders.status, 'AWAITING_PAYMENT'), lt(orders.createdAt, cutoff)))
    .returning({ id: orders.id })
  for (const o of stale) {
    await addEvent(db, o.id, 'CANCELLED', 'SYSTEM', null, 'pagamento expirado')
    const payment = await getOrderPayment(db, o.id)
    if (payment && payment.status === 'PENDING') {
      if (provider) await provider.cancelPayment(payment.providerPaymentId)
      await db.update(payments).set({ status: 'EXPIRED' }).where(eq(payments.id, payment.id))
    }
  }
  return stale.length
}
```
NOTA `inArray` importado mas não usado → remova do import (lint).

- [ ] **Step 4: Ver passar** — 6 verdes. Suite + typecheck + lint.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): payment lifecycle service — pix create, confirm, refund, expire"`

---

### Task 5: checkout online — createOrder com PIX/cartão (TDD)

**Files:**
- Modify: `apps/api/src/services/order.service.ts`, `apps/api/src/routes/orders.ts`
- Test: casos novos em `apps/api/test/orders.routes.test.ts`

- [ ] **Step 1: Modificar `order.service.ts` — assinatura e fluxo do createOrder**

Substituir a assinatura por:
```ts
import type { PaymentProvider } from '../lib/payment-provider'
import { createPixPaymentForOrder, recordCardPayment, getOrderPayment, PaymentError } from './payment.service'

export type CreateOrderResult = {
  order: typeof orders.$inferSelect
  /** presente só em PIX_ONLINE — dados pra tela de pagamento */
  payment: { qrCode: string; qrCodeBase64: string; expiresAt: string } | null
}

export async function createOrder(
  db: Db, customerId: string, input: CheckoutInput,
  paymentCtx?: { provider: PaymentProvider | null; payerEmail: string; publicApiUrl: string | null },
): Promise<CreateOrderResult> {
```
Regras (substituem o bloco atual de PIX_ONLINE→throw):
```ts
  const isOnline = input.paymentMethod === 'PIX_ONLINE' || input.paymentMethod === 'CARD_ONLINE'
  if (isOnline && !paymentCtx?.provider)
    throw new OrderError('Pagamento online indisponível no momento — use dinheiro ou maquininha', 503)
```
- Idempotência: replay existente retorna `{ order: existing, payment: null }` **exceto** se existing está AWAITING_PAYMENT com payment PIX pendente — nesse caso retornar também o payment salvo (`getOrderPayment`) pra reexibir o QR:
```ts
  if (existing) {
    if (existing.status === 'AWAITING_PAYMENT') {
      const p = await getOrderPayment(db, existing.id)
      if (p?.qrCode) return { order: existing, payment: { qrCode: p.qrCode, qrCodeBase64: p.qrCodeBase64!, expiresAt: p.expiresAt!.toISOString() } }
    }
    return { order: existing, payment: null }
  }
```
- No insert do pedido (dentro da tx): `status: isOnline ? 'AWAITING_PAYMENT' : 'PENDING'` e o event inicial usa esse mesmo status.
- Após a tx (pedido criado):
```ts
  if (input.paymentMethod === 'PIX_ONLINE') {
    const payment = await createPixPaymentForOrder(db, paymentCtx!.provider!, order, paymentCtx!.payerEmail, paymentCtx!.publicApiUrl)
    return { order, payment: { qrCode: payment.qrCode!, qrCodeBase64: payment.qrCodeBase64!, expiresAt: payment.expiresAt!.toISOString() } }
  }
  if (input.paymentMethod === 'CARD_ONLINE') {
    const result = await paymentCtx!.provider!.createCardPayment({
      orderId: order.id, amountCents: order.totalCents, description: 'Pedido Delivo',
      payerEmail: paymentCtx!.payerEmail, cardToken: input.cardToken!,
      cardPaymentMethodId: input.cardPaymentMethodId!, installments: input.installments ?? 1,
    })
    await recordCardPayment(db, order.id, order.totalCents, result.providerPaymentId, result.status === 'APPROVED')
    if (result.status === 'APPROVED') {
      await db.update(orders).set({ status: 'PENDING' }).where(and(eq(orders.id, order.id), eq(orders.status, 'AWAITING_PAYMENT')))
      await addEvent(db, order.id, 'PENDING', 'SYSTEM', null, 'pagamento confirmado (cartão)')
      const [paid] = await db.select().from(orders).where(eq(orders.id, order.id))
      return { order: paid!, payment: null }
    }
    // recusado: cancela o pedido e devolve 402 (cliente tenta de novo — front NÃO limpa carrinho)
    await db.update(orders).set({ status: 'CANCELLED', cancelReason: 'Cartão recusado' }).where(eq(orders.id, order.id))
    await addEvent(db, order.id, 'CANCELLED', 'SYSTEM', null, `cartão recusado: ${result.statusDetail}`)
    throw new PaymentError('Cartão recusado — verifique os dados ou tente outro método', 402)
  }
  return { order, payment: null }
```
(Imports: `addEvent` de order-status.service — CUIDADO com ciclo: order-status.service não importa order.service? Importa `OrderError` de order.service — ciclo order.service→order-status.service→order.service. Node ESM tolera se só tipos/valores usados após init; para EVITAR risco, mova `addEvent` para um arquivo próprio: crie `apps/api/src/services/order-events.ts` com a função `addEvent` (mesmo corpo atual), e re-exporte de order-status.service (`export { addEvent } from './order-events'`) — payment.service e order.service importam de `'./order-events'`. Faça isso NESTA task, ajustando os imports existentes.)

- payerEmail: cliente pode não ter email — na rota (Step 2) resolver: `user.email ?? \`cliente-${sub.slice(0, 8)}@pedidos.delivo.app\`` (MP exige email sintaticamente válido, não verificado).

- [ ] **Step 2: Rota `orders.ts`** — no handler do POST /orders:
```ts
import { createPaymentProvider } from '../lib/mercadopago'
import { PaymentError } from '../services/payment.service'
import { users } from '../db/schema'
import { eq } from 'drizzle-orm'

// rethrow ganha PaymentError:
function rethrow(e: unknown): never {
  if (e instanceof OrderError || e instanceof PaymentError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

// handler POST /orders:
  async (c) => {
    const db = c.get('db')
    const sub = c.get('auth')!.sub
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, sub))
    const result = await createOrder(db, sub, c.req.valid('json'), {
      provider: createPaymentProvider(c.env),
      payerEmail: user?.email ?? `cliente-${sub.slice(0, 8)}@pedidos.delivo.app`,
      publicApiUrl: c.env.PUBLIC_API_URL || null,
    }).catch(rethrow)
    return c.json(result, 201)
  }
```
ATENÇÃO: response agora é `{ order, payment }` — ajustar TODOS os testes existentes que faziam `(await c1.json()).id` para `.order.id` (orders.routes.test tem vários; store-orders/driver tests usam createOrder service direto — o service agora retorna `{order,...}`: **ajustar todos os call-sites de teste** `const o = await createOrder(...)` → `const { order: o } = await createOrder(...)`, e chamadas sem paymentCtx continuam válidas (param opcional, CASH não precisa)).

- [ ] **Step 3: Testes novos em `orders.routes.test.ts`** (provider mockado via vi.mock do módulo mercadopago):

```ts
import * as mp from '../src/lib/mercadopago'

it('PIX_ONLINE: order born AWAITING_PAYMENT, response has QR; replay returns same QR', async () => {
  vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
    createPixPayment: async (i) => ({ providerPaymentId: 'mp-pix-1', status: 'PENDING', qrCode: 'copia', qrCodeBase64: 'b64', ticketUrl: null, expiresAt: i.expiresAt }),
    createCardPayment: async () => { throw new Error('not used') },
    getPayment: async () => ({ providerPaymentId: 'x', status: 'PENDING' }),
    refundPayment: async () => {}, cancelPayment: async () => {},
  })
  const body = checkout({ paymentMethod: 'PIX_ONLINE' })
  const res = await req('/orders', { method: 'POST', body: JSON.stringify(body) }, customerToken)
  expect(res.status).toBe(201)
  const r = (await res.json()) as { order: { status: string }; payment: { qrCode: string } }
  expect(r.order.status).toBe('AWAITING_PAYMENT')
  expect(r.payment.qrCode).toBe('copia')
  const replay = await req('/orders', { method: 'POST', body: JSON.stringify(body) }, customerToken)
  expect(((await replay.json()) as { payment: { qrCode: string } }).payment.qrCode).toBe('copia')
  vi.restoreAllMocks()
})

it('CARD_ONLINE approved → order PENDING direct; rejected → 402 + order CANCELLED', async () => {
  const approve = vi.fn(async () => ({ providerPaymentId: 'mp-c1', status: 'APPROVED' as const, statusDetail: 'accredited' }))
  vi.spyOn(mp, 'createPaymentProvider').mockReturnValue({
    createPixPayment: async () => { throw new Error('not used') },
    createCardPayment: approve,
    getPayment: async () => ({ providerPaymentId: 'x', status: 'APPROVED' }),
    refundPayment: async () => {}, cancelPayment: async () => {},
  })
  const ok = await req('/orders', { method: 'POST', body: JSON.stringify(checkout({ paymentMethod: 'CARD_ONLINE', cardToken: 'tok_12345678', cardPaymentMethodId: 'master', installments: 1 })) }, customerToken)
  expect(ok.status).toBe(201)
  expect(((await ok.json()) as { order: { status: string } }).order.status).toBe('PENDING')

  approve.mockResolvedValueOnce({ providerPaymentId: 'mp-c2', status: 'REJECTED', statusDetail: 'cc_rejected' })
  const bad = await req('/orders', { method: 'POST', body: JSON.stringify(checkout({ paymentMethod: 'CARD_ONLINE', cardToken: 'tok_87654321', cardPaymentMethodId: 'visa', installments: 1 })) }, customerToken)
  expect(bad.status).toBe(402)
  vi.restoreAllMocks()
})

it('online payment without provider configured → 503', async () => {
  // env de teste não tem MP_ACCESS_TOKEN → createPaymentProvider real retorna null
  const res = await req('/orders', { method: 'POST', body: JSON.stringify(checkout({ paymentMethod: 'PIX_ONLINE' })) }, customerToken)
  expect(res.status).toBe(503)
})
```

- [ ] **Step 4: Ver passar + suite inteira** (muitos testes ajustados: `.order.id` / destructuring). Typecheck + lint.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): online checkout — pix awaiting-payment flow + sync card"`

---

### Task 6: webhook Mercado Pago (TDD)

**Files:**
- Create: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/webhooks.routes.test.ts`

- [ ] **Step 1: Teste que falha — `apps/api/test/webhooks.routes.test.ts`** (db real + provider mockado; assinatura HMAC calculada no teste com WebCrypto):

```ts
// seed padrão + makeAwaitingPaymentOrder + createPixPaymentForOrder com fakeProvider (mp-1)
// COPIE o helper fakeProvider do payment.service.test.ts (mesma implementação)
import * as mp from '../src/lib/mercadopago'

const WEBHOOK_SECRET = 'whsec-test'
const envWithMp = { ...env, MP_WEBHOOK_SECRET: WEBHOOK_SECRET, MP_ACCESS_TOKEN: 'tok' }

async function sign(dataId: string, requestId: string, ts: string): Promise<string> {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function webhookReq(dataId: string, v1: string, ts = String(Math.floor(Date.now() / 1000))) {
  return app.request(`/webhooks/mercadopago?data.id=${dataId}&type=payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': `ts=${ts},v1=${v1}`,
      'x-request-id': 'req-1',
    },
    body: JSON.stringify({ type: 'payment', data: { id: dataId } }),
  }, envWithMp)
}

describe('POST /webhooks/mercadopago', () => {
  it('valid signature + approved payment → order becomes PENDING', async () => {
    // seed: pedido AWAITING_PAYMENT com payment mp-1 PENDING
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(fakeProvider({
      getPayment: async () => ({ providerPaymentId: 'mp-1', status: 'APPROVED' }),
    }))
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await webhookReq('mp-1', await sign('mp-1', 'req-1', ts), ts)
    expect(res.status).toBe(200)
    const after = await getCustomerOrder(testDb, customerId, orderId)
    expect(after!.status).toBe('PENDING')
    vi.restoreAllMocks()
  })

  it('invalid signature → 401 and nothing changes', async () => {
    const res = await webhookReq('mp-1', 'deadbeef')
    expect(res.status).toBe(401)
  })

  it('gateway says still pending → 200 but no transition (re-fetch is the source of truth)', async () => {
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(fakeProvider({
      getPayment: async () => ({ providerPaymentId: 'mp-1', status: 'PENDING' }),
    }))
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await webhookReq('mp-1', await sign('mp-1', 'req-1', ts), ts)
    expect(res.status).toBe(200)
    expect((await getCustomerOrder(testDb, customerId, orderId))!.status).toBe('AWAITING_PAYMENT')
    vi.restoreAllMocks()
  })

  it('unknown payment id → 200 (ack, no-op); missing secret config → 503', async () => {
    vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(fakeProvider({
      getPayment: async () => ({ providerPaymentId: 'ghost', status: 'APPROVED' }),
    }))
    const ts = String(Math.floor(Date.now() / 1000))
    expect((await webhookReq('ghost', await sign('ghost', 'req-1', ts), ts)).status).toBe(200)
    const noSecret = await app.request('/webhooks/mercadopago?data.id=x&type=payment', { method: 'POST', body: '{}' }, env)
    expect(noSecret.status).toBe(503)
    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `apps/api/src/routes/webhooks.ts`**

```ts
import { Hono } from 'hono'
import type { AppContext } from '../env'
import { createPaymentProvider } from '../lib/mercadopago'
import { confirmPaymentApproved } from '../services/payment.service'

/**
 * Webhook do Mercado Pago. Regras de ouro:
 * 1. Valida HMAC do x-signature (manifest id;request-id;ts).
 * 2. NUNCA confia no corpo — re-consulta o pagamento na API.
 * 3. Responde 200 rápido (MP re-tenta em erro).
 */
export const webhookRoutes = new Hono<AppContext>()

async function hmacHex(secret: string, manifest: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

webhookRoutes.post('/webhooks/mercadopago', async (c) => {
  const secret = c.env.MP_WEBHOOK_SECRET
  const provider = createPaymentProvider(c.env)
  if (!secret || !provider) return c.json({ error: 'Webhook não configurado' }, 503)

  const dataId = c.req.query('data.id') ?? c.req.query('id')
  const type = c.req.query('type') ?? c.req.query('topic')
  if (!dataId || type !== 'payment') return c.json({ ok: true }, 200) // outros eventos: ack

  // validação x-signature (formato: "ts=...,v1=...")
  const signature = c.req.header('x-signature') ?? ''
  const requestId = c.req.header('x-request-id') ?? ''
  const parts = Object.fromEntries(signature.split(',').map((p) => p.trim().split('=') as [string, string]))
  const ts = parts.ts
  const v1 = parts.v1
  if (!ts || !v1) return c.json({ error: 'Assinatura ausente' }, 401)
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
  const expected = await hmacHex(secret, manifest)
  if (expected !== v1) return c.json({ error: 'Assinatura inválida' }, 401)

  // fonte da verdade: API do MP
  try {
    const payment = await provider.getPayment(dataId)
    if (payment.status === 'APPROVED') {
      await confirmPaymentApproved(c.get('db'), dataId)
    }
  } catch {
    // gateway indisponível: responder 200 mesmo assim faria o MP parar de re-tentar.
    return c.json({ error: 'retry' }, 500)
  }
  return c.json({ ok: true }, 200)
})
```

- [ ] **Step 4: Montar** — `app.ts`: `app.route('/', webhookRoutes)`.

- [ ] **Step 5: Ver passar + suite.** Typecheck + lint.

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): mercado pago webhook with hmac validation and api re-fetch"`

---

### Task 7: estorno nos cancelamentos + cron de expiração (TDD)

**Files:**
- Modify: `apps/api/src/services/order-status.service.ts`, `apps/api/src/routes/store-orders.ts`, `apps/api/src/routes/orders.ts`, `apps/api/src/index.ts`
- Test: casos novos em `apps/api/test/store-orders.routes.test.ts` + `apps/api/test/cron.test.ts`

- [ ] **Step 1: Threading do provider nos cancelamentos.** `storeUpdateOrderStatus`, `storeResolveCancelRequest` (approve) e `customerCancelOrder` ganham parâmetro opcional final `provider?: PaymentProvider | null`; quando a transição resultante é `CANCELLED`, chamar:
```ts
import { refundOrderPaymentIfAny } from './payment.service'
// após o addEvent do CANCELLED:
await refundOrderPaymentIfAny(db, provider ?? null, orderId)
```
Nas rotas (`store-orders.ts` PATCH status + approve; `orders.ts` cancel), passar `createPaymentProvider(c.env)`.
`cancelStalePendingOrders` (cron 30min de PENDING) também ganha provider e estorna (pedido pago que a loja ignorou por 30min → estorno automático).

- [ ] **Step 2: Cron de AWAITING_PAYMENT.** `index.ts` scheduled: além do existente, chamar `expireStaleAwaitingPayment(db, createPaymentProvider(env))`:
```ts
const expired = await expireStaleAwaitingPayment(db, createPaymentProvider(env))
if (expired > 0) console.log(`cron: ${expired} pagamentos expirados`)
```

- [ ] **Step 3: Testes** — em `store-orders.routes.test.ts` (fakeProvider copiado do payment.service.test; helpers do próprio arquivo):
```ts
it('cancelling a paid order triggers full refund', async () => {
  // pedido pago: cria CASH, converte pra online pago via SQL + payment row
  const { order: o } = await createOrder(testDb, customerId, checkout())
  await testDb.execute(sql`update orders set payment_method='PIX_ONLINE' where id = ${o.id}`)
  const refundSpy = vi.fn(async () => {})
  const provider = fakeProvider({ refundPayment: refundSpy })
  const [freshOrder] = await testDb.select().from(orders).where(eq(orders.id, o.id))
  await createPixPaymentForOrder(testDb, provider, freshOrder!, 'c@x.com', null)
  await confirmPaymentApproved(testDb, 'mp-1') // pedido segue PENDING (já estava) — payment APPROVED
  vi.spyOn(mp, 'createPaymentProvider').mockReturnValue(provider)

  const res = await req(`/store/me/orders/${o.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ to: 'CANCELLED', reason: 'sem estoque' }),
  }, ownerToken)
  expect(res.status).toBe(200)
  expect(refundSpy).toHaveBeenCalledWith('mp-1')
  expect((await getOrderPayment(testDb, o.id))!.status).toBe('REFUNDED')
  vi.restoreAllMocks()
})
```
(Imports extras no arquivo: `sql, eq` de drizzle-orm; `orders` do schema; `createPixPaymentForOrder, confirmPaymentApproved, getOrderPayment` de payment.service; `* as mp` de lib/mercadopago. ATENÇÃO: confirmPaymentApproved num pedido PENDING marca payment APPROVED e retorna false — comportamento correto pra este cenário.)
Em `cron.test.ts`:
```ts
it('expireStaleAwaitingPayment cancels old unpaid online orders', async () => {
  // reuso do teste da Task 4 mas via index/cron path: chamar expireStaleAwaitingPayment direto (já coberto) — aqui apenas garantir que cancelStalePendingOrders NÃO pega AWAITING_PAYMENT (status diferente)
  const awaiting = await makeAwaitingPaymentOrder()
  await testDb.execute(sql`update orders set created_at = now() - interval '40 minutes' where id = ${awaiting.id}`)
  const n = await cancelStalePendingOrders(testDb, 30)
  expect(n).toBe(0) // não toca AWAITING_PAYMENT
})
```
(Escreva os testes COMPLETOS seguindo os helpers já existentes nos arquivos — o esqueleto acima define o comportamento esperado; corpo do teste segue o padrão do arquivo.)

- [ ] **Step 4: Ver passar + suite.** Typecheck + lint.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): automatic refunds on cancellation + awaiting-payment expiry cron"`

---

### Task 8: chaves PIX — loja e entregador (TDD leve)

**Files:**
- Modify: `packages/shared/src/store.schema.ts` (StoreUpdateSchema += pixKey), `apps/api/src/routes/driver.ts`, `apps/api/src/services/dispatch.service.ts`
- Test: casos em `apps/api/test/store-me.routes.test.ts` e `apps/api/test/driver.routes.test.ts`

- [ ] **Step 1:** `StoreUpdateSchema` += `pixKey: z.string().trim().min(3).max(140).nullable(),` (dentro do object antes do `.partial()`). Loja atualiza via PATCH /store/me existente (nada novo na rota).

- [ ] **Step 2:** dispatch.service += :
```ts
export async function setDriverPixKey(db: Db, userId: string, pixKey: string | null) {
  await ensureDriverProfile(db, userId)
  const [row] = await db.update(drivers).set({ pixKey }).where(eq(drivers.userId, userId)).returning()
  return row!
}
```
`driver.ts` += rota:
```ts
driverRoutes.openapi(
  createRoute({ method: 'patch', path: '/driver/me/pix-key',
    request: { body: { content: { 'application/json': { schema: z.object({ pixKey: z.string().trim().min(3).max(140).nullable() }) } } } },
    responses: { 200: { description: 'Salvo', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await setDriverPixKey(c.get('db'), c.get('auth')!.sub, c.req.valid('json').pixKey), 200),
)
```

- [ ] **Step 3: Testes** — store-me: PATCH /store/me `{pixKey: 'chave@pix.com'}` → 200 e GET reflete; driver: PATCH /driver/me/pix-key → 200, null limpa. (2 testes, padrão dos arquivos.)

- [ ] **Step 4: Suite + commit** — `git add apps/api packages/shared && git commit -m "feat(api): pix keys for store and driver payouts"`

---

### Task 9: web — tela de pagamento PIX no tracking

**Files:**
- Modify: `apps/web/src/views/OrderTrackingView.vue`, `apps/web/src/views/CheckoutView.vue`

- [ ] **Step 1: CheckoutView** — habilitar PIX:
- Radio PIX: substituir o `disabled` por `<label class="flex items-center gap-2"><input v-model="paymentMethod" type="radio" value="PIX_ONLINE" /> PIX (pague agora)</label>`
- `submit()`: response agora é `{ order: { id }, payment }` — usar `r.order.id` no redirect. **Carrinho: `cart.clear()` permanece SÓ no sucesso** (recusa de cartão = catch → carrinho intacto).

- [ ] **Step 2: OrderTrackingView — bloco de pagamento.** Type `Order` += `paymentMethod: string`; nova busca do payment quando `status === 'AWAITING_PAYMENT'`: a response do GET /orders/:id não tem payment — ADICIONAR no backend: em `getCustomerOrder` (order.service), incluir:
```ts
  const payment = await getOrderPayment(db, order.id)
  // ...no objeto retornado:
  payment: payment && order.status === 'AWAITING_PAYMENT' && payment.qrCode
    ? { qrCode: payment.qrCode, qrCodeBase64: payment.qrCodeBase64, expiresAt: payment.expiresAt?.toISOString() ?? null }
    : null,
```
(Import getOrderPayment de payment.service. Teste rápido em orders.routes.test: detail de pedido AWAITING_PAYMENT inclui `payment.qrCode`.)

No template do tracking, ANTES do stepper (quando aguardando pagamento):
```vue
      <section v-if="order.status === 'AWAITING_PAYMENT' && order.payment" class="space-y-2 rounded border border-blue-300 bg-blue-50 p-3">
        <p class="font-semibold">Pague com PIX para confirmar o pedido</p>
        <img :src="`data:image/png;base64,${order.payment.qrCodeBase64}`" class="mx-auto h-48 w-48" alt="QR Code PIX" />
        <div class="flex gap-2">
          <input :value="order.payment.qrCode" readonly class="flex-1 rounded border bg-white p-2 text-xs" />
          <button class="rounded bg-black px-3 text-white" @click="copyPix">Copiar</button>
        </div>
        <p class="text-xs text-gray-600">
          {{ copied ? 'Copiado! Cole no app do seu banco.' : 'Escaneie o QR ou copie o código.' }}
          <span v-if="pixCountdown"> Expira em {{ pixCountdown }}.</span>
        </p>
      </section>
      <section v-else-if="order.status === 'AWAITING_PAYMENT'" class="rounded border border-blue-300 bg-blue-50 p-3">
        Aguardando confirmação do pagamento…
      </section>
```
Script adições:
```ts
const copied = ref(false)
function copyPix() {
  if (!order.value?.payment) return
  navigator.clipboard.writeText(order.value.payment.qrCode)
  copied.value = true
  setTimeout(() => (copied.value = false), 3000)
}
const pixCountdown = computed(() => {
  const exp = order.value?.payment?.expiresAt
  if (!exp) return null
  const ms = new Date(exp).getTime() - now.value
  if (ms <= 0) return 'instantes'
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m${String(s).padStart(2, '0')}s`
})
const now = ref(Date.now())
// no onMounted, junto do timer existente: setInterval(() => (now.value = Date.now()), 1000) — guardar e limpar no onBeforeUnmount
```
Type Order += `payment: { qrCode: string; qrCodeBase64: string; expiresAt: string | null } | null`.
Polling existente (15s) já vai flipar pra PENDING quando o webhook confirmar. Adicionar `AWAITING_PAYMENT` ao array STEPS? NÃO — o stepper começa em PENDING; quando AWAITING_PAYMENT, esconder o stepper (o v-if do bloco PIX já domina; envolver o `<ol>` com `v-else-if="order.status !== 'AWAITING_PAYMENT'"` mantendo o ramo CANCELLED/DELIVERY_FAILED antes).

- [ ] **Step 3: Verificar** — build + typecheck + lint + testes web.

- [ ] **Step 4: Commit** — `git add apps/web apps/api && git commit -m "feat(web): pix payment screen with qr, copy code and countdown"`

---

### Task 10: web — cartão online via Payment Brick (gated em MP_PUBLIC_KEY)

**Files:**
- Create: `apps/web/src/lib/mp-brick.ts`
- Modify: `apps/web/src/views/CheckoutView.vue`, `apps/web/.env.development`, `apps/web/package.json`

- [ ] **Step 1:** `pnpm --filter @delivery/web add @mercadopago/sdk-js`. `.env.development` += `VITE_MP_PUBLIC_KEY=` (vazio = cartão desabilitado).

- [ ] **Step 2: Criar `apps/web/src/lib/mp-brick.ts`**

```ts
/** Payment Brick do MP (cartão). Gated: sem VITE_MP_PUBLIC_KEY → desabilitado. */
import { loadMercadoPago } from '@mercadopago/sdk-js'

export function cardConfigured(): boolean {
  return Boolean(import.meta.env.VITE_MP_PUBLIC_KEY)
}

export type CardFormData = { token: string; payment_method_id: string; installments: number }

/**
 * Monta o CardPayment Brick no container e resolve com os dados do cartão quando o cliente submeter.
 * Retorna função de destroy.
 */
export async function mountCardBrick(
  containerId: string,
  amountReais: number,
  onSubmit: (data: CardFormData) => Promise<void>,
): Promise<() => void> {
  await loadMercadoPago()
  // @ts-expect-error MercadoPago é global injetado pelo loader
  const mp = new window.MercadoPago(import.meta.env.VITE_MP_PUBLIC_KEY, { locale: 'pt-BR' })
  const bricks = mp.bricks()
  const controller = await bricks.create('cardPayment', containerId, {
    initialization: { amount: amountReais },
    customization: { paymentMethods: { maxInstallments: 1 } },
    callbacks: {
      onReady: () => {},
      onSubmit: (cardFormData: CardFormData) => onSubmit(cardFormData),
      onError: (error: unknown) => console.error('brick error', error),
    },
  })
  return () => controller.unmount()
}
```

- [ ] **Step 3: CheckoutView** — cartão online:
- Radio: `<label v-if="cardAvailable" ...><input v-model="paymentMethod" type="radio" value="CARD_ONLINE" /> Cartão de crédito (online)</label>` — `const cardAvailable = cardConfigured()`.
- Quando `paymentMethod === 'CARD_ONLINE'` e quote ok: renderizar `<div id="mp-card-brick"></div>` e montar o brick (watch em paymentMethod+quote; destroy no unmount/mudança). `onSubmit` do brick → seta `cardData` e chama `submit()`.
- `checkoutBody()` += quando CARD_ONLINE: `cardToken: cardData?.token, cardPaymentMethodId: cardData?.payment_method_id, installments: 1`.
- Botão "Confirmar pedido" oculto quando CARD_ONLINE (o brick tem botão próprio que dispara onSubmit).
- Erro 402 (recusado): mostrar `error` — carrinho intacto, brick permanece pra retry (remontar brick após erro pra novo token: destroy+mount).
- Amount do brick = `quote.totalCents / 100`.
- Implementação de referência (script):
```ts
import { cardConfigured, mountCardBrick, type CardFormData } from '../lib/mp-brick'
const cardAvailable = cardConfigured()
const cardData = ref<CardFormData | null>(null)
let destroyBrick: (() => void) | null = null

watch([paymentMethod, quote], async ([pm, q]) => {
  destroyBrick?.()
  destroyBrick = null
  if (pm === 'CARD_ONLINE' && q && q.problems.length === 0) {
    await nextTick()
    destroyBrick = await mountCardBrick('mp-card-brick', q.totalCents / 100, async (data) => {
      cardData.value = data
      await submit()
    })
  }
})
onBeforeUnmount(() => destroyBrick?.())
```
Template (na seção pagamento):
```vue
      <div v-show="paymentMethod === 'CARD_ONLINE'" id="mp-card-brick" class="mt-2"></div>
```
E o botão confirmar: `v-if="paymentMethod !== 'CARD_ONLINE'"`.

- [ ] **Step 4: Verificar** — build + typecheck + lint (com env vazio: radio de cartão não aparece; zero regressão). Testes web verdes.

- [ ] **Step 5: Commit** — `git add apps/web && git commit -m "feat(web): online card via mercado pago payment brick (gated)"`

---

### Task 11: web/driver — campos de chave PIX + badge "pago" na loja

**Files:**
- Modify: `apps/web/src/views/store/StoreProfileView.vue`, `apps/driver/src/components/DriverLayout.vue`, `apps/web/src/views/store/StoreOrdersView.vue`

- [ ] **Step 1: StoreProfileView** — seção nova (antes de Horários):
```vue
    <section class="space-y-2">
      <h2 class="font-semibold">Repasse (PIX)</h2>
      <input
        :value="form.pixKey ?? ''"
        placeholder="Sua chave PIX (CPF/CNPJ, email, telefone ou aleatória)"
        class="w-full rounded border p-2"
        @input="(e) => (form.pixKey = (e.target as HTMLInputElement).value || null)"
      />
      <p class="text-xs text-gray-500">Usada pela plataforma para repassar suas vendas online (semanal).</p>
    </section>
```
Type Store local += `pixKey: string | null` (form já é Partial<Store>; o PATCH /store/me aceita pixKey pela Task 8). Se o handler inline com cast quebrar vue-tsc, extrair função `setPixKey` no script (padrão do arquivo).

- [ ] **Step 2: DriverLayout** — seção discreta (details) no header ou logo abaixo dele:
```vue
    <details class="border-b p-3 text-sm">
      <summary class="cursor-pointer text-gray-600">Minha chave PIX (recebimento do frete)</summary>
      <div class="mt-2 flex gap-2">
        <input v-model="pixKey" placeholder="Chave PIX" class="flex-1 rounded border p-2" />
        <button class="rounded bg-black px-3 text-white" :disabled="savingPix" @click="savePixKey">Salvar</button>
      </div>
      <p v-if="pixMsg" class="mt-1 text-xs" :class="pixMsg === 'Salvo!' ? 'text-green-700' : 'text-red-600'">{{ pixMsg }}</p>
    </details>
```
Script:
```ts
const pixKey = ref('')
const pixMsg = ref('')
const savingPix = ref(false)
// no onMounted existente, após /driver/me: pixKey.value = (me as { pixKey?: string | null }).pixKey ?? ''
async function savePixKey() {
  savingPix.value = true
  pixMsg.value = ''
  try {
    await api('/driver/me/pix-key', { method: 'PATCH', body: JSON.stringify({ pixKey: pixKey.value || null }) })
    pixMsg.value = 'Salvo!'
  } catch (e) {
    pixMsg.value = e instanceof Error ? e.message : 'Erro'
  } finally {
    savingPix.value = false
  }
}
```

- [ ] **Step 3: StoreOrdersView — badge de pago.** Pedido online chega pra loja já pago (só entra na fila em PENDING). No card do pedido, junto das infos de pagamento:
```vue
              {{ o.paymentMethod === 'CASH' ? `Dinheiro${o.changeForCents ? ` (troco p/ ${formatBRL(o.changeForCents)})` : ''}` : o.paymentMethod === 'CARD_MACHINE' ? 'Maquininha' : o.paymentMethod === 'PIX_ONLINE' ? '✅ PIX pago' : '✅ Cartão pago' }}
```
(Substitui o ternário atual CASH/Maquininha.) Mesmo ajuste no modal de detalhe.

- [ ] **Step 4: Verificar** — builds + typecheck + lint + testes.

- [ ] **Step 5: Commit** — `git add apps/web apps/driver && git commit -m "feat: pix key fields for payouts + paid badges on store queue"`

---

### Task 12: runbook do repasse manual + docs

**Files:**
- Create: `docs/runbooks/repasse-semanal.md`

- [ ] **Step 1: Criar `docs/runbooks/repasse-semanal.md`**

```markdown
# Runbook — Repasse semanal (manual, fase 1)

Todo pagamento ONLINE (PIX/cartão) cai na conta Mercado Pago da plataforma.
Semanalmente (sugestão: segunda de manhã), repassar às lojas e entregadores.

## Passo a passo

1. **Levantar valores** (enquanto não há tela no admin — Plano 8 automatiza):
   ```sql
   -- vendas online entregues na semana, por loja (valor - comissão a definir):
   SELECT s.name, s.pix_key, SUM(o.subtotal_cents)/100.0 AS produtos_reais,
          SUM(COALESCE(o.delivery_fee_cents,0))/100.0 AS fretes_reais
   FROM orders o JOIN stores s ON s.id = o.store_id
   WHERE o.payment_method IN ('PIX_ONLINE','CARD_ONLINE')
     AND o.status = 'DELIVERED'
     AND o.created_at >= now() - interval '7 days'
   GROUP BY s.id, s.name, s.pix_key;

   -- fretes por entregador (todas as entregas da semana, qualquer método):
   SELECT u.name, d.pix_key, SUM(COALESCE(o.delivery_fee_cents,0))/100.0 AS fretes_reais
   FROM orders o JOIN users u ON u.id = o.driver_id LEFT JOIN drivers d ON d.user_id = o.driver_id
   WHERE o.status = 'DELIVERED' AND o.driver_id IS NOT NULL
     AND o.created_at >= now() - interval '7 days'
   GROUP BY u.id, u.name, d.pix_key;
   ```
2. **Calcular repasse da loja** = produtos − comissão da plataforma (percentual acordado) + fretes de pedidos SEM entregador freelance. Regra fina de frete/comissão entra no ledger (Plano 8) — até lá, planilha.
3. **Pagar**: PIX da conta Mercado Pago (ou da conta bancária da empresa) para a `pix_key` de cada um.
4. **Registrar**: anotar comprovantes na planilha da semana (data, quem, valor, id da transação).

## Regras
- Pedido `DELIVERY_FAILED` pago online: frete do entregador É devido (viagem feita); produto = decidir com a loja caso a caso (estorno já foi automático se cancelado).
- Loja/entregador sem `pix_key` cadastrada: cobrar cadastro antes do repasse.

## Evolução
- Fase 2 (Plano 8): ledger + tela de fechamento no admin gera a lista pronta.
- Fase 3: automação de envio (API PIX bancária) e/ou migração pro split nativo do MP.
```

- [ ] **Step 2: Commit** — `git add docs && git commit -m "docs: weekly manual payout runbook"`

---

### Task 13: e2e + encerramento

- [ ] **Step 1: E2E com MP mockado local está coberto pelos testes.** E2E REAL exige credenciais de sandbox — se `apps/api/.dev.vars` tiver `MP_ACCESS_TOKEN` (usuário configura), rodar smoke real: wrangler dev → checkout PIX_ONLINE via curl → response com qrCode real do MP → GET /orders/:id mostra payment → (pagamento real não é possível via curl; confirmar via simulação do painel MP ou aguardar usuário). Reportar até onde foi possível. SEM credenciais: reportar "smoke real pendente de credenciais" — não é falha.

- [ ] **Step 2: carry-forwards** — ADICIONAR:
```markdown
| Pagamentos centralizados na conta MP da plataforma — split nativo/automação = fases futuras (ver runbook) | Plano 7 | Plano 8 (ledger) + futuro split |
| Webhook exige URL pública (PUBLIC_API_URL) — em dev usar tunnel (cloudflared) ou confirmar via reconsulta; produção resolve no deploy CF | Plano 7 | Deploy prod |
| Cartão: MVP 1x sem parcelamento; sem 3DS challenge flow | Plano 7 | Se recusas indicarem necessidade |
| Estorno parcial (amendment) pendente | Plano 7 | Plano 5b |
| Tracking não tem botão "regenerar PIX" após expirar — cliente refaz o pedido | Plano 7 | UX futura |
```

- [ ] **Step 3: README** — Roadmap: "7. ✅ Pagamentos — MP centralizado (PIX+cartão), estornos, webhook". Dev: seção "## Mercado Pago (opcional em dev)" apontando `.dev.vars` (MP_ACCESS_TOKEN/MP_WEBHOOK_SECRET/PUBLIC_API_URL) + `VITE_MP_PUBLIC_KEY` no web + nota do tunnel pra webhook local.

- [ ] **Step 4: Suite final + push + CI** — `pnpm typecheck && pnpm test && pnpm lint && pnpm build` verdes; commit `docs: payments plan wrap-up`; push; CI verde.

---

## Critério de sucesso

- Checkout PIX: pedido nasce `AWAITING_PAYMENT` (invisível pra loja), tracking mostra QR + copia-e-cola + countdown; webhook (assinatura validada + re-fetch na API) confirma → `PENDING` → beep na loja. Replay de idempotência devolve o MESMO QR
- Checkout cartão: Brick tokeniza no front (PCI ok), aprovado → pedido direto `PENDING` pago; recusado → 402, pedido cancelado, **carrinho preservado** pra retry
- Sem `MP_ACCESS_TOKEN`: métodos online retornam 503 com mensagem clara; resto do sistema intacto
- Cancelamento de pedido pago (loja, aprovação de solicitação, timeout 30min) → **estorno total automático** + evento
- Cron cancela `AWAITING_PAYMENT` >15min + expira pagamento no gateway
- Loja vê "✅ PIX pago"/"✅ Cartão pago" na fila; chaves PIX cadastráveis (loja e entregador); runbook do repasse escrito
- Valores: centavos no banco, reais só na borda MP e na UI (R$)
- Suite completa + CI verdes; ZERO teste tocando API real do MP

# Lojas & Descoberta Implementation Plan (Plano 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lojas reais na plataforma — admin cria loja (conta STORE + dados), loja configura perfil/horário/frete/pin/logo, e a home pública lista/busca lojas com deep-link funcionando.

**Architecture:** Tabela `stores` (1:1 com user role STORE) com config de frete (fixo ou mínimo+km), horário `jsonb`, pin lat/lng e logo no R2 (binding local no dev, servida via rota `/media/*`). Funções puras em `shared` (slug, horário/aberto-agora, haversine, cálculo de frete) testadas por TDD; services/rotas testados contra Postgres real (harness existente). `requireRole` finalmente montado em rotas reais (ADMIN e STORE). Frontend: admin UI mínima, form de perfil da loja com Leaflet, home de descoberta.

**Tech Stack:** Drizzle (jsonb, tx), R2 binding (`wrangler dev` simula local), Leaflet + OpenStreetMap, Zod, Vitest (pg real p/ api; happy-dom p/ web).

**Decisões fixas:** dinheiro em **centavos (integer)**; timezone **America/Sao_Paulo**; frete DISTANCE = `max(minFeeCents, perKmCents × kmCobrável)` com km arredondado pra cima em passos de 0,5; fora do raio (`maxKm`) → frete `null` (só retirada); logo servida pelo Worker em `GET /media/:key` com cache público.

---

## Estrutura de arquivos

```
packages/shared/src/
├── store.ts                  # categorias de loja + labels, RESERVED_SLUGS, slugify
├── store.schema.ts           # zod: StoreCreateSchema, StoreUpdateSchema, OpeningHoursSchema
├── opening-hours.ts          # isOpenNow() pura (Intl + America/Sao_Paulo, overnight ok)
├── geo.ts                    # haversineKm(), calcDeliveryFee()
└── (constants.ts += store, opening-hours, geo; schemas.ts += store.schema)

apps/api/src/
├── db/schema/stores.ts       # tabela stores
├── services/store.service.ts # create/list/get/update/setActive
├── routes/admin-stores.ts    # /admin/stores (requireRole ADMIN)
├── routes/store-me.ts        # /store/me GET/PATCH + PUT logo (requireRole STORE)
├── routes/stores-public.ts   # GET /stores, GET /stores/:slug
├── routes/media.ts           # GET /media/:key (R2)
└── env.ts                    # MOD: +BUCKET: R2Bucket

apps/web/src/
├── views/admin/AdminStoresView.vue   # lista + criar + bloquear
├── views/store/StoreProfileView.vue  # config completa + horário + Leaflet + logo
├── views/HomeView.vue                # MOD: descoberta real
├── views/StoreCatalogView.vue        # MOD: header real da loja
└── router/index.ts                   # MOD: /loja/perfil, /admin → AdminStoresView
```

Responsabilidades: `shared/store*` = regra de domínio pura (sem IO). `store.service` = negócio+banco. Rotas = HTTP fino. Views consomem `api()` direto (sem pinia store novo — YAGNI).

---

### Task 1: shared — categorias, slugs reservados, schemas (TDD)

**Files:**
- Create: `packages/shared/src/store.ts`, `packages/shared/src/store.schema.ts`
- Modify: `packages/shared/src/constants.ts`, `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/store.test.ts`

- [ ] **Step 1: Teste que falha — `packages/shared/src/store.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { RESERVED_SLUGS, STORE_CATEGORIES, slugify } from './store'
import { StoreCreateSchema, StoreUpdateSchema } from './store.schema'

describe('slugify', () => {
  it('normalizes names to url-safe slugs', () => {
    expect(slugify('Pizzaria do João!')).toBe('pizzaria-do-joao')
    expect(slugify('  Açaí & Cia  ')).toBe('acai-cia')
    expect(slugify('LOJA___teste--2')).toBe('loja-teste-2')
  })
})

describe('StoreCreateSchema', () => {
  const valid = {
    name: 'Pizzaria do João',
    slug: 'pizzaria-do-joao',
    category: 'PIZZARIA',
    phone: '(44) 3333-4444',
    city: 'Cidade Exemplo',
    addressText: 'Rua Central, 100',
    lat: -23.5,
    lng: -51.9,
    owner: { name: 'João', email: 'Joao@Email.com', password: 'senha123' },
  }

  it('accepts valid input, normalizes phone digits and owner email', () => {
    const r = StoreCreateSchema.parse(valid)
    expect(r.phone).toBe('4433334444')
    expect(r.owner.email).toBe('joao@email.com')
  })

  it('rejects reserved and malformed slugs', () => {
    for (const slug of ['admin', 'login', 'loja', 'api', 'Pizzaria!']) {
      expect(() => StoreCreateSchema.parse({ ...valid, slug })).toThrow()
    }
  })

  it('rejects unknown category and bad coords', () => {
    expect(() => StoreCreateSchema.parse({ ...valid, category: 'XYZ' })).toThrow()
    expect(() => StoreCreateSchema.parse({ ...valid, lat: 91 })).toThrow()
  })
})

describe('StoreUpdateSchema', () => {
  it('accepts partial config updates', () => {
    const r = StoreUpdateSchema.parse({
      deliveryFeeMode: 'DISTANCE',
      deliveryMinFeeCents: 400,
      deliveryPerKmCents: 150,
      deliveryMaxKm: 8,
      minOrderCents: 1500,
      deliveryEtaMinutes: [40, 60],
      pickupEtaMinutes: [15, 25],
      isPaused: true,
      openingHours: [{ dow: 5, open: '18:00', close: '23:30' }],
    })
    expect(r.deliveryFeeMode).toBe('DISTANCE')
  })

  it('rejects invalid opening hours and negative money', () => {
    expect(() => StoreUpdateSchema.parse({ openingHours: [{ dow: 7, open: '18:00', close: '23:00' }] })).toThrow()
    expect(() => StoreUpdateSchema.parse({ openingHours: [{ dow: 1, open: '25:00', close: '23:00' }] })).toThrow()
    expect(() => StoreUpdateSchema.parse({ minOrderCents: -1 })).toThrow()
  })
})

describe('constants', () => {
  it('exposes categories with PT-BR labels and reserved slugs', () => {
    expect(STORE_CATEGORIES.PIZZARIA).toBe('Pizzaria')
    expect(RESERVED_SLUGS).toContain('admin')
    expect(RESERVED_SLUGS).toContain('cadastro')
  })
})
```

- [ ] **Step 2: Ver falhar** — `pnpm --filter @delivery/shared test store` → FAIL (no module)

- [ ] **Step 3: Criar `packages/shared/src/store.ts`**

```ts
/** Categorias de loja (chave estável no banco, label PT-BR na UI) */
export const STORE_CATEGORIES = {
  PIZZARIA: 'Pizzaria',
  LANCHES: 'Lanches',
  RESTAURANTE: 'Restaurante',
  MERCADO: 'Mercado',
  FARMACIA: 'Farmácia',
  ACOUGUE: 'Açougue',
  BEBIDAS: 'Bebidas',
  DOCES: 'Doces & Sorvetes',
  CONVENIENCIA: 'Conveniência',
  OUTROS: 'Outros',
} as const
export type StoreCategory = keyof typeof STORE_CATEGORIES

/** Slugs que colidem com rotas do app — nunca podem ser slug de loja */
export const RESERVED_SLUGS = [
  'admin', 'loja', 'login', 'cadastro', 'auth', 'api', 'docs', 'health',
  'media', 'stores', 'store', 'entregador', 'sobre', 'privacidade', 'termos',
] as const

/** Nome → slug url-safe (remove acentos, minúsculas, hífens) */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
```

- [ ] **Step 4: Criar `packages/shared/src/store.schema.ts`**

```ts
import { z } from 'zod'
import { normalizePhone } from './auth.schema'
import { RESERVED_SLUGS, STORE_CATEGORIES } from './store'

const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug inválido')
  .min(3)
  .max(60)
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), 'Slug reservado')

const HourSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const OpeningHoursSchema = z
  .array(
    z.object({
      dow: z.number().int().min(0).max(6), // 0=domingo
      open: HourSchema,
      close: HourSchema, // close < open = atravessa a meia-noite
    }),
  )
  .max(21)

const Cents = z.number().int().min(0).max(1_000_000)
const EtaRange = z.tuple([z.number().int().min(1).max(600), z.number().int().min(1).max(600)])

type StoreCategoryKey = keyof typeof STORE_CATEGORIES

export const StoreCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: SlugSchema,
  category: z.enum(Object.keys(STORE_CATEGORIES) as [StoreCategoryKey, ...StoreCategoryKey[]]),
  phone: z.string().transform(normalizePhone).pipe(z.string().min(10).max(13)),
  city: z.string().trim().min(2).max(80),
  addressText: z.string().trim().min(5).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  owner: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password: z.string().min(8).max(128),
  }),
})
export type StoreCreateInput = z.infer<typeof StoreCreateSchema>

export const StoreUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    category: z.enum(Object.keys(STORE_CATEGORIES) as [StoreCategoryKey, ...StoreCategoryKey[]]),
    phone: z.string().transform(normalizePhone).pipe(z.string().min(10).max(13)),
    addressText: z.string().trim().min(5).max(200),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    deliveryFeeMode: z.enum(['FIXED', 'DISTANCE']),
    deliveryFixedFeeCents: Cents.nullable(),
    deliveryMinFeeCents: Cents.nullable(),
    deliveryPerKmCents: Cents.nullable(),
    deliveryMaxKm: z.number().min(0.5).max(100).nullable(),
    minOrderCents: Cents.nullable(),
    deliveryEtaMinutes: EtaRange.nullable(),
    pickupEtaMinutes: EtaRange.nullable(),
    isPaused: z.boolean(),
    openingHours: OpeningHoursSchema,
  })
  .partial()
export type StoreUpdateInput = z.infer<typeof StoreUpdateSchema>
```

- [ ] **Step 5: Atualizar barrels** — `constants.ts` += `export * from './store'`; `schemas.ts` += `export * from './store.schema'`.

- [ ] **Step 6: Ver passar** — `pnpm --filter @delivery/shared test` → PASS (17 antigos + 7 novos = 24)

- [ ] **Step 7: Typecheck + lint + web bundle segue sem zod**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @delivery/web build
grep -ci zod apps/web/dist/assets/StoreOrdersView-*.js || echo zod-free-OK
```

- [ ] **Step 8: Commit** — `git add packages/shared && git commit -m "feat(shared): store categories, reserved slugs, store schemas"`

---

### Task 2: shared — horário de funcionamento + geo/frete (TDD)

**Files:**
- Create: `packages/shared/src/opening-hours.ts`, `packages/shared/src/geo.ts`
- Modify: `packages/shared/src/constants.ts`
- Test: `packages/shared/src/opening-hours.test.ts`, `packages/shared/src/geo.test.ts`

- [ ] **Step 1: Testes que falham**

`packages/shared/src/opening-hours.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isOpenNow, type OpeningHour } from './opening-hours'

// Datas em UTC; America/Sao_Paulo = UTC-3.
// 2026-07-08 é uma quarta-feira (dow 3).
const wed20h = new Date('2026-07-08T23:00:00Z') // 20:00 em SP, quarta
const wed23h30 = new Date('2026-07-09T02:30:00Z') // 23:30 em SP, ainda quarta
const thu01h = new Date('2026-07-09T04:00:00Z') // 01:00 em SP, quinta

const hours: OpeningHour[] = [{ dow: 3, open: '18:00', close: '23:00' }]

describe('isOpenNow', () => {
  it('open within window, closed outside', () => {
    expect(isOpenNow(hours, wed20h)).toBe(true)
    expect(isOpenNow(hours, wed23h30)).toBe(false)
  })

  it('closed on days without entries', () => {
    expect(isOpenNow(hours, thu01h)).toBe(false)
  })

  it('overnight window (close < open) spans midnight', () => {
    const overnight: OpeningHour[] = [{ dow: 3, open: '22:00', close: '02:00' }]
    expect(isOpenNow(overnight, wed23h30)).toBe(true) // 23:30 de quarta
    expect(isOpenNow(overnight, thu01h)).toBe(true) // 01:00 de quinta conta pro turno de quarta
    expect(isOpenNow(overnight, wed20h)).toBe(false) // 20:00 antes de abrir
  })

  it('empty hours = always closed', () => {
    expect(isOpenNow([], wed20h)).toBe(false)
  })
})
```

`packages/shared/src/geo.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { calcDeliveryFee, haversineKm } from './geo'

describe('haversineKm', () => {
  it('zero for same point, known distance for 1 degree lat', () => {
    expect(haversineKm({ lat: -23.5, lng: -51.9 }, { lat: -23.5, lng: -51.9 })).toBe(0)
    const d = haversineKm({ lat: -23, lng: -51 }, { lat: -24, lng: -51 })
    expect(d).toBeGreaterThan(110)
    expect(d).toBeLessThan(112)
  })
})

describe('calcDeliveryFee', () => {
  const fixed = { deliveryFeeMode: 'FIXED' as const, deliveryFixedFeeCents: 500, deliveryMinFeeCents: null, deliveryPerKmCents: null, deliveryMaxKm: null }
  const dist = { deliveryFeeMode: 'DISTANCE' as const, deliveryFixedFeeCents: null, deliveryMinFeeCents: 400, deliveryPerKmCents: 200, deliveryMaxKm: 8 }

  it('FIXED returns the fixed fee regardless of distance', () => {
    expect(calcDeliveryFee(fixed, 0.3)).toBe(500)
    expect(calcDeliveryFee(fixed, 12)).toBe(500)
  })

  it('DISTANCE rounds km up in 0.5 steps and applies floor (min fee)', () => {
    expect(calcDeliveryFee(dist, 1.2)).toBe(400) // 1.5km*200=300 → piso 400
    expect(calcDeliveryFee(dist, 3.1)).toBe(700) // 3.5km*200=700
  })

  it('DISTANCE beyond maxKm returns null (delivery unavailable)', () => {
    expect(calcDeliveryFee(dist, 8.4)).toBeNull()
  })

  it('unconfigured mode returns null', () => {
    expect(calcDeliveryFee({ ...dist, deliveryPerKmCents: null }, 2)).toBeNull()
    expect(calcDeliveryFee({ ...fixed, deliveryFixedFeeCents: null }, 2)).toBeNull()
  })
})
```

- [ ] **Step 2: Ver falhar** — `pnpm --filter @delivery/shared test opening geo` → FAIL

- [ ] **Step 3: Criar `packages/shared/src/opening-hours.ts`**

```ts
export type OpeningHour = { dow: number; open: string; close: string }

const TZ = 'America/Sao_Paulo'

/** dow (0=domingo) + minutos do dia no fuso de SP para um instante UTC */
function spDayMinutes(at: Date): { dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const hour = Number(get('hour')) % 24 // Intl pode devolver '24' à meia-noite
  return { dow: dows.indexOf(get('weekday')), minutes: hour * 60 + Number(get('minute')) }
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** Aberto agora? Janela com close < open atravessa a meia-noite (conta pro dow de abertura). */
export function isOpenNow(hours: OpeningHour[], now: Date = new Date()): boolean {
  const { dow, minutes } = spDayMinutes(now)
  const prevDow = (dow + 6) % 7
  return hours.some((h) => {
    const open = toMin(h.open)
    const close = toMin(h.close)
    if (close > open) return h.dow === dow && minutes >= open && minutes < close
    // overnight: [open..24h) no dia h.dow, [0..close) no dia seguinte
    if (h.dow === dow && minutes >= open) return true
    if (h.dow === prevDow && minutes < close) return true
    return false
  })
}
```

- [ ] **Step 4: Criar `packages/shared/src/geo.ts`**

```ts
export type LatLng = { lat: number; lng: number }

/** Distância em linha reta (haversine), km */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

export type DeliveryFeeConfig = {
  deliveryFeeMode: 'FIXED' | 'DISTANCE'
  deliveryFixedFeeCents: number | null
  deliveryMinFeeCents: number | null
  deliveryPerKmCents: number | null
  deliveryMaxKm: number | null
}

/**
 * Frete em centavos. DISTANCE: km arredondado pra CIMA em passos de 0,5;
 * taxa = max(minFee, perKm × km). Fora do raio ou não configurado → null.
 */
export function calcDeliveryFee(cfg: DeliveryFeeConfig, distKm: number): number | null {
  if (cfg.deliveryFeeMode === 'FIXED') return cfg.deliveryFixedFeeCents ?? null
  if (cfg.deliveryPerKmCents == null) return null
  if (cfg.deliveryMaxKm != null && distKm > cfg.deliveryMaxKm) return null
  const km = Math.ceil(distKm * 2) / 2
  const fee = Math.round(cfg.deliveryPerKmCents * km)
  return Math.max(cfg.deliveryMinFeeCents ?? 0, fee)
}
```

- [ ] **Step 5: Barrel** — `constants.ts` += `export * from './opening-hours'` e `export * from './geo'`.

- [ ] **Step 6: Ver passar** — `pnpm --filter @delivery/shared test` → PASS (24 + 8 = 32)

- [ ] **Step 7: Typecheck + lint** — `pnpm typecheck && pnpm lint`

- [ ] **Step 8: Commit** — `git add packages/shared && git commit -m "feat(shared): opening hours + haversine/delivery fee (pure, tz-aware)"`

---

### Task 3: db — tabela stores + migration

**Files:**
- Create: `apps/api/src/db/schema/stores.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Criar `apps/api/src/db/schema/stores.ts`**

```ts
import {
  boolean, doublePrecision, integer, jsonb, pgEnum, pgTable, real, text,
  timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'

export const deliveryFeeMode = pgEnum('delivery_fee_mode', ['FIXED', 'DISTANCE'])

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    category: text('category').notNull(),
    phone: text('phone').notNull(),
    city: text('city').notNull(),
    addressText: text('address_text').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    /** chave do objeto no R2 (logos/<uuid>) */
    logoKey: text('logo_key'),
    deliveryFeeMode: deliveryFeeMode('delivery_fee_mode').notNull().default('FIXED'),
    deliveryFixedFeeCents: integer('delivery_fixed_fee_cents'),
    deliveryMinFeeCents: integer('delivery_min_fee_cents'),
    deliveryPerKmCents: integer('delivery_per_km_cents'),
    deliveryMaxKm: real('delivery_max_km'),
    minOrderCents: integer('min_order_cents'),
    /** [min,max] minutos */
    deliveryEtaMinutes: jsonb('delivery_eta_minutes').$type<[number, number] | null>(),
    pickupEtaMinutes: jsonb('pickup_eta_minutes').$type<[number, number] | null>(),
    /** [{dow,open,close}] */
    openingHours: jsonb('opening_hours').$type<{ dow: number; open: string; close: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isPaused: boolean('is_paused').notNull().default(false),
    /** false = bloqueada pelo admin (some da home, checkout negado) */
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('stores_slug_unique').on(sql`lower(${t.slug})`),
    uniqueIndex('stores_owner_unique').on(t.ownerUserId),
  ],
)
```

- [ ] **Step 2: Barrel** — `schema/index.ts` += `export * from './stores'`.

- [ ] **Step 3: Migration**

```bash
pnpm --filter @delivery/api db:generate
pnpm --filter @delivery/api db:migrate
```
Expected: `drizzle/0003_*.sql`. Verificar: `flatpak-spawn --host docker compose exec postgres psql -U postgres -d delivery -c '\d stores'`

- [ ] **Step 4: Atualizar `truncateAll` no test helper** — `apps/api/test/helpers/test-db.ts`: TRUNCATE ganha `stores`:
```ts
await testDb.execute(sql`TRUNCATE TABLE refresh_tokens, auth_providers, stores, users CASCADE`)
```

- [ ] **Step 5: Suite** — `pnpm --filter @delivery/api test && pnpm --filter @delivery/api typecheck` → 36 + clean

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): stores table with delivery config, hours jsonb, slug unique"`

---

### Task 4: R2 binding + rota /media

**Files:**
- Modify: `apps/api/wrangler.jsonc`, `apps/api/src/env.ts`, `apps/api/src/app.ts`
- Create: `apps/api/src/routes/media.ts`
- Test: `apps/api/test/media.test.ts`

- [ ] **Step 1: Binding em `wrangler.jsonc`** (top-level):

```jsonc
  "r2_buckets": [
    {
      "binding": "BUCKET",
      // bucket real criado no deploy prod; wrangler dev usa armazenamento local
      "bucket_name": "delivo-media"
    }
  ],
```

- [ ] **Step 2: `env.ts`** — `Env` ganha `BUCKET: R2Bucket`.

- [ ] **Step 3: Teste que falha — `apps/api/test/media.test.ts`** (BUCKET mockado; sem R2 real no node pool):

```ts
import { describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: {} as never, client: { end: async () => {} } }) }
})

function envWith(bucket: Partial<R2Bucket>) {
  return {
    JWT_SECRET: 'test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
    BUCKET: bucket as R2Bucket,
  }
}

describe('GET /media/:key', () => {
  it('streams object with content-type and long cache', async () => {
    const obj = {
      body: new Blob(['fake-image']).stream(),
      httpMetadata: { contentType: 'image/png' },
    }
    const env = envWith({ get: vi.fn(async () => obj as unknown as R2ObjectBody) })
    const res = await app.request('/media/logos/abc.png', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('public')
    expect(await res.text()).toBe('fake-image')
  })

  it('404 for missing object', async () => {
    const env = envWith({ get: vi.fn(async () => null) })
    const res = await app.request('/media/nope.png', {}, env)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 4: Ver falhar** — `pnpm --filter @delivery/api test media` → FAIL

- [ ] **Step 5: Criar `apps/api/src/routes/media.ts`**

```ts
import { Hono } from 'hono'
import type { AppContext } from '../env'

/** Serve objetos do R2 (logos, fotos). Rota pública, cache forte (chaves imutáveis). */
export const mediaRoutes = new Hono<AppContext>()

mediaRoutes.get('/media/:key{.+}', async (c) => {
  const obj = await c.env.BUCKET.get(c.req.param('key'))
  if (!obj) return c.json({ error: 'Not Found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})
```
(Hono cru, não OpenAPIHono — rota de arquivo, fora do contrato JSON/OpenAPI.)

- [ ] **Step 6: Montar em `app.ts`** — `app.route('/', mediaRoutes)` junto das outras.

- [ ] **Step 7: Ver passar + suite** — `pnpm --filter @delivery/api test` → 38. Typecheck.

- [ ] **Step 8: Commit** — `git add apps/api && git commit -m "feat(api): r2 bucket binding + public media route"`

---

### Task 5: store service (TDD contra Postgres real)

**Files:**
- Create: `apps/api/src/services/store.service.ts`
- Test: `apps/api/test/store.service.test.ts`

- [ ] **Step 1: Teste que falha — `apps/api/test/store.service.test.ts`**

```ts
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import {
  createStoreWithOwner, getStoreByOwner, getStoreBySlug, listPublicStores,
  setStoreActive, updateStore, StoreError,
} from '../src/services/store.service'

const input = {
  name: 'Pizzaria do João',
  slug: 'pizzaria-do-joao',
  category: 'PIZZARIA',
  phone: '4433334444',
  city: 'Cidade Exemplo',
  addressText: 'Rua Central, 100',
  lat: -23.5,
  lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('createStoreWithOwner', () => {
  it('creates STORE user + store atomically', async () => {
    const s = await createStoreWithOwner(testDb, input)
    expect(s.slug).toBe('pizzaria-do-joao')
    const byOwner = await getStoreByOwner(testDb, s.ownerUserId)
    expect(byOwner?.id).toBe(s.id)
  })

  it('rejects duplicate slug (case-insensitive) and duplicate owner email', async () => {
    await createStoreWithOwner(testDb, input)
    await expect(
      createStoreWithOwner(testDb, { ...input, slug: 'PIZZARIA-DO-JOAO'.toLowerCase(), owner: { ...input.owner, email: 'x@y.com' } }),
    ).rejects.toThrow(StoreError)
    await expect(
      createStoreWithOwner(testDb, { ...input, slug: 'outra-loja' }),
    ).rejects.toThrow(StoreError) // mesmo email de owner
  })

  it('does not leave orphan user when store insert fails', async () => {
    await createStoreWithOwner(testDb, input)
    await expect(
      createStoreWithOwner(testDb, { ...input, owner: { ...input.owner, email: 'b@y.com' } }),
    ).rejects.toThrow(StoreError) // slug dup → tx rollback
    const orphan = await testDb.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, 'b@y.com'),
    })
    expect(orphan).toBeUndefined()
  })
})

describe('listPublicStores / getStoreBySlug', () => {
  it('lists only active stores with computed isOpen', async () => {
    const a = await createStoreWithOwner(testDb, input)
    const b = await createStoreWithOwner(testDb, {
      ...input, name: 'Mercado X', slug: 'mercado-x', category: 'MERCADO',
      owner: { ...input.owner, email: 'm@y.com' },
    })
    await setStoreActive(testDb, b.id, false)
    const list = await listPublicStores(testDb)
    expect(list.map((s) => s.slug)).toEqual(['pizzaria-do-joao'])
    expect(list[0]).toHaveProperty('isOpen')
    expect(list[0]).not.toHaveProperty('ownerUserId') // shape público
    const bySlug = await getStoreBySlug(testDb, 'pizzaria-do-joao')
    expect(bySlug?.name).toBe('Pizzaria do João')
    expect(await getStoreBySlug(testDb, 'mercado-x')).toBeNull() // inativa
    void a
  })
})

describe('updateStore', () => {
  it('updates config and hours for the owner store', async () => {
    const s = await createStoreWithOwner(testDb, input)
    const upd = await updateStore(testDb, s.id, {
      deliveryFeeMode: 'DISTANCE',
      deliveryMinFeeCents: 400,
      deliveryPerKmCents: 150,
      openingHours: [{ dow: 3, open: '18:00', close: '23:00' }],
      isPaused: true,
    })
    expect(upd.deliveryFeeMode).toBe('DISTANCE')
    expect(upd.isPaused).toBe(true)
    expect(upd.openingHours).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Ver falhar** — `pnpm --filter @delivery/api test store.service` → FAIL

- [ ] **Step 3: Criar `apps/api/src/services/store.service.ts`**

```ts
import { eq, sql } from 'drizzle-orm'
import type { StoreCreateInput, StoreUpdateInput } from '@delivery/shared/schemas'
import { isOpenNow } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { stores, users, authProviders } from '../db/schema'
import { hashPassword } from '../lib/password'

export class StoreError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 409,
  ) {
    super(message)
  }
}

function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as { code?: string }).code ?? (e.cause as { code?: string } | undefined)?.code
  return code === '23505'
}

/** Cria user (role STORE) + loja numa transação. Rollback total em conflito. */
export async function createStoreWithOwner(db: Db, input: StoreCreateInput) {
  try {
    return await db.transaction(async (tx) => {
      const [owner] = await tx
        .insert(users)
        .values({ name: input.owner.name, email: input.owner.email, role: 'STORE', status: 'ACTIVE' })
        .returning()
      if (!owner) throw new StoreError('Falha ao criar usuário da loja', 400)
      await tx.insert(authProviders).values({
        userId: owner.id,
        provider: 'PASSWORD',
        passwordHash: await hashPassword(input.owner.password),
      })
      const [store] = await tx
        .insert(stores)
        .values({
          ownerUserId: owner.id,
          name: input.name,
          slug: input.slug,
          category: input.category,
          phone: input.phone,
          city: input.city,
          addressText: input.addressText,
          lat: input.lat,
          lng: input.lng,
        })
        .returning()
      if (!store) throw new StoreError('Falha ao criar loja', 400)
      return store
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new StoreError('Slug ou email já em uso', 409)
    throw e
  }
}

const PUBLIC_COLUMNS = {
  id: stores.id,
  name: stores.name,
  slug: stores.slug,
  category: stores.category,
  phone: stores.phone,
  city: stores.city,
  addressText: stores.addressText,
  lat: stores.lat,
  lng: stores.lng,
  logoKey: stores.logoKey,
  deliveryFeeMode: stores.deliveryFeeMode,
  deliveryFixedFeeCents: stores.deliveryFixedFeeCents,
  deliveryMinFeeCents: stores.deliveryMinFeeCents,
  deliveryPerKmCents: stores.deliveryPerKmCents,
  deliveryMaxKm: stores.deliveryMaxKm,
  minOrderCents: stores.minOrderCents,
  deliveryEtaMinutes: stores.deliveryEtaMinutes,
  pickupEtaMinutes: stores.pickupEtaMinutes,
  openingHours: stores.openingHours,
  isPaused: stores.isPaused,
}

function withOpen<T extends { openingHours: { dow: number; open: string; close: string }[]; isPaused: boolean }>(s: T) {
  return { ...s, isOpen: !s.isPaused && isOpenNow(s.openingHours) }
}

/** Home: só lojas ativas, com isOpen computado (abertas primeiro fica pro front/SQL depois). */
export async function listPublicStores(db: Db) {
  const rows = await db.select(PUBLIC_COLUMNS).from(stores).where(eq(stores.isActive, true))
  return rows.map(withOpen)
}

export async function getStoreBySlug(db: Db, slug: string) {
  const [row] = await db
    .select(PUBLIC_COLUMNS)
    .from(stores)
    .where(sql`lower(${stores.slug}) = ${slug.toLowerCase()} and ${stores.isActive} = true`)
    .limit(1)
  return row ? withOpen(row) : null
}

export async function getStoreByOwner(db: Db, ownerUserId: string) {
  const [row] = await db.select().from(stores).where(eq(stores.ownerUserId, ownerUserId)).limit(1)
  return row ?? null
}

export async function updateStore(db: Db, storeId: string, input: StoreUpdateInput) {
  const [row] = await db.update(stores).set(input).where(eq(stores.id, storeId)).returning()
  if (!row) throw new StoreError('Loja não encontrada', 404)
  return row
}

export async function setStoreActive(db: Db, storeId: string, isActive: boolean) {
  const [row] = await db.update(stores).set({ isActive }).where(eq(stores.id, storeId)).returning()
  if (!row) throw new StoreError('Loja não encontrada', 404)
  return row
}

/** Lista completa pro admin (inclui inativas + owner). */
export async function listAllStores(db: Db) {
  return db.select().from(stores)
}
```

- [ ] **Step 4: Ver passar** — `pnpm --filter @delivery/api test store.service` → PASS 6. Suite completa + typecheck + lint.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): store service — atomic create with owner, public listing, config update"`

---

### Task 6: rotas admin `/admin/stores` (requireRole ADMIN, TDD)

**Files:**
- Create: `apps/api/src/routes/admin-stores.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/admin-stores.routes.test.ts`

- [ ] **Step 1: Teste que falha** — `apps/api/test/admin-stores.routes.test.ts`:

```ts
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { signAccessToken } from '../src/lib/tokens'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const storeInput = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA',
  phone: '(44) 3333-4444', city: 'Cidade Exemplo', addressText: 'Rua Central, 100',
  lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

async function adminToken() {
  return signAccessToken({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Root' }, env.JWT_SECRET)
}
async function customerToken() {
  return signAccessToken({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
}

function req(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) }
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(path, { ...init, headers }, env)
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('POST /admin/stores', () => {
  it('admin creates store, 201', async () => {
    const res = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.slug).toBe('pizzaria-do-joao')
    expect(body).not.toHaveProperty('owner')
  })

  it('401 sem token, 403 role errado, 400 slug reservado, 409 duplicado', async () => {
    expect((await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) })).status).toBe(401)
    expect((await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await customerToken())).status).toBe(403)
    const reserved = await req('/admin/stores', { method: 'POST', body: JSON.stringify({ ...storeInput, slug: 'admin' }) }, await adminToken())
    expect(reserved.status).toBe(400)
    await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const dup = await req('/admin/stores', { method: 'POST', body: JSON.stringify({ ...storeInput, owner: { ...storeInput.owner, email: 'z@y.com' } }) }, await adminToken())
    expect(dup.status).toBe(409)
  })
})

describe('GET /admin/stores + PATCH active', () => {
  it('lists all (including inactive) and toggles active', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { id } = await create.json()
    const patch = await req(`/admin/stores/${id}/active`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) }, await adminToken())
    expect(patch.status).toBe(200)
    const list = await req('/admin/stores', {}, await adminToken())
    const body = await list.json()
    expect(body).toHaveLength(1)
    expect(body[0].isActive).toBe(false)
  })
})
```

- [ ] **Step 2: Ver falhar** — FAIL (no module)

- [ ] **Step 3: Criar `apps/api/src/routes/admin-stores.ts`**

```ts
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { StoreCreateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware, requireRole } from '../middleware/auth'
import {
  createStoreWithOwner, listAllStores, setStoreActive, StoreError,
} from '../services/store.service'

export const adminStoreRoutes = createRouter()

adminStoreRoutes.use('/admin/*', authMiddleware, requireRole('ADMIN'))

function rethrow(e: unknown): never {
  if (e instanceof StoreError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const StoreOut = z.object({ id: z.string(), slug: z.string(), name: z.string(), isActive: z.boolean() }).passthrough()

adminStoreRoutes.openapi(
  createRoute({
    method: 'post', path: '/admin/stores',
    request: { body: { content: { 'application/json': { schema: StoreCreateSchema } } } },
    responses: { 201: { description: 'Loja criada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const store = await createStoreWithOwner(c.get('db'), c.req.valid('json')).catch(rethrow)
    return c.json(store, 201)
  },
)

adminStoreRoutes.openapi(
  createRoute({
    method: 'get', path: '/admin/stores',
    responses: { 200: { description: 'Todas as lojas', content: { 'application/json': { schema: z.array(StoreOut) } } } },
  }),
  async (c) => c.json(await listAllStores(c.get('db')), 200),
)

adminStoreRoutes.openapi(
  createRoute({
    method: 'patch', path: '/admin/stores/{id}/active',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: z.object({ isActive: z.boolean() }) } } },
    },
    responses: { 200: { description: 'Atualizada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { isActive } = c.req.valid('json')
    const store = await setStoreActive(c.get('db'), id, isActive).catch(rethrow)
    return c.json(store, 200)
  },
)
```

- [ ] **Step 4: Montar** — `app.ts`: `app.route('/', adminStoreRoutes)`.

- [ ] **Step 5: Ver passar + suite** — 3 novos verdes; total 41. Typecheck + lint.

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): admin store routes with rbac (first real requireRole mount)"`

---

### Task 7: rotas da loja `/store/me` + upload de logo (TDD)

**Files:**
- Create: `apps/api/src/routes/store-me.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/store-me.routes.test.ts`

- [ ] **Step 1: Teste que falha** — `apps/api/test/store-me.routes.test.ts`:

```ts
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { signAccessToken } from '../src/lib/tokens'
import { createStoreWithOwner } from '../src/services/store.service'

const put = vi.fn(async () => ({}))
const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: { put } as unknown as R2Bucket,
}

const input = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA', phone: '4433334444',
  city: 'Cidade Exemplo', addressText: 'Rua Central, 100', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  put.mockClear()
})
afterAll(closeTestDb)

async function makeStore() {
  const store = await createStoreWithOwner(testDb, input)
  const token = await signAccessToken({ sub: store.ownerUserId, role: 'STORE', name: 'João' }, env.JWT_SECRET)
  return { store, token }
}

describe('GET/PATCH /store/me', () => {
  it('owner reads and updates own store', async () => {
    const { token } = await makeStore()
    const get = await app.request('/store/me', { headers: { Authorization: `Bearer ${token}` } }, env)
    expect(get.status).toBe(200)
    expect((await get.json()).slug).toBe('pizzaria-do-joao')

    const patch = await app.request('/store/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPaused: true, minOrderCents: 2000 }),
    }, env)
    expect(patch.status).toBe(200)
    const body = await patch.json()
    expect(body.isPaused).toBe(true)
    expect(body.minOrderCents).toBe(2000)
  })

  it('401 anon, 403 CUSTOMER, 404 STORE sem loja', async () => {
    expect((await app.request('/store/me', {}, env)).status).toBe(401)
    const cust = await signAccessToken({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
    expect((await app.request('/store/me', { headers: { Authorization: `Bearer ${cust}` } }, env)).status).toBe(403)
    const orphanStore = await signAccessToken({ sub: crypto.randomUUID(), role: 'STORE', name: 'S' }, env.JWT_SECRET)
    expect((await app.request('/store/me', { headers: { Authorization: `Bearer ${orphanStore}` } }, env)).status).toBe(404)
  })
})

describe('PUT /store/me/logo', () => {
  it('stores image in bucket and saves logoKey', async () => {
    const { token } = await makeStore()
    const res = await app.request('/store/me/logo', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
      body: new Uint8Array([137, 80, 78, 71]),
    }, env)
    expect(res.status).toBe(200)
    const { logoKey } = await res.json()
    expect(logoKey).toMatch(/^logos\//)
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('rejects non-image content types', async () => {
    const { token } = await makeStore()
    const res = await app.request('/store/me/logo', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html' },
      body: 'nope',
    }, env)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `apps/api/src/routes/store-me.ts`**

Primeiro, adicionar ao `store.service.ts` (Task 5 já criou o arquivo):

```ts
export async function setStoreLogo(db: Db, storeId: string, logoKey: string) {
  const [row] = await db.update(stores).set({ logoKey }).where(eq(stores.id, storeId)).returning()
  if (!row) throw new StoreError('Loja não encontrada', 404)
  return row
}
```

Depois a rota:

```ts
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { StoreUpdateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware, requireRole } from '../middleware/auth'
import { getStoreByOwner, setStoreLogo, updateStore, StoreError } from '../services/store.service'

export const storeMeRoutes = createRouter()

storeMeRoutes.use('/store/*', authMiddleware, requireRole('STORE'))

function rethrow(e: unknown): never {
  if (e instanceof StoreError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const StoreOut = z.object({ id: z.string(), slug: z.string(), name: z.string() }).passthrough()

storeMeRoutes.openapi(
  createRoute({
    method: 'get', path: '/store/me',
    responses: { 200: { description: 'Minha loja', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
    if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
    return c.json(store, 200)
  },
)

storeMeRoutes.openapi(
  createRoute({
    method: 'patch', path: '/store/me',
    request: { body: { content: { 'application/json': { schema: StoreUpdateSchema } } } },
    responses: { 200: { description: 'Atualizada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
    if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
    const updated = await updateStore(c.get('db'), store.id, c.req.valid('json')).catch(rethrow)
    return c.json(updated, 200)
  },
)

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_LOGO_BYTES = 2 * 1024 * 1024

storeMeRoutes.put('/store/me/logo', async (c) => {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  const type = c.req.header('Content-Type') ?? ''
  if (!IMAGE_TYPES.includes(type)) throw new HTTPException(400, { message: 'Envie png, jpeg ou webp' })
  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0 || body.byteLength > MAX_LOGO_BYTES)
    throw new HTTPException(400, { message: 'Imagem vazia ou maior que 2MB' })
  const ext = type.split('/')[1]
  const key = `logos/${crypto.randomUUID()}.${ext}`
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: type } })
  await setStoreLogo(c.get('db'), store.id, key).catch(rethrow)
  return c.json({ logoKey: key }, 200)
})
```
(Duplicação do lookup `getStoreByOwner` nas 3 rotas é aceita — simples e claro; extrair helper só se crescer.)

- [ ] **Step 4: Montar** — `app.ts`: `app.route('/', storeMeRoutes)`.

- [ ] **Step 5: Ver passar + suite** — 4 novos; total 45. Typecheck + lint.

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): store self-service routes + r2 logo upload"`

---

### Task 8: rotas públicas de descoberta (TDD)

**Files:**
- Create: `apps/api/src/routes/stores-public.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/stores-public.routes.test.ts`

- [ ] **Step 1: Teste que falha** — `apps/api/test/stores-public.routes.test.ts`:

```ts
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

import { app } from '../src/app'
import { createStoreWithOwner, setStoreActive } from '../src/services/store.service'

const env = {
  JWT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const base = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA', phone: '4433334444',
  city: 'Cidade Exemplo', addressText: 'Rua Central, 100', lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com', password: 'senha123' },
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('GET /stores', () => {
  it('lists active stores publicly (no auth), hides owner fields', async () => {
    await createStoreWithOwner(testDb, base)
    const inactive = await createStoreWithOwner(testDb, {
      ...base, slug: 'fechada', name: 'Fechada', owner: { ...base.owner, email: 'f@y.com' },
    })
    await setStoreActive(testDb, inactive.id, false)
    const res = await app.request('/stores', {}, env)
    expect(res.status).toBe(200)
    const list = await res.json()
    expect(list).toHaveLength(1)
    expect(list[0].slug).toBe('pizzaria-do-joao')
    expect(list[0]).toHaveProperty('isOpen')
    expect(list[0]).not.toHaveProperty('ownerUserId')
  })
})

describe('GET /stores/:slug', () => {
  it('returns store by slug case-insensitive; 404 unknown/inactive', async () => {
    await createStoreWithOwner(testDb, base)
    const res = await app.request('/stores/PIZZARIA-DO-JOAO', {}, env)
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe('Pizzaria do João')
    expect((await app.request('/stores/nao-existe', {}, env)).status).toBe(404)
  })
})
```

- [ ] **Step 2: Ver falhar** — FAIL

- [ ] **Step 3: Criar `apps/api/src/routes/stores-public.ts`**

```ts
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../app-factory'
import { getStoreBySlug, listPublicStores } from '../services/store.service'

export const publicStoreRoutes = createRouter()

const PublicStore = z.object({ id: z.string(), slug: z.string(), name: z.string(), isOpen: z.boolean() }).passthrough()

publicStoreRoutes.openapi(
  createRoute({
    method: 'get', path: '/stores',
    responses: { 200: { description: 'Lojas ativas', content: { 'application/json': { schema: z.array(PublicStore) } } } },
  }),
  async (c) => c.json(await listPublicStores(c.get('db')), 200),
)

publicStoreRoutes.openapi(
  createRoute({
    method: 'get', path: '/stores/{slug}',
    request: { params: z.object({ slug: z.string().min(1).max(60) }) },
    responses: { 200: { description: 'Loja', content: { 'application/json': { schema: PublicStore } } } },
  }),
  async (c) => {
    const store = await getStoreBySlug(c.get('db'), c.req.valid('param').slug)
    if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
    return c.json(store, 200)
  },
)
```

- [ ] **Step 4: Montar** — `app.ts`: `app.route('/', publicStoreRoutes)`.

- [ ] **Step 5: Ver passar + suite** — 2 novos; total 47. Typecheck + lint. Smoke: `pnpm --filter @delivery/api dev` + curl `/stores` → `[]` (dev db pode estar vazio) — 200.

- [ ] **Step 6: Commit + push + CI**

```bash
git add apps/api
git commit -m "feat(api): public store discovery routes"
git push
export GH_CONFIG_DIR=$HOME/.config/gh
gh run watch --repo OMARQUES/Delivo $(gh run list --repo OMARQUES/Delivo --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
```

---

### Task 9: web — admin UI mínima de lojas

**Files:**
- Create: `apps/web/src/views/admin/AdminStoresView.vue`
- Modify: `apps/web/src/views/admin/AdminLayout.vue`, `apps/web/src/router/index.ts`

- [ ] **Step 1: Router** — rota `/admin` vira layout com child:

```ts
    {
      path: '/admin',
      component: () => import('../views/admin/AdminLayout.vue'),
      meta: { requiresRole: ['ADMIN'] },
      children: [
        { path: '', name: 'admin', redirect: '/admin/lojas' },
        { path: 'lojas', name: 'admin-stores', component: () => import('../views/admin/AdminStoresView.vue') },
      ],
    },
```

- [ ] **Step 2: `AdminLayout.vue`** — vira shell com RouterView:

```vue
<template>
  <div class="min-h-screen">
    <header class="border-b p-4 font-semibold">Admin da Plataforma</header>
    <RouterView />
  </div>
</template>
```

- [ ] **Step 3: Criar `apps/web/src/views/admin/AdminStoresView.vue`**

```vue
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { STORE_CATEGORIES, slugify } from '@delivery/shared/constants'
import { api } from '../../lib/api'

type AdminStore = { id: string; name: string; slug: string; category: string; isActive: boolean }

const stores = ref<AdminStore[]>([])
const error = ref('')
const saving = ref(false)
const showForm = ref(false)

const form = reactive({
  name: '', slug: '', category: 'PIZZARIA', phone: '', city: '', addressText: '',
  lat: -23.5, lng: -51.9,
  owner: { name: '', email: '', password: '' },
})

async function load() {
  stores.value = await api<AdminStore[]>('/admin/stores')
}
onMounted(() => load().catch((e) => (error.value = e.message)))

function suggestSlug() {
  if (!form.slug) form.slug = slugify(form.name)
}

async function createStore() {
  error.value = ''
  saving.value = true
  try {
    await api('/admin/stores', { method: 'POST', body: JSON.stringify(form) })
    showForm.value = false
    Object.assign(form, { name: '', slug: '', phone: '', addressText: '', owner: { name: '', email: '', password: '' } })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erro'
  } finally {
    saving.value = false
  }
}

async function toggleActive(s: AdminStore) {
  await api(`/admin/stores/${s.id}/active`, { method: 'PATCH', body: JSON.stringify({ isActive: !s.isActive }) })
  await load()
}
</script>

<template>
  <main class="mx-auto max-w-2xl p-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">Lojas</h1>
      <button class="rounded bg-black px-3 py-1 text-white" @click="showForm = !showForm">
        {{ showForm ? 'Fechar' : 'Nova loja' }}
      </button>
    </div>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>

    <form v-if="showForm" class="mt-4 space-y-2 rounded border p-4" @submit.prevent="createStore">
      <input v-model="form.name" required placeholder="Nome da loja" class="w-full rounded border p-2" @blur="suggestSlug" />
      <input v-model="form.slug" required placeholder="slug-da-loja" class="w-full rounded border p-2" />
      <select v-model="form.category" class="w-full rounded border p-2">
        <option v-for="(label, key) in STORE_CATEGORIES" :key="key" :value="key">{{ label }}</option>
      </select>
      <input v-model="form.phone" required placeholder="WhatsApp da loja" class="w-full rounded border p-2" />
      <input v-model="form.city" required placeholder="Cidade" class="w-full rounded border p-2" />
      <input v-model="form.addressText" required placeholder="Endereço" class="w-full rounded border p-2" />
      <div class="grid grid-cols-2 gap-2">
        <input v-model.number="form.lat" type="number" step="any" required placeholder="Lat" class="rounded border p-2" />
        <input v-model.number="form.lng" type="number" step="any" required placeholder="Lng" class="rounded border p-2" />
      </div>
      <p class="pt-2 text-sm font-semibold">Dono (login da loja)</p>
      <input v-model="form.owner.name" required placeholder="Nome do dono" class="w-full rounded border p-2" />
      <input v-model="form.owner.email" type="email" required placeholder="Email de login" class="w-full rounded border p-2" />
      <input v-model="form.owner.password" required minlength="8" placeholder="Senha inicial" class="w-full rounded border p-2" />
      <button type="submit" :disabled="saving" class="w-full rounded bg-black p-2 text-white disabled:opacity-50">
        {{ saving ? 'Criando…' : 'Criar loja' }}
      </button>
    </form>

    <ul class="mt-4 divide-y rounded border">
      <li v-for="s in stores" :key="s.id" class="flex items-center justify-between p-3">
        <div>
          <p class="font-medium">{{ s.name }} <span class="text-xs text-gray-500">/{{ s.slug }}</span></p>
          <p class="text-xs text-gray-500">{{ s.category }} · {{ s.isActive ? 'ativa' : 'bloqueada' }}</p>
        </div>
        <button class="rounded border px-2 py-1 text-sm" @click="toggleActive(s)">
          {{ s.isActive ? 'Bloquear' : 'Desbloquear' }}
        </button>
      </li>
    </ul>
  </main>
</template>
```

- [ ] **Step 4: Verificar** — `pnpm --filter @delivery/web build && pnpm --filter @delivery/web test && pnpm typecheck && pnpm lint` (teste de guard existente: rota /admin agora redireciona child — se o guard.test esperar name 'admin' em navegação de CUSTOMER→home, segue ok; se navegação /admin de anon esperar query redirect '/admin', verifique valor real resolvido `/admin/lojas` e ajuste asserção se necessário — reporte).

- [ ] **Step 5: Commit** — `git add apps/web && git commit -m "feat(web): minimal admin stores ui (create, list, block)"`

---

### Task 10: web — perfil da loja (config + horário + Leaflet + logo)

**Files:**
- Create: `apps/web/src/views/store/StoreProfileView.vue`, `apps/web/src/components/MapPicker.vue`
- Modify: `apps/web/src/router/index.ts`, `apps/web/src/views/store/StoreLayout.vue`

- [ ] **Step 1: Instalar Leaflet** — `pnpm --filter @delivery/web add leaflet && pnpm --filter @delivery/web add -D @types/leaflet`

- [ ] **Step 2: Criar `apps/web/src/components/MapPicker.vue`** (pin arrastável, reutilizado depois no endereço do cliente):

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const props = defineProps<{ lat: number; lng: number }>()
const emit = defineEmits<{ (e: 'update', v: { lat: number; lng: number }): void }>()

const el = ref<HTMLDivElement>()
let map: L.Map | undefined
let marker: L.Marker | undefined

onMounted(() => {
  map = L.map(el.value!).setView([props.lat, props.lng], 15)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
  }).addTo(map)
  marker = L.marker([props.lat, props.lng], { draggable: true }).addTo(map)
  marker.on('dragend', () => {
    const p = marker!.getLatLng()
    emit('update', { lat: p.lat, lng: p.lng })
  })
  map.on('click', (ev: L.LeafletMouseEvent) => {
    marker!.setLatLng(ev.latlng)
    emit('update', { lat: ev.latlng.lat, lng: ev.latlng.lng })
  })
})

watch(
  () => [props.lat, props.lng] as const,
  ([lat, lng]) => marker?.setLatLng([lat, lng]),
)

onBeforeUnmount(() => map?.remove())
</script>

<template>
  <div ref="el" class="h-64 w-full rounded border"></div>
</template>
```

- [ ] **Step 3: Router + layout** — rota `/loja` ganha child `perfil`; `StoreLayout.vue` ganha nav:

Router children de `/loja`:
```ts
        { path: '', redirect: '/loja/pedidos' },
        { path: 'pedidos', name: 'store-orders', component: () => import('../views/store/StoreOrdersView.vue') },
        { path: 'perfil', name: 'store-profile', component: () => import('../views/store/StoreProfileView.vue') },
```

`StoreLayout.vue`:
```vue
<template>
  <div class="min-h-screen">
    <header class="flex items-center gap-4 border-b p-4">
      <span class="font-semibold">Painel da Loja</span>
      <nav class="flex gap-3 text-sm">
        <RouterLink to="/loja/pedidos" class="underline">Pedidos</RouterLink>
        <RouterLink to="/loja/perfil" class="underline">Perfil</RouterLink>
      </nav>
    </header>
    <RouterView />
  </div>
</template>
```

- [ ] **Step 4: Criar `apps/web/src/views/store/StoreProfileView.vue`**

```vue
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { STORE_CATEGORIES } from '@delivery/shared/constants'
import { api } from '../../lib/api'
import MapPicker from '../../components/MapPicker.vue'

type Hours = { dow: number; open: string; close: string }
type Store = {
  id: string; name: string; slug: string; category: string; phone: string
  addressText: string; lat: number; lng: number; logoKey: string | null
  deliveryFeeMode: 'FIXED' | 'DISTANCE'
  deliveryFixedFeeCents: number | null; deliveryMinFeeCents: number | null
  deliveryPerKmCents: number | null; deliveryMaxKm: number | null
  minOrderCents: number | null
  deliveryEtaMinutes: [number, number] | null; pickupEtaMinutes: [number, number] | null
  isPaused: boolean; openingHours: Hours[]
}

const DOWS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

const store = ref<Store | null>(null)
const msg = ref('')
const saving = ref(false)
const form = reactive<Partial<Store>>({})

onMounted(async () => {
  store.value = await api<Store>('/store/me')
  Object.assign(form, store.value)
  if (!form.openingHours) form.openingHours = []
})

function addHour() {
  form.openingHours!.push({ dow: 1, open: '18:00', close: '23:00' })
}
function removeHour(i: number) {
  form.openingHours!.splice(i, 1)
}

async function save() {
  msg.value = ''
  saving.value = true
  try {
    const { id, slug, logoKey, ...payload } = form as Store
    store.value = await api<Store>('/store/me', { method: 'PATCH', body: JSON.stringify(payload) })
    msg.value = 'Salvo!'
  } catch (e) {
    msg.value = e instanceof Error ? e.message : 'Erro ao salvar'
  } finally {
    saving.value = false
  }
}

async function uploadLogo(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  const { logoKey } = await api<{ logoKey: string }>('/store/me/logo', {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  })
  if (store.value) store.value.logoKey = logoKey
}
</script>

<template>
  <main v-if="store" class="mx-auto max-w-2xl space-y-6 p-4">
    <section>
      <h1 class="text-xl font-bold">Perfil — /{{ store.slug }}</h1>
      <label class="mt-2 flex items-center gap-2 text-sm">
        <input v-model="form.isPaused" type="checkbox" /> Pausar pedidos agora
      </label>
    </section>

    <section class="space-y-2">
      <img v-if="store.logoKey" :src="`${API_URL}/media/${store.logoKey}`" class="h-20 w-20 rounded object-cover" alt="logo" />
      <input type="file" accept="image/png,image/jpeg,image/webp" @change="uploadLogo" />
    </section>

    <section class="space-y-2">
      <input v-model="form.name" class="w-full rounded border p-2" placeholder="Nome" />
      <select v-model="form.category" class="w-full rounded border p-2">
        <option v-for="(label, key) in STORE_CATEGORIES" :key="key" :value="key">{{ label }}</option>
      </select>
      <input v-model="form.phone" class="w-full rounded border p-2" placeholder="WhatsApp" />
      <input v-model="form.addressText" class="w-full rounded border p-2" placeholder="Endereço" />
      <MapPicker
        v-if="form.lat != null"
        :lat="form.lat!"
        :lng="form.lng!"
        @update="({ lat, lng }) => Object.assign(form, { lat, lng })"
      />
    </section>

    <section class="space-y-2">
      <h2 class="font-semibold">Entrega</h2>
      <select v-model="form.deliveryFeeMode" class="w-full rounded border p-2">
        <option value="FIXED">Taxa fixa</option>
        <option value="DISTANCE">Mínimo + por km</option>
      </select>
      <input v-if="form.deliveryFeeMode === 'FIXED'" v-model.number="form.deliveryFixedFeeCents" type="number" class="w-full rounded border p-2" placeholder="Taxa fixa (centavos)" />
      <template v-else>
        <input v-model.number="form.deliveryMinFeeCents" type="number" class="w-full rounded border p-2" placeholder="Taxa mínima (centavos)" />
        <input v-model.number="form.deliveryPerKmCents" type="number" class="w-full rounded border p-2" placeholder="Por km (centavos)" />
        <input v-model.number="form.deliveryMaxKm" type="number" step="0.5" class="w-full rounded border p-2" placeholder="Raio máx (km, opcional)" />
      </template>
      <input v-model.number="form.minOrderCents" type="number" class="w-full rounded border p-2" placeholder="Pedido mínimo (centavos, opcional)" />
    </section>

    <section class="space-y-2">
      <h2 class="font-semibold">Horários</h2>
      <div v-for="(h, i) in form.openingHours" :key="i" class="flex items-center gap-2">
        <select v-model.number="h.dow" class="rounded border p-1">
          <option v-for="(d, di) in DOWS" :key="di" :value="di">{{ d }}</option>
        </select>
        <input v-model="h.open" type="time" class="rounded border p-1" />
        <span>–</span>
        <input v-model="h.close" type="time" class="rounded border p-1" />
        <button type="button" class="text-sm text-red-600" @click="removeHour(i)">remover</button>
      </div>
      <button type="button" class="rounded border px-2 py-1 text-sm" @click="addHour">+ horário</button>
    </section>

    <p v-if="msg" class="text-sm" :class="msg === 'Salvo!' ? 'text-green-700' : 'text-red-600'">{{ msg }}</p>
    <button :disabled="saving" class="w-full rounded bg-black p-2 text-white disabled:opacity-50" @click="save">
      {{ saving ? 'Salvando…' : 'Salvar' }}
    </button>
  </main>
</template>
```

- [ ] **Step 5: Verificar** — build + typecheck + lint + testes web. E2E manual: admin cria loja → login como dono → /loja/perfil → configura tudo → salva → pausa.

- [ ] **Step 6: Commit** — `git add apps/web && git commit -m "feat(web): store profile config with hours, leaflet pin and logo upload"`

---

### Task 11: web — home de descoberta + página da loja

**Files:**
- Modify: `apps/web/src/views/HomeView.vue`, `apps/web/src/views/StoreCatalogView.vue`

- [ ] **Step 1: `HomeView.vue` real**

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { STORE_CATEGORIES } from '@delivery/shared/constants'
import { api } from '../lib/api'
import { useAuthStore } from '../stores/auth'

type PublicStore = {
  id: string; name: string; slug: string; category: string; logoKey: string | null
  isOpen: boolean; minOrderCents: number | null; deliveryEtaMinutes: [number, number] | null
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const auth = useAuthStore()
const stores = ref<PublicStore[]>([])
const search = ref('')
const category = ref<string>('')
const loading = ref(true)

onMounted(async () => {
  try {
    stores.value = await api<PublicStore[]>('/stores')
  } finally {
    loading.value = false
  }
})

const filtered = computed(() =>
  stores.value
    .filter((s) => !category.value || s.category === category.value)
    .filter((s) => !search.value || s.name.toLowerCase().includes(search.value.toLowerCase()))
    .sort((a, b) => Number(b.isOpen) - Number(a.isOpen)),
)

function money(cents: number | null) {
  return cents == null ? null : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Lojas da cidade</h1>
      <RouterLink v-if="!auth.isAuthenticated" to="/login" class="text-sm underline">Entrar</RouterLink>
      <span v-else class="text-sm text-gray-600">Olá, {{ auth.user?.name }}</span>
    </header>

    <input v-model="search" placeholder="Buscar loja…" class="mt-3 w-full rounded border p-2" />
    <div class="mt-2 flex flex-wrap gap-1">
      <button class="rounded-full border px-3 py-1 text-xs" :class="!category && 'bg-black text-white'" @click="category = ''">Todas</button>
      <button
        v-for="(label, key) in STORE_CATEGORIES"
        :key="key"
        class="rounded-full border px-3 py-1 text-xs"
        :class="category === key && 'bg-black text-white'"
        @click="category = key"
      >
        {{ label }}
      </button>
    </div>

    <p v-if="loading" class="mt-6 text-gray-500">Carregando…</p>
    <p v-else-if="filtered.length === 0" class="mt-6 text-gray-500">Nenhuma loja encontrada.</p>
    <ul class="mt-4 space-y-2">
      <li v-for="s in filtered" :key="s.id">
        <RouterLink :to="`/${s.slug}`" class="flex items-center gap-3 rounded border p-3" :class="!s.isOpen && 'opacity-50'">
          <img v-if="s.logoKey" :src="`${API_URL}/media/${s.logoKey}`" class="h-12 w-12 rounded object-cover" alt="" />
          <div v-else class="flex h-12 w-12 items-center justify-center rounded bg-gray-200 font-bold">{{ s.name[0] }}</div>
          <div class="flex-1">
            <p class="font-medium">{{ s.name }}</p>
            <p class="text-xs text-gray-500">
              {{ s.isOpen ? 'Aberto' : 'Fechado' }}
              <template v-if="s.deliveryEtaMinutes"> · {{ s.deliveryEtaMinutes[0] }}-{{ s.deliveryEtaMinutes[1] }} min</template>
              <template v-if="money(s.minOrderCents)"> · mín {{ money(s.minOrderCents) }}</template>
            </p>
          </div>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>
```

- [ ] **Step 2: `StoreCatalogView.vue` — header real da loja**

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../lib/api'

type PublicStore = {
  name: string; slug: string; category: string; phone: string; addressText: string
  logoKey: string | null; isOpen: boolean
  deliveryEtaMinutes: [number, number] | null; pickupEtaMinutes: [number, number] | null
  minOrderCents: number | null
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
const route = useRoute()
const store = ref<PublicStore | null>(null)
const notFound = ref(false)

async function load(slug: string) {
  notFound.value = false
  store.value = null
  try {
    store.value = await api<PublicStore>(`/stores/${slug}`)
  } catch {
    notFound.value = true
  }
}

onMounted(() => load(route.params.storeSlug as string))
watch(
  () => route.params.storeSlug,
  (s) => typeof s === 'string' && load(s),
)
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <p v-if="notFound">
      Loja não encontrada. <RouterLink to="/" class="underline">Ver todas</RouterLink>
    </p>
    <template v-else-if="store">
      <header class="flex items-center gap-3">
        <img v-if="store.logoKey" :src="`${API_URL}/media/${store.logoKey}`" class="h-16 w-16 rounded object-cover" alt="" />
        <div>
          <h1 class="text-2xl font-bold">{{ store.name }}</h1>
          <p class="text-sm" :class="store.isOpen ? 'text-green-700' : 'text-red-600'">
            {{ store.isOpen ? 'Aberto agora' : 'Fechado' }}
          </p>
          <p class="text-xs text-gray-500">
            {{ store.addressText }}
            <template v-if="store.deliveryEtaMinutes"> · entrega {{ store.deliveryEtaMinutes[0] }}-{{ store.deliveryEtaMinutes[1] }} min</template>
          </p>
        </div>
      </header>
      <p class="mt-6 text-gray-600">Cardápio entra no plano de produtos.</p>
    </template>
    <p v-else class="text-gray-500">Carregando…</p>
  </main>
</template>
```

- [ ] **Step 3: Verificar** — build + typecheck + testes web + lint. E2E manual: home lista loja criada, filtro/busca funcionam, deep-link `/pizzaria-do-joao` mostra header, loja bloqueada some.

- [ ] **Step 4: Commit + push + CI**

```bash
git add apps/web
git commit -m "feat(web): real discovery home + store page header"
git push
```

---

### Task 12: encerramento

**Files:**
- Modify: `docs/carry-forwards.md`, `README.md`

- [ ] **Step 1: carry-forwards** — REMOVER linha "Slugs reservados (`loja`, `admin`, etc.) — validar na criação de loja" (resolvido: RESERVED_SLUGS + schema). ADICIONAR:

```markdown
| Bucket R2 `delivo-media` real não criado — dev usa storage local do wrangler; criar via `wrangler r2 bucket create delivo-media` no deploy prod | Plano Lojas T4 | Deploy prod (Task 9 fundação) |
| Logo upload passa pelo Worker (limite 2MB ok p/ logo); fotos de produto em volume podem justificar presigned URL direto ao R2 | Plano Lojas T7 | Plano Produtos se necessário |
| Home ordena abertas-primeiro no client; com muitas lojas mover ordenação/paginação pro SQL | Plano Lojas T11 | Quando lista crescer |
```

- [ ] **Step 2: README** — Roadmap: marcar "3. Lojas & Descoberta ✅" e renumerar (4. Produtos & Cardápio, 5. Pedidos, 6. Dispatch, 7. Pagamentos, 8. Financeiro, 9. Capacitor, 10. Admin & Relatórios). Dev: nota "admin cria lojas em /admin/lojas".

- [ ] **Step 3: Suite final** — `pnpm typecheck && pnpm test && pnpm lint && pnpm build` verde. Commit + push:

```bash
git add docs/carry-forwards.md README.md
git commit -m "docs: stores plan wrap-up — carry-forwards + roadmap"
git push
```

---

## Critério de sucesso

- Admin (UI) cria loja com conta STORE; slug reservado/duplicado rejeitado; bloquear/desbloquear funciona
- Dono loga → `/loja/perfil` → configura horário/frete/pin/logo/pausa → salvo de verdade
- Home pública lista lojas ativas com logo/aberto-fechado/eta/mínimo, filtro por categoria + busca por nome
- Deep-link `/:slug` mostra a loja (case-insensitive); loja inativa = 404
- `isOpenNow` correto em America/Sao_Paulo incluindo overnight; `calcDeliveryFee` conforme decisões
- `requireRole` montado em rotas reais (ADMIN e STORE) — carry-forward resolvido
- Suite completa + CI verdes (~47 testes api, 32 shared, 8 web)

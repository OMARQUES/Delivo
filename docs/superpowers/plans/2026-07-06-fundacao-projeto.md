# Fundação do Projeto Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monorepo funcional 100% Cloudflare com API Hono (Workers) + Postgres (Neon/Hyperdrive/Drizzle), webapp Vue (cliente/loja/admin), shell do app do entregador, CI/CD e deploy de ponta a ponta.

**Architecture:** Monorepo pnpm com 3 apps (`api` em Workers, `web` e `driver` como SPAs Vue servidas por Workers Assets) e 1 pacote compartilhado (`shared`) com tipos, schemas Zod e a máquina de estados do pedido. API usa Hono + zod-openapi (docs automáticas), Drizzle ORM sobre Postgres via Hyperdrive. Dev local: Postgres em Docker + `wrangler dev`.

**Tech Stack:** pnpm workspaces, TypeScript strict, Hono, @hono/zod-openapi, Zod, Drizzle ORM, postgres.js, Neon (Postgres), Cloudflare Workers/Hyperdrive/Workers Assets, Vue 3, Vite, Pinia, Vue Router, Tailwind CSS v4, Vitest, ESLint + Prettier, GitHub Actions.

**Pré-requisitos da máquina:** Node 22+, pnpm 10+ (`corepack enable`), Docker, conta Cloudflare (free), conta Neon (free), `wrangler` autenticado (`npx wrangler login`).

---

## Estrutura de arquivos final

```
Delivery/
├── package.json                  # raiz: scripts agregados
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .gitignore
├── .prettierrc.json
├── eslint.config.js
├── docker-compose.yml            # Postgres local
├── .github/workflows/ci.yml
├── .github/workflows/deploy.yml
├── docs/superpowers/plans/       # este plano e os próximos
├── packages/
│   └── shared/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── src/index.ts
│       ├── src/order-status.ts   # máquina de estados do pedido
│       └── src/order-status.test.ts
└── apps/
    ├── api/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── wrangler.jsonc
    │   ├── vitest.config.ts
    │   ├── drizzle.config.ts
    │   ├── .dev.vars             # não commitado
    │   ├── .env                  # não commitado (drizzle-kit CLI)
    │   ├── src/index.ts          # entry Workers
    │   ├── src/app.ts            # instância Hono (testável)
    │   ├── src/env.ts            # tipagem dos bindings
    │   ├── src/middleware/error-handler.ts
    │   ├── src/routes/health.ts
    │   ├── src/db/client.ts
    │   ├── src/db/schema/index.ts
    │   ├── src/db/schema/users.ts
    │   ├── drizzle/              # migrations geradas
    │   └── test/health.test.ts
    ├── web/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── vite.config.ts
    │   ├── wrangler.jsonc        # deploy Workers Assets (SPA)
    │   ├── index.html
    │   └── src/
    │       ├── main.ts
    │       ├── App.vue
    │       ├── style.css
    │       ├── router/index.ts
    │       ├── views/HomeView.vue
    │       ├── views/StoreCatalogView.vue
    │       ├── views/store/StoreLayout.vue
    │       ├── views/store/StoreOrdersView.vue
    │       └── views/admin/AdminLayout.vue
    └── driver/
        ├── package.json
        ├── tsconfig.json
        ├── vite.config.ts
        ├── wrangler.jsonc
        ├── index.html
        └── src/
            ├── main.ts
            ├── App.vue
            ├── style.css
            └── views/DeliveriesView.vue
```

**Responsabilidades:**
- `packages/shared` — única fonte de verdade para enums/status/schemas usados por api, web e driver. Nunca importa nada dos apps.
- `apps/api/src/app.ts` — monta o Hono app (rotas + middlewares). Separado de `index.ts` para os testes chamarem `app.request()` sem runtime Workers.
- `apps/api/src/db/` — client Drizzle (via Hyperdrive) e schema. Migrations geradas pelo drizzle-kit em `apps/api/drizzle/`.
- `apps/web` — SPA única com áreas por papel: `/` (cliente), `/:storeSlug` (deep-link da loja), `/loja/*` (dashboard), `/admin/*`.
- `apps/driver` — SPA separada (build enxuta; vira Capacitor Android em plano futuro).

---

### Task 1: Raiz do monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.prettierrc.json`, `eslint.config.js`

- [ ] **Step 1: Inicializar git**

```bash
cd /home/omarques/Desktop/Projetos/Delivery
git init -b main
```

- [ ] **Step 2: Criar `pnpm-workspace.yaml`**

```yaml
packages:
  - apps/*
  - packages/*
```

- [ ] **Step 3: Criar `package.json` da raiz**

```json
{
  "name": "delivery",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev:api": "pnpm --filter @delivery/api dev",
    "dev:web": "pnpm --filter @delivery/web dev",
    "dev:driver": "pnpm --filter @delivery/driver dev",
    "build": "pnpm -r build",
    "test": "pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "lint": "eslint .",
    "format": "prettier --write ."
  }
}
```

- [ ] **Step 4: Criar `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  }
}
```

- [ ] **Step 5: Criar `.gitignore`**

```
node_modules/
dist/
.wrangler/
.dev.vars
.env
*.local
coverage/
.DS_Store
```

- [ ] **Step 6: Criar `.prettierrc.json`**

```json
{
  "semi": false,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

- [ ] **Step 7: Instalar tooling da raiz**

```bash
pnpm add -D -w typescript prettier eslint @eslint/js typescript-eslint eslint-plugin-vue eslint-config-prettier globals
```

- [ ] **Step 8: Criar `eslint.config.js`**

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.wrangler/**', '**/drizzle/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: globals.browser,
    },
  },
  prettier,
)
```

- [ ] **Step 9: Verificar que o lint roda**

Run: `pnpm lint`
Expected: sai com código 0 (nenhum arquivo pra lintar ainda é OK; erro de config não é OK)

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: bootstrap pnpm monorepo (ts, eslint, prettier)"
```

---

### Task 2: Pacote `shared` — máquina de estados do pedido (TDD)

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/order-status.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/order-status.test.ts`

- [ ] **Step 1: Criar `packages/shared/package.json`**

```json
{
  "name": "@delivery/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Criar `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Instalar deps do pacote**

```bash
pnpm --filter @delivery/shared add zod
pnpm --filter @delivery/shared add -D vitest
```

- [ ] **Step 4: Criar `packages/shared/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

- [ ] **Step 5: Escrever o teste que falha — `packages/shared/src/order-status.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { canTransition, ORDER_STATUSES, isTerminal } from './order-status'

describe('order status state machine', () => {
  it('follows the happy path with external driver', () => {
    expect(canTransition('PENDING', 'ACCEPTED')).toBe(true)
    expect(canTransition('ACCEPTED', 'PREPARING')).toBe(true)
    expect(canTransition('PREPARING', 'READY')).toBe(true)
    expect(canTransition('READY', 'AWAITING_DRIVER')).toBe(true)
    expect(canTransition('AWAITING_DRIVER', 'OUT_FOR_DELIVERY')).toBe(true)
    expect(canTransition('OUT_FOR_DELIVERY', 'DELIVERED')).toBe(true)
  })

  it('allows store with own driver to skip AWAITING_DRIVER', () => {
    expect(canTransition('READY', 'OUT_FOR_DELIVERY')).toBe(true)
  })

  it('rejects skipping states', () => {
    expect(canTransition('PENDING', 'DELIVERED')).toBe(false)
    expect(canTransition('PENDING', 'OUT_FOR_DELIVERY')).toBe(false)
    expect(canTransition('ACCEPTED', 'READY')).toBe(false)
  })

  it('rejects moving backwards', () => {
    expect(canTransition('READY', 'PREPARING')).toBe(false)
    expect(canTransition('DELIVERED', 'PENDING')).toBe(false)
  })

  it('allows cancellation until food leaves, not after', () => {
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true)
    expect(canTransition('ACCEPTED', 'CANCELLED')).toBe(true)
    expect(canTransition('PREPARING', 'CANCELLED')).toBe(true)
    expect(canTransition('READY', 'CANCELLED')).toBe(true)
    expect(canTransition('AWAITING_DRIVER', 'CANCELLED')).toBe(true)
    expect(canTransition('OUT_FOR_DELIVERY', 'CANCELLED')).toBe(false)
  })

  it('terminal states have no exits', () => {
    expect(isTerminal('DELIVERED')).toBe(true)
    expect(isTerminal('CANCELLED')).toBe(true)
    expect(isTerminal('PENDING')).toBe(false)
    for (const to of ORDER_STATUSES) {
      expect(canTransition('DELIVERED', to)).toBe(false)
      expect(canTransition('CANCELLED', to)).toBe(false)
    }
  })
})
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `pnpm --filter @delivery/shared test`
Expected: FAIL — `Cannot find module './order-status'`

- [ ] **Step 7: Implementar `packages/shared/src/order-status.ts`**

```ts
export const ORDER_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'AWAITING_DRIVER',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  // READY -> OUT_FOR_DELIVERY direto quando a loja tem entregador próprio
  READY: ['AWAITING_DRIVER', 'OUT_FOR_DELIVERY', 'CANCELLED'],
  AWAITING_DRIVER: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0
}

/** Labels PT-BR para exibição nos frontends */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: 'Aguardando confirmação',
  ACCEPTED: 'Confirmado',
  PREPARING: 'Em preparo',
  READY: 'Pronto',
  AWAITING_DRIVER: 'Aguardando entregador',
  OUT_FOR_DELIVERY: 'Saiu para entrega',
  DELIVERED: 'Entregue',
  CANCELLED: 'Cancelado',
}
```

- [ ] **Step 8: Criar `packages/shared/src/index.ts`**

```ts
export * from './order-status'
```

- [ ] **Step 9: Rodar e ver passar**

Run: `pnpm --filter @delivery/shared test`
Expected: PASS — 6 testes verdes

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @delivery/shared typecheck`
Expected: sem erros

- [ ] **Step 11: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): order status state machine with tests"
```

---

### Task 3: API Hono no Workers — skeleton + health (TDD)

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/wrangler.jsonc`, `apps/api/vitest.config.ts`
- Create: `apps/api/src/env.ts`, `apps/api/src/app.ts`, `apps/api/src/index.ts`
- Create: `apps/api/src/middleware/error-handler.ts`, `apps/api/src/routes/health.ts`
- Test: `apps/api/test/health.test.ts`

- [ ] **Step 1: Criar `apps/api/package.json`**

```json
{
  "name": "@delivery/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "cf-typegen": "wrangler types"
  }
}
```

- [ ] **Step 2: Instalar deps**

```bash
pnpm --filter @delivery/api add hono @hono/zod-openapi @hono/swagger-ui zod @delivery/shared@workspace:*
pnpm --filter @delivery/api add -D wrangler vitest @cloudflare/workers-types
```

- [ ] **Step 3: Criar `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "vitest/globals"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Criar `apps/api/wrangler.jsonc`**

O `id` do Hyperdrive é placeholder — substituído no Task 9 (provisionamento). Em dev, `wrangler dev` usa `localConnectionString`.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "delivery-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      // placeholder — substituir pelo id real criado no Task 9
      "id": "00000000000000000000000000000000",
      "localConnectionString": "postgres://postgres:postgres@localhost:5432/delivery"
    }
  ]
}
```

- [ ] **Step 5: Criar `apps/api/src/env.ts`**

```ts
export type Env = {
  HYPERDRIVE: Hyperdrive
}

export type AppContext = {
  Bindings: Env
}
```

- [ ] **Step 6: Criar `apps/api/src/middleware/error-handler.ts`**

```ts
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

export function errorHandler(err: Error, c: Context) {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  console.error('unhandled error', { path: c.req.path, message: err.message, stack: err.stack })
  return c.json({ error: 'Internal Server Error' }, 500)
}
```

- [ ] **Step 7: Escrever o teste que falha — `apps/api/test/health.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { app } from '../src/app'

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('unknown route', () => {
  it('returns structured 404', async () => {
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
  })
})
```

- [ ] **Step 8: Criar `apps/api/vitest.config.ts` e rodar o teste (deve falhar)**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', globals: true },
})
```

Run: `pnpm --filter @delivery/api test`
Expected: FAIL — `Cannot find module '../src/app'`

- [ ] **Step 9: Criar `apps/api/src/routes/health.ts`**

```ts
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppContext } from '../env'

export const healthRoutes = new OpenAPIHono<AppContext>()

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: {
      description: 'API is up',
      content: {
        'application/json': { schema: z.object({ status: z.literal('ok') }) },
      },
    },
  },
})

healthRoutes.openapi(healthRoute, (c) => c.json({ status: 'ok' as const }, 200))
```

- [ ] **Step 10: Criar `apps/api/src/app.ts`**

```ts
import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { AppContext } from './env'
import { errorHandler } from './middleware/error-handler'
import { healthRoutes } from './routes/health'

export const app = new OpenAPIHono<AppContext>()

app.use('*', logger())
app.use('*', cors())
app.onError(errorHandler)
app.notFound((c) => c.json({ error: 'Not Found' }, 404))

app.route('/', healthRoutes)

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Delivery API', version: '0.0.1' },
})
app.get('/docs', swaggerUI({ url: '/openapi.json' }))
```

- [ ] **Step 11: Criar `apps/api/src/index.ts`**

```ts
import { app } from './app'

export default app
```

- [ ] **Step 12: Rodar testes e ver passar**

Run: `pnpm --filter @delivery/api test`
Expected: PASS — 2 testes verdes

- [ ] **Step 13: Smoke test local com wrangler**

```bash
pnpm --filter @delivery/api dev &
sleep 5
curl -s http://localhost:8787/health
kill %1
```

Expected: `{"status":"ok"}`

- [ ] **Step 14: Commit**

```bash
git add apps/api
git commit -m "feat(api): hono skeleton on workers with health route and openapi docs"
```

---

### Task 4: Banco — Docker local, Drizzle, primeira migration, health do DB

**Files:**
- Create: `docker-compose.yml` (raiz)
- Create: `apps/api/drizzle.config.ts`, `apps/api/.env`, `apps/api/.dev.vars`
- Create: `apps/api/src/db/schema/users.ts`, `apps/api/src/db/schema/index.ts`, `apps/api/src/db/client.ts`
- Modify: `apps/api/src/routes/health.ts`, `apps/api/src/env.ts`

- [ ] **Step 1: Criar `docker-compose.yml` na raiz**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: delivery
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

- [ ] **Step 2: Subir o banco**

```bash
docker compose up -d postgres
docker compose ps
```

Expected: serviço `postgres` com status `running`

- [ ] **Step 3: Instalar deps de banco**

```bash
pnpm --filter @delivery/api add drizzle-orm postgres
pnpm --filter @delivery/api add -D drizzle-kit dotenv
```

- [ ] **Step 4: Criar `apps/api/.env` (CLI do drizzle-kit; não commitado)**

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/delivery
```

- [ ] **Step 5: Criar `apps/api/drizzle.config.ts`**

```ts
import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

- [ ] **Step 6: Criar `apps/api/src/db/schema/users.ts`**

Tabela mínima para provar o pipeline de migration. Campos de auth (hash de senha, provider Google) entram no plano de Auth.

```ts
import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['CUSTOMER', 'STORE', 'DRIVER', 'ADMIN'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: userRole('role').notNull().default('CUSTOMER'),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

- [ ] **Step 7: Criar `apps/api/src/db/schema/index.ts`**

```ts
export * from './users'
```

- [ ] **Step 8: Gerar e aplicar a migration**

```bash
pnpm --filter @delivery/api db:generate
pnpm --filter @delivery/api db:migrate
```

Expected: arquivo novo em `apps/api/drizzle/0000_*.sql`; migrate termina sem erro

- [ ] **Step 9: Verificar tabela no banco**

```bash
docker compose exec postgres psql -U postgres -d delivery -c '\dt'
```

Expected: tabelas `users` e `__drizzle_migrations` listadas

- [ ] **Step 10: Criar `apps/api/src/db/client.ts`**

`fetch_types: false` e `prepare: false` são as opções recomendadas para postgres.js atrás do Hyperdrive (pooling em modo transação).

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { Env } from '../env'
import * as schema from './schema'

export function createDb(env: Env) {
  const client = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: false,
  })
  return drizzle(client, { schema })
}

export type Db = ReturnType<typeof createDb>
```

- [ ] **Step 11: Adicionar rota `/health/db` em `apps/api/src/routes/health.ts`**

Adicionar ao final do arquivo:

```ts
import { sql } from 'drizzle-orm'
import { createDb } from '../db/client'

const dbHealthRoute = createRoute({
  method: 'get',
  path: '/health/db',
  responses: {
    200: {
      description: 'Database reachable',
      content: {
        'application/json': { schema: z.object({ status: z.literal('ok') }) },
      },
    },
  },
})

healthRoutes.openapi(dbHealthRoute, async (c) => {
  const db = createDb(c.env)
  await db.execute(sql`select 1`)
  return c.json({ status: 'ok' as const }, 200)
})
```

(Mover os `import` para o topo do arquivo, junto dos existentes.)

- [ ] **Step 12: Criar `apps/api/.dev.vars` (vazio por enquanto, já no .gitignore)**

```
# segredos de dev entram aqui (ex.: JWT_SECRET no plano de auth)
```

- [ ] **Step 13: Testar de ponta a ponta em dev**

```bash
pnpm --filter @delivery/api dev &
sleep 5
curl -s http://localhost:8787/health/db
kill %1
```

Expected: `{"status":"ok"}` — prova Worker → Hyperdrive local → Postgres Docker → Drizzle

- [ ] **Step 14: Rodar testes existentes (não podem quebrar)**

Run: `pnpm --filter @delivery/api test`
Expected: PASS (o teste de `/health` não toca banco)

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat(api): drizzle + hyperdrive + users schema + db health check"
```

---

### Task 5: Webapp Vue — SPA com áreas por papel

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/wrangler.jsonc`
- Create: `apps/web/src/main.ts`, `apps/web/src/App.vue`, `apps/web/src/style.css`, `apps/web/src/router/index.ts`
- Create: `apps/web/src/views/HomeView.vue`, `apps/web/src/views/StoreCatalogView.vue`, `apps/web/src/views/store/StoreLayout.vue`, `apps/web/src/views/store/StoreOrdersView.vue`, `apps/web/src/views/admin/AdminLayout.vue`

- [ ] **Step 1: Criar `apps/web/package.json`**

```json
{
  "name": "@delivery/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "vue-tsc --noEmit",
    "deploy": "pnpm build && wrangler deploy"
  }
}
```

- [ ] **Step 2: Instalar deps**

```bash
pnpm --filter @delivery/web add vue vue-router pinia @delivery/shared@workspace:*
pnpm --filter @delivery/web add -D vite @vitejs/plugin-vue vue-tsc typescript tailwindcss @tailwindcss/vite wrangler
```

- [ ] **Step 3: Criar `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "src/**/*.vue"]
}
```

- [ ] **Step 4: Criar `apps/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
})
```

- [ ] **Step 5: Criar `apps/web/index.html`**

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Delivery</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Criar `apps/web/src/style.css`**

```css
@import 'tailwindcss';
```

- [ ] **Step 7: Criar `apps/web/src/router/index.ts`**

`/:storeSlug` fica por último — é catch de slug, não pode engolir `/loja` e `/admin`.

```ts
import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    {
      path: '/loja',
      component: () => import('../views/store/StoreLayout.vue'),
      children: [
        { path: '', redirect: '/loja/pedidos' },
        {
          path: 'pedidos',
          name: 'store-orders',
          component: () => import('../views/store/StoreOrdersView.vue'),
        },
      ],
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('../views/admin/AdminLayout.vue'),
    },
    // deep-link da loja: exemplo.com.br/NomeDaLoja — SEMPRE por último
    {
      path: '/:storeSlug',
      name: 'store-catalog',
      component: () => import('../views/StoreCatalogView.vue'),
    },
  ],
})
```

- [ ] **Step 8: Criar `apps/web/src/main.ts`**

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './style.css'

createApp(App).use(createPinia()).use(router).mount('#app')
```

- [ ] **Step 9: Criar `apps/web/src/App.vue`**

```vue
<template>
  <RouterView />
</template>
```

- [ ] **Step 10: Criar as views placeholder**

`apps/web/src/views/HomeView.vue`:

```vue
<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-2xl font-bold">Lojas da cidade</h1>
    <p class="mt-2 text-gray-600">Lista de lojas entra no plano de catálogo.</p>
  </main>
</template>
```

`apps/web/src/views/StoreCatalogView.vue`:

```vue
<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
const storeSlug = route.params.storeSlug as string
</script>

<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-2xl font-bold">{{ storeSlug }}</h1>
    <p class="mt-2 text-gray-600">Catálogo da loja entra no plano de catálogo.</p>
  </main>
</template>
```

`apps/web/src/views/store/StoreLayout.vue`:

```vue
<template>
  <div class="min-h-screen">
    <header class="border-b p-4 font-semibold">Painel da Loja</header>
    <RouterView />
  </div>
</template>
```

`apps/web/src/views/store/StoreOrdersView.vue`:

```vue
<template>
  <main class="p-4">
    <h1 class="text-xl font-bold">Pedidos</h1>
    <p class="mt-2 text-gray-600">Fila de pedidos entra no plano de pedidos.</p>
  </main>
</template>
```

`apps/web/src/views/admin/AdminLayout.vue`:

```vue
<template>
  <main class="p-4">
    <h1 class="text-xl font-bold">Admin da Plataforma</h1>
    <p class="mt-2 text-gray-600">Gestão de lojas/entregadores entra no plano de admin.</p>
  </main>
</template>
```

- [ ] **Step 11: Criar `apps/web/wrangler.jsonc` (deploy como Workers Assets, SPA fallback)**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "delivery-web",
  "compatibility_date": "2026-07-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

- [ ] **Step 12: Verificar build e typecheck**

```bash
pnpm --filter @delivery/web build
```

Expected: `dist/` gerado sem erros de tipo

- [ ] **Step 13: Smoke test das rotas em dev**

```bash
pnpm --filter @delivery/web dev &
sleep 4
curl -s http://localhost:5173/ | grep -o '<div id="app">'
kill %1
```

Expected: `<div id="app">` (SPA servindo; rotas conferidas no navegador: `/`, `/PizzariaTeste`, `/loja`, `/admin`)

- [ ] **Step 14: Commit**

```bash
git add apps/web
git commit -m "feat(web): vue spa with role areas and store deep-link route"
```

---

### Task 6: Shell do app do entregador

**Files:**
- Create: `apps/driver/package.json`, `apps/driver/tsconfig.json`, `apps/driver/vite.config.ts`, `apps/driver/index.html`, `apps/driver/wrangler.jsonc`
- Create: `apps/driver/src/main.ts`, `apps/driver/src/App.vue`, `apps/driver/src/style.css`, `apps/driver/src/views/DeliveriesView.vue`

Nota: Capacitor Android + FCM entram em plano próprio. Aqui o driver é uma SPA (útil já em dev, e o Capacitor embrulha exatamente este build depois).

- [ ] **Step 1: Criar `apps/driver/package.json`**

```json
{
  "name": "@delivery/driver",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5174",
    "build": "vue-tsc -b && vite build",
    "typecheck": "vue-tsc --noEmit",
    "deploy": "pnpm build && wrangler deploy"
  }
}
```

- [ ] **Step 2: Instalar deps**

```bash
pnpm --filter @delivery/driver add vue vue-router pinia @delivery/shared@workspace:*
pnpm --filter @delivery/driver add -D vite @vitejs/plugin-vue vue-tsc typescript tailwindcss @tailwindcss/vite wrangler
```

- [ ] **Step 3: Criar `apps/driver/tsconfig.json`** (idêntico ao do web)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "src/**/*.vue"]
}
```

- [ ] **Step 4: Criar `apps/driver/vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
})
```

- [ ] **Step 5: Criar `apps/driver/index.html`**

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Delivery — Entregador</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Criar `apps/driver/src/style.css`**

```css
@import 'tailwindcss';
```

- [ ] **Step 7: Criar `apps/driver/src/main.ts`**

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'

createApp(App).use(createPinia()).mount('#app')
```

- [ ] **Step 8: Criar `apps/driver/src/App.vue`**

```vue
<script setup lang="ts">
import DeliveriesView from './views/DeliveriesView.vue'
</script>

<template>
  <DeliveriesView />
</template>
```

- [ ] **Step 9: Criar `apps/driver/src/views/DeliveriesView.vue`**

```vue
<template>
  <main class="mx-auto max-w-lg p-4">
    <h1 class="text-2xl font-bold">Minhas entregas</h1>
    <p class="mt-2 text-gray-600">
      Lista de entregas e alertas de novos pedidos entram no plano de dispatch.
    </p>
  </main>
</template>
```

- [ ] **Step 10: Criar `apps/driver/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "delivery-driver",
  "compatibility_date": "2026-07-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

- [ ] **Step 11: Verificar build**

Run: `pnpm --filter @delivery/driver build`
Expected: `dist/` gerado sem erros

- [ ] **Step 12: Commit**

```bash
git add apps/driver
git commit -m "feat(driver): vue spa shell for driver app"
```

---

### Task 7: Verificação integrada do monorepo

**Files:** nenhum novo — validação cruzada.

- [ ] **Step 1: Provar que `shared` é consumido pelos apps**

Adicionar em `apps/web/src/views/StoreOrdersView.vue` o uso real do shared (substituir o conteúdo):

```vue
<script setup lang="ts">
import { ORDER_STATUS_LABELS, ORDER_STATUSES } from '@delivery/shared'
</script>

<template>
  <main class="p-4">
    <h1 class="text-xl font-bold">Pedidos</h1>
    <ul class="mt-2 space-y-1">
      <li v-for="s in ORDER_STATUSES" :key="s" class="text-sm text-gray-600">
        {{ ORDER_STATUS_LABELS[s] }}
      </li>
    </ul>
  </main>
</template>
```

- [ ] **Step 2: Rodar a suíte completa da raiz**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

Expected: tudo verde — typecheck nos 4 pacotes, testes de shared+api, lint sem erros, builds de web/driver gerados

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: wire shared package into web, full monorepo verification"
```

---

### Task 8: CI no GitHub Actions

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Criar `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Commit e criar repo remoto**

```bash
git add .github
git commit -m "ci: typecheck, lint, test, build on pr and main"
gh repo create delivery --private --source=. --push
```

Expected: repo criado, push feito

- [ ] **Step 3: Verificar CI verde**

```bash
gh run watch
```

Expected: workflow `CI` conclui com sucesso

---

### Task 9: Provisionamento Cloudflare + Neon e primeiro deploy

**Files:**
- Modify: `apps/api/wrangler.jsonc` (id real do Hyperdrive)

Passos manuais de console estão explícitos — rodar uma única vez.

- [ ] **Step 1: Criar projeto no Neon**

No console do Neon (https://console.neon.tech): criar projeto `delivery`, região `sa-east-1` (São Paulo) se disponível, copiar a connection string (formato `postgres://user:pass@host/dbname?sslmode=require`).

- [ ] **Step 2: Criar o Hyperdrive apontando pro Neon**

```bash
npx wrangler hyperdrive create delivery-db --connection-string="postgres://user:pass@host/dbname?sslmode=require"
```

Expected: output com `id: <hex de 32 chars>`

- [ ] **Step 3: Substituir o id placeholder em `apps/api/wrangler.jsonc`**

Trocar `"id": "00000000000000000000000000000000"` pelo id retornado no Step 2.

- [ ] **Step 4: Aplicar migrations no Neon**

```bash
cd apps/api
DATABASE_URL="postgres://user:pass@host/dbname?sslmode=require" pnpm db:migrate
cd ../..
```

Expected: migration `0000_*` aplicada sem erro

- [ ] **Step 5: Deploy da API**

```bash
pnpm --filter @delivery/api deploy
```

Expected: output com URL `https://delivery-api.<subdominio>.workers.dev`

- [ ] **Step 6: Smoke test em produção**

```bash
curl -s https://delivery-api.<subdominio>.workers.dev/health
curl -s https://delivery-api.<subdominio>.workers.dev/health/db
```

Expected: `{"status":"ok"}` nos dois — segundo prova Worker→Hyperdrive→Neon em prod

- [ ] **Step 7: Deploy dos frontends**

```bash
pnpm --filter @delivery/web deploy
pnpm --filter @delivery/driver deploy
```

Expected: URLs `https://delivery-web.<subdominio>.workers.dev` e `https://delivery-driver.<subdominio>.workers.dev` respondendo; rota `/loja` do web carrega a SPA (fallback SPA funcionando)

- [ ] **Step 8: Commit**

```bash
git add apps/api/wrangler.jsonc
git commit -m "chore: wire production hyperdrive id"
git push
```

---

### Task 10: Deploy contínuo no merge pra main

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Criar API token na Cloudflare**

No dashboard Cloudflare → My Profile → API Tokens → Create Token → template "Edit Cloudflare Workers". Copiar token e account id.

- [ ] **Step 2: Registrar secrets no GitHub**

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

- [ ] **Step 3: Criar `.github/workflows/deploy.yml`**

```yaml
name: Deploy

on:
  push:
    branches: [main]

concurrency: deploy-prod

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Deploy API
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: apps/api
      - name: Deploy Web
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: apps/web
      - name: Deploy Driver
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: apps/driver
```

- [ ] **Step 4: Commit, push e verificar deploy automático**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: auto deploy api, web and driver on main"
git push
gh run watch
```

Expected: workflow `Deploy` verde; `curl https://delivery-api.<subdominio>.workers.dev/health` continua ok

---

### Task 11: README + roadmap dos próximos planos

**Files:**
- Create: `README.md`

- [ ] **Step 1: Criar `README.md`**

````markdown
# Delivery

Plataforma de delivery para cidades pequenas. 100% Cloudflare.

## Stack

- **API**: Hono + Drizzle no Cloudflare Workers, Postgres (Neon) via Hyperdrive
- **Web** (cliente/loja/admin): Vue 3 SPA em Workers Assets
- **Entregador**: Vue 3 SPA (futuro Capacitor Android + FCM)
- **Shared**: tipos, schemas Zod e máquina de estados do pedido

## Dev

```bash
corepack enable && pnpm install
docker compose up -d postgres
pnpm --filter @delivery/api db:migrate
pnpm dev:api     # http://localhost:8787 (docs em /docs)
pnpm dev:web     # http://localhost:5173
pnpm dev:driver  # http://localhost:5174
```

## Verificação

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

## Deploy

Merge em `main` → GitHub Actions deploya api, web e driver via wrangler.

## Roadmap de planos (docs/superpowers/plans/)

1. ✅ Fundação (este repo)
2. Auth — email+senha e Google, JWT + refresh, RBAC por role
3. Catálogo — lojas, categorias, produtos, variações, adicionais, upload R2, horário de funcionamento
4. Pedidos — carrinho, checkout, máquina de status, painel da loja, polling de tracking
5. Dispatch — broadcast FCM pros entregadores disponíveis, aceite com lock atômico, telas do driver
6. Pagamentos — Asaas PIX + split (comissão plataforma / loja / entregador), webhooks
7. Capacitor — build Android do driver, FCM nativo
8. Admin & Relatórios — gestão de lojas/entregadores, faturamento, mini-ERP
````

- [ ] **Step 2: Commit e push**

```bash
git add README.md
git commit -m "docs: readme with stack, dev workflow and plan roadmap"
git push
```

---

## Critério de sucesso do plano

- `pnpm typecheck && pnpm test && pnpm lint && pnpm build` verdes na raiz e no CI
- `/health` e `/health/db` respondendo `{"status":"ok"}` em dev **e** produção
- `delivery-web` servindo SPA com rotas `/`, `/:storeSlug`, `/loja`, `/admin` (fallback SPA ok)
- Merge em `main` deploya os três apps automaticamente
- Migration `users` aplicada no Neon

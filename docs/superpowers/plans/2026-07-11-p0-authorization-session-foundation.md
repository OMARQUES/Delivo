# P0 Authorization and Session Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar falhas P0 de RBAC, revogação de sessão, suspensão de loja, mídia privada, PII de entregador e baseline HTTP antes do staging.

**Architecture:** PostgreSQL permanece fonte síncrona de verdade. Todo request protegido valida JWT completo e resolve usuário, família de sessão e estado da loja no banco. Políticas HTTP e DTOs explícitos negam superfície e propriedades por padrão.

**Tech Stack:** Cloudflare Workers, Hono 4, TypeScript 6, PostgreSQL/Neon, Drizzle ORM, Zod, Vitest.

## Global Constraints

- TDD: teste falha antes da implementação; menor mudança para passar; commit por task.
- Executar em worktree limpo e isolado, criado a partir de um commit que já contenha as migrations locais 0020 e 0021.
- Banco local descartável; nenhuma migração de dados legados reais.
- Não implementar email-first, Resend, Turnstile, Google, MFA, rate limiting ou confiabilidade de pagamentos neste plano.
- JWT: HS256 fixo; access TTL 15 minutos; `iss=delivery-api`; `aud=delivery-clients`; `nbf`, `jti`, `sid`, `ver` obrigatórios.
- PostgreSQL consultado em todo request protegido; sem KV/cache para decisão de segurança.
- Logout de dispositivo revoga família; logout-all, bloqueio, mudança de papel e suspensão incrementam `tokenVersion` e revogam todas as famílias.
- `/orders*` e `/me/addresses*`: somente CUSTOMER.
- `/driver/*`: somente DRIVER. `/store/*`: somente STORE com loja `ACTIVE`. `/admin/*`: somente ADMIN.
- Loja `PAUSED` continua acessível; `SUSPENDED` bloqueia todas rotas; `CLOSED` terminal e bloqueado.
- Mídia pública aceita somente `logos/` e `products/`; `returns/` nunca sai por `/media/*`.
- Resposta externa nunca usa spread de entidade `orders` nas superfícies de entregador.
- Cross-tenant retorna `404`; autenticação inválida retorna envelope genérico.
- Respostas protegidas/sensíveis: `Cache-Control: no-store`.
- Docs, OpenAPI e health DB: apenas `APP_ENV=local`.
- Não editar UI neste plano.

---

## File map

**Create**

- `apps/api/src/services/security-session.service.ts`: emissão/revogação e projeção viva do principal.
- `apps/api/src/middleware/security-baseline.ts`: limite de corpo, content type, headers, cache e superfície local.
- `apps/api/src/services/driver-delivery.dto.ts`: contratos explícitos por estado.
- `apps/api/test/security-session.service.test.ts`: revogação e corrida.
- `apps/api/test/authorization-matrix.routes.test.ts`: matriz ANON/CUSTOMER/DRIVER/STORE/ADMIN.
- `apps/api/test/security-baseline.test.ts`: body, headers, CORS, docs e health.
- `apps/api/test/driver-delivery.dto.test.ts`: ausência de PII proibida.
- Próximo SQL e snapshot em `apps/api/drizzle/`, com índice/tag definidos pelo Drizzle no momento da geração; não presumir nome de arquivo.

**Modify**

- `apps/api/src/db/schema/users.ts`, `stores.ts`, `refresh-tokens.ts`, `index.ts`.
- `apps/api/src/lib/tokens.ts`, `apps/api/src/env.ts`.
- `apps/api/src/middleware/auth.ts`.
- `apps/api/src/services/auth.service.ts`, `store.service.ts`, `dispatch.service.ts`, `return.service.ts`, `batch.service.ts`.
- `apps/api/src/routes/auth.ts`, `addresses.ts`, `orders.ts`, `admin-drivers.ts`, `admin-stores.ts`, `media.ts`, `driver.ts`.
- `apps/api/src/app.ts` and affected route tests.
- `apps/api/test/helpers/test-db.ts` and Drizzle journal.

---

### Task 1: Security-state schema and disposable migration

**Interfaces:**

- Produces `users.tokenVersion: number` and `stores.securityStatus: 'ACTIVE'|'SUSPENDED'|'CLOSED'`.
- Preserves `stores.isPaused` as operational pause; removes ambiguous `stores.isActive`.

- [ ] **Step 1: Add failing schema assertions**

Create `apps/api/test/security-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { stores, users } from '../src/db/schema'

describe('security state schema', () => {
  it('has token version and explicit store security status', () => {
    expect(getTableColumns(users)).toHaveProperty('tokenVersion')
    expect(getTableColumns(stores)).toHaveProperty('securityStatus')
    expect(getTableColumns(stores)).not.toHaveProperty('isActive')
  })
})
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- security-schema.test.ts`
Expected: FAIL because columns do not exist.

- [ ] **Step 3: Change Drizzle schema**

In `users.ts`, import `integer` and add:

```ts
tokenVersion: integer('token_version').notNull().default(0),
```

In `stores.ts`, add:

```ts
export const storeSecurityStatus = pgEnum('store_security_status', ['ACTIVE', 'SUSPENDED', 'CLOSED'])
// inside stores
securityStatus: storeSecurityStatus('security_status').notNull().default('ACTIVE'),
```

Delete `isActive`. Update public queries to `eq(stores.securityStatus, 'ACTIVE')`.

- [ ] **Step 4: Generate migration over committed 0020/0021**

Run:

```bash
pnpm --filter @delivery/api exec drizzle-kit generate --name security-session-foundation
```

Expected: CLI informa o SQL gerado e atualiza o snapshot e `meta/_journal.json`. Antes de editar, confirme no journal que a nova entrada sucede 0021 e que o snapshot novo aponta para `meta/0021_snapshot.json` por `prevId`. Use os caminhos mostrados por `git status --short`; não renomeie artefatos gerados. Verifique que o SQL adiciona `token_version`, cria enum/status, mapeia `is_active=false` para `SUSPENDED` e só então remove `is_active`. Como dados locais são descartáveis, recriar o banco é aceitável se o Drizzle não expressar a conversão com segurança.

- [ ] **Step 5: Update test truncation and run schema test**

No new table is introduced. Run:

```bash
pnpm --filter @delivery/api test -- security-schema.test.ts
pnpm --filter @delivery/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema apps/api/drizzle apps/api/test/security-schema.test.ts
git commit -m "feat(security): add revocable principal state"
```

### Task 2: Complete access-token claims

**Interfaces:**

- Produces `signAccessToken(principal, secret, familyId, now?)`.
- Produces payload `{sub,role,name,ver,sid,jti,iss,aud,iat,nbf,exp}`.

- [ ] **Step 1: Replace token test with full contract**

In `apps/api/test/tokens.test.ts` assert:

```ts
const now = new Date('2026-07-11T12:00:00Z')
const token = await signAccessToken(
  { sub: 'user-1', role: 'CUSTOMER', name: 'Ana', tokenVersion: 7 },
  SECRET,
  '11111111-1111-4111-8111-111111111111',
  now,
)
const payload = await verify(token, SECRET, 'HS256')
expect(payload).toMatchObject({
  sub: 'user-1',
  role: 'CUSTOMER',
  name: 'Ana',
  ver: 7,
  sid: '11111111-1111-4111-8111-111111111111',
  iss: 'delivery-api',
  aud: 'delivery-clients',
})
expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/)
expect(payload.nbf).toBe(payload.iat)
expect(Number(payload.exp) - Number(payload.iat)).toBe(ACCESS_TTL_SECONDS)
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- tokens.test.ts`
Expected: compile/test failure on new signature and claims.

- [ ] **Step 3: Implement token contract**

In `apps/api/src/lib/tokens.ts`:

```ts
export const TOKEN_ISSUER = 'delivery-api'
export const TOKEN_AUDIENCE = 'delivery-clients'

export type AccessTokenPayload = {
  sub: string
  role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'
  name: string
  ver: number
  sid: string
  jti: string
  iss: typeof TOKEN_ISSUER
  aud: typeof TOKEN_AUDIENCE
  iat: number
  nbf: number
  exp: number
}

export type AccessPrincipal = Pick<AccessTokenPayload, 'sub' | 'role' | 'name'> & {
  tokenVersion: number
}

export async function signAccessToken(
  p: AccessPrincipal,
  secret: string,
  familyId: string,
  from = new Date(),
): Promise<string> {
  const now = Math.floor(from.getTime() / 1000)
  return sign(
    {
      sub: p.sub,
      role: p.role,
      name: p.name,
      ver: p.tokenVersion,
      sid: familyId,
      jti: crypto.randomUUID(),
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      iat: now,
      nbf: now,
      exp: now + ACCESS_TTL_SECONDS,
    },
    secret,
  )
}
```

- [ ] **Step 4: Run token tests**

Run: `pnpm --filter @delivery/api test -- tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/tokens.ts apps/api/test/tokens.test.ts
git commit -m "feat(auth): bind access tokens to sessions"
```

### Task 3: Live principal resolver and auth middleware

**Interfaces:**

- Produces `resolveLivePrincipal(db, payload, now?)`.
- `c.get('auth')` becomes verified current principal, never raw trusted JWT state.

- [ ] **Step 1: Add failing middleware cases**

Create `apps/api/test/security-session.service.test.ts`. Seed user + refresh family, then cover: valid; deleted user; BLOCKED; role mismatch; stale `ver`; revoked family; expired family; malformed `sid`; wrong `iss/aud`; future `nbf`. Expected status for every invalid case: `401`, except authenticated blocked/suspended state: `403`.

Core assertion:

```ts
expect((await protectedRequest(validToken)).status).toBe(200)
await testDb.update(users).set({ tokenVersion: 1 }).where(eq(users.id, userId))
expect((await protectedRequest(validToken)).status).toBe(401)
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- security-session.service.test.ts`
Expected: stale and revoked access tokens still return 200.

- [ ] **Step 3: Implement resolver**

Create `security-session.service.ts` with:

```ts
export type LivePrincipal = {
  sub: string
  role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'
  name: string
  tokenVersion: number
  sessionFamilyId: string
  jti: string
  storeId: string | null
}

export async function resolveLivePrincipal(db: Db, p: AccessTokenPayload, now = new Date()) {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      status: users.status,
      tokenVersion: users.tokenVersion,
      storeId: stores.id,
      storeSecurityStatus: stores.securityStatus,
    })
    .from(users)
    .leftJoin(stores, eq(stores.ownerUserId, users.id))
    .where(eq(users.id, p.sub))
    .limit(1)
  if (!row) throw new PrincipalError('INVALID', 401)
  if (row.status !== 'ACTIVE') throw new PrincipalError('ACCOUNT_BLOCKED', 403)
  if (row.role !== p.role || row.tokenVersion !== p.ver) throw new PrincipalError('INVALID', 401)
  if (row.role === 'STORE' && row.storeSecurityStatus !== 'ACTIVE') {
    throw new PrincipalError('STORE_SUSPENDED', 403)
  }
  const [family] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, row.id),
        eq(refreshTokens.familyId, p.sid),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, now),
      ),
    )
    .limit(1)
  if (!family) throw new PrincipalError('INVALID', 401)
  return {
    sub: row.id,
    role: row.role,
    name: row.name,
    tokenVersion: row.tokenVersion,
    sessionFamilyId: p.sid,
    jti: p.jti,
    storeId: row.storeId,
  } satisfies LivePrincipal
}
```

Define `PrincipalError` with code and status; never expose whether user/family/version failed.

- [ ] **Step 4: Validate claims and resolve live principal**

In `middleware/auth.ts`, after fixed HS256 verification, reject non-string/invalid claims, require `iss`, `aud`, `jti`, UUID `sid`, integer `ver`, `nbf <= now`, then call `resolveLivePrincipal`. Set only returned `LivePrincipal` in context. Map invalid to `401 Sessão inválida ou expirada`; blocked/suspended to explicit `403`.

Update `env.ts` variable type to `LivePrincipal`.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @delivery/api test -- security-session.service.test.ts auth.routes.test.ts
pnpm --filter @delivery/api typecheck
```

Expected: PASS after test helpers stop minting orphan JWTs and create a real refresh family.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/security-session.service.ts apps/api/src/middleware/auth.ts apps/api/src/env.ts apps/api/test
git commit -m "feat(auth): resolve live principal per request"
```

### Task 4: Atomic issue, refresh, logout and global revocation

**Interfaces:**

- Produces `issueSession`, `rotateSession`, `revokeSessionFamily`, `revokeAllSessions`.
- `POST /auth/logout` requires current access token and revokes its `sid`; body refresh token is removed.
- Produces `POST /auth/logout-all`.

- [ ] **Step 1: Add failing session tests**

Extend auth tests:

```ts
const beforeLogout = await get('/auth/me', accessToken)
expect(beforeLogout.status).toBe(200)
expect((await post('/auth/logout', {}, accessToken)).status).toBe(204)
expect((await get('/auth/me', accessToken)).status).toBe(401)

const [deviceA, deviceB] = await Promise.all([login(), login()])
expect((await post('/auth/logout-all', {}, deviceA.accessToken)).status).toBe(204)
expect((await get('/auth/me', deviceA.accessToken)).status).toBe(401)
expect((await get('/auth/me', deviceB.accessToken)).status).toBe(401)
```

Add a concurrent refresh test with `Promise.allSettled`: exactly one succeeds; reuse/loser revokes family; both resulting access/refresh credentials fail afterward.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- auth.routes.test.ts security-session.service.test.ts`
Expected: logout access remains valid; concurrent reuse family survives.

- [ ] **Step 3: Implement session functions**

Move token issuance from `auth.service.ts` to `security-session.service.ts`. Generate `familyId` before signing. Insert refresh row and sign access with same family. Implement rotation in one transaction:

```ts
const [claimed] = await tx
  .update(refreshTokens)
  .set({ usedAt: now })
  .where(
    and(
      eq(refreshTokens.id, row.id),
      isNull(refreshTokens.usedAt),
      isNull(refreshTokens.revokedAt),
    ),
  )
  .returning({ id: refreshTokens.id })
if (!claimed) {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)))
  throw new AuthError('Sessão inválida', 401)
}
```

Lock user before issuing replacement; reject current blocked/role/store state. `revokeAllSessions` locks user, increments `tokenVersion`, revokes all active refresh rows in same transaction.

- [ ] **Step 4: Update auth routes**

`POST /auth/logout`: middleware `[authMiddleware]`, no body, revoke `c.get('auth').sessionFamilyId`.
`POST /auth/logout-all`: middleware `[authMiddleware]`, no body, call `revokeAllSessions(db, sub)`.
`GET /auth/me`: return current principal `{sub,role,name}`.

- [ ] **Step 5: Run session suite**

```bash
pnpm --filter @delivery/api test -- auth.routes.test.ts auth.service.test.ts security-session.service.test.ts
pnpm --filter @delivery/api typecheck
```

Expected: PASS; no direct `signAccessToken` test helper remains without persisted family.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/auth.service.ts apps/api/src/services/security-session.service.ts apps/api/src/routes/auth.ts apps/api/test
git commit -m "fix(auth): make session revocation immediate"
```

### Task 5: Customer RBAC and route authorization matrix

**Interfaces:** protected namespaces enforce role before validation/service execution.

- [ ] **Step 1: Add failing role matrix for customer routes**

Create `authorization-matrix.routes.test.ts` with real session tokens for all roles. Table:

```ts
const customerRoutes = [
  ['GET', '/me/addresses'],
  ['POST', '/me/addresses'],
  ['DELETE', `/me/addresses/${ID}`],
  ['GET', '/orders'],
  ['POST', '/orders'],
  ['POST', '/orders/quote'],
  ['GET', `/orders/${ID}`],
  ['POST', `/orders/${ID}/cancel`],
  ['POST', `/orders/${ID}/cancel-request`],
  ['POST', `/orders/${ID}/amendments/current/approve`],
  ['POST', `/orders/${ID}/amendments/current/reject`],
] as const
```

For every route: ANON `401`; DRIVER/STORE/ADMIN `403`; CUSTOMER must not return `401/403` (validation/business status may vary).

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- authorization-matrix.routes.test.ts`
Expected: non-customer roles reach customer handlers.

- [ ] **Step 3: Apply guards**

```ts
addressRoutes.use('/me/*', authMiddleware, requireRole('CUSTOMER'))
orderRoutes.use('/orders', authMiddleware, requireRole('CUSTOMER'))
orderRoutes.use('/orders/*', authMiddleware, requireRole('CUSTOMER'))
```

- [ ] **Step 4: Expand namespace matrix**

Add one representative read and mutation for every route module under `/driver/*`, `/store/*`, `/admin/*`. Wrong roles always `403`; ANON `401`. Add explicit public allowlist assertions for `/health`, public stores/menu/search and allowed `/media/logos|products`.

- [ ] **Step 5: Run route tests**

```bash
pnpm --filter @delivery/api test -- authorization-matrix.routes.test.ts addresses.routes.test.ts orders.routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/addresses.ts apps/api/src/routes/orders.ts apps/api/test/authorization-matrix.routes.test.ts apps/api/test/addresses.routes.test.ts apps/api/test/orders.routes.test.ts
git commit -m "fix(authz): restrict customer routes by role"
```

### Task 6: Store suspension and session invalidation

**Interfaces:**

- Replaces `setStoreActive` with `setStoreSecurityStatus(db, storeId, status)`.
- Admin route becomes `PATCH /admin/stores/{id}/security-status`.

- [ ] **Step 1: Add failing lifecycle tests**

Cover:

```ts
expect((await storeGet(storeToken)).status).toBe(200)
await adminPatch(storeId, 'SUSPENDED')
expect((await storeGet(storeToken)).status).toBe(403)
expect((await login(storeEmail, storePassword)).status).toBe(403)
expect((await publicGet(storeSlug)).status).toBe(404)
await adminPatch(storeId, 'ACTIVE')
expect((await storeGet(storeToken)).status).toBe(401) // old tokenVersion remains stale
expect((await login(storeEmail, storePassword)).status).toBe(200)
```

Also verify `PAUSED` (`isPaused=true`) does not revoke/block store routes. `CLOSED→ACTIVE` returns `409`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- admin-stores.routes.test.ts store-me.routes.test.ts`.

- [ ] **Step 3: Implement transactional lifecycle**

`setStoreSecurityStatus` locks store and owner. If current `CLOSED`, reject any change. For `SUSPENDED` or `CLOSED`, set status, increment owner `tokenVersion`, revoke all owner refresh families in same transaction. `ACTIVE→ACTIVE` is idempotent. Reactivating `SUSPENDED→ACTIVE` does not decrement version.

- [ ] **Step 4: Update admin API and public/store queries**

Use schema:

```ts
z.object({ securityStatus: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) })
```

Return `securityStatus`; remove `isActive`. Public discovery and checkout require `ACTIVE`. Login session issuance checks store status.

- [ ] **Step 5: Run lifecycle and regression suites**

```bash
pnpm --filter @delivery/api test -- admin-stores.routes.test.ts store-me.routes.test.ts stores-public.routes.test.ts store.service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/stores.ts apps/api/src/services/store.service.ts apps/api/src/routes/admin-stores.ts apps/api/test
git commit -m "fix(authz): suspend stores and revoke sessions"
```

### Task 7: Emergency private-media guard

**Interfaces:** `/media/:key` serves only public prefixes; denied prefix never queries R2.

- [ ] **Step 1: Add failing media tests**

```ts
for (const key of ['returns/secret.jpg', 'unknown/a.png', '../returns/x.jpg']) {
  const get = vi.fn()
  const res = await app.request(`/media/${encodeURI(key)}`, {}, envWith({ get }))
  expect(res.status).toBe(404)
  expect(get).not.toHaveBeenCalled()
}
```

Verify `logos/*.png` and `products/*.webp` remain public; successful responses retain immutable public cache.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- media.test.ts`
Expected: `returns/` invokes bucket and may return 200.

- [ ] **Step 3: Add strict key parser**

In `media.ts`:

```ts
const PUBLIC_MEDIA_KEY = /^(logos|products)\/[0-9a-f-]+\.(png|jpg|jpeg|webp)$/i
const key = c.req.param('key')
if (!PUBLIC_MEDIA_KEY.test(key)) return c.json({ error: 'Not Found' }, 404)
```

Do this before `BUCKET.get`. Keep `nosniff` and immutable cache. Private authenticated reads remain in later media plan.

- [ ] **Step 4: Run tests and scan**

```bash
pnpm --filter @delivery/api test -- media.test.ts returns.routes.test.ts
rg -n "public, max-age|BUCKET.get" apps/api/src/routes
```

Expected: only public media handler uses year-long public cache; returns remain uploadable but not publicly readable.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/media.ts apps/api/test/media.test.ts
git commit -m "fix(media): block private evidence from public route"
```

### Task 8: Explicit driver delivery DTOs and PII lifecycle

**Interfaces:**

- Produces `toActiveDriverDelivery`, `toDriverHistoryDelivery`, `toDriverActionResult`.
- History never contains `customerId`, `taxId`, phone, address/reference, coordinates, raw evidence keys or internal cancellation/payment metadata.

- [ ] **Step 1: Add failing DTO/route tests**

Create tests with an order containing distinctive secret values. Assert active assigned response contains operational destination/contact but not `customerId`, `taxId`, `idempotencyKey`, `returnConfirmedBy`. After `DELIVERED` and after confirmed return, recursively assert forbidden keys absent:

```ts
const forbidden = [
  'customerId',
  'customerPhone',
  'taxId',
  'addressText',
  'addressReference',
  'addressLat',
  'addressLng',
  'idempotencyKey',
  'returnPhotoKeys',
  'returnConfirmedBy',
  'cancelRequestNote',
]
for (const key of forbidden) expect(JSON.stringify(body)).not.toContain(`\"${key}\"`)
```

Mutation responses for collect/deliver/fail/returned contain only `{id,status}`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- driver-delivery.dto.test.ts driver.routes.test.ts`
Expected: raw order fields leak.

- [ ] **Step 3: Create DTO module**

Define explicit types and object literals. Active DTO fields:

```ts
return {
  id: row.id,
  status: row.status,
  paymentMethod: row.paymentMethod,
  changeForCents: row.changeForCents,
  totalCents: row.totalCents,
  deliveryFeeCents: row.deliveryFeeCents,
  distanceKm: row.distanceKm,
  note: row.note,
  createdAt: row.createdAt,
  batchId: row.batchId,
  driverArrivedAt: row.driverArrivedAt,
  returnPendingAt: row.returnPendingAt,
  returnedAt: row.returnedAt,
  driverReturnedAt: row.driverReturnedAt,
  storeName: row.storeName,
  storeAddressText: row.storeAddressText,
  storeLat: row.storeLat,
  storeLng: row.storeLng,
  storePhone: row.storePhone,
  customerName: row.customerName,
  customerPhone: row.customerPhone,
  addressText: row.addressText,
  addressReference: row.addressReference,
  addressLat: row.addressLat,
  addressLng: row.addressLng,
  returnPhotoCount: row.returnPhotoKeys.length,
}
```

History DTO includes only `id,status,deliveryFeeCents,distanceKm,createdAt,storeName,storeAddressText,items`; pending return may use active operational DTO until confirmed. Action result: `{id,status}`.

- [ ] **Step 4: Replace entity spreads and raw returning responses**

Update `driverOrderDetail`, `listDriverDeliveries`, driver order mutations and batch delivery detail. Select explicit columns at query boundary. Replace `returning()` with `returning({id: orders.id,status: orders.status})` for driver-visible mutations. Keep store/admin projections out of this task.

- [ ] **Step 5: Scan and test**

```bash
rg -n "\.\.\.(row\.order|r\.order|order)" apps/api/src/services/dispatch.service.ts apps/api/src/services/batch.service.ts apps/api/src/routes/driver.ts
pnpm --filter @delivery/api test -- driver-delivery.dto.test.ts driver.routes.test.ts dispatch.service.test.ts batch.service.test.ts returns.routes.test.ts
```

Expected: scan has no driver response entity spread; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/driver-delivery.dto.ts apps/api/src/services/dispatch.service.ts apps/api/src/services/batch.service.ts apps/api/src/services/return.service.ts apps/api/src/routes/driver.ts apps/api/test
git commit -m "fix(privacy): minimize driver delivery data"
```

### Task 9: HTTP security baseline and local-only diagnostics

**Interfaces:**

- Adds required `APP_ENV: 'local'|'staging'|'production'`.
- JSON max 256 KiB; global max 6 MiB; over limit `413`.
- Non-local docs/OpenAPI/DB health return `404`.

- [ ] **Step 1: Add failing baseline tests**

Cover: 257 KiB JSON returns `413`; JSON POST with `text/plain` returns `415`; 7 MiB upload returns `413`; protected response `no-store`; `nosniff`, frame denial, CSP, referrer and permissions headers; HSTS only production; disallowed CORS origin lacks ACAO; docs/OpenAPI/health DB local `200`, staging/production `404`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @delivery/api test -- security-baseline.test.ts`.

- [ ] **Step 3: Implement middleware**

Use `bodyLimit` from `hono/body-limit`. Global 6 MiB. For `application/json`, invoke 256 KiB limiter. Unsafe non-upload/non-CSV routes require exact JSON media type allowing `; charset=utf-8`. Add headers:

```ts
c.header('X-Content-Type-Options', 'nosniff')
c.header('X-Frame-Options', 'DENY')
c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
c.header('Referrer-Policy', 'no-referrer')
c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
if (c.env.APP_ENV === 'production')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
```

Set `Cache-Control: no-store` for `/auth`, `/orders`, `/me`, `/driver`, `/store`, `/admin`, `/private-media`. Preserve explicit immutable header on public media.

- [ ] **Step 4: Gate diagnostics**

Register middleware before docs/health handlers:

```ts
const localOnly = createMiddleware<AppContext>(async (c, next) => {
  if (c.env.APP_ENV !== 'local') return c.json({ error: 'Not Found' }, 404)
  await next()
})
app.use('/docs', localOnly)
app.use('/openapi.json', localOnly)
app.use('/health/db', localOnly)
```

Add `APP_ENV` to every test env and Wrangler vars; local dev uses `local`.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @delivery/api test -- security-baseline.test.ts health.test.ts media.test.ts
pnpm --filter @delivery/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/security-baseline.ts apps/api/src/app.ts apps/api/src/env.ts apps/api/src/routes apps/api/test apps/api/wrangler.jsonc
git commit -m "feat(security): enforce HTTP baseline"
```

### Task 10: Full authorization, tenant and revocation gate

**Interfaces:** final evidence that P0 boundary is safe and later plans can build on it.

- [ ] **Step 1: Complete protected route manifest**

Enumerate every registered protected method/path from route modules in `authorization-matrix.routes.test.ts`. Each row declares `allowedRole`. Test ANON plus all four roles. Allowed role only needs to pass authz; `400/404/409` from dummy object/body is acceptable. `401/403` is never acceptable for allowed role.

Use this checked inventory; replace `{id}` and `{proposalId}` with fixed UUIDs and query `scope=active` where required:

```ts
const anyAuthenticated = ['GET /auth/me', 'POST /auth/logout', 'POST /auth/logout-all'] as const

const customer = [
  'GET /me/addresses',
  'POST /me/addresses',
  'DELETE /me/addresses/{id}',
  'POST /orders/quote',
  'POST /orders',
  'GET /orders',
  'GET /orders/{id}',
  'POST /orders/{id}/amendments/current/approve',
  'POST /orders/{id}/amendments/current/reject',
  'POST /orders/{id}/cancel',
  'POST /orders/{id}/cancel-request',
] as const

const driver = [
  'GET /driver/offers',
  'POST /driver/offers/{id}/accept',
  'POST /driver/offers/{id}/dismiss',
  'GET /driver/links',
  'POST /driver/links/{id}/confirm',
  'POST /driver/links/{id}/terms/confirm',
  'POST /driver/links/{id}/terms/reject',
  'GET /driver/shifts/active',
  'POST /driver/shifts',
  'GET /driver/shift-authorizations',
  'POST /driver/shift-authorizations/{id}/accept',
  'POST /driver/shift-authorizations/{id}/reject',
  'POST /driver/shifts/{id}/terms/{proposalId}/accept',
  'POST /driver/shifts/{id}/terms/{proposalId}/reject',
  'POST /driver/shifts/{id}/end',
  'POST /driver/shifts/{id}/reactivate',
  'GET /driver/shifts/recent',
  'GET /driver/shift-deliveries',
  'GET /driver/shift-batches',
  'POST /driver/orders/{id}/accept-shift',
  'POST /driver/orders/{id}/refuse-direct',
  'POST /driver/orders/{id}/arrived',
  'GET /driver/me',
  'GET /driver/batches',
  'POST /driver/batches/{id}/accept',
  'POST /driver/batches/{id}/release',
  'POST /driver/batches/{id}/refuse',
  'POST /driver/batches/{id}/collect',
  'PATCH /driver/me/availability',
  'POST /driver/me/fcm-token',
  'PATCH /driver/me/pix-key',
  'GET /driver/available',
  'GET /driver/deliveries?scope=active',
  'POST /driver/orders/{id}/accept',
  'POST /driver/orders/{id}/release',
  'POST /driver/orders/{id}/collect',
  'POST /driver/orders/{id}/deliver',
  'POST /driver/orders/{id}/returned',
  'PUT /driver/orders/{id}/return-photo',
  'POST /driver/orders/{id}/fail',
  'GET /driver/me/finance',
  'GET /driver/earnings/orders/{id}',
] as const

const store = [
  'GET /store/me',
  'PATCH /store/me',
  'PUT /store/me/logo',
  'GET /store/me/catalog',
  'POST /store/me/categories',
  'PATCH /store/me/categories/{id}',
  'DELETE /store/me/categories/{id}',
  'POST /store/me/products',
  'PATCH /store/me/products/{id}',
  'DELETE /store/me/products/{id}',
  'PUT /store/me/products/{id}/options',
  'PATCH /store/me/options/{id}',
  'PUT /store/me/products/{id}/photo',
  'POST /store/me/offers',
  'GET /store/me/offers',
  'POST /store/me/offers/{id}/close',
  'GET /store/me/drivers',
  'POST /store/me/drivers',
  'PATCH /store/me/drivers/{id}',
  'DELETE /store/me/drivers/{id}',
  'GET /store/me/shifts',
  'POST /store/me/shifts/{id}/terms',
  'POST /store/me/shifts/{id}/terms/{proposalId}/cancel',
  'POST /store/me/shift-authorizations',
  'POST /store/me/shift-authorizations/{id}/cancel',
  'POST /store/me/shifts/{id}/release',
  'POST /store/me/shifts/{id}/daily/approve',
  'POST /store/me/shifts/{id}/daily/reject',
  'POST /store/me/shifts/{id}/reactivation',
  'POST /store/me/orders/{id}/confirm-return',
  'POST /store/me/orders/{id}/release-driver',
  'GET /store/me/batches',
  'POST /store/me/orders/{id}/request-own',
  'POST /store/me/orders/{id}/request-specific',
  'POST /store/me/orders/{id}/request-withdraw',
  'POST /store/me/batches',
  'POST /store/me/batches/{id}/broadcast',
  'DELETE /store/me/batches/{id}',
  'GET /store/me/orders',
  'GET /store/me/orders/{id}',
  'POST /store/me/orders/{id}/amendments',
  'DELETE /store/me/orders/{id}/amendments/current',
  'PATCH /store/me/orders/{id}/status',
  'POST /store/me/orders/{id}/request-driver',
  'POST /store/me/orders/{id}/cancel-request/approve',
  'POST /store/me/orders/{id}/cancel-request/deny',
  'GET /store/me/finance',
] as const

const admin = [
  'GET /admin/drivers',
  'PATCH /admin/drivers/{id}/status',
  'GET /admin/returns',
  'POST /admin/orders/{id}/confirm-return',
  'POST /admin/stores',
  'GET /admin/stores',
  'PATCH /admin/stores/{id}/security-status',
  'PATCH /admin/stores/{id}/commission',
  'POST /admin/stores/{id}/catalog/import',
  'POST /admin/finance/close',
  'GET /admin/finance',
  'PATCH /admin/finance/store-invoices/{id}/paid',
  'PATCH /admin/finance/store-payouts/{id}/paid',
  'PATCH /admin/finance/driver-payouts/{id}/paid',
] as const
```

- [ ] **Step 2: Add cross-actor negative contracts**

Using real fixtures, verify STORE_A gets `404` and cannot mutate STORE_B resources for catalog, order, batch, offer, link, shift, authorization, return and finance. DRIVER_A cannot read/mutate DRIVER_B delivery/return/shift/payout. CUSTOMER_A cannot read/mutate CUSTOMER_B order/address/amendment.

- [ ] **Step 3: Add security-event transitions**

Table-test old access and refresh tokens after: user BLOCKED, tokenVersion increment, role change, store SUSPENDED, logout family and logout-all. Every old access request and refresh attempt must fail immediately.

- [ ] **Step 4: Run complete verification**

```bash
pnpm --filter @delivery/shared test
pnpm --filter @delivery/api test
pnpm --filter @delivery/api typecheck
pnpm lint
git diff --check
```

Expected: all commands exit 0. Record exact test counts in plan execution notes.

- [ ] **Step 5: Review security scans**

```bash
rg -n "\.\.\.(row\.order|r\.order)|/media/.*returns|isActive|signAccessToken\(" apps/api/src apps/api/test
rg -n "use\('/(orders|me|driver|store|admin)" apps/api/src/routes
```

Expected: no raw driver order spread; no return evidence public URL; no obsolete `isActive`; direct token signing only token tests/session service; every protected namespace has role middleware.

- [ ] **Step 6: Update security documentation**

Append a P0 remediation table to `docs/security/2026-07-11-backend-security-review.md`: SEC-01, SEC-04, SEC-05, emergency mitigation for SEC-06, SEC-07 and baseline portions of SEC-12/20. Mark SEC-02/03/08 and complete private-media work as pending their dedicated plans. Do not claim whole audit resolved.

- [ ] **Step 7: Commit gate**

```bash
git add apps/api packages/shared docs/security/2026-07-11-backend-security-review.md
git commit -m "test(security): gate P0 authorization foundation"
```

---

## Self-review record

- Spec coverage: CUSTOMER guards, live state, tokenVersion, session family, immediate logout, store suspension, media emergency guard, driver DTO, body/header/docs baseline and matrix all mapped.
- Deferred by design: email identity, Turnstile/rate limit, Google, MFA, final private bucket/read audit, payment inbox/outbox and staging infra.
- Type consistency: JWT uses `ver/sid/jti`; application principal uses `tokenVersion/sessionFamilyId/jti`; store state uses `securityStatus` only.
- Migration safety: geração obrigatoriamente sobre 0020/0021 já commitadas; nome real vem do Drizzle; dados locais descartáveis; sem execução em produção.
- Worktree safety: executor starts from committed 0020/0021 in an isolated clean worktree and stops if unrelated changes appear.

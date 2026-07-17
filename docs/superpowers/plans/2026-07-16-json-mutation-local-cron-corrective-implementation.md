# JSON Mutation and Local Cron Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline; do not dispatch subagents.

**Goal:** Remove `415` failures from logically bodyless web/driver mutations and add a safe recurring local scheduled-event runner so due payment retries advance during development.

**Architecture:** Normalize empty unsafe requests centrally in both frontend `api()` wrappers while preserving explicit payloads, uploads, credentials and refresh behavior. Keep the API security baseline and payment state machine unchanged; expose Wrangler's existing scheduled-test route from `dev:api` and call it sequentially from a loopback-only `dev:cron` process.

**Tech Stack:** TypeScript 6, Vue 3, Vite 8, Vitest 4, Hono 4, Wrangler 4, Cloudflare Workers scheduled events, PostgreSQL 17.

## Global Constraints

- Follow the approved [corrective design](../specs/2026-07-16-json-mutation-local-cron-corrective-design.md).
- Work in an isolated worktree. Preserve ignored `.env*`, `.dev.vars*`, `.demo-accounts.md` and all unrelated user changes.
- Execute inline without subagents.
- Use TDD: observe every behavior-changing focused test fail before editing production code.
- Do not weaken `securityBaseline`, add content-type exceptions, or change upload/webhook handling.
- Do not edit the 31 affected UI call sites individually; establish the contract in the web and driver wrappers.
- Preserve explicit bodies, explicit content types, bearer authorization, `credentials: 'include'`, and refresh-once behavior.
- Keep payment retry timing, attempt limits, reconciliation stages, provider mutations, database schema and staging/production cron unchanged.
- The local cron runner must use only loopback, must not overlap ticks, and must never print response bodies, provider identifiers, order IDs, emails, QR data, credentials, database URLs, tokens, secrets or idempotency keys.
- Automated verification must not call Mercado Pago, reset/reseed a database, deploy, push or change external configuration.
- Review each task's diff, run its focused/full gates, and commit before continuing.

---

### Task 1: Normalize logically empty mutations in both frontend clients

**Files:**
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/driver/src/lib/api.test.ts`
- Modify: `apps/driver/src/lib/api.ts`

**Interfaces:**
- Consumes: `api<T>(path: string, init?: RequestInit, retried?: boolean): Promise<T>` in each frontend.
- Produces: every `POST`, `PUT`, `PATCH`, or `DELETE` with `init.body == null` reaches `fetch` with `body: '{}'` and `Content-Type: application/json` unless the caller supplied a content type.
- Preserves: safe bodyless methods, explicit `BodyInit`, caller headers, Access cookies, bearer token injection and one refresh retry.

- [x] **Step 1: Add the RED empty-mutation matrix to the web wrapper tests**

In `apps/web/src/lib/api.test.ts`, import `setTokenProvider` with `api`:

```ts
import { api, setTokenProvider } from './api'
```

Add this reset inside the existing `beforeEach` so a failed refresh test cannot
leak its provider into the next case:

```ts
setTokenProvider({ getAccessToken: () => null, tryRefresh: async () => false })
```

Add inside `describe('api errors')`:

```ts
it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
  'normalizes a bodyless %s mutation to empty JSON',
  async (method) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/mutation', { method })

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(init.body).toBe(JSON.stringify({}))
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(init.credentials).toBe('include')
  },
)

it('preserves explicit mutation input and leaves GET bodyless', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  const explicit = JSON.stringify({ value: 1 })
  await api('/mutation', {
    method: 'POST',
    body: explicit,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
  const upload = new Blob(['image'], { type: 'image/png' })
  await api('/upload', {
    method: 'PUT',
    body: upload,
    headers: { 'Content-Type': 'image/png' },
  })
  await api('/health')

  const first = fetchMock.mock.calls[0]![1] as RequestInit
  const second = fetchMock.mock.calls[1]![1] as RequestInit
  const third = fetchMock.mock.calls[2]![1] as RequestInit
  expect(first.body).toBe(explicit)
  expect(new Headers(first.headers).get('Content-Type')).toBe('application/json; charset=utf-8')
  expect(second.body).toBe(upload)
  expect(new Headers(second.headers).get('Content-Type')).toBe('image/png')
  expect(third.body).toBeUndefined()
  expect(new Headers(third.headers).has('Content-Type')).toBe(false)
})

it('replays the same normalized empty JSON after one refresh', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'expired' }), { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  setTokenProvider({ getAccessToken: () => 'local-test-token', tryRefresh: async () => true })

  await api('/mutation', { method: 'POST' })

  expect(fetchMock).toHaveBeenCalledTimes(2)
  for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
    expect(init.body).toBe(JSON.stringify({}))
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  }
  setTokenProvider({ getAccessToken: () => null, tryRefresh: async () => false })
})
```

The token text is a local test literal, not a real credential.

- [x] **Step 2: Add the complete RED contract to the driver wrapper tests**

In `apps/driver/src/lib/api.test.ts`, import and reset the provider exactly as
the web suite does:

```ts
import { api, setTokenProvider } from './api'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setTokenProvider({ getAccessToken: () => null, tryRefresh: async () => false })
})
```

Add inside `describe('driver api errors')`:

```ts
it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
  'normalizes a bodyless %s mutation to empty JSON',
  async (method) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/mutation', { method })

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(init.body).toBe(JSON.stringify({}))
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(init.credentials).toBe('include')
  },
)

it('preserves explicit mutation input and leaves GET bodyless', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  const explicit = JSON.stringify({ value: 1 })
  await api('/mutation', {
    method: 'POST',
    body: explicit,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
  const upload = new Blob(['image'], { type: 'image/png' })
  await api('/upload', {
    method: 'PUT',
    body: upload,
    headers: { 'Content-Type': 'image/png' },
  })
  await api('/health')

  const first = fetchMock.mock.calls[0]![1] as RequestInit
  const second = fetchMock.mock.calls[1]![1] as RequestInit
  const third = fetchMock.mock.calls[2]![1] as RequestInit
  expect(first.body).toBe(explicit)
  expect(new Headers(first.headers).get('Content-Type')).toBe('application/json; charset=utf-8')
  expect(second.body).toBe(upload)
  expect(new Headers(second.headers).get('Content-Type')).toBe('image/png')
  expect(third.body).toBeUndefined()
  expect(new Headers(third.headers).has('Content-Type')).toBe(false)
})

it('replays the same normalized empty JSON after one refresh', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'expired' }), { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  setTokenProvider({ getAccessToken: () => 'local-test-token', tryRefresh: async () => true })

  await api('/mutation', { method: 'POST' })

  expect(fetchMock).toHaveBeenCalledTimes(2)
  for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
    expect(init.body).toBe(JSON.stringify({}))
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  }
  setTokenProvider({ getAccessToken: () => null, tryRefresh: async () => false })
})
```

- [x] **Step 3: Run both focused suites and verify RED**

Run:

```bash
pnpm --dir apps/web exec vitest run src/lib/api.test.ts
pnpm --dir apps/driver exec vitest run src/lib/api.test.ts
```

Expected: both suites fail the unsafe-method matrix because `init.body` is currently `undefined`; the explicit-body and GET characterization assertions pass.

- [x] **Step 4: Implement the normalization in the web wrapper**

In `apps/web/src/lib/api.ts`, add above `api()`:

```ts
const EMPTY_JSON_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function normalizedBody(init: RequestInit): BodyInit | null | undefined {
  const method = (init.method ?? 'GET').toUpperCase()
  return EMPTY_JSON_METHODS.has(method) && init.body == null
    ? JSON.stringify({})
    : init.body
}
```

Replace the start of `api()` and its `fetch` call with:

```ts
export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const body = normalizedBody(init)
  const headers = new Headers(init.headers)
  if (body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const access = tokenProvider?.getAccessToken()
  if (access) headers.set('Authorization', `Bearer ${access}`)

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    body,
    credentials: 'include',
    headers,
  })
```

Leave response parsing and refresh recursion unchanged. Passing original `init` to the recursive call intentionally derives the same normalized body again.

- [x] **Step 5: Implement the identical normalization in the driver wrapper**

In `apps/driver/src/lib/api.ts`, add above `api()`:

```ts
const EMPTY_JSON_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function normalizedBody(init: RequestInit): BodyInit | null | undefined {
  const method = (init.method ?? 'GET').toUpperCase()
  return EMPTY_JSON_METHODS.has(method) && init.body == null
    ? JSON.stringify({})
    : init.body
}
```

Replace the start of the driver `api()` and its `fetch` call with:

```ts
export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const body = normalizedBody(init)
  const headers = new Headers(init.headers)
  if (body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const access = tokenProvider?.getAccessToken()
  if (access) headers.set('Authorization', `Bearer ${access}`)

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    body,
    credentials: 'include',
    headers,
  })
```

Leave response parsing and refresh recursion unchanged. Do not create a shared
package abstraction in this correction; the two existing frontend boundaries
must remain structurally identical.

- [x] **Step 6: Run focused and frontend gates**

Run:

```bash
pnpm --dir apps/web exec vitest run src/lib/api.test.ts
pnpm --dir apps/driver exec vitest run src/lib/api.test.ts
pnpm --filter @delivery/web test
pnpm --filter @delivery/driver test
pnpm --filter @delivery/web typecheck
pnpm --filter @delivery/driver typecheck
git diff --check
```

Expected: all pass. Inspect the two implementations side by side and confirm the normalization logic is identical.

- [x] **Step 7: Review and commit the transport correction**

Review:

```bash
git diff -- apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts \
  apps/driver/src/lib/api.ts apps/driver/src/lib/api.test.ts
```

Confirm no UI component, security middleware, upload path or environment file changed. Then commit:

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts \
  apps/driver/src/lib/api.ts apps/driver/src/lib/api.test.ts
git commit -m "fix(frontend): normalize empty mutations"
```

---

### Task 2: Add a safe recurring local cron process and document validation

**Files:**
- Create: `apps/api/src/dev/local-cron.ts`
- Create: `apps/api/scripts/local-cron.ts`
- Create: `apps/api/test/local-cron.test.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/security/runbooks/mercado-pago-orders.md`

**Interfaces:**
- Produces: `LOCAL_CRON_URL`, `LOCAL_CRON_INTERVAL_MS`, `triggerLocalCron(fetcher)` and `runLocalCronLoop(options)`.
- Produces: root command `pnpm dev:cron` and API development with `wrangler dev --test-scheduled`.
- Consumes: Wrangler's local-only `GET /__scheduled` route and the existing Worker `scheduled()` handler.
- Preserves: the configured staging cron, reconciliation stages, retry eligibility, idempotency and provider-operation semantics.

- [x] **Step 1: Write RED tests for the local cron unit**

Create `apps/api/test/local-cron.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_CRON_INTERVAL_MS,
  LOCAL_CRON_URL,
  runLocalCronLoop,
  triggerLocalCron,
  type LocalCronFetch,
  type LocalCronStatus,
} from '../src/dev/local-cron'

describe('local cron runner', () => {
  it('uses only the exact loopback scheduled-test URL and discards its body', async () => {
    const cancel = vi.fn(async () => undefined)
    const fetcher = vi.fn(async () => ({ ok: true, body: { cancel } }) as unknown as Response)

    await expect(triggerLocalCron(fetcher)).resolves.toBe('TRIGGERED')

    expect(LOCAL_CRON_URL).toBe(
      'http://127.0.0.1:8787/__scheduled?cron=*%2F5+*+*+*+*',
    )
    expect(new URL(LOCAL_CRON_URL).hostname).toBe('127.0.0.1')
    expect(fetcher).toHaveBeenCalledWith(LOCAL_CRON_URL, { method: 'GET' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('maps HTTP and connection failures without exposing response data', async () => {
    const httpFailure = vi.fn(async () => new Response('private-body', { status: 503 }))
    const unavailable = vi.fn(async () => { throw new Error('private connection detail') })

    await expect(triggerLocalCron(httpFailure)).resolves.toBe('HTTP_ERROR')
    await expect(triggerLocalCron(unavailable)).resolves.toBe('API_UNAVAILABLE')
  })

  it('runs sequentially every ten seconds and stops cleanly', async () => {
    const controller = new AbortController()
    const statuses: LocalCronStatus[] = []
    let active = 0
    let maximumActive = 0
    const fetcher: LocalCronFetch = vi.fn(async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active--
      return new Response(null, { status: 200 })
    })
    const wait = vi.fn(async (milliseconds: number) => {
      expect(milliseconds).toBe(10_000)
    })

    await runLocalCronLoop({
      signal: controller.signal,
      fetcher,
      wait,
      onStatus: (status) => {
        statuses.push(status)
        if (statuses.length === 3) controller.abort()
      },
    })

    expect(LOCAL_CRON_INTERVAL_MS).toBe(10_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(maximumActive).toBe(1)
    expect(statuses).toEqual(['TRIGGERED', 'TRIGGERED', 'TRIGGERED'])
  })
})
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/api exec vitest run test/local-cron.test.ts
```

Expected: FAIL because `../src/dev/local-cron` does not exist.

- [x] **Step 3: Implement the testable local cron unit**

Create `apps/api/src/dev/local-cron.ts`:

```ts
export const LOCAL_CRON_URL =
  'http://127.0.0.1:8787/__scheduled?cron=*%2F5+*+*+*+*'
export const LOCAL_CRON_INTERVAL_MS = 10_000

export type LocalCronStatus = 'TRIGGERED' | 'HTTP_ERROR' | 'API_UNAVAILABLE'
export type LocalCronFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>
export type LocalCronWait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>

export async function triggerLocalCron(
  fetcher: LocalCronFetch = fetch,
  signal?: AbortSignal,
): Promise<LocalCronStatus> {
  try {
    const response = await fetcher(LOCAL_CRON_URL, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    })
    await response.body?.cancel()
    return response.ok ? 'TRIGGERED' : 'HTTP_ERROR'
  } catch {
    return 'API_UNAVAILABLE'
  }
}

export const waitForLocalCron: LocalCronWait = (milliseconds, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })

export async function runLocalCronLoop(options: {
  signal: AbortSignal
  fetcher?: LocalCronFetch
  wait?: LocalCronWait
  onStatus?: (status: LocalCronStatus) => void
}): Promise<void> {
  const wait = options.wait ?? waitForLocalCron
  while (!options.signal.aborted) {
    const status = await triggerLocalCron(options.fetcher, options.signal)
    options.onStatus?.(status)
    if (!options.signal.aborted) {
      await wait(LOCAL_CRON_INTERVAL_MS, options.signal)
    }
  }
}
```

The fetch boundary deliberately returns only a three-value status; no response
body or thrown error crosses into logging.

- [x] **Step 4: Create the signal-aware CLI entry point**

Create `apps/api/scripts/local-cron.ts`:

```ts
import { LOCAL_CRON_INTERVAL_MS, runLocalCronLoop } from '../src/dev/local-cron'

const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

console.log(`local_cron=STARTED interval_seconds=${LOCAL_CRON_INTERVAL_MS / 1000}`)
await runLocalCronLoop({
  signal: controller.signal,
  onStatus: (status) => console.log(`local_cron=${status}`),
})
console.log('local_cron=STOPPED')
```

Do not add arguments or environment variables that allow a remote URL.

- [x] **Step 5: Add the two development scripts**

In `apps/api/package.json`, change:

```json
"dev": "wrangler dev"
```

to:

```json
"dev": "wrangler dev --test-scheduled",
"dev:cron": "tsx scripts/local-cron.ts"
```

In the root `package.json`, add beside the other `dev:*` scripts:

```json
"dev:cron": "pnpm --filter @delivery/api dev:cron"
```

Do not add `concurrently` or another dependency; the approved workflow uses four explicit terminals.

- [x] **Step 6: Run the cron unit and API gates**

Run:

```bash
pnpm --dir apps/api exec vitest run test/local-cron.test.ts
pnpm --filter @delivery/api typecheck
pnpm --filter @delivery/api test
```

Expected: all pass without starting Wrangler, contacting Mercado Pago or changing the database.

- [x] **Step 7: Document the four-terminal workflow and sanitized diagnosis**

In the `README.md` Dev block, list:

```bash
pnpm dev:api     # terminal 1 — API + /__scheduled local
pnpm dev:web     # terminal 2 — web
pnpm dev:driver  # terminal 3 — driver
pnpm dev:cron    # terminal 4 — scheduled tick local a cada 10s
```

Immediately below, state that `dev:cron` is local-only, that the reconciler
still honors `next_attempt_at`, and that stopping it may leave retryable payment
operations pending until another scheduled tick.

In `docs/security/runbooks/mercado-pago-orders.md`, extend **Verificação local**
with the same four commands and these exact interpretations:

```text
CANCEL_PENDING durante desenvolvimento local não avança apenas com espera:
o próximo tick agendado precisa ocorrer. `pnpm dev:cron` fornece esses ticks.
TRIGGERED confirma somente execução do evento local; conclusão financeira deve
ser comprovada pela projeção do pedido e por payment-work-status.sql.
```

Keep provider IDs and response bodies out of the runbook examples.

- [x] **Step 8: Run repository verification and manual non-financial smoke**

First run the complete automated gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Expected: all pass.

Then start the four terminals. Without creating a payment, verify:

1. `pnpm dev:api` reports `Ready on http://localhost:8787`;
2. `pnpm dev:cron` reports `local_cron=STARTED interval_seconds=10`;
3. before the API is ready, only `local_cron=API_UNAVAILABLE` may appear;
4. after the API is ready, ticks report `local_cron=TRIGGERED`;
5. simultaneous scheduled requests never appear in the API log;
6. `Ctrl+C` reports `local_cron=STOPPED` and exits.

Do not perform Mercado Pago mutations as part of the implementation gate.

- [x] **Step 9: Review and commit the local development correction**

Review:

```bash
git diff -- apps/api/src/dev/local-cron.ts apps/api/scripts/local-cron.ts \
  apps/api/test/local-cron.test.ts apps/api/package.json package.json \
  README.md docs/security/runbooks/mercado-pago-orders.md
git status --short
```

Confirm only planned tracked files plus pre-existing user-local files appear. Commit:

```bash
git add apps/api/src/dev/local-cron.ts apps/api/scripts/local-cron.ts \
  apps/api/test/local-cron.test.ts apps/api/package.json package.json \
  README.md docs/security/runbooks/mercado-pago-orders.md
git commit -m "chore(dev): run local scheduled events"
```

- [ ] **Step 10: Perform authorized manual sandbox validation after implementation**

Only after the user explicitly starts a fresh sandbox test, validate:

1. customer creates a cancellation request after the order is no longer directly cancellable;
2. store approves it and the network records `POST .../cancel-request/approve` as `200`, never `415`;
3. one representative bodyless admin mutation succeeds;
4. one representative bodyless driver accept/refuse mutation succeeds;
5. a cancelled `CONT` order stays commercially `CANCELLED` while `dev:cron` advances due `CANCEL_PENDING` work;
6. a provider terminal no-charge result projects `NOT_CHARGED`;
7. concurrent approval creates/finishes `REFUND_FULL` and projects `REFUNDED`;
8. `apps/api/scripts/payment-work-status.sql` shows no unexpected `REVIEW_REQUIRED` row.

Record only HTTP status, application state, operation status/result code, failure
class and counts. Never record full provider/order identifiers or financial
provider bodies.

## Completion Boundary

Completion means the wrapper contract prevents `415` for every logically empty
web/driver mutation, explicit payloads/uploads remain unchanged, the approved
store cancellation action succeeds, the four-terminal local workflow advances
due payment retries without overlapping events, financial safety semantics are
unchanged, and all focused/full gates pass. It does not authorize deployment,
production configuration, real-money payment tests or provider-data logging.

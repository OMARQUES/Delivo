import { describe, expect, it, vi } from 'vitest'
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { app } from '../src/app'
import { createRouter } from '../src/app-factory'
import { errorHandler } from '../src/middleware/error-handler'

// dbMiddleware runs on '*', so the db client module is mocked for the whole
// file: no test here should ever open a real socket to Postgres.
const { executeMock, endMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  endMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/db/client', () => ({
  createDb: vi.fn(() => ({
    db: { execute: executeMock },
    client: { end: endMock },
  })),
}))

// cors middleware runs on '*' and reads c.env.ALLOWED_ORIGINS, so every
// app.request call needs a bindings object, not just the cors-focused tests.
const env = {
  APP_ENV: 'local' as const,
  ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:5174',
  JWT_SECRET: 'test',
  HYPERDRIVE: {} as Hyperdrive,
}

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.request('/health', {}, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('security baseline', () => {
  it('fails closed for diagnostics when APP_ENV is missing', async () => {
    const missingEnvironment: Partial<typeof env> = { ...env }
    delete missingEnvironment.APP_ENV
    expect((await app.request('/docs', {}, missingEnvironment as never)).status).toBe(404)
    expect((await app.request('/openapi.json', {}, missingEnvironment as never)).status).toBe(404)
    expect((await app.request('/health/db', {}, missingEnvironment as never)).status).toBe(404)
  })

  it('adds security and no-store headers to authentication errors', async () => {
    const res = await app.request('/auth/me', {}, env)
    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('hides diagnostics outside local and enables HSTS only in production', async () => {
    const staging = { ...env, APP_ENV: 'staging' as const }
    const production = { ...env, APP_ENV: 'production' as const }
    for (const path of ['/docs', '/openapi.json', '/health/db']) {
      expect((await app.request(path, {}, staging)).status).toBe(404)
      expect((await app.request(path, {}, production)).status).toBe(404)
    }
    expect((await app.request('/health', {}, env)).headers.get('strict-transport-security')).toBeNull()
    expect((await app.request('/health', {}, production)).headers.get('strict-transport-security'))
      .toBe('max-age=31536000; includeSubDomains')
  })

  it('rejects oversized JSON, oversized global bodies and wrong JSON media type', async () => {
    const oversizedJson = JSON.stringify({ identifier: 'x'.repeat(257 * 1024), password: 'x' })
    const json = await app.request('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: oversizedJson,
    }, env)
    expect(json.status).toBe(413)

    const global = await app.request('/health', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(6 * 1024 * 1024 + 1),
    }, env)
    expect(global.status).toBe(413)

    const wrongType = await app.request('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    }, env)
    expect(wrongType.status).toBe(415)

    const missingType = await app.request('/auth/login', {
      method: 'POST', body: new TextEncoder().encode('{}'),
    }, env)
    expect(missingType.status).toBe(415)
  })
})

describe('GET /health/db', () => {
  it('returns 200 ok when the database responds', async () => {
    executeMock.mockResolvedValueOnce([{ '?column?': 1 }])
    const res = await app.request('/health/db', {}, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('returns 503 degraded when the database is unreachable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      executeMock.mockRejectedValueOnce(new Error('connection refused'))
      const res = await app.request('/health/db', {}, env)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ status: 'degraded' })
    } finally {
      spy.mockRestore()
    }
  })

  it('closes the db client after the request', async () => {
    executeMock.mockResolvedValueOnce([{ '?column?': 1 }])
    endMock.mockClear()
    await app.request('/health/db', {}, env)
    expect(endMock).toHaveBeenCalledTimes(1)
  })
})

describe('unknown route', () => {
  it('returns structured 404', async () => {
    const res = await app.request('/nope', {}, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
  })
})

describe('cors allowlist', () => {
  it('allows configured origin', async () => {
    const res = await app.request('/health', { headers: { Origin: 'http://localhost:5173' } }, env)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('does not echo unknown origins', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } }, env)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('error contract', () => {
  function makeTestApp() {
    const testApp = createRouter()
    testApp.onError(errorHandler)
    testApp.get('/teapot', () => {
      throw new HTTPException(418, { message: 'teapot' })
    })
    testApp.get('/custom-response', () => {
      throw new HTTPException(401, {
        res: new Response(JSON.stringify({ error: 'custom', code: 'TOKEN_EXPIRED' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      })
    })
    testApp.get('/boom', () => {
      throw new Error('boom')
    })
    testApp.openapi(
      createRoute({
        method: 'get',
        path: '/items/{id}',
        request: { params: z.object({ id: z.uuid() }) },
        responses: {
          200: {
            description: 'ok',
            content: { 'application/json': { schema: z.object({ id: z.string() }) } },
          },
        },
      }),
      (c) => c.json({ id: c.req.valid('param').id }, 200),
    )
    return testApp
  }

  it('wraps HTTPException in {error} envelope', async () => {
    const res = await makeTestApp().request('/teapot')
    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ error: 'teapot' })
  })

  it('respects a custom HTTPException response', async () => {
    const res = await makeTestApp().request('/custom-response')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'custom', code: 'TOKEN_EXPIRED' })
  })

  it('returns 500 {error: "Internal Server Error"} on unhandled throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await makeTestApp().request('/boom')
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Internal Server Error' })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('returns 400 {error, issues} on validation failure', async () => {
    const res = await makeTestApp().request('/items/not-a-uuid')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: unknown[] }
    expect(body.error).toBe('Validation failed')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues.length).toBeGreaterThan(0)
  })
})

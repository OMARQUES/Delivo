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

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('GET /health/db', () => {
  it('returns 200 ok when the database responds', async () => {
    executeMock.mockResolvedValueOnce([{ '?column?': 1 }])
    const res = await app.request('/health/db')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('returns 503 degraded when the database is unreachable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      executeMock.mockRejectedValueOnce(new Error('connection refused'))
      const res = await app.request('/health/db')
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ status: 'degraded' })
    } finally {
      spy.mockRestore()
    }
  })

  it('closes the db client after the request', async () => {
    executeMock.mockResolvedValueOnce([{ '?column?': 1 }])
    endMock.mockClear()
    await app.request('/health/db')
    expect(endMock).toHaveBeenCalledTimes(1)
  })
})

describe('unknown route', () => {
  it('returns structured 404', async () => {
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
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

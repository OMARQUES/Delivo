import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, setTokenProvider } from './api'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setTokenProvider({ getAccessToken: () => null, tryRefresh: async () => false })
})

describe('api errors', () => {
  it('always includes Cloudflare Access cookies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/health', { credentials: 'omit' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/health',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('marks an explicit empty JSON mutation body as application/json', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await api('/orders/order-1/cancel', { method: 'POST', body: JSON.stringify({}) })

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(init.credentials).toBe('include')
  })

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

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    const first = calls[0]![1]
    const second = calls[1]![1]
    const third = calls[2]![1]
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
  })

  it('preserves stable code and Retry-After metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ error: 'Muitas tentativas', code: 'RATE_LIMITED' }),
        { status: 429, headers: { 'Retry-After': '42' } },
      )),
    )

    await expect(api('/auth/login')).rejects.toMatchObject({
      status: 429,
      message: 'Muitas tentativas',
      code: 'RATE_LIMITED',
      retryAfter: 42,
    })
  })
})

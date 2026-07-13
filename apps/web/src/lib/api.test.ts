import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

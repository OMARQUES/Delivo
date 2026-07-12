import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('api errors', () => {
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

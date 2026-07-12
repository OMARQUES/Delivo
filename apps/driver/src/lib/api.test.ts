import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('driver api errors', () => {
  it('preserves stable code and Retry-After metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ error: 'Confirme que você não é um robô', code: 'TURNSTILE_REQUIRED' }),
        { status: 401, headers: { 'Retry-After': '30' } },
      )),
    )

    await expect(api('/auth/login')).rejects.toMatchObject({
      status: 401,
      message: 'Confirme que você não é um robô',
      code: 'TURNSTILE_REQUIRED',
      retryAfter: 30,
    })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from './auth'

const tokens = { accessToken: 'acc-1', refreshToken: 'ref-1' }
const user = { id: 'u1', name: 'Ana', role: 'CUSTOMER', status: 'ACTIVE', phone: '44', email: null }

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('auth store', () => {
  it('login stores user + tokens and persists to localStorage', async () => {
    mockFetchOnce(200, { user, ...tokens })
    const store = useAuthStore()
    await store.login('ana@email.com', 'senha123')
    expect(store.user?.name).toBe('Ana')
    expect(store.isAuthenticated).toBe(true)
    expect(JSON.parse(localStorage.getItem('delivery.auth')!)).toMatchObject(tokens)
  })

  it('login failure surfaces error message and stays logged out', async () => {
    mockFetchOnce(401, { error: 'Credenciais inválidas' })
    const store = useAuthStore()
    await expect(store.login('x@y.com', 'errada123')).rejects.toThrow('Credenciais inválidas')
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.auth')).toBeNull()
  })

  it('hydrates from localStorage on init', () => {
    localStorage.setItem('delivery.auth', JSON.stringify({ ...tokens, user }))
    const store = useAuthStore()
    expect(store.isAuthenticated).toBe(true)
    expect(store.user?.role).toBe('CUSTOMER')
  })

  it('logout clears state + storage and calls API', async () => {
    localStorage.setItem('delivery.auth', JSON.stringify({ ...tokens, user }))
    mockFetchOnce(204, null)
    const store = useAuthStore()
    await store.logout()
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.auth')).toBeNull()
  })

  it('coalesces concurrent refreshes into a single call', async () => {
    localStorage.setItem('delivery.auth', JSON.stringify({ ...tokens, user }))
    const store = useAuthStore()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ user, accessToken: 'acc-2', refreshToken: 'ref-2' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const results = await Promise.all([store.tryRefresh(), store.tryRefresh(), store.tryRefresh()])
    expect(results).toEqual([true, true, true])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.accessToken).toBe('acc-2')
  })

  it('sends Turnstile tokens on login and registration', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user, ...tokens }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()

    await store.login('ana@email.com', 'senha123', 'login-token')
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(JSON.parse(String(calls[0]![1]!.body))).toMatchObject({ turnstileToken: 'login-token' })

    await store.register({
      name: 'Ana',
      phone: '44',
      email: 'ana@email.com',
      password: 'senha123',
      acceptedTerms: true,
      turnstileToken: 'register-token',
    })
    expect(JSON.parse(String(calls[1]![1]!.body))).toMatchObject({ turnstileToken: 'register-token' })
  })
})

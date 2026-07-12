import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from './auth'

const tokens = { accessToken: 'acc-1', refreshToken: 'ref-1' }
const driver = { id: 'd1', name: 'Dan', role: 'DRIVER', status: 'ACTIVE', phone: '44', email: 'dan@email.com' }

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('driver auth store', () => {
  it('sends Turnstile token on login and persists returned driver session only', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: driver, ...tokens }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()

    await store.login('dan@email.com', 'senha123', 'login-token')

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(JSON.parse(String(calls[0]![1]!.body))).toMatchObject({ turnstileToken: 'login-token' })
    expect(localStorage.getItem('delivery.driver.auth')).toContain('acc-1')
  })

  it('register always sends role DRIVER and Turnstile token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: { ...driver, status: 'PENDING' }, accessToken: null, refreshToken: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()

    await store.register({
      name: 'Dan',
      phone: '44',
      email: 'dan@email.com',
      password: 'senha123',
      acceptedTerms: true,
      role: 'CUSTOMER',
      turnstileToken: 'register-token',
    })

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(JSON.parse(String(calls[0]![1]!.body))).toMatchObject({ role: 'DRIVER', turnstileToken: 'register-token' })
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from './auth'

const tokens = { accessToken: 'acc-1', refreshToken: 'ref-1' }
const driver = { id: 'd1', name: 'Dan', role: 'DRIVER', status: 'ACTIVE', phone: '44', email: 'dan@email.com' }
const customer = { ...driver, id: 'c1', role: 'CUSTOMER' }
const verificationId = '123e4567-e89b-42d3-a456-426614174000'
const flow = {
  verificationId,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  resendAt: new Date(Date.now() + 60_000).toISOString(),
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('driver auth store', () => {
  it('sends Turnstile token on login and persists returned driver session only', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: driver, ...tokens }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()

    await store.login('dan@email.com', 'senha123', 'login-token')

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({
      email: 'dan@email.com', password: 'senha123', turnstileToken: 'login-token',
    })
    expect(localStorage.getItem('delivery.driver.auth')).toContain('acc-1')
  })

  it('rejects non-DRIVER login response before persistence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: customer, ...tokens }), { status: 200 })))
    const store = useAuthStore()
    await expect(store.login('customer@example.test', 'senha123')).rejects.toThrow('não é de entregador')
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
  })

  it('fails closed on malformed login response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const store = useAuthStore()
    await expect(store.login('driver@example.test', 'senha123')).rejects.toThrow('não é de entregador')
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
  })

  it('removes a stale non-DRIVER persisted session during hydration', () => {
    localStorage.setItem('delivery.driver.auth', JSON.stringify({ user: customer, ...tokens }))
    const store = useAuthStore()
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
  })

  it('starts DRIVER registration with required identity fields and no session', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(flow), { status: 202 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()

    await store.registerDriver({
      name: 'Dan',
      phone: '44999998888',
      email: 'dan@email.com',
      password: 'safe-driver-password',
      acceptedTerms: true,
      turnstileToken: 'register-token',
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      name: 'Dan', phone: '44999998888', email: 'dan@email.com',
      password: 'safe-driver-password', acceptedTerms: true,
      role: 'DRIVER', turnstileToken: 'register-token',
    })
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
    const timing = sessionStorage.getItem(`delivery.driver.auth.verification.${verificationId}`)!
    expect(timing).not.toContain('safe-driver-password')
    expect(timing).not.toContain('dan@email.com')
  })

  it('confirms DRIVER pending approval without storing tokens', async () => {
    sessionStorage.setItem(`delivery.driver.auth.verification.${verificationId}`, JSON.stringify(flow))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      kind: 'DRIVER_PENDING_APPROVAL', user: { ...driver, status: 'PENDING_APPROVAL' },
    }), { status: 200 })))
    const store = useAuthStore()

    await expect(store.confirmEmail(verificationId, '123456')).resolves.toMatchObject({ kind: 'DRIVER_PENDING_APPROVAL' })
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
    expect(sessionStorage.getItem(`delivery.driver.auth.verification.${verificationId}`)).toBeNull()
  })

  it('discards CUSTOMER confirmation tokens before persistence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      kind: 'CUSTOMER_SESSION', user: customer, ...tokens,
    }), { status: 200 })))
    const store = useAuthStore()
    await expect(store.confirmEmail(verificationId, '123456')).rejects.toThrow('não é de entregador')
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.driver.auth')).toBeNull()
  })

  it('resends with adaptive Turnstile token and updates public timing only', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(flow), { status: 202 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()
    await store.resendEmail(verificationId, 'resend-token')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)))
      .toEqual({ verificationId, turnstileToken: 'resend-token' })
    expect(sessionStorage.getItem(`delivery.driver.auth.verification.${verificationId}`)).not.toContain('resend-token')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from './auth'

const tokens = { accessToken: 'acc-1', refreshToken: 'ref-1' }
const user = { id: 'u1', name: 'Ana', role: 'CUSTOMER', status: 'ACTIVE', phone: '44', email: 'ana@example.test' }
const verificationId = '123e4567-e89b-42d3-a456-426614174000'
const flow = {
  verificationId,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  resendAt: new Date(Date.now() + 60_000).toISOString(),
}
const passwordSetupTicket = 'S'.repeat(43)
const passwordSetupExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString()

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
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
    const body = JSON.parse(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body))
    expect(body).toMatchObject({ email: 'ana@email.com', password: 'senha123' })
    expect(body).not.toHaveProperty('identifier')
  })

  it('login failure surfaces error message and stays logged out', async () => {
    mockFetchOnce(401, { error: 'Credenciais inválidas' })
    const store = useAuthStore()
    await expect(store.login('x@y.com', 'errada123')).rejects.toThrow('Credenciais inválidas')
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.auth')).toBeNull()
  })

  it('fails closed on malformed successful login response', async () => {
    mockFetchOnce(200, {})
    const store = useAuthStore()
    await expect(store.login('x@y.com', 'senha123')).rejects.toThrow('Resposta de autenticação inválida')
    expect(localStorage.getItem('delivery.auth')).toBeNull()
  })

  it('hydrates from localStorage on init', () => {
    localStorage.setItem('delivery.auth', JSON.stringify({ ...tokens, user }))
    const store = useAuthStore()
    expect(store.isAuthenticated).toBe(true)
    expect(store.user?.role).toBe('CUSTOMER')
  })

  it('removes an inactive persisted session during hydration', () => {
    localStorage.setItem('delivery.auth', JSON.stringify({ ...tokens, user: { ...user, status: 'BLOCKED' } }))
    const store = useAuthStore()
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.auth')).toBeNull()
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

  it('starts CUSTOMER registration without creating a session or storing secrets', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(flow), { status: 202 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()

    await expect(store.registerCustomer({
      name: 'Ana',
      email: 'ana@email.com',
      password: 'safe-pass-123',
      acceptedTerms: true,
      turnstileToken: 'register-token',
    })).resolves.toEqual(flow)

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect(body).toEqual({
      name: 'Ana', email: 'ana@email.com', password: 'safe-pass-123',
      acceptedTerms: true, role: 'CUSTOMER', turnstileToken: 'register-token',
    })
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.auth')).toBeNull()
    const stored = sessionStorage.getItem(`delivery.auth.verification.${verificationId}`)
    expect(stored).toBeTruthy()
    expect(stored).not.toContain('safe-pass-123')
    expect(stored).not.toContain('ana@email.com')
  })

  it('persists CUSTOMER session only after email confirmation and clears flow timing', async () => {
    sessionStorage.setItem(`delivery.auth.verification.${verificationId}`, JSON.stringify(flow))
    mockFetchOnce(200, { kind: 'CUSTOMER_SESSION', user, ...tokens })
    const store = useAuthStore()

    await expect(store.confirmEmail(verificationId, '123456')).resolves.toMatchObject({ kind: 'CUSTOMER_SESSION' })
    expect(store.isAuthenticated).toBe(true)
    expect(localStorage.getItem('delivery.auth')).toContain('acc-1')
    expect(sessionStorage.getItem(`delivery.auth.verification.${verificationId}`)).toBeNull()
  })

  it('rejects non-active CUSTOMER confirmation before persistence', async () => {
    mockFetchOnce(200, { kind: 'CUSTOMER_SESSION', user: { ...user, status: 'BLOCKED' }, ...tokens })
    const store = useAuthStore()
    await expect(store.confirmEmail(verificationId, '123456')).rejects.toThrow('Resposta de verificação inválida')
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.auth')).toBeNull()
  })

  it('fails closed on malformed CUSTOMER confirmation response', async () => {
    mockFetchOnce(200, { kind: 'CUSTOMER_SESSION', ...tokens, user: null })
    const store = useAuthStore()

    await expect(store.confirmEmail(verificationId, '123456'))
      .rejects.toThrow('Resposta de verificação inválida')
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('delivery.auth')).toBeNull()
  })

  it('resends with optional Turnstile and stores only replacement timing', async () => {
    const replacement = { ...flow, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() }
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(replacement), { status: 202 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const store = useAuthStore()

    await store.resendEmail(verificationId, 'resend-token')
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect(body).toEqual({ verificationId, turnstileToken: 'resend-token' })
    expect(sessionStorage.getItem(`delivery.auth.verification.${verificationId}`)).toContain(replacement.expiresAt)
  })

  it('keeps STORE password-setup ticket only in Pinia memory', async () => {
    mockFetchOnce(200, {
      kind: 'PASSWORD_SETUP_REQUIRED',
      passwordSetupTicket,
      expiresAt: passwordSetupExpiresAt,
    })
    const store = useAuthStore()

    await expect(store.confirmEmail(verificationId, '123456'))
      .resolves.toMatchObject({ kind: 'PASSWORD_SETUP_REQUIRED' })

    expect(store.passwordSetupTicket).toBe(passwordSetupTicket)
    expect(store.passwordSetupExpiresAt).toBe(passwordSetupExpiresAt)
    expect(store.isAuthenticated).toBe(false)
    expect(JSON.stringify(localStorage)).not.toContain(passwordSetupTicket)
    expect(JSON.stringify(sessionStorage)).not.toContain(passwordSetupTicket)
  })

  it('submits initial password using only memory ticket and clears it after success', async () => {
    mockFetchOnce(204, null)
    const store = useAuthStore()
    store.$patch({ passwordSetupTicket, passwordSetupExpiresAt })

    await store.setupInitialPassword('a strong store password')

    const body = JSON.parse(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body))
    expect(body).toEqual({ passwordSetupTicket, newPassword: 'a strong store password' })
    expect(body).not.toHaveProperty('email')
    expect(body).not.toHaveProperty('userId')
    expect(body).not.toHaveProperty('storeId')
    expect(store.passwordSetupTicket).toBeNull()
  })

  it('handles ADMIN email confirmation without persisting session or setup ticket', async () => {
    mockFetchOnce(200, { kind: 'EMAIL_VERIFIED' })
    const store = useAuthStore()

    await expect(store.confirmEmail(verificationId, '123456')).resolves.toEqual({ kind: 'EMAIL_VERIFIED' })

    expect(store.isAuthenticated).toBe(false)
    expect(store.passwordSetupTicket).toBeNull()
    expect(localStorage.getItem('delivery.auth')).toBeNull()
  })
})

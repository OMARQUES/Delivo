import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecoveryStore } from './recovery'

const recoveryId = '123e4567-e89b-42d3-a456-426614174000'
const expiresAt = new Date(Date.now() + 600_000).toISOString()
const resetTicket = 'A'.repeat(43)

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('recovery store', () => {
  it('starts with mandatory proof and keeps public flow data out of browser storage', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ recoveryId, expiresAt }), { status: 202 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const store = useRecoveryStore()

    await expect(store.start('ana@example.test', 'turnstile-token')).resolves.toEqual({ recoveryId, expiresAt })

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      email: 'ana@example.test',
      turnstileToken: 'turnstile-token',
    })
    expect(JSON.stringify(store.$state)).not.toContain(recoveryId)
    expect(JSON.stringify(localStorage)).not.toContain(recoveryId)
    expect(JSON.stringify(sessionStorage)).not.toContain(recoveryId)
  })

  it('holds reset ticket only in Pinia memory and never persists it', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ resetTicket, expiresAt }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const store = useRecoveryStore()

    await expect(store.verify(recoveryId, '123456')).resolves.toEqual({ resetTicket, expiresAt })

    expect(store.resetTicket).toBe(resetTicket)
    expect(store.resetExpiresAt).toBe(expiresAt)
    expect(JSON.stringify(localStorage)).not.toContain(resetTicket)
    expect(JSON.stringify(sessionStorage)).not.toContain(resetTicket)
  })

  it('sends only ticket and password, then clears all sensitive flow state', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 204 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const store = useRecoveryStore()
    store.$patch({ resetTicket, resetExpiresAt: expiresAt })

    await store.reset(resetTicket, 'new secure password')

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      resetTicket,
      newPassword: 'new secure password',
    })
    expect(store.resetTicket).toBeNull()
    expect(store.resetExpiresAt).toBeNull()
  })

  it('retains an unexpired in-memory ticket after a policy error so the user can retry', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ error: 'A senha não atende à política de segurança.', code: 'PASSWORD_POLICY_REJECTED' }),
      { status: 400 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const store = useRecoveryStore()
    store.$patch({ resetTicket, resetExpiresAt: expiresAt })

    await expect(store.reset(resetTicket, 'password')).rejects.toMatchObject({ code: 'PASSWORD_POLICY_REJECTED' })

    expect(store.resetTicket).toBe(resetTicket)
    expect(store.resetExpiresAt).toBe(expiresAt)
  })
})

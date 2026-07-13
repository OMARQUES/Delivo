import { defineStore } from 'pinia'
import { api, setTokenProvider } from '../lib/api'

export type SessionUser = {
  id: string
  name: string
  role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'
  status: 'ACTIVE' | 'PENDING_EMAIL' | 'PENDING_APPROVAL' | 'BLOCKED'
  phone: string | null
  email: string
}

type AuthResponse = { user: SessionUser; accessToken: string; refreshToken: string }
export type VerificationFlow = { verificationId: string; expiresAt: string; resendAt: string }
export type ConfirmationResult =
  | { kind: 'CUSTOMER_SESSION'; user: SessionUser; accessToken: string; refreshToken: string }
  | { kind: 'DRIVER_PENDING_APPROVAL'; user: SessionUser }
  | { kind: 'EMAIL_VERIFIED' }
  | { kind: 'PASSWORD_SETUP_REQUIRED'; passwordSetupTicket: string; expiresAt: string }

type VerificationTiming = { expiresAt?: string; resendAt?: string }

const STORAGE_KEY = 'delivery.auth'
const FLOW_PREFIX = 'delivery.auth.verification.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Persisted = { user: SessionUser; accessToken: string; refreshToken: string }

/** Single-flight: só um refresh em voo; 401s paralelos aguardam a mesma promise. */
let refreshInFlight: Promise<boolean> | null = null

function isActiveSession(value: unknown): value is AuthResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AuthResponse>
  return Boolean(candidate.user && candidate.user.status === 'ACTIVE')
    && typeof candidate.accessToken === 'string' && candidate.accessToken.length > 0
    && typeof candidate.refreshToken === 'string' && candidate.refreshToken.length > 0
}

function flowKey(verificationId: string) {
  if (!UUID.test(verificationId)) throw new Error('Fluxo de verificação inválido')
  return `${FLOW_PREFIX}${verificationId}`
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  const expected = new Set(allowed)
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key))
}

function assertConfirmationResult(value: unknown): ConfirmationResult {
  if (!value || typeof value !== 'object') throw new Error('Resposta de verificação inválida')
  const result = value as Partial<ConfirmationResult> & Record<string, unknown>
  if (result.kind === 'CUSTOMER_SESSION') {
    if (
      !exactKeys(result, ['kind', 'user', 'accessToken', 'refreshToken'])
      || !isActiveSession(result)
    ) {
      throw new Error('Resposta de verificação inválida')
    }
    return result as Extract<ConfirmationResult, { kind: 'CUSTOMER_SESSION' }>
  }
  if (result.kind === 'DRIVER_PENDING_APPROVAL') {
    const user = result.user as SessionUser | undefined
    if (!exactKeys(result, ['kind', 'user']) || user?.role !== 'DRIVER' || user.status !== 'PENDING_APPROVAL') {
      throw new Error('Resposta de verificação inválida')
    }
    return result as Extract<ConfirmationResult, { kind: 'DRIVER_PENDING_APPROVAL' }>
  }
  if (result.kind === 'EMAIL_VERIFIED') {
    if (!exactKeys(result, ['kind'])) throw new Error('Resposta de verificação inválida')
    return { kind: result.kind }
  }
  if (result.kind === 'PASSWORD_SETUP_REQUIRED') {
    if (
      !exactKeys(result, ['kind', 'passwordSetupTicket', 'expiresAt'])
      || typeof result.passwordSetupTicket !== 'string'
      || result.passwordSetupTicket.length < 40
      || result.passwordSetupTicket.length > 512
      || !validTimestamp(result.expiresAt)
      || Date.parse(result.expiresAt) <= Date.now()
    ) throw new Error('Resposta de verificação inválida')
    return result as Extract<ConfirmationResult, { kind: 'PASSWORD_SETUP_REQUIRED' }>
  }
  throw new Error('Resposta de verificação inválida')
}

export function saveVerificationTiming(flow: VerificationFlow) {
  if (!validTimestamp(flow.expiresAt) || !validTimestamp(flow.resendAt)) {
    throw new Error('Fluxo de verificação inválido')
  }
  sessionStorage.setItem(flowKey(flow.verificationId), JSON.stringify({
    expiresAt: flow.expiresAt,
    resendAt: flow.resendAt,
  }))
}

export function loadVerificationTiming(verificationId: string): VerificationTiming | null {
  try {
    const raw = sessionStorage.getItem(flowKey(verificationId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as VerificationTiming
    return {
      expiresAt: validTimestamp(parsed.expiresAt) ? parsed.expiresAt : undefined,
      resendAt: validTimestamp(parsed.resendAt) ? parsed.resendAt : undefined,
    }
  } catch {
    return null
  }
}

export function deferVerificationResend(verificationId: string, resendAt: string) {
  if (!validTimestamp(resendAt)) return
  const current = loadVerificationTiming(verificationId) ?? {}
  sessionStorage.setItem(flowKey(verificationId), JSON.stringify({ ...current, resendAt }))
}

export function clearVerificationTiming(verificationId: string) {
  try {
    sessionStorage.removeItem(flowKey(verificationId))
  } catch {
    // invalid public flow IDs never become storage keys
  }
}

function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Persisted
    if (isActiveSession(saved)) return saved
    localStorage.removeItem(STORAGE_KEY)
    return null
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => {
    const saved = load()
    return {
      user: saved?.user ?? null,
      accessToken: saved?.accessToken ?? null,
      refreshToken: saved?.refreshToken ?? null,
      // Raw setup ticket is deliberately memory-only. Never persist this state.
      passwordSetupTicket: null as string | null,
      passwordSetupExpiresAt: null as string | null,
    }
  },
  getters: {
    isAuthenticated: (s) => Boolean(s.accessToken && s.user),
    role: (s) => s.user?.role ?? null,
  },
  actions: {
    persist() {
      if (this.user && this.accessToken && this.refreshToken) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ user: this.user, accessToken: this.accessToken, refreshToken: this.refreshToken }),
        )
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    },
    setSession(r: AuthResponse) {
      if (!isActiveSession(r)) throw new Error('Resposta de autenticação inválida')
      this.user = r.user
      this.accessToken = r.accessToken
      this.refreshToken = r.refreshToken
      this.persist()
    },
    clear() {
      this.user = null
      this.accessToken = null
      this.refreshToken = null
      this.clearPasswordSetup()
      this.persist()
    },
    clearPasswordSetup() {
      this.passwordSetupTicket = null
      this.passwordSetupExpiresAt = null
    },
    async login(email: string, password: string, turnstileToken?: string) {
      const r = await api<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, turnstileToken }) })
      this.setSession(r)
    },
    async registerCustomer(input: { name: string; phone?: string; email: string; password: string; acceptedTerms: boolean; turnstileToken: string }) {
      const flow = await api<VerificationFlow>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ ...input, phone: input.phone?.trim() || undefined, role: 'CUSTOMER' }),
      })
      saveVerificationTiming(flow)
      return flow
    },
    async confirmEmail(verificationId: string, code: string) {
      this.clearPasswordSetup()
      const result = assertConfirmationResult(await api<unknown>('/auth/verification/confirm', {
        method: 'POST', body: JSON.stringify({ verificationId, code }),
      }))
      if (result.kind === 'CUSTOMER_SESSION') {
        if (result.user.role !== 'CUSTOMER') {
          throw new Error('Resposta de autenticação inválida')
        }
        this.setSession(result)
      } else if (result.kind === 'PASSWORD_SETUP_REQUIRED') {
        this.passwordSetupTicket = result.passwordSetupTicket
        this.passwordSetupExpiresAt = result.expiresAt
      }
      clearVerificationTiming(verificationId)
      return result
    },
    async setupInitialPassword(newPassword: string): Promise<void> {
      const expiresAt = this.passwordSetupExpiresAt
        ? Date.parse(this.passwordSetupExpiresAt)
        : Number.NaN
      if (
        !this.passwordSetupTicket
        || !Number.isFinite(expiresAt)
        || expiresAt <= Date.now()
      ) {
        this.clearPasswordSetup()
        throw new Error('Fluxo inválido ou expirado.')
      }
      if (newPassword.length < 15 || newPassword.length > 128) {
        throw new Error('Senha deve ter de 15 a 128 caracteres.')
      }
      await api<void>('/auth/password-setup', {
        method: 'POST',
        body: JSON.stringify({
          passwordSetupTicket: this.passwordSetupTicket,
          newPassword,
        }),
      })
      this.clearPasswordSetup()
    },
    async resendEmail(verificationId: string, turnstileToken?: string) {
      const flow = await api<VerificationFlow>('/auth/verification/resend', {
        method: 'POST', body: JSON.stringify({ verificationId, turnstileToken }),
      })
      saveVerificationTiming(flow)
      return flow
    },
    async updateContactPhone(phone: string | null) {
      if (!this.user || this.user.role !== 'CUSTOMER') throw new Error('Sessão de cliente necessária')
      const response = await api<{ phone: string | null }>('/auth/me/contact', {
        method: 'PATCH',
        body: JSON.stringify({ phone }),
      })
      this.user = { ...this.user, phone: response.phone }
      this.persist()
      return response.phone
    },
    async tryRefresh(): Promise<boolean> {
      if (!this.refreshToken) return false
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = (async () => {
        try {
          const r = await api<AuthResponse>('/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken: this.refreshToken }),
          })
          this.setSession(r)
          return true
        } catch {
          this.clear()
          return false
        } finally {
          refreshInFlight = null
        }
      })()
      return refreshInFlight
    },
    async logout() {
      const rt = this.refreshToken
      this.clear()
      if (rt) await api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: rt }) }).catch(() => {})
    },
  },
})

/** Liga o store ao api client (chamar 1x no main.ts após createPinia). */
export function wireAuthToApi() {
  const store = useAuthStore()
  setTokenProvider({ getAccessToken: () => store.accessToken, tryRefresh: () => store.tryRefresh() })
}

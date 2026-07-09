import { defineStore } from 'pinia'
import { api, setTokenProvider } from '../lib/api'

export type SessionUser = {
  id: string
  name: string
  role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'
  status: 'ACTIVE' | 'PENDING' | 'BLOCKED'
  phone: string | null
  email: string | null
}

type AuthResponse = { user: SessionUser; accessToken: string | null; refreshToken: string | null }

const STORAGE_KEY = 'delivery.driver.auth'
type Persisted = { user: SessionUser; accessToken: string; refreshToken: string }

/** Single-flight: só um refresh em voo; 401s paralelos aguardam a mesma promise. */
let refreshInFlight: Promise<boolean> | null = null

function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Persisted) : null
  } catch {
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
      this.user = r.user
      this.accessToken = r.accessToken
      this.refreshToken = r.refreshToken
      this.persist()
    },
    clear() {
      this.user = null
      this.accessToken = null
      this.refreshToken = null
      this.persist()
    },
    async login(identifier: string, password: string) {
      const r = await api<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) })
      this.setSession(r)
    },
    async register(input: { name: string; phone: string; email?: string; password: string; acceptedTerms: boolean; role?: 'CUSTOMER' | 'DRIVER' }) {
      const r = await api<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify(input) })
      if (r.accessToken) this.setSession(r)
      return r.user
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

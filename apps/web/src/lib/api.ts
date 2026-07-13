/** Fetch wrapper: baseURL + bearer + refresh-on-401 (uma tentativa). */
export type ApiError = { status: number; message: string; code?: string; retryAfter?: number }

type TokenProvider = {
  getAccessToken: () => string | null
  tryRefresh: () => Promise<boolean>
}

let tokenProvider: TokenProvider | null = null
export function setTokenProvider(p: TokenProvider) {
  tokenProvider = p
}

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const access = tokenProvider?.getAccessToken()
  if (access) headers.set('Authorization', `Bearer ${access}`)

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  })

  if (res.status === 401 && !retried && tokenProvider && !path.startsWith('/auth/')) {
    const ok = await tokenProvider.tryRefresh()
    if (ok) return api<T>(path, init, true)
  }

  if (res.status === 204) return undefined as T
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    code?: string
    issues?: Array<{ message?: string; path?: Array<string | number> }>
  }
  if (!res.ok) {
    const issue = body.issues?.[0]
    const field = issue?.path?.length ? `${issue.path.join('.')}: ` : ''
    const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '', 10)
    const err: ApiError = {
      status: res.status,
      message: issue?.message ? `${field}${issue.message}` : body.error ?? 'Erro inesperado',
      code: body.code,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    }
    throw Object.assign(new Error(err.message), err)
  }
  return body as T
}

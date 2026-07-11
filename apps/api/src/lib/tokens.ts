import { sign } from 'hono/jwt'

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_DAYS = 30
export const TOKEN_ISSUER = 'delivery-api'
export const TOKEN_AUDIENCE = 'delivery-clients'

export type AccessTokenPayload = {
  sub: string
  role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'
  name: string
  ver: number
  sid: string
  jti: string
  iss: typeof TOKEN_ISSUER
  aud: typeof TOKEN_AUDIENCE
  iat: number
  nbf: number
  exp: number
}

export type AccessPrincipal = Pick<AccessTokenPayload, 'sub' | 'role' | 'name'> & {
  tokenVersion?: number
}

export async function signAccessToken(
  p: AccessPrincipal,
  secret: string,
  familyId: string = crypto.randomUUID(),
  from = new Date(),
): Promise<string> {
  const now = Math.floor(from.getTime() / 1000)
  return sign({
    sub: p.sub,
    role: p.role,
    name: p.name,
    ver: p.tokenVersion ?? 0,
    sid: familyId,
    jti: crypto.randomUUID(),
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    iat: now,
    nbf: now,
    exp: now + ACCESS_TTL_SECONDS,
  }, secret)
}

function toB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function generateRefreshToken(): Promise<{ token: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const token = toB64url(raw)
  return { token, hash: await hashToken(token) }
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return toB64url(new Uint8Array(digest))
}

export function refreshExpiry(from = new Date()): Date {
  return new Date(from.getTime() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000)
}

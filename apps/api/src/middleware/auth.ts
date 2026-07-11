import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { verify } from 'hono/jwt'
import type { AppContext } from '../env'
import type { AccessTokenPayload } from '../lib/tokens'
import { PrincipalError, resolveLivePrincipal } from '../services/security-session.service'

const ROLES = new Set<AccessTokenPayload['role']>(['CUSTOMER', 'STORE', 'DRIVER', 'ADMIN'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isCurrentPayload(payload: unknown, now: number): payload is AccessTokenPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  return typeof p.sub === 'string'
    && ROLES.has(p.role as AccessTokenPayload['role'])
    && typeof p.name === 'string'
    && Number.isInteger(p.ver)
    && typeof p.sid === 'string' && UUID.test(p.sid)
    && typeof p.jti === 'string' && UUID.test(p.jti)
    && p.iss === 'delivery-api'
    && p.aud === 'delivery-clients'
    && Number.isInteger(p.iat)
    && Number.isInteger(p.nbf) && Number(p.nbf) <= now
    && Number.isInteger(p.exp)
}

export const authMiddleware = createMiddleware<AppContext>(async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) throw new HTTPException(401, { message: 'Não autenticado' })
  try {
    const payload = await verify(header.slice(7), c.env.JWT_SECRET, 'HS256')
    if (!isCurrentPayload(payload, Math.floor(Date.now() / 1000))) {
      throw new PrincipalError('INVALID', 401)
    }
    c.set('auth', await resolveLivePrincipal(c.get('db'), payload))
  } catch (error) {
    if (error instanceof PrincipalError && error.status === 403) {
      const message = error.code === 'ACCOUNT_BLOCKED' ? 'Conta bloqueada' : 'Loja suspensa ou encerrada'
      throw new HTTPException(403, { message })
    }
    throw new HTTPException(401, { message: 'Sessão inválida ou expirada' })
  }
  await next()
})

export function requireRole(...roles: AccessTokenPayload['role'][]) {
  return createMiddleware<AppContext>(async (c, next) => {
    const auth = c.get('auth')
    if (!auth) throw new HTTPException(401, { message: 'Não autenticado' })
    if (!roles.includes(auth.role)) throw new HTTPException(403, { message: 'Sem permissão' })
    await next()
  })
}

import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { verify } from 'hono/jwt'
import type { AppContext } from '../env'
import type { AccessTokenPayload } from '../lib/tokens'

export const authMiddleware = createMiddleware<AppContext>(async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) throw new HTTPException(401, { message: 'Não autenticado' })
  try {
    const payload = (await verify(header.slice(7), c.env.JWT_SECRET, 'HS256')) as AccessTokenPayload & { exp: number }
    c.set('auth', payload)
  } catch {
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

import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { LoginSchema, RefreshSchema, RegisterSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware } from '../middleware/auth'
import {
  AuthError,
  loginUser,
  registerUser,
  rotateRefreshToken,
} from '../services/auth.service'
import { revokeAllSessions, revokeSessionFamily } from '../services/security-session.service'

export const authRoutes = createRouter()

const UserShape = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['CUSTOMER', 'STORE', 'DRIVER', 'ADMIN']),
  status: z.enum(['ACTIVE', 'PENDING', 'BLOCKED']),
  phone: z.string().nullable(),
  email: z.string().nullable(),
})
const TokenResponse = z.object({
  user: UserShape,
  accessToken: z.string().nullable(),
  refreshToken: z.string().nullable(),
})

function rethrow(e: unknown): never {
  if (e instanceof AuthError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/register',
    request: { body: { content: { 'application/json': { schema: RegisterSchema } } } },
    responses: { 201: { description: 'Criado', content: { 'application/json': { schema: TokenResponse } } } },
  }),
  async (c) => {
    const result = await registerUser(c.get('db'), c.req.valid('json'), c.env.JWT_SECRET).catch(rethrow)
    return c.json(result, 201)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/login',
    request: { body: { content: { 'application/json': { schema: LoginSchema } } } },
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: TokenResponse } } } },
  }),
  async (c) => {
    const result = await loginUser(c.get('db'), c.req.valid('json'), c.env.JWT_SECRET).catch(rethrow)
    return c.json(result, 200)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/refresh',
    request: { body: { content: { 'application/json': { schema: RefreshSchema } } } },
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: TokenResponse } } } },
  }),
  async (c) => {
    const { refreshToken } = c.req.valid('json')
    const result = await rotateRefreshToken(c.get('db'), refreshToken, c.env.JWT_SECRET).catch(rethrow)
    return c.json(result, 200)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/logout',
    middleware: [authMiddleware] as const,
    responses: { 204: { description: 'Sessão encerrada' } },
  }),
  async (c) => {
    await revokeSessionFamily(c.get('db'), c.get('auth')!.sessionFamilyId)
    return c.body(null, 204)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/logout-all',
    middleware: [authMiddleware] as const,
    responses: { 204: { description: 'Todas as sessões encerradas' } },
  }),
  async (c) => {
    await revokeAllSessions(c.get('db'), c.get('auth')!.sub)
    return c.body(null, 204)
  },
)

authRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/auth/me',
    middleware: [authMiddleware] as const,
    responses: {
      200: {
        description: 'Usuário atual',
        content: { 'application/json': { schema: z.object({ sub: z.string(), role: z.string(), name: z.string() }) } },
      },
    },
  }),
  (c) => {
    const auth = c.get('auth')!
    return c.json({ sub: auth.sub, role: auth.role, name: auth.name }, 200)
  },
)

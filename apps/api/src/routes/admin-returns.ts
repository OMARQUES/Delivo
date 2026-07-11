import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../app-factory'
import { authMiddleware, requireRole } from '../middleware/auth'
import {
  adminConfirmOrderReturn, listPendingReturns, ReturnError,
} from '../services/return.service'

export const adminReturnRoutes = createRouter()
adminReturnRoutes.use('/admin/*', authMiddleware, requireRole('ADMIN'))

const Out = z.object({}).passthrough()
const IdParam = z.object({ id: z.uuid() })
function rethrow(error: unknown): never {
  if (error instanceof ReturnError) throw new HTTPException(error.status, { message: error.message })
  throw error
}

adminReturnRoutes.openapi(createRoute({
  method: 'get', path: '/admin/returns',
  responses: { 200: { description: 'Devoluções pendentes', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listPendingReturns(c.get('db')), 200))

adminReturnRoutes.openapi(createRoute({
  method: 'post', path: '/admin/orders/{id}/confirm-return', request: { params: IdParam },
  responses: { 200: { description: 'Devolução confirmada', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await adminConfirmOrderReturn(
  c.get('db'), c.req.valid('param').id, c.get('auth')!.sub,
).catch(rethrow), 200))

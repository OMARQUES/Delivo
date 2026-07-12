import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { desc, eq } from 'drizzle-orm'
import { createRouter } from '../app-factory'
import { drivers, users } from '../db/schema'
import { authMiddleware, requireRole } from '../middleware/auth'
import { DriverAccountStatusError, setDriverAccountStatus } from '../services/security-session.service'

export const adminDriverRoutes = createRouter()

adminDriverRoutes.use('/admin/*', authMiddleware, requireRole('ADMIN'))

const Out = z.object({}).passthrough()

adminDriverRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/drivers',
    responses: { 200: { description: 'Entregadores', content: { 'application/json': { schema: z.array(Out) } } } },
  }),
  async (c) => {
    const rows = await c.get('db')
      .select({
        id: users.id,
        name: users.name,
        phone: users.phone,
        status: users.status,
        createdAt: users.createdAt,
        isAvailable: drivers.isAvailable,
      })
      .from(users)
      .leftJoin(drivers, eq(drivers.userId, users.id))
      .where(eq(users.role, 'DRIVER'))
      .orderBy(desc(users.createdAt))
    return c.json(rows.map((r) => ({ ...r, isAvailable: r.isAvailable ?? false })), 200)
  },
)

adminDriverRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/admin/drivers/{id}/status',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: z.object({ status: z.enum(['ACTIVE', 'BLOCKED']) }) } } },
    },
    responses: { 200: { description: 'Atualizado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { status } = c.req.valid('json')
    const updated = await setDriverAccountStatus(c.get('db'), id, status).catch((error) => {
      if (error instanceof DriverAccountStatusError) {
        throw new HTTPException(error.status, { message: error.message })
      }
      throw error
    })
    if (!updated) throw new HTTPException(404, { message: 'Entregador não encontrado' })
    return c.json(updated, 200)
  },
)

import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { eq } from 'drizzle-orm'
import { StoreCreateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { stores } from '../db/schema'
import { authMiddleware, requireRole } from '../middleware/auth'
import { importCsvCatalog } from '../services/catalog.service'
import {
  listAllStores, setStoreCommission, setStoreSecurityStatus, StoreError,
} from '../services/store.service'
import { provisionStoreWithOwner } from '../services/store-provisioning.service'
import { EMAIL_DELIVERY_UNAVAILABLE_MESSAGE, SecurityHttpError } from '../security/http'

export const adminStoreRoutes = createRouter()

adminStoreRoutes.use('/admin/*', authMiddleware, requireRole('ADMIN'))

function rethrow(e: unknown): never {
  if (e instanceof StoreError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const StoreOut = z.object({
  id: z.string(), slug: z.string(), name: z.string(),
  securityStatus: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED', 'PENDING_ACTIVATION']),
}).passthrough()

adminStoreRoutes.openapi(
  createRoute({
    method: 'post', path: '/admin/stores',
    request: { body: { content: { 'application/json': { schema: StoreCreateSchema } } } },
    responses: { 201: { description: 'Loja criada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const authCodeSecret = c.env.AUTH_CODE_SECRET?.trim()
    if (!authCodeSecret) {
      throw new SecurityHttpError(503, 'EMAIL_DELIVERY_UNAVAILABLE', EMAIL_DELIVERY_UNAVAILABLE_MESSAGE)
    }
    const result = await provisionStoreWithOwner(c.get('db'), c.req.valid('json'), {
      authCodeSecret,
      jwtSecret: c.env.JWT_SECRET,
      requestId: c.get('requestId'),
    }).catch(rethrow)
    return c.json(result.store, 201)
  },
)

adminStoreRoutes.openapi(
  createRoute({
    method: 'get', path: '/admin/stores',
    responses: { 200: { description: 'Todas as lojas', content: { 'application/json': { schema: z.array(StoreOut) } } } },
  }),
  async (c) => c.json(await listAllStores(c.get('db')), 200),
)

adminStoreRoutes.openapi(
  createRoute({
    method: 'patch', path: '/admin/stores/{id}/security-status',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: z.object({ securityStatus: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) }) } } },
    },
    responses: { 200: { description: 'Atualizada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { securityStatus } = c.req.valid('json')
    const store = await setStoreSecurityStatus(c.get('db'), id, securityStatus).catch(rethrow)
    return c.json(store, 200)
  },
)

adminStoreRoutes.openapi(
  createRoute({
    method: 'patch', path: '/admin/stores/{id}/commission',
    request: {
      params: z.object({ id: z.uuid() }),
      // basis points: 0..10000 = 0%..100%
      body: { content: { 'application/json': { schema: z.object({ commissionBps: z.number().int().min(0).max(10_000) }) } } },
    },
    responses: { 200: { description: 'Comissão atualizada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { commissionBps } = c.req.valid('json')
    const store = await setStoreCommission(c.get('db'), id, commissionBps).catch(rethrow)
    return c.json(store, 200)
  },
)

const MAX_CSV_LINES = 2000

adminStoreRoutes.post('/admin/stores/:id/catalog/import', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new HTTPException(400, { message: 'ID inválido' })
  const [store] = await c.get('db').select({ id: stores.id }).from(stores).where(eq(stores.id, id))
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  const csv = await c.req.text()
  if (!csv.trim()) throw new HTTPException(400, { message: 'CSV vazio' })
  if (csv.split(/\r?\n/).length > MAX_CSV_LINES)
    throw new HTTPException(400, { message: `CSV acima de ${MAX_CSV_LINES} linhas — divida o arquivo` })
  const result = await importCsvCatalog(c.get('db'), id, csv)
  return c.json(result, 200)
})

import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { eq } from 'drizzle-orm'
import { StoreCreateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { stores } from '../db/schema'
import { authMiddleware, requireRole } from '../middleware/auth'
import { importCsvCatalog } from '../services/catalog.service'
import {
  createStoreWithOwner, listAllStores, setStoreActive, StoreError,
} from '../services/store.service'

export const adminStoreRoutes = createRouter()

adminStoreRoutes.use('/admin/*', authMiddleware, requireRole('ADMIN'))

function rethrow(e: unknown): never {
  if (e instanceof StoreError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const StoreOut = z.object({ id: z.string(), slug: z.string(), name: z.string(), isActive: z.boolean() }).passthrough()

adminStoreRoutes.openapi(
  createRoute({
    method: 'post', path: '/admin/stores',
    request: { body: { content: { 'application/json': { schema: StoreCreateSchema } } } },
    responses: { 201: { description: 'Loja criada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const store = await createStoreWithOwner(c.get('db'), c.req.valid('json')).catch(rethrow)
    return c.json(store, 201)
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
    method: 'patch', path: '/admin/stores/{id}/active',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: z.object({ isActive: z.boolean() }) } } },
    },
    responses: { 200: { description: 'Atualizada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { isActive } = c.req.valid('json')
    const store = await setStoreActive(c.get('db'), id, isActive).catch(rethrow)
    return c.json(store, 200)
  },
)

adminStoreRoutes.post('/admin/stores/:id/catalog/import', async (c) => {
  const id = c.req.param('id')
  const [store] = await c.get('db').select({ id: stores.id }).from(stores).where(eq(stores.id, id))
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  const csv = await c.req.text()
  if (!csv.trim()) throw new HTTPException(400, { message: 'CSV vazio' })
  const result = await importCsvCatalog(c.get('db'), id, csv)
  return c.json(result, 200)
})

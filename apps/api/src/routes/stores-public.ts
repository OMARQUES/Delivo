import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../app-factory'
import { getStoreBySlug, listPublicStores } from '../services/store.service'

export const publicStoreRoutes = createRouter()

const PublicStore = z.object({ id: z.string(), slug: z.string(), name: z.string(), isOpen: z.boolean() }).passthrough()

publicStoreRoutes.openapi(
  createRoute({
    method: 'get', path: '/stores',
    responses: { 200: { description: 'Lojas ativas', content: { 'application/json': { schema: z.array(PublicStore) } } } },
  }),
  async (c) => c.json(await listPublicStores(c.get('db')), 200),
)

publicStoreRoutes.openapi(
  createRoute({
    method: 'get', path: '/stores/{slug}',
    request: { params: z.object({ slug: z.string().min(1).max(60) }) },
    responses: { 200: { description: 'Loja', content: { 'application/json': { schema: PublicStore } } } },
  }),
  async (c) => {
    const store = await getStoreBySlug(c.get('db'), c.req.valid('param').slug)
    if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
    return c.json(store, 200)
  },
)

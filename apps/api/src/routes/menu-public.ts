import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../app-factory'
import { getPublicMenu, searchProducts } from '../services/catalog.service'

export const menuPublicRoutes = createRouter()

menuPublicRoutes.openapi(
  createRoute({ method: 'get', path: '/stores/{slug}/menu',
    request: { params: z.object({ slug: z.string().min(1).max(60) }) },
    responses: { 200: { description: 'Cardápio', content: { 'application/json': { schema: z.object({ categories: z.array(z.object({}).passthrough()) }) } } } } }),
  async (c) => {
    const menu = await getPublicMenu(c.get('db'), c.req.valid('param').slug)
    if (!menu) throw new HTTPException(404, { message: 'Loja não encontrada' })
    return c.json(menu, 200)
  },
)

menuPublicRoutes.openapi(
  createRoute({ method: 'get', path: '/search',
    request: { query: z.object({ q: z.string().max(80).default('') }) },
    responses: { 200: { description: 'Resultados por loja', content: { 'application/json': { schema: z.array(z.object({}).passthrough()) } } } } }),
  async (c) => c.json(await searchProducts(c.get('db'), c.req.valid('query').q), 200),
)

import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { StoreUpdateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware, requireRole } from '../middleware/auth'
import { getStoreByOwner, setStoreLogo, updateStore, StoreError } from '../services/store.service'

export const storeMeRoutes = createRouter()

storeMeRoutes.use('/store/*', authMiddleware, requireRole('STORE'))

function rethrow(e: unknown): never {
  if (e instanceof StoreError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const StoreOut = z.object({ id: z.string(), slug: z.string(), name: z.string() }).passthrough()

storeMeRoutes.openapi(
  createRoute({
    method: 'get', path: '/store/me',
    responses: { 200: { description: 'Minha loja', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
    if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
    return c.json(store, 200)
  },
)

storeMeRoutes.openapi(
  createRoute({
    method: 'patch', path: '/store/me',
    request: { body: { content: { 'application/json': { schema: StoreUpdateSchema } } } },
    responses: { 200: { description: 'Atualizada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
    if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
    const updated = await updateStore(c.get('db'), store.id, c.req.valid('json')).catch(rethrow)
    return c.json(updated, 200)
  },
)

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_LOGO_BYTES = 2 * 1024 * 1024

storeMeRoutes.put('/store/me/logo', async (c) => {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  const type = c.req.header('Content-Type') ?? ''
  if (!IMAGE_TYPES.includes(type)) throw new HTTPException(400, { message: 'Envie png, jpeg ou webp' })
  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0 || body.byteLength > MAX_LOGO_BYTES)
    throw new HTTPException(400, { message: 'Imagem vazia ou maior que 2MB' })
  const ext = type.split('/')[1]
  const key = `logos/${crypto.randomUUID()}.${ext}`
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: type } })
  await setStoreLogo(c.get('db'), store.id, key).catch(rethrow)
  return c.json({ logoKey: key }, 200)
})

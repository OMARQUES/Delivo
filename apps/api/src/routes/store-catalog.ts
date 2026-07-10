import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import {
  CategorySchema,
  OptionUpdateSchema,
  OptionsTreeSchema,
  ProductSchema,
  ProductUpdateSchema,
} from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware, requireRole } from '../middleware/auth'
import { getStoreByOwner, StoreError } from '../services/store.service'
import {
  CatalogError, createCategory, createProduct, deleteCategory, deleteProduct,
  getStoreCatalog, replaceProductOptions, setProductPhoto, updateCategory, updateOption, updateProduct,
} from '../services/catalog.service'
import type { AppContext } from '../env'
import type { Context } from 'hono'

export const storeCatalogRoutes = createRouter()

storeCatalogRoutes.use('/store/*', authMiddleware, requireRole('STORE'))

function rethrow(e: unknown): never {
  if (e instanceof CatalogError || e instanceof StoreError)
    throw new HTTPException(e.status, { message: e.message })
  throw e
}

async function ownStoreId(c: Context<AppContext>): Promise<string> {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  return store.id
}

const IdParam = z.object({ id: z.uuid() })
const Out = z.object({ id: z.string() }).passthrough()

storeCatalogRoutes.openapi(
  createRoute({ method: 'get', path: '/store/me/catalog',
    responses: { 200: { description: 'Catálogo aninhado', content: { 'application/json': { schema: z.array(Out) } } } } }),
  async (c) => c.json(await getStoreCatalog(c.get('db'), await ownStoreId(c)), 200),
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'post', path: '/store/me/categories',
    request: { body: { content: { 'application/json': { schema: CategorySchema } } } },
    responses: { 201: { description: 'Criada', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await createCategory(c.get('db'), await ownStoreId(c), c.req.valid('json')).catch(rethrow), 201),
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'patch', path: '/store/me/categories/{id}',
    request: { params: IdParam, body: { content: { 'application/json': { schema: CategorySchema.partial().extend({ sortIndex: z.number().int().min(0).optional() }) } } } },
    responses: { 200: { description: 'Atualizada', content: { 'application/json': { schema: Out } } } } }),
  async (c) => {
    const body = c.req.valid('json')
    if (Object.keys(body).length === 0) throw new HTTPException(400, { message: 'Nada para atualizar' })
    const row = await updateCategory(c.get('db'), await ownStoreId(c), c.req.valid('param').id, body as { name: string; sortIndex?: number }).catch(rethrow)
    return c.json(row, 200)
  },
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'delete', path: '/store/me/categories/{id}',
    request: { params: IdParam },
    responses: { 204: { description: 'Removida' } } }),
  async (c) => {
    await deleteCategory(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow)
    return c.body(null, 204)
  },
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'post', path: '/store/me/products',
    request: { body: { content: { 'application/json': { schema: ProductSchema } } } },
    responses: { 201: { description: 'Criado', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await createProduct(c.get('db'), await ownStoreId(c), c.req.valid('json')).catch(rethrow), 201),
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'patch', path: '/store/me/products/{id}',
    request: { params: IdParam, body: { content: { 'application/json': { schema: ProductUpdateSchema } } } },
    responses: { 200: { description: 'Atualizado', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await updateProduct(c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json')).catch(rethrow), 200),
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'delete', path: '/store/me/products/{id}',
    request: { params: IdParam },
    responses: { 204: { description: 'Removido' } } }),
  async (c) => {
    await deleteProduct(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow)
    return c.body(null, 204)
  },
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'put', path: '/store/me/products/{id}/options',
    request: { params: IdParam, body: { content: { 'application/json': { schema: OptionsTreeSchema } } } },
    responses: { 200: { description: 'Árvore substituída', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } } }),
  async (c) => {
    await replaceProductOptions(c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json')).catch(rethrow)
    return c.json({ ok: true }, 200)
  },
)

storeCatalogRoutes.openapi(
  createRoute({ method: 'patch', path: '/store/me/options/{id}',
    request: { params: IdParam, body: { content: { 'application/json': { schema: OptionUpdateSchema } } } },
    responses: { 200: { description: 'Opção atualizada', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(
    await updateOption(c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json')).catch(rethrow),
    200,
  ),
)

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_PHOTO_BYTES = 2 * 1024 * 1024

storeCatalogRoutes.put('/store/me/products/:id/photo', async (c) => {
  const storeId = await ownStoreId(c)
  const id = c.req.param('id')
  const type = c.req.header('Content-Type') ?? ''
  if (!IMAGE_TYPES.includes(type)) throw new HTTPException(400, { message: 'Envie png, jpeg ou webp' })
  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0 || body.byteLength > MAX_PHOTO_BYTES)
    throw new HTTPException(400, { message: 'Imagem vazia ou maior que 2MB' })
  const key = `products/${crypto.randomUUID()}.${type.split('/')[1]}`
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: type } })
  await setProductPhoto(c.get('db'), storeId, id, key).catch(rethrow)
  return c.json({ photoKey: key }, 200)
})

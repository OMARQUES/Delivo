import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { AddressSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware } from '../middleware/auth'
import { createAddress, deleteAddress, listAddresses } from '../services/address.service'

export const addressRoutes = createRouter()

addressRoutes.use('/me/*', authMiddleware)

const Out = z.object({ id: z.string() }).passthrough()

addressRoutes.openapi(
  createRoute({ method: 'get', path: '/me/addresses',
    responses: { 200: { description: 'Endereços', content: { 'application/json': { schema: z.array(Out) } } } } }),
  async (c) => c.json(await listAddresses(c.get('db'), c.get('auth')!.sub), 200),
)

addressRoutes.openapi(
  createRoute({ method: 'post', path: '/me/addresses',
    request: { body: { content: { 'application/json': { schema: AddressSchema } } } },
    responses: { 201: { description: 'Criado', content: { 'application/json': { schema: Out } } } } }),
  async (c) => c.json(await createAddress(c.get('db'), c.get('auth')!.sub, c.req.valid('json')), 201),
)

addressRoutes.openapi(
  createRoute({ method: 'delete', path: '/me/addresses/{id}',
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 204: { description: 'Removido' } } }),
  async (c) => {
    const ok = await deleteAddress(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id)
    if (!ok) throw new HTTPException(404, { message: 'Endereço não encontrado' })
    return c.body(null, 204)
  },
)

import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { AvailabilitySchema, DeliveryFailSchema, FcmTokenSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware, requireRole } from '../middleware/auth'
import {
  DispatchError,
  acceptDelivery,
  collectDelivery,
  completeDelivery,
  ensureDriverProfile,
  failDelivery,
  listAvailableDeliveries,
  listDriverDeliveries,
  releaseDelivery,
  setAvailability,
  setFcmToken,
} from '../services/dispatch.service'

export const driverRoutes = createRouter()

driverRoutes.use('/driver/*', authMiddleware, requireRole('DRIVER'))

function rethrow(e: unknown): never {
  if (e instanceof DispatchError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const Out = z.object({}).passthrough()
const IdParam = z.object({ id: z.uuid() })

driverRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/driver/me',
    responses: { 200: { description: 'Perfil', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await ensureDriverProfile(c.get('db'), c.get('auth')!.sub), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/driver/me/availability',
    request: { body: { content: { 'application/json': { schema: AvailabilitySchema } } } },
    responses: { 200: { description: 'Atualizado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await setAvailability(c.get('db'), c.get('auth')!.sub, c.req.valid('json').isAvailable), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/me/fcm-token',
    request: { body: { content: { 'application/json': { schema: FcmTokenSchema } } } },
    responses: { 200: { description: 'Salvo', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await setFcmToken(c.get('db'), c.get('auth')!.sub, c.req.valid('json').token), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/driver/available',
    responses: { 200: { description: 'Entregas disponíveis', content: { 'application/json': { schema: z.array(Out) } } } },
  }),
  async (c) => c.json(await listAvailableDeliveries(c.get('db')), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/driver/deliveries',
    request: { query: z.object({ scope: z.enum(['active', 'done']).default('active') }) },
    responses: { 200: { description: 'Minhas entregas', content: { 'application/json': { schema: z.array(Out) } } } },
  }),
  async (c) => c.json(await listDriverDeliveries(c.get('db'), c.get('auth')!.sub, c.req.valid('query').scope), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/orders/{id}/accept',
    request: { params: IdParam },
    responses: { 200: { description: 'Aceita', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await acceptDelivery(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/orders/{id}/release',
    request: { params: IdParam },
    responses: { 200: { description: 'Liberada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await releaseDelivery(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/orders/{id}/collect',
    request: { params: IdParam },
    responses: { 200: { description: 'Coletada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await collectDelivery(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/orders/{id}/deliver',
    request: { params: IdParam },
    responses: { 200: { description: 'Entregue', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await completeDelivery(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/orders/{id}/fail',
    request: { params: IdParam, body: { content: { 'application/json': { schema: DeliveryFailSchema } } } },
    responses: { 200: { description: 'Falha registrada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(await failDelivery(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id, c.req.valid('json')).catch(rethrow), 200),
)

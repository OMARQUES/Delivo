import type { Context } from 'hono'
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { eq } from 'drizzle-orm'
import { StatusUpdateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { stores } from '../db/schema'
import type { AppContext } from '../env'
import { sendPushToTokens } from '../lib/fcm'
import { authMiddleware, requireRole } from '../middleware/auth'
import { getStoreOrder, listStoreOrders, OrderError } from '../services/order.service'
import { listAvailableDriverTokens, requestDriver, storeResolveCancelRequest, storeUpdateOrderStatus } from '../services/order-status.service'
import { getStoreByOwner } from '../services/store.service'

export const storeOrderRoutes = createRouter()

storeOrderRoutes.use('/store/*', authMiddleware, requireRole('STORE'))

function rethrow(e: unknown): never {
  if (e instanceof OrderError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

async function ownStoreId(c: Context<AppContext>): Promise<string> {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  return store.id
}

const Out = z.object({ id: z.string() }).passthrough()
const IdParam = z.object({ id: z.uuid() })

storeOrderRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/store/me/orders',
    request: { query: z.object({ scope: z.enum(['active', 'done']).default('active') }) },
    responses: { 200: { description: 'Fila', content: { 'application/json': { schema: z.array(Out) } } } },
  }),
  async (c) => c.json(await listStoreOrders(c.get('db'), await ownStoreId(c), c.req.valid('query').scope), 200),
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/store/me/orders/{id}',
    request: { params: IdParam },
    responses: { 200: { description: 'Detalhe', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const order = await getStoreOrder(c.get('db'), await ownStoreId(c), c.req.valid('param').id)
    if (!order) throw new HTTPException(404, { message: 'Pedido não encontrado' })
    return c.json(order, 200)
  },
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/store/me/orders/{id}/status',
    request: { params: IdParam, body: { content: { 'application/json': { schema: StatusUpdateSchema } } } },
    responses: { 200: { description: 'Atualizado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const { to, reason } = c.req.valid('json')
    const order = await storeUpdateOrderStatus(
      c.get('db'),
      await ownStoreId(c),
      c.req.valid('param').id,
      to,
      c.get('auth')!.sub,
      reason,
    ).catch(rethrow)
    return c.json(order, 200)
  },
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/store/me/orders/{id}/request-driver',
    request: { params: IdParam },
    responses: { 200: { description: 'Entregador solicitado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const db = c.get('db')
    const order = await requestDriver(db, await ownStoreId(c), c.req.valid('param').id).catch(rethrow)
    const [store] = await db.select({ name: stores.name }).from(stores).where(eq(stores.id, order.storeId))
    const tokens = await listAvailableDriverTokens(db)
    const push = sendPushToTokens(
      c.env.FIREBASE_PROJECT_ID,
      c.env.FIREBASE_SERVICE_ACCOUNT,
      tokens,
      { title: 'Nova entrega disponível! 🛵', body: store?.name ?? 'Uma loja', data: { orderId: order.id } },
    )
    try {
      c.executionCtx.waitUntil(push)
    } catch {
      await push
    }
    return c.json(order, 200)
  },
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/store/me/orders/{id}/cancel-request/approve',
    request: { params: IdParam },
    responses: { 200: { description: 'Cancelado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(
      await storeResolveCancelRequest(c.get('db'), await ownStoreId(c), c.req.valid('param').id, true, c.get('auth')!.sub).catch(rethrow),
      200,
    ),
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/store/me/orders/{id}/cancel-request/deny',
    request: { params: IdParam },
    responses: { 200: { description: 'Negado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(
      await storeResolveCancelRequest(c.get('db'), await ownStoreId(c), c.req.valid('param').id, false, c.get('auth')!.sub).catch(rethrow),
      200,
    ),
)

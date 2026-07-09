import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { CancelRequestSchema, CheckoutSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware } from '../middleware/auth'
import {
  OrderError,
  createOrder,
  getCustomerOrder,
  listCustomerOrders,
  quoteOrder,
} from '../services/order.service'
import { customerCancelOrder, customerRequestCancel } from '../services/order-status.service'

export const orderRoutes = createRouter()

orderRoutes.use('/orders/*', authMiddleware)
orderRoutes.use('/orders', authMiddleware)

function rethrow(e: unknown): never {
  if (e instanceof OrderError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const Out = z.object({ id: z.string() }).passthrough()
const IdParam = z.object({ id: z.uuid() })

orderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders/quote',
    request: { body: { content: { 'application/json': { schema: CheckoutSchema } } } },
    responses: { 200: { description: 'Cotação', content: { 'application/json': { schema: z.object({ totalCents: z.number() }).passthrough() } } } },
  }),
  async (c) => c.json(await quoteOrder(c.get('db'), c.get('auth')!.sub, c.req.valid('json')).catch(rethrow), 200),
)

orderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders',
    request: { body: { content: { 'application/json': { schema: CheckoutSchema } } } },
    responses: { 201: { description: 'Pedido criado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await createOrder(c.get('db'), c.get('auth')!.sub, c.req.valid('json')).catch(rethrow), 201),
)

orderRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/orders',
    responses: { 200: { description: 'Meus pedidos', content: { 'application/json': { schema: z.array(Out) } } } },
  }),
  async (c) => c.json(await listCustomerOrders(c.get('db'), c.get('auth')!.sub), 200),
)

orderRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/orders/{id}',
    request: { params: IdParam },
    responses: { 200: { description: 'Detalhe', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const order = await getCustomerOrder(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id)
    if (!order) throw new HTTPException(404, { message: 'Pedido não encontrado' })
    return c.json(order, 200)
  },
)

orderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders/{id}/cancel',
    request: { params: IdParam },
    responses: { 200: { description: 'Cancelado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(await customerCancelOrder(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)

orderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders/{id}/cancel-request',
    request: { params: IdParam, body: { content: { 'application/json': { schema: CancelRequestSchema } } } },
    responses: { 200: { description: 'Solicitado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(
      await customerRequestCancel(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id, c.req.valid('json').note).catch(rethrow),
      200,
    ),
)

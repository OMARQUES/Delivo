import { createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { CancelRequestSchema, CheckoutSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { users } from '../db/schema'
import { createPaymentProvider } from '../lib/mercadopago'
import { authMiddleware } from '../middleware/auth'
import {
  OrderError,
  createOrder,
  getCustomerOrder,
  listCustomerOrders,
  quoteOrder,
} from '../services/order.service'
import { customerCancelOrder, customerRequestCancel } from '../services/order-status.service'
import { PaymentError } from '../services/payment.service'

export const orderRoutes = createRouter()

orderRoutes.use('/orders/*', authMiddleware)
orderRoutes.use('/orders', authMiddleware)

function rethrow(e: unknown): never {
  if (e instanceof OrderError || e instanceof PaymentError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const Out = z.object({ id: z.string() }).passthrough()
const CreateOut = z.object({ order: Out, payment: z.unknown().nullable() })
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
    responses: { 201: { description: 'Pedido criado', content: { 'application/json': { schema: CreateOut } } } },
  }),
  async (c) => {
    const db = c.get('db')
    const sub = c.get('auth')!.sub
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, sub))
    const result = await createOrder(db, sub, c.req.valid('json'), {
      provider: createPaymentProvider(c.env),
      payerEmail: user?.email ?? `cliente-${sub.slice(0, 8)}@pedidos.delivo.app`,
      publicApiUrl: c.env.PUBLIC_API_URL || null,
    }).catch(rethrow)
    return c.json(result, 201)
  },
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

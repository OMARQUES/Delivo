import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { CancelRequestSchema, CheckoutSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import type { AppContext } from '../env'
import { users } from '../db/schema'
import { createPaymentProvider } from '../lib/mercadopago'
import { CheckoutError } from '../payments/checkout.service'
import { createPaymentProvider as createOrdersPaymentProvider } from '../payments/mercadopago'
import { PaymentProviderError as OrdersProviderError } from '../payments/provider'
import { resolvePayerEmail } from '../lib/payer-email'
import { PaymentProviderError } from '../lib/payment-provider'
import { authMiddleware, requireRole } from '../middleware/auth'
import {
  OrderError,
  createOrder,
  getCustomerOrder,
  listCustomerOrders,
  quoteOrder,
} from '../services/order.service'
import { customerCancelOrder, customerRequestCancel } from '../services/order-status.service'
import { PaymentError } from '../services/payment.service'
import { AmendmentError, approveAmendment, rejectAmendment } from '../services/amendment.service'
import { consumeAll } from '../security/auth-abuse'
import { resolveClientIp } from '../security/client-ip'
import { POLICIES } from '../security/rate-limit-policies'

export const orderRoutes = createRouter()

orderRoutes.use('/orders/*', authMiddleware, requireRole('CUSTOMER'))
orderRoutes.use('/orders', authMiddleware, requireRole('CUSTOMER'))

function rethrow(e: unknown): never {
  if (e instanceof AmendmentError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof OrderError || e instanceof PaymentError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof PaymentProviderError)
    throw new HTTPException(e.status === 402 ? 402 : 503, {
      message: 'Pagamento indisponível no momento — tente novamente ou use pagamento na entrega',
      })
  if (e instanceof CheckoutError) throw new HTTPException(e.status, { message: 'Pagamento indisponível no momento — tente novamente ou use pagamento na entrega' })
  if (e instanceof OrdersProviderError)
    throw new HTTPException(503, { message: 'Pagamento indisponível no momento — tente novamente ou use pagamento na entrega' })
  throw e
}

const Out = z.object({ id: z.string() }).passthrough()
const CreateOut = z.object({ order: Out, payment: z.unknown().nullable() })
const IdParam = z.object({ id: z.uuid() })

async function protectQuote(c: Context<AppContext>) {
  await consumeAll(c, [POLICIES.orderQuoteUserMinute, POLICIES.orderQuoteUserDay], c.get('auth')!.sub)
  await consumeAll(c, [POLICIES.orderQuoteIpMinute], resolveClientIp(c.env.APP_ENV, c.req.raw.headers))
}

async function protectCreate(c: Context<AppContext>) {
  await consumeAll(c, [POLICIES.orderCreateUserHour, POLICIES.orderCreateUserDay], c.get('auth')!.sub)
  await consumeAll(c, [POLICIES.orderCreateIpHour], resolveClientIp(c.env.APP_ENV, c.req.raw.headers))
}

orderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders/quote',
    request: { body: { content: { 'application/json': { schema: CheckoutSchema } } } },
    responses: { 200: { description: 'Cotação', content: { 'application/json': { schema: z.object({ totalCents: z.number() }).passthrough() } } } },
  }),
  async (c) => {
    await protectQuote(c)
    return c.json(await quoteOrder(c.get('db'), c.get('auth')!.sub, c.req.valid('json')).catch(rethrow), 200)
  },
)

orderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders',
    request: { body: { content: { 'application/json': { schema: CheckoutSchema } } } },
    responses: { 201: { description: 'Pedido criado', content: { 'application/json': { schema: CreateOut } } } },
  }),
  async (c) => {
    await protectCreate(c)
    const db = c.get('db')
    const sub = c.get('auth')!.sub
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, sub))
    const result = await createOrder(db, sub, c.req.valid('json'), {
      provider: createOrdersPaymentProvider(c.env),
      payerEmail: resolvePayerEmail(c.env, user?.email, sub),
      applicationId: c.env.MP_APPLICATION_ID ?? '',
      accountId: c.env.MP_ACCOUNT_ID ?? '',
      liveMode: c.env.MP_LIVE_MODE === 'true',
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
    path: '/orders/{id}/amendments/current/approve',
    request: { params: IdParam },
    responses: { 200: { description: 'Alteração aprovada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(
      await approveAmendment(c.get('db'), createPaymentProvider(c.env), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow),
      200,
    ),
)

orderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders/{id}/amendments/current/reject',
    request: { params: IdParam },
    responses: { 200: { description: 'Alteração recusada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(
      await rejectAmendment(c.get('db'), createPaymentProvider(c.env), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow),
      200,
    ),
)

orderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders/{id}/cancel',
    request: { params: IdParam },
    responses: { 200: { description: 'Cancelado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(
      await customerCancelOrder(
        c.get('db'),
        c.get('auth')!.sub,
        c.req.valid('param').id,
        createPaymentProvider(c.env),
      ).catch(rethrow),
      200,
    ),
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

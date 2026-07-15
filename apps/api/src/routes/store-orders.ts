import type { Context } from 'hono'
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { eq } from 'drizzle-orm'
import { AmendmentProposalSchema, BatchBroadcastSchema, SpecificDriverRequestSchema, StatusUpdateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { stores } from '../db/schema'
import type { AppContext } from '../env'
import { sendPushToTokens } from '../lib/fcm'
import { createPaymentProvider } from '../payments/mercadopago'
import { authMiddleware, requireRole } from '../middleware/auth'
import { getStoreOrder, listStoreOrders, OrderError } from '../services/order.service'
import {
  listAvailableDriverTokens, listShiftDriverTokens, requestDriver, requestDriverOwn,
  requestDriverSpecific, storeResolveCancelRequest, storeUpdateOrderStatus, withdrawDriverRequest,
} from '../services/order-status.service'
import { getStoreByOwner } from '../services/store.service'
import { AmendmentError, proposeAmendment, withdrawAmendment } from '../services/amendment.service'
import { BatchError, broadcastBatch, cancelBatch, createBatch, listStoreBatches } from '../services/batch.service'
import { DispatchError, storeReleaseDriver } from '../services/dispatch.service'
import { confirmOrderReturn, ReturnError } from '../services/return.service'

export const storeOrderRoutes = createRouter()

storeOrderRoutes.use('/store/*', authMiddleware, requireRole('STORE'))

function rethrow(e: unknown): never {
  if (e instanceof AmendmentError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof BatchError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof OrderError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof DispatchError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof ReturnError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

async function ownStoreId(c: Context<AppContext>): Promise<string> {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  return store.id
}

const Out = z.object({ id: z.string() }).passthrough()
const IdParam = z.object({ id: z.uuid() })
const BatchBody = z.object({ orderIds: z.array(z.uuid()).min(2).max(30) })

async function pushForTarget(
  c: Context<AppContext>,
  storeId: string,
  target: 'GENERAL' | 'OWN' | 'SPECIFIC',
  driverUserId: string | undefined,
  data: Record<string, string>,
) {
  const db = c.get('db')
  const [store] = await db.select({ name: stores.name }).from(stores).where(eq(stores.id, storeId))
  const tokens = target === 'GENERAL'
    ? await listAvailableDriverTokens(db)
    : await listShiftDriverTokens(db, storeId, target === 'SPECIFIC' ? driverUserId : undefined)
  const push = sendPushToTokens(
    c.env.FIREBASE_PROJECT_ID, c.env.FIREBASE_SERVICE_ACCOUNT, tokens,
    { title: target === 'SPECIFIC' ? 'Entrega direcionada a você 📍' : 'Nova entrega disponível! 🛵', body: store?.name ?? 'Uma loja', data },
  )
  try { c.executionCtx.waitUntil(push) } catch { await push }
}

storeOrderRoutes.openapi(
  createRoute({
    method: 'post', path: '/store/me/orders/{id}/confirm-return', request: { params: IdParam },
    responses: { 200: { description: 'Devolução confirmada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await confirmOrderReturn(
    c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.get('auth')!.sub,
  ).catch(rethrow), 200),
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post', path: '/store/me/orders/{id}/release-driver', request: { params: IdParam },
    responses: { 200: { description: 'Entregador desvinculado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await storeReleaseDriver(
    c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.get('auth')!.sub,
  ).catch(rethrow), 200),
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/store/me/batches',
    responses: { 200: { description: 'Pacotes ativos', content: { 'application/json': { schema: z.array(Out) } } } },
  }),
  async (c) => c.json(await listStoreBatches(c.get('db'), await ownStoreId(c)), 200),
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/store/me/orders/{id}/request-own',
    request: { params: IdParam },
    responses: { 200: { description: 'Entregadores próprios solicitados', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const storeId = await ownStoreId(c)
    const order = await requestDriverOwn(c.get('db'), storeId, c.req.valid('param').id).catch(rethrow)
    await pushForTarget(c, storeId, 'OWN', undefined, { orderId: order.id })
    return c.json(order, 200)
  },
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post', path: '/store/me/orders/{id}/request-specific',
    request: { params: IdParam, body: { content: { 'application/json': { schema: SpecificDriverRequestSchema } } } },
    responses: { 200: { description: 'Pedido direcionado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const storeId = await ownStoreId(c)
    const { driverUserId } = c.req.valid('json')
    const order = await requestDriverSpecific(c.get('db'), storeId, c.req.valid('param').id, driverUserId).catch(rethrow)
    await pushForTarget(c, storeId, 'SPECIFIC', driverUserId, { orderId: order.id })
    return c.json(order, 200)
  },
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post', path: '/store/me/orders/{id}/request-withdraw',
    request: { params: IdParam },
    responses: { 200: { description: 'Chamado retirado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const storeId = await ownStoreId(c)
    const order = await withdrawDriverRequest(c.get('db'), storeId, c.req.valid('param').id, c.get('auth')!.sub).catch(rethrow)
    return c.json(order, 200)
  },
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/store/me/batches',
    request: { body: { content: { 'application/json': { schema: BatchBody } } } },
    responses: { 201: { description: 'Pacote criado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(
    await createBatch(c.get('db'), await ownStoreId(c), c.req.valid('json').orderIds).catch(rethrow),
    201,
  ),
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/store/me/batches/{id}/broadcast',
    request: { params: IdParam },
    responses: { 200: { description: 'Pacote ofertado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const parsed = BatchBroadcastSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? 'Destino inválido' })
    const storeId = await ownStoreId(c)
    const batch = await broadcastBatch(c.get('db'), storeId, c.req.valid('param').id, {
      target: parsed.data.target, requestedDriverId: parsed.data.driverUserId,
    }).catch(rethrow)
    await pushForTarget(c, storeId, parsed.data.target, parsed.data.driverUserId, { batchId: batch.id })
    return c.json(batch, 200)
  },
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/store/me/batches/{id}',
    request: { params: IdParam },
    responses: { 200: { description: 'Pacote cancelado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(
    await cancelBatch(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow),
    200,
  ),
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/store/me/orders',
    request: { query: z.object({ scope: z.enum(['active', 'done', 'returns']).default('active') }) },
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
    method: 'post',
    path: '/store/me/orders/{id}/amendments',
    request: { params: IdParam, body: { content: { 'application/json': { schema: AmendmentProposalSchema } } } },
    responses: { 201: { description: 'Alteração proposta', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(
      await proposeAmendment(c.get('db'), await ownStoreId(c), c.get('auth')!.sub, c.req.valid('param').id, c.req.valid('json')).catch(rethrow),
      201,
    ),
)

storeOrderRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/store/me/orders/{id}/amendments/current',
    request: { params: IdParam },
    responses: { 200: { description: 'Alteração retirada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(
      await withdrawAmendment(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow),
      200,
    ),
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
      createPaymentProvider(c.env),
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
    await pushForTarget(c, order.storeId, 'GENERAL', undefined, { orderId: order.id })
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
      await storeResolveCancelRequest(
        c.get('db'),
        await ownStoreId(c),
        c.req.valid('param').id,
        true,
        c.get('auth')!.sub,
        createPaymentProvider(c.env),
      ).catch(rethrow),
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

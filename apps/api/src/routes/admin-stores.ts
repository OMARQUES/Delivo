import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { StoreCreateSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { stores } from '../db/schema'
import type { AppContext } from '../env'
import { resolveEmailConfig, type EmailConfig } from '../email/config'
import { dispatchOutboxById } from '../email/outbox.service'
import { createResendSender } from '../email/resend-sender'
import { authMiddleware, requireRole } from '../middleware/auth'
import { importCsvCatalog } from '../services/catalog.service'
import {
  listAllStores, setStoreCommission, setStoreSecurityStatus, StoreError,
} from '../services/store.service'
import {
  getPendingStoreActivationTarget,
  provisionStoreWithOwner,
  resendStoreActivation,
} from '../services/store-provisioning.service'
import { protectCodeSend } from '../security/identity-abuse'
import { EMAIL_DELIVERY_UNAVAILABLE_MESSAGE, SecurityHttpError } from '../security/http'

export const adminStoreRoutes = createRouter()

adminStoreRoutes.use('/admin/*', authMiddleware, requireRole('ADMIN'))

function rethrow(e: unknown): never {
  if (e instanceof StoreError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

const StoreOut = z.object({
  id: z.string(), slug: z.string(), name: z.string(),
  securityStatus: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED', 'PENDING_ACTIVATION']),
}).passthrough()
const OwnerOut = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  phone: z.string().nullable(),
  role: z.literal('STORE'),
  status: z.literal('PENDING_EMAIL'),
})
const VerificationOut = z.object({
  expiresAt: z.iso.datetime(),
  resendAt: z.iso.datetime(),
})
const ProvisionOut = z.object({
  store: StoreOut,
  owner: OwnerOut,
  verification: VerificationOut,
})

function emailDelivery(c: Context<AppContext>) {
  try {
    const config = resolveEmailConfig(c.env)
    const authCodeSecret = c.env.AUTH_CODE_SECRET?.trim()
    if (!authCodeSecret) throw new Error('AUTH_CODE_SECRET is required')
    return { config, authCodeSecret }
  } catch {
    throw new SecurityHttpError(503, 'EMAIL_DELIVERY_UNAVAILABLE', EMAIL_DELIVERY_UNAVAILABLE_MESSAGE)
  }
}

async function dispatchBestEffort(c: Context<AppContext>, config: EmailConfig, outboxId: string) {
  await dispatchOutboxById(
    c.get('db'),
    createResendSender(config),
    c.env,
    outboxId,
  ).catch(() => undefined)
}

adminStoreRoutes.openapi(
  createRoute({
    method: 'post', path: '/admin/stores',
    request: { body: { content: { 'application/json': { schema: StoreCreateSchema } } } },
    responses: { 201: { description: 'Loja provisionada', content: { 'application/json': { schema: ProvisionOut } } } },
  }),
  async (c) => {
    const delivery = emailDelivery(c)
    const result = await provisionStoreWithOwner(c.get('db'), c.req.valid('json'), {
      authCodeSecret: delivery.authCodeSecret,
      jwtSecret: c.env.JWT_SECRET,
      requestId: c.get('requestId'),
    }).catch(rethrow)
    await dispatchBestEffort(c, delivery.config, result.outboxId)
    return c.json({
      store: result.store,
      owner: result.owner,
      verification: { expiresAt: result.expiresAt, resendAt: result.resendAt },
    }, 201)
  },
)

const ActivationResendBody = z.object({
  turnstileToken: z.string().trim().min(1).max(2048).optional(),
}).strict()

adminStoreRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/stores/{id}/activation/resend',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: ActivationResendBody } } },
    },
    responses: {
      202: { description: 'Reenvio processado', content: { 'application/json': { schema: VerificationOut } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { turnstileToken } = c.req.valid('json')
    const delivery = emailDelivery(c)
    const target = await getPendingStoreActivationTarget(c.get('db'), id).catch(rethrow)
    await protectCodeSend(c, 'STORE_ACTIVATION', target.email, id, turnstileToken)
    const result = await resendStoreActivation(c.get('db'), id, {
      authCodeSecret: delivery.authCodeSecret,
      jwtSecret: c.env.JWT_SECRET,
      requestId: c.get('requestId'),
    }).catch(rethrow)
    await dispatchBestEffort(c, delivery.config, result.outboxId)
    return c.json({ expiresAt: result.expiresAt, resendAt: result.resendAt }, 202)
  },
)

adminStoreRoutes.openapi(
  createRoute({
    method: 'get', path: '/admin/stores',
    responses: { 200: { description: 'Todas as lojas', content: { 'application/json': { schema: z.array(StoreOut) } } } },
  }),
  async (c) => c.json(await listAllStores(c.get('db')), 200),
)

adminStoreRoutes.openapi(
  createRoute({
    method: 'patch', path: '/admin/stores/{id}/security-status',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: z.object({ securityStatus: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) }) } } },
    },
    responses: { 200: { description: 'Atualizada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { securityStatus } = c.req.valid('json')
    const store = await setStoreSecurityStatus(c.get('db'), id, securityStatus).catch(rethrow)
    return c.json(store, 200)
  },
)

adminStoreRoutes.openapi(
  createRoute({
    method: 'patch', path: '/admin/stores/{id}/commission',
    request: {
      params: z.object({ id: z.uuid() }),
      // basis points: 0..10000 = 0%..100%
      body: { content: { 'application/json': { schema: z.object({ commissionBps: z.number().int().min(0).max(10_000) }) } } },
    },
    responses: { 200: { description: 'Comissão atualizada', content: { 'application/json': { schema: StoreOut } } } },
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const { commissionBps } = c.req.valid('json')
    const store = await setStoreCommission(c.get('db'), id, commissionBps).catch(rethrow)
    return c.json(store, 200)
  },
)

const MAX_CSV_LINES = 2000

adminStoreRoutes.post('/admin/stores/:id/catalog/import', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new HTTPException(400, { message: 'ID inválido' })
  const [store] = await c.get('db').select({ id: stores.id }).from(stores).where(eq(stores.id, id))
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  const csv = await c.req.text()
  if (!csv.trim()) throw new HTTPException(400, { message: 'CSV vazio' })
  if (csv.split(/\r?\n/).length > MAX_CSV_LINES)
    throw new HTTPException(400, { message: `CSV acima de ${MAX_CSV_LINES} linhas — divida o arquivo` })
  const result = await importCsvCatalog(c.get('db'), id, csv)
  return c.json(result, 200)
})

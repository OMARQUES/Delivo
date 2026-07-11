import type { Context } from 'hono'
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../app-factory'
import type { AppContext } from '../env'
import { authMiddleware, requireRole } from '../middleware/auth'
import {
  closeFinancePeriod,
  FinanceError,
  getDriverEarningOrderDetail,
  getDriverFinance,
  getStoreFinance,
  listAdminFinance,
  markDriverPayoutPaid,
  markStoreInvoicePaid,
  markStorePayoutPaid,
} from '../services/finance-settlement.service'
import { getStoreByOwner } from '../services/store.service'

export const financeRoutes = createRouter()

financeRoutes.use('/admin/*', authMiddleware, requireRole('ADMIN'))
financeRoutes.use('/store/*', authMiddleware, requireRole('STORE'))
financeRoutes.use('/driver/*', authMiddleware, requireRole('DRIVER'))

function rethrow(e: unknown): never {
  if (e instanceof FinanceError) throw new HTTPException(e.status, { message: e.message })
  throw e
}

function parseDate(value: string, label: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new HTTPException(400, { message: `${label} inválido` })
  return date
}

async function ownStoreId(c: Context<AppContext>): Promise<string> {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  return store.id
}

const Out = z.object({}).passthrough()
const IdParam = z.object({ id: z.uuid() })
const PeriodSchema = z.object({ periodStart: z.string(), periodEnd: z.string() })

financeRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/finance/close',
    request: { body: { content: { 'application/json': { schema: PeriodSchema } } } },
    responses: { 200: { description: 'Período fechado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => {
    const input = c.req.valid('json')
    const result = await closeFinancePeriod(c.get('db'), {
      periodStart: parseDate(input.periodStart, 'periodStart'),
      periodEnd: parseDate(input.periodEnd, 'periodEnd'),
    }).catch(rethrow)
    return c.json(result, 200)
  },
)

financeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/finance',
    responses: { 200: { description: 'Financeiro admin', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await listAdminFinance(c.get('db')), 200),
)

financeRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/admin/finance/store-invoices/{id}/paid',
    request: { params: IdParam },
    responses: { 200: { description: 'Fatura paga', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await markStoreInvoicePaid(c.get('db'), c.req.valid('param').id).catch(rethrow), 200),
)

financeRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/admin/finance/store-payouts/{id}/paid',
    request: { params: IdParam },
    responses: { 200: { description: 'Repasse da loja pago', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await markStorePayoutPaid(c.get('db'), c.req.valid('param').id).catch(rethrow), 200),
)

financeRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/admin/finance/driver-payouts/{id}/paid',
    request: { params: IdParam },
    responses: { 200: { description: 'Repasse do entregador pago', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await markDriverPayoutPaid(c.get('db'), c.req.valid('param').id).catch(rethrow), 200),
)

financeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/store/me/finance',
    responses: { 200: { description: 'Financeiro da loja', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await getStoreFinance(c.get('db'), await ownStoreId(c)), 200),
)

financeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/driver/me/finance',
    responses: { 200: { description: 'Financeiro do entregador', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await getDriverFinance(c.get('db'), c.get('auth')!.sub), 200),
)

financeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/driver/earnings/orders/{id}',
    request: { params: IdParam },
    responses: { 200: { description: 'Detalhe sanitizado do ganho', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await getDriverEarningOrderDetail(
    c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
  ).catch(rethrow), 200),
)

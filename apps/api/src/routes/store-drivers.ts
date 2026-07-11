import type { Context } from 'hono'
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { AdjustActiveShiftSchema, InviteStoreDriverSchema, OfferCreateSchema, UpdateStoreDriverTermsSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import type { AppContext } from '../env'
import { authMiddleware, requireRole } from '../middleware/auth'
import { getStoreByOwner } from '../services/store.service'
import {
  inviteDriver, listStoreDrivers, proposeLinkTerms, removeLink, StoreDriverError,
} from '../services/store-driver.service'
import { listActiveStoreShifts, releaseShift, ShiftError, updateActiveShift } from '../services/shift.service'
import { closeOffer, createOffer, listStoreOffers, OfferError } from '../services/offer.service'

export const storeDriverRoutes = createRouter()
storeDriverRoutes.use('/store/*', authMiddleware, requireRole('STORE'))

async function ownStoreId(c: Context<AppContext>) {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  return store.id
}

function rethrow(error: unknown): never {
  if (error instanceof StoreDriverError || error instanceof ShiftError || error instanceof OfferError) {
    throw new HTTPException(error.status, { message: error.message })
  }
  throw error
}

const Out = z.object({}).passthrough()
const IdParam = z.object({ id: z.uuid() })

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/offers',
  request: { body: { content: { 'application/json': { schema: OfferCreateSchema } } } },
  responses: { 201: { description: 'Oferta criada', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await createOffer(c.get('db'), await ownStoreId(c), c.req.valid('json')), 201))

storeDriverRoutes.openapi(createRoute({
  method: 'get', path: '/store/me/offers',
  responses: { 200: { description: 'Ofertas da loja', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listStoreOffers(c.get('db'), await ownStoreId(c)), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/offers/{id}/close', request: { params: IdParam },
  responses: { 200: { description: 'Oferta encerrada', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await closeOffer(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'get', path: '/store/me/drivers',
  responses: { 200: { description: 'Entregadores próprios', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listStoreDrivers(c.get('db'), await ownStoreId(c)), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/drivers',
  request: { body: { content: { 'application/json': { schema: InviteStoreDriverSchema } } } },
  responses: { 201: { description: 'Convite criado', content: { 'application/json': { schema: Out } } } },
}), async (c) => {
  const { phone, ...terms } = c.req.valid('json')
  return c.json(await inviteDriver(c.get('db'), await ownStoreId(c), phone, terms).catch(rethrow), 201)
})

storeDriverRoutes.openapi(createRoute({
  method: 'patch', path: '/store/me/drivers/{id}', request: {
    params: IdParam, body: { content: { 'application/json': { schema: UpdateStoreDriverTermsSchema } } },
  }, responses: { 200: { description: 'Alteração de termos proposta', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await proposeLinkTerms(
  c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json'),
).catch(rethrow), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'delete', path: '/store/me/drivers/{id}', request: { params: IdParam },
  responses: { 200: { description: 'Vínculo removido', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await removeLink(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'get', path: '/store/me/shifts',
  responses: { 200: { description: 'Turnos ativos', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listActiveStoreShifts(c.get('db'), await ownStoreId(c)), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'patch', path: '/store/me/shifts/{id}', request: {
    params: IdParam, body: { content: { 'application/json': { schema: AdjustActiveShiftSchema } } },
  }, responses: { 200: { description: 'Turno reajustado', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await updateActiveShift(
  c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json'),
).catch(rethrow), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/shifts/{id}/release', request: { params: IdParam },
  responses: { 200: { description: 'Turno liberado', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await releaseShift(c.get('db'), await ownStoreId(c), c.req.valid('param').id).catch(rethrow), 200))

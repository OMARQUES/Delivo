import type { Context } from 'hono'
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { CreateShiftAuthorizationSchema, InviteStoreDriverSchema, OfferCreateSchema, ProposeActiveShiftTermsSchema, RejectShiftDailySchema, UpdateStoreDriverTermsSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import type { AppContext } from '../env'
import { authMiddleware, requireRole } from '../middleware/auth'
import { getStoreByOwner } from '../services/store.service'
import {
  inviteDriver, listStoreDrivers, proposeLinkTerms, removeLink, StoreDriverError,
} from '../services/store-driver.service'
import { decideShiftDaily, listActiveStoreShifts, offerShiftReactivation, releaseShift, ShiftError } from '../services/shift.service'
import { closeOffer, createOffer, listStoreOffers, OfferError } from '../services/offer.service'
import { cancelActiveShiftTerms, cancelShiftAuthorization, createShiftAuthorization, proposeActiveShiftTerms, ShiftProposalError } from '../services/shift-proposal.service'

export const storeDriverRoutes = createRouter()
storeDriverRoutes.use('/store/*', authMiddleware, requireRole('STORE'))

async function ownStoreId(c: Context<AppContext>) {
  const store = await getStoreByOwner(c.get('db'), c.get('auth')!.sub)
  if (!store) throw new HTTPException(404, { message: 'Loja não encontrada' })
  return store.id
}

function rethrow(error: unknown): never {
  if (error instanceof StoreDriverError || error instanceof ShiftError || error instanceof OfferError || error instanceof ShiftProposalError) {
    throw new HTTPException(error.status, { message: error.message })
  }
  throw error
}

const Out = z.object({}).passthrough()
const IdParam = z.object({ id: z.uuid() })
const ShiftProposalParam = z.object({ id: z.uuid(), proposalId: z.uuid() })

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
  method: 'post', path: '/store/me/shifts/{id}/terms', request: {
    params: IdParam, body: { content: { 'application/json': { schema: ProposeActiveShiftTermsSchema } } },
  }, responses: { 201: { description: 'Reajuste proposto', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await proposeActiveShiftTerms(
  c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.req.valid('json'),
).catch(rethrow), 201))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/shifts/{id}/terms/{proposalId}/cancel', request: { params: ShiftProposalParam },
  responses: { 200: { description: 'Proposta cancelada', content: { 'application/json': { schema: Out } } } },
}), async (c) => { const p = c.req.valid('param'); return c.json(await cancelActiveShiftTerms(
  c.get('db'), await ownStoreId(c), p.id, p.proposalId,
).catch(rethrow), 200) })

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/shift-authorizations', request: {
    body: { content: { 'application/json': { schema: CreateShiftAuthorizationSchema } } },
  }, responses: { 201: { description: 'Autorização proposta', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await createShiftAuthorization(c.get('db'), await ownStoreId(c), c.req.valid('json')).catch(rethrow), 201))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/shift-authorizations/{id}/cancel', request: { params: IdParam },
  responses: { 200: { description: 'Autorização cancelada', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await cancelShiftAuthorization(
  c.get('db'), await ownStoreId(c), c.req.valid('param').id,
).catch(rethrow), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/shifts/{id}/release', request: { params: IdParam },
  responses: { 200: { description: 'Turno liberado', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await releaseShift(c.get('db'), await ownStoreId(c), c.req.valid('param').id, c.get('auth')!.sub).catch(rethrow), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/shifts/{id}/daily/approve', request: { params: IdParam },
  responses: { 200: { description: 'Diária aprovada', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await decideShiftDaily(c.get('db'), await ownStoreId(c), c.get('auth')!.sub,
  c.req.valid('param').id, true,
).catch(rethrow), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/shifts/{id}/daily/reject', request: {
    params: IdParam, body: { content: { 'application/json': { schema: RejectShiftDailySchema } } },
  }, responses: { 200: { description: 'Diária recusada', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await decideShiftDaily(c.get('db'), await ownStoreId(c), c.get('auth')!.sub,
  c.req.valid('param').id, false, c.req.valid('json').reason,
).catch(rethrow), 200))

storeDriverRoutes.openapi(createRoute({
  method: 'post', path: '/store/me/shifts/{id}/reactivation', request: { params: IdParam },
  responses: { 200: { description: 'Reativação liberada', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await offerShiftReactivation(
  c.get('db'), await ownStoreId(c), c.req.valid('param').id,
).catch(rethrow), 200))

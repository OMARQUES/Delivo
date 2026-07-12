import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { AvailabilitySchema, DeliveryFailSchema, DriverArrivalSchema, FcmTokenSchema, StartShiftSchema } from '@delivery/shared/schemas'
import { createRouter } from '../app-factory'
import { authMiddleware, requireRole } from '../middleware/auth'
import {
  DispatchError,
  acceptDelivery,
  acceptShiftDelivery,
  collectDelivery,
  completeDelivery,
  confirmArrival,
  ensureDriverProfile,
  failDelivery,
  listAvailableDeliveries,
  listDriverDeliveries,
  listShiftDeliveries,
  refuseDirectDelivery,
  releaseDelivery,
  setAvailability,
  setDriverPixKey,
  setFcmToken,
} from '../services/dispatch.service'
import {
  BatchError,
  acceptBatch,
  collectBatch,
  listAvailableBatches,
  listShiftBatches,
  refuseBatch,
  releaseBatch,
} from '../services/batch.service'
import {
  confirmLink, confirmLinkTermsChange, listDriverLinks, rejectLinkTermsChange, StoreDriverError,
} from '../services/store-driver.service'
import { endShift, getActiveShift, listDriverRecentShifts, reactivateShift, ShiftError, startShift } from '../services/shift.service'
import { createPaymentProvider } from '../lib/mercadopago'
import { PaymentProviderError } from '../lib/payment-provider'
import { PaymentError } from '../services/payment.service'
import {
  appendReturnPhotoKey,
  getDriverPendingReturn,
  markDriverReturned,
  ReturnError,
} from '../services/return.service'
import { acceptOffer, dismissOffer, listOpenOffers, OfferError } from '../services/offer.service'
import { decideActiveShiftTerms, decideShiftAuthorization, listDriverAuthorizations, ShiftProposalError } from '../services/shift-proposal.service'
import { toDriverActionResult } from '../services/driver-delivery.dto'
import { consumeAll } from '../security/auth-abuse'
import { resolveClientIp } from '../security/client-ip'
import { POLICIES } from '../security/rate-limit-policies'
import { readLimitedArrayBuffer } from '../security/request-body'

export const driverRoutes = createRouter()

driverRoutes.use('/driver/*', authMiddleware, requireRole('DRIVER'))

function rethrow(e: unknown): never {
  if (e instanceof DispatchError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof BatchError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof StoreDriverError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof ShiftError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof PaymentError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof ReturnError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof OfferError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof ShiftProposalError) throw new HTTPException(e.status, { message: e.message })
  if (e instanceof PaymentProviderError)
    throw new HTTPException(503, { message: 'Falha registrada; o estorno do cliente será reprocessado (gateway indisponível)' })
  throw e
}

const Out = z.object({}).passthrough()
const IdParam = z.object({ id: z.uuid() })
const ShiftProposalParam = z.object({ id: z.uuid(), proposalId: z.uuid() })

driverRoutes.openapi(createRoute({
  method: 'get', path: '/driver/offers',
  responses: { 200: { description: 'Ofertas abertas', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listOpenOffers(c.get('db'), c.get('auth')!.sub), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/offers/{id}/accept', request: { params: IdParam },
  responses: { 200: { description: 'Oferta aceita', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await acceptOffer(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/offers/{id}/dismiss', request: { params: IdParam },
  responses: { 200: { description: 'Oferta dispensada', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await dismissOffer(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'get', path: '/driver/links',
  responses: { 200: { description: 'Vínculos com lojas', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listDriverLinks(c.get('db'), c.get('auth')!.sub), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/links/{id}/confirm', request: { params: IdParam },
  responses: { 200: { description: 'Vínculo confirmado', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await confirmLink(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/links/{id}/terms/confirm', request: { params: IdParam },
  responses: { 200: { description: 'Novos termos confirmados', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await confirmLinkTermsChange(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/links/{id}/terms/reject', request: { params: IdParam },
  responses: { 200: { description: 'Novos termos recusados', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await rejectLinkTermsChange(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'get', path: '/driver/shifts/active',
  responses: { 200: { description: 'Turno ativo', content: { 'application/json': { schema: Out.nullable() } } } },
}), async (c) => c.json(await getActiveShift(c.get('db'), c.get('auth')!.sub), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/shifts', request: {
    body: { content: { 'application/json': { schema: StartShiftSchema } } },
  }, responses: { 201: { description: 'Turno iniciado', content: { 'application/json': { schema: Out } } } },
}), async (c) => {
  const { storeDriverId, lat, lng } = c.req.valid('json')
  return c.json(await startShift(c.get('db'), c.get('auth')!.sub, storeDriverId, { lat, lng }).catch(rethrow), 201)
})

driverRoutes.openapi(createRoute({
  method: 'get', path: '/driver/shift-authorizations',
  responses: { 200: { description: 'Autorizações pendentes', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listDriverAuthorizations(c.get('db'), c.get('auth')!.sub), 200))

for (const decision of ['accept', 'reject'] as const) driverRoutes.openapi(createRoute({
  method: 'post', path: `/driver/shift-authorizations/{id}/${decision}`, request: { params: IdParam },
  responses: { 200: { description: 'Autorização respondida', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await decideShiftAuthorization(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id, decision === 'accept',
).catch(rethrow), 200))

for (const decision of ['accept', 'reject'] as const) driverRoutes.openapi(createRoute({
  method: 'post', path: `/driver/shifts/{id}/terms/{proposalId}/${decision}`, request: { params: ShiftProposalParam },
  responses: { 200: { description: 'Reajuste respondido', content: { 'application/json': { schema: Out } } } },
}), async (c) => { const p = c.req.valid('param'); return c.json(await decideActiveShiftTerms(
  c.get('db'), c.get('auth')!.sub, p.id, p.proposalId, decision === 'accept',
).catch(rethrow), 200) })

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/shifts/{id}/end', request: { params: IdParam },
  responses: { 200: { description: 'Turno encerrado', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await endShift(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/shifts/{id}/reactivate', request: { params: IdParam },
  responses: { 200: { description: 'Turno reativado', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await reactivateShift(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'get', path: '/driver/shifts/recent',
  responses: { 200: { description: 'Turnos recentes', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listDriverRecentShifts(c.get('db'), c.get('auth')!.sub), 200))

driverRoutes.openapi(createRoute({
  method: 'get', path: '/driver/shift-deliveries',
  responses: { 200: { description: 'Entregas do turno', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listShiftDeliveries(c.get('db'), c.get('auth')!.sub), 200))

driverRoutes.openapi(createRoute({
  method: 'get', path: '/driver/shift-batches',
  responses: { 200: { description: 'Pacotes do turno', content: { 'application/json': { schema: z.array(Out) } } } },
}), async (c) => c.json(await listShiftBatches(c.get('db'), c.get('auth')!.sub), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/orders/{id}/accept-shift', request: { params: IdParam },
  responses: { 200: { description: 'Entrega do turno aceita', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await acceptShiftDelivery(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/orders/{id}/refuse-direct', request: { params: IdParam },
  responses: { 200: { description: 'Direcionamento recusado', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await refuseDirectDelivery(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
).catch(rethrow), 200))

driverRoutes.openapi(createRoute({
  method: 'post', path: '/driver/batches/{id}/refuse', request: { params: IdParam },
  responses: { 200: { description: 'Pacote recusado', content: { 'application/json': { schema: Out } } } },
}), async (c) => c.json(await refuseBatch(
  c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
).catch(rethrow), 200))

driverRoutes.openapi(
  createRoute({
    method: 'post', path: '/driver/orders/{id}/arrived',
    request: { params: IdParam, body: { content: { 'application/json': { schema: DriverArrivalSchema } } } },
    responses: { 200: { description: 'Chegada registrada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(toDriverActionResult(await confirmArrival(
    c.get('db'), c.get('auth')!.sub, c.req.valid('param').id, c.req.valid('json'),
  ).catch(rethrow)), 200),
)

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
    method: 'get',
    path: '/driver/batches',
    responses: { 200: { description: 'Pacotes disponíveis', content: { 'application/json': { schema: z.array(Out) } } } },
  }),
  async (c) => c.json(await listAvailableBatches(c.get('db'), c.get('auth')!.sub), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/batches/{id}/accept',
    request: { params: IdParam },
    responses: { 200: { description: 'Pacote aceito', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await acceptBatch(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/batches/{id}/release',
    request: { params: IdParam },
    responses: { 200: { description: 'Pacote liberado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await releaseBatch(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/batches/{id}/collect',
    request: { params: IdParam },
    responses: { 200: { description: 'Pacote coletado', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await collectBatch(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow), 200),
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
    method: 'patch',
    path: '/driver/me/pix-key',
    request: { body: { content: { 'application/json': { schema: z.object({ pixKey: z.string().trim().min(3).max(140).nullable() }) } } } },
    responses: { 200: { description: 'Salvo', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(await setDriverPixKey(c.get('db'), c.get('auth')!.sub, c.req.valid('json').pixKey), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/driver/available',
    responses: { 200: { description: 'Entregas disponíveis', content: { 'application/json': { schema: z.array(Out) } } } },
  }),
  async (c) => c.json(await listAvailableDeliveries(c.get('db'), c.get('auth')!.sub), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/driver/deliveries',
    request: { query: z.object({ scope: z.enum(['active', 'done', 'returns']).default('active') }) },
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
  async (c) => c.json(toDriverActionResult(await collectDelivery(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow)), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/orders/{id}/deliver',
    request: { params: IdParam },
    responses: { 200: { description: 'Entregue', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(toDriverActionResult(await completeDelivery(c.get('db'), c.get('auth')!.sub, c.req.valid('param').id).catch(rethrow)), 200),
)

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/orders/{id}/returned',
    request: { params: IdParam },
    responses: { 200: { description: 'Devolução declarada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) => c.json(toDriverActionResult(await markDriverReturned(
    c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
  ).catch(rethrow)), 200),
)

const RETURN_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
const MAX_RETURN_PHOTO_BYTES = 5 * 1024 * 1024

driverRoutes.put('/driver/orders/:id/return-photo', async (c) => {
  const driverId = c.get('auth')!.sub
  const orderId = c.req.param('id')
  if (!z.uuid().safeParse(orderId).success) throw new HTTPException(400, { message: 'Pedido inválido' })
  const type = c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const ext = RETURN_IMAGE_TYPES[type]
  if (!ext) throw new HTTPException(400, { message: 'Envie uma imagem jpeg, png ou webp' })

  const declaredLength = Number(c.req.header('Content-Length') ?? 0)
  if (declaredLength > MAX_RETURN_PHOTO_BYTES) {
    throw new HTTPException(400, { message: 'Imagem maior que 5MB' })
  }

  await getDriverPendingReturn(c.get('db'), driverId, orderId).catch(rethrow)
  await consumeAll(c, [POLICIES.returnUploadDriverHour, POLICIES.returnUploadDriverDay], driverId)
  await consumeAll(c, [POLICIES.returnUploadIpHour], resolveClientIp(c.env.APP_ENV, c.req.raw.headers))
  const body = await readLimitedArrayBuffer(c.req.raw, MAX_RETURN_PHOTO_BYTES, 'Imagem vazia ou maior que 5MB')
  if (body.byteLength === 0 || body.byteLength > MAX_RETURN_PHOTO_BYTES) {
    throw new HTTPException(400, { message: 'Imagem vazia ou maior que 5MB' })
  }

  const key = `returns/${crypto.randomUUID()}.${ext}`
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: type } })
  try {
    await appendReturnPhotoKey(c.get('db'), driverId, orderId, key)
  } catch (error) {
    await c.env.BUCKET.delete(key).catch(() => undefined)
    rethrow(error)
  }
  return c.json({ key }, 200)
})

driverRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/driver/orders/{id}/fail',
    request: { params: IdParam, body: { content: { 'application/json': { schema: DeliveryFailSchema } } } },
    responses: { 200: { description: 'Falha registrada', content: { 'application/json': { schema: Out } } } },
  }),
  async (c) =>
    c.json(toDriverActionResult(await failDelivery(
      c.get('db'), c.get('auth')!.sub, c.req.valid('param').id,
      c.req.valid('json'), createPaymentProvider(c.env),
    ).catch(rethrow)), 200),
)

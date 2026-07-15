import { Hono } from 'hono'
import type { AppContext } from '../env'
import { createPaymentProvider } from '../payments/mercadopago'
import { enqueueWebhook, processWebhookInboxItem } from '../payments/webhook-inbox.service'
import { verifyMercadoPagoSignature } from '../payments/webhook-signature'
import { consumeAll } from '../security/auth-abuse'
import { resolveClientIp } from '../security/client-ip'
import { POLICIES } from '../security/rate-limit-policies'

export const webhookRoutes = new Hono<AppContext>()

webhookRoutes.post('/webhooks/mercadopago', async (c) => {
  const type = c.req.query('type') ?? c.req.query('topic')
  if (type !== 'order') return c.json({ ok: true }, 200)

  const secret = c.env.MP_WEBHOOK_SECRET
  if (!secret) return c.json({ error: 'Webhook não configurado' }, 503)
  const dataId = c.req.query('data.id') ?? c.req.query('id') ?? ''
  const requestId = c.req.header('x-request-id') ?? ''
  const signature = c.req.header('x-signature') ?? ''
  const verified = await verifyMercadoPagoSignature({ secret, dataId, requestId, signature })
  if (!verified.valid) {
    await consumeAll(c, [POLICIES.paymentWebhookInvalidIpMinute], resolveClientIp(c.env.APP_ENV, c.req.raw.headers))
    return c.json({ error: 'Assinatura inválida' }, 401)
  }

  const now = new Date()
  const queued = await enqueueWebhook(c.get('db'), { topic: 'order', resourceId: dataId, requestId, signatureTimestamp: verified.timestamp }, now)
  const provider = createPaymentProvider(c.env)
  if (provider && queued.inserted && c.executionCtx) {
    c.executionCtx.waitUntil(processWebhookInboxItem(c.get('db'), provider, queued.id, crypto.randomUUID(), now).catch(() => undefined))
  }
  return c.json({ ok: true }, 200)
})

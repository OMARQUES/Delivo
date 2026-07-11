import { Hono } from 'hono'
import type { AppContext } from '../env'
import { createPaymentProvider } from '../lib/mercadopago'
import { PaymentProviderError } from '../lib/payment-provider'
import { confirmPaymentApproved } from '../services/payment.service'

/**
 * Webhook do Mercado Pago:
 * 1. valida HMAC do x-signature;
 * 2. nunca confia no corpo;
 * 3. reconsulta pagamento na API antes de transicionar.
 */
export const webhookRoutes = new Hono<AppContext>()

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacHex(secret: string, manifest: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

webhookRoutes.post('/webhooks/mercadopago', async (c) => {
  const secret = c.env.MP_WEBHOOK_SECRET
  const provider = createPaymentProvider(c.env)
  if (!secret || !provider) return c.json({ error: 'Webhook não configurado' }, 503)

  const dataId = c.req.query('data.id') ?? c.req.query('id')
  const type = c.req.query('type') ?? c.req.query('topic')
  if (!dataId || type !== 'payment') return c.json({ ok: true }, 200)

  const signature = c.req.header('x-signature') ?? ''
  const requestId = c.req.header('x-request-id') ?? ''
  const parts = Object.fromEntries(signature.split(',').map((p) => p.trim().split('=') as [string, string]))
  const ts = parts.ts
  const v1 = parts.v1
  if (!ts || !v1) return c.json({ error: 'Assinatura ausente' }, 401)
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
  const expected = await hmacHex(secret, manifest)
  if (!timingSafeEqualHex(expected, v1)) return c.json({ error: 'Assinatura inválida' }, 401)

  try {
    const payment = await provider.getPayment(dataId)
    if (payment.status === 'APPROVED') {
      await confirmPaymentApproved(c.get('db'), dataId, provider)
    }
  } catch (e) {
    // pagamento inexistente no MP (ex.: teste do painel com id fake) — ack, sem retry
    if (e instanceof PaymentProviderError && e.httpStatus === 404) return c.json({ ok: true, ignored: true }, 200)
    return c.json({ error: 'retry' }, 500)
  }
  return c.json({ ok: true }, 200)
})

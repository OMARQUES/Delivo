import { and, eq, lt, sql } from 'drizzle-orm'
import { PIX_EXPIRATION_MINUTES } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { orders, payments } from '../db/schema'
import type { PaymentProvider } from '../lib/payment-provider'
import { addEvent } from './order-events'

export class PaymentError extends Error {
  constructor(
    message: string,
    public status: 400 | 402 | 409 | 503 = 400,
  ) {
    super(message)
  }
}

type OrderRow = typeof orders.$inferSelect

export async function getOrderPayment(db: Db, orderId: string) {
  const [row] = await db.select().from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(sql`${payments.createdAt} desc`)
    .limit(1)
  return row ?? null
}

/** Cria pagamento PIX no gateway + linha local. Pedido deve estar AWAITING_PAYMENT. */
export async function createPixPaymentForOrder(
  db: Db,
  provider: PaymentProvider,
  order: OrderRow,
  payerEmail: string,
  publicApiUrl: string | null,
) {
  const expiresAt = new Date(Date.now() + PIX_EXPIRATION_MINUTES * 60_000)
  const pix = await provider.createPixPayment({
    orderId: order.id,
    amountCents: order.totalCents,
    description: 'Pedido Delivo',
    payerEmail,
    expiresAt,
    notificationUrl: publicApiUrl ? `${publicApiUrl}/webhooks/mercadopago` : null,
  })
  const [row] = await db.insert(payments).values({
    orderId: order.id,
    providerPaymentId: pix.providerPaymentId,
    method: 'PIX',
    amountCents: order.totalCents,
    qrCode: pix.qrCode,
    qrCodeBase64: pix.qrCodeBase64,
    ticketUrl: pix.ticketUrl,
    expiresAt,
  }).returning()
  return row!
}

/** Registra tentativa de cartão (linha local) com resultado sync do gateway. */
export async function recordCardPayment(
  db: Db,
  orderId: string,
  amountCents: number,
  providerPaymentId: string,
  approved: boolean,
) {
  const [row] = await db.insert(payments).values({
    orderId,
    providerPaymentId,
    method: 'CARD',
    amountCents,
    status: approved ? 'APPROVED' : 'REJECTED',
  }).returning()
  return row!
}

/**
 * Confirmação (webhook/reconsulta): paga o pedido.
 * Retorna true se transicionou agora; false se já confirmado/inexistente.
 * Se PIX for pago após cancelamento/expiração, estorna automaticamente.
 */
export async function confirmPaymentApproved(
  db: Db,
  providerPaymentId: string,
  provider?: PaymentProvider | null,
): Promise<boolean> {
  const [payment] = await db.select().from(payments)
    .where(eq(payments.providerPaymentId, providerPaymentId))
  if (!payment) return false
  if (payment.status === 'APPROVED' || payment.status === 'REFUNDED') return false

  await db.update(payments).set({ status: 'APPROVED' }).where(eq(payments.id, payment.id))
  const rows = await db.update(orders)
    .set({ status: 'PENDING' })
    .where(and(eq(orders.id, payment.orderId), eq(orders.status, 'AWAITING_PAYMENT')))
    .returning({ id: orders.id })
  if (rows.length === 0) {
    const [order] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, payment.orderId))
    if (order?.status === 'CANCELLED') {
      if (provider) await provider.refundPayment(providerPaymentId)
      await db.update(payments).set({ status: 'REFUNDED', refundedAt: new Date() }).where(eq(payments.id, payment.id))
      await addEvent(db, payment.orderId, 'CANCELLED', 'SYSTEM', null, 'pagamento tardio estornado automaticamente')
    }
    return false
  }
  await addEvent(db, payment.orderId, 'PENDING', 'SYSTEM', null, 'pagamento confirmado')
  return true
}

/**
 * Cancelamento de pedido: estorna se pago; cancela no gateway se pendente.
 * Retorna true se estornou (pagamento aprovado existia).
 */
export async function refundOrderPaymentIfAny(db: Db, provider: PaymentProvider | null, orderId: string): Promise<boolean> {
  const payment = await getOrderPayment(db, orderId)
  if (!payment) return false
  if (payment.status === 'APPROVED') {
    if (provider) await provider.refundPayment(payment.providerPaymentId)
    await db.update(payments)
      .set({ status: 'REFUNDED', refundedAt: new Date() })
      .where(eq(payments.id, payment.id))
    await addEvent(db, orderId, 'CANCELLED', 'SYSTEM', null, 'pagamento estornado')
    return true
  }
  if (payment.status === 'PENDING') {
    if (provider) await provider.cancelPayment(payment.providerPaymentId)
    await db.update(payments).set({ status: 'CANCELLED' }).where(eq(payments.id, payment.id))
  }
  return false
}

/** Cron: AWAITING_PAYMENT velhos -> CANCELLED + payment EXPIRED. */
export async function expireStaleAwaitingPayment(
  db: Db,
  provider: PaymentProvider | null,
  olderThanMinutes = PIX_EXPIRATION_MINUTES,
) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const stale = await db.update(orders)
    .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Pagamento não realizado a tempo' })
    .where(and(eq(orders.status, 'AWAITING_PAYMENT'), lt(orders.createdAt, cutoff)))
    .returning({ id: orders.id })
  for (const o of stale) {
    await addEvent(db, o.id, 'CANCELLED', 'SYSTEM', null, 'pagamento expirado')
    const { expirePendingAmendment } = await import('./amendment.service')
    await expirePendingAmendment(db, o.id)
    const payment = await getOrderPayment(db, o.id)
    if (payment && payment.status === 'PENDING') {
      if (provider) await provider.cancelPayment(payment.providerPaymentId)
      await db.update(payments).set({ status: 'EXPIRED' }).where(eq(payments.id, payment.id))
    }
  }
  return stale.length
}

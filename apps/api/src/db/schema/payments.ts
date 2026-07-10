import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { PAYMENT_STATUSES } from '@delivery/shared/constants'
import { orders } from './orders'

export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES)
export const paymentGatewayMethod = pgEnum('payment_gateway_method', ['PIX', 'CARD'])

/** Pagamentos online (1 linha por tentativa; pedido pode ter várias tentativas de cartão) */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull().default('MERCADO_PAGO'),
    /** id do pagamento no gateway */
    providerPaymentId: text('provider_payment_id').notNull(),
    status: paymentStatus('status').notNull().default('PENDING'),
    method: paymentGatewayMethod('method').notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** PIX: copia-e-cola */
    qrCode: text('qr_code'),
    /** PIX: imagem base64 (sem prefixo data:) */
    qrCodeBase64: text('qr_code_base64'),
    ticketUrl: text('ticket_url'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('payments_provider_id_unique').on(t.provider, t.providerPaymentId)],
)

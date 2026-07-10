import {
  doublePrecision, integer, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid, index,
} from 'drizzle-orm/pg-core'
import { DRIVER_REQUEST_TARGETS, ORDER_STATUSES } from '@delivery/shared/constants'
import { stores } from './stores'
import { users } from './users'
import { products } from './catalog'

export const orderStatus = pgEnum('order_status', ORDER_STATUSES)
export const fulfillmentType = pgEnum('fulfillment_type', ['DELIVERY', 'PICKUP'])
export const paymentMethod = pgEnum('payment_method', ['CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE'])
export const driverRequestTarget = pgEnum('driver_request_target', DRIVER_REQUEST_TARGETS)

export const customerAddresses = pgTable('customer_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label: text('label'),
  addressText: text('address_text').notNull(),
  reference: text('reference'),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    status: orderStatus('status').notNull().default('PENDING'),
    fulfillment: fulfillmentType('fulfillment').notNull(),
    paymentMethod: paymentMethod('payment_method').notNull(),
    /** "troco para" — só CASH */
    changeForCents: integer('change_for_cents'),
    subtotalCents: integer('subtotal_cents').notNull(),
    /** null = retirada */
    deliveryFeeCents: integer('delivery_fee_cents'),
    totalCents: integer('total_cents').notNull(),
    note: text('note'),
    /** snapshot do endereço no momento do pedido (null = retirada) */
    addressText: text('address_text'),
    addressReference: text('address_reference'),
    addressLat: doublePrecision('address_lat'),
    addressLng: doublePrecision('address_lng'),
    distanceKm: real('distance_km'),
    /** CPF/CNPJ na nota (opcional, só dígitos) — exibido pra loja emitir NFC-e */
    taxId: text('tax_id'),
    cancelReason: text('cancel_reason'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    cancelRequestNote: text('cancel_request_note'),
    /** Plano 6 */
    driverId: uuid('driver_id'),
    /** Plano ③: pacote de entregas (null = pedido avulso). */
    batchId: uuid('batch_id'),
    /** Turno do entregador próprio; null para freelance/entrega da loja. */
    shiftId: uuid('shift_id'),
    /** loja solicitou entregador (broadcast ativo enquanto driverId null) */
    driverRequestedAt: timestamp('driver_requested_at', { withTimezone: true }),
    /** Separa de forma segura o pool geral do broadcast aos próprios. */
    driverRequestTarget: driverRequestTarget('driver_request_target'),
    /** Alvo individual quando driverRequestTarget = SPECIFIC. */
    requestedDriverId: uuid('requested_driver_id'),
    /** O alvo individual recusou; a loja precisa redirecionar explicitamente. */
    driverRequestRefusedAt: timestamp('driver_request_refused_at', { withTimezone: true }),
    driverAssignedAt: timestamp('driver_assigned_at', { withTimezone: true }),
    /** DELIVERY_FAILED: motivo (enum em shared) */
    failReason: text('fail_reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('orders_idempotency_unique').on(t.customerId, t.idempotencyKey),
    index('orders_store_status_idx').on(t.storeId, t.status),
    index('orders_customer_idx').on(t.customerId, t.createdAt),
    index('orders_batch_idx').on(t.batchId),
    index('orders_shift_idx').on(t.shiftId),
  ],
)

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  /** referência solta — produto pode ser apagado depois */
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  nameSnapshot: text('name_snapshot').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
  note: text('note'),
  sortIndex: integer('sort_index').notNull().default(0),
})

export const orderItemOptions = pgTable('order_item_options', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderItemId: uuid('order_item_id').notNull().references(() => orderItems.id, { onDelete: 'cascade' }),
  /** ex: "Tamanho: G" | "Sabor: Calabresa" | "Extra: Borda" */
  label: text('label').notNull(),
  priceCents: integer('price_cents'),
})

export const orderEvents = pgTable('order_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  status: orderStatus('status').notNull(),
  /** CUSTOMER | STORE | SYSTEM */
  actorRole: text('actor_role').notNull(),
  actorId: uuid('actor_id'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

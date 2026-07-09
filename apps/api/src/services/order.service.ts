import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm'
import type { CheckoutInput } from '@delivery/shared/schemas'
import {
  calcDeliveryFee,
  calcItemPrice,
  haversineKm,
  isOpenNow,
  type MenuProduct,
  type Selection,
} from '@delivery/shared/constants'
import type { Db } from '../db/client'
import {
  orderEvents,
  orderItemOptions,
  orderItems,
  orders,
  stores,
  users,
} from '../db/schema'
import { getAddress } from './address.service'
import { getMenuProductsByIds } from './catalog.service'

export class OrderError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  const causeCode = (e as { cause?: { code?: string } })?.cause?.code
  return code === '23505' || causeCode === '23505'
}

type QuotedItem = {
  productId: string
  name: string
  quantity: number
  unitPriceCents: number
  totalCents: number
  note: string | null
  optionLabels: { label: string; priceCents: number | null }[]
}

export type Quote = {
  storeId: string
  items: QuotedItem[]
  subtotalCents: number
  deliveryFeeCents: number | null
  totalCents: number
  distanceKm: number | null
  address: { text: string; reference: string | null; lat: number; lng: number } | null
  problems: string[]
}

function optionLabelsFor(product: MenuProduct, selections: Selection[]) {
  const labels: { label: string; priceCents: number | null }[] = []
  for (const sel of selections) {
    const group = product.groups.find((g) => g.id === sel.groupId)
    if (!group) continue
    for (const oid of sel.optionIds) {
      const opt = group.options.find((o) => o.id === oid)
      if (opt) labels.push({ label: `${group.name}: ${opt.name}`, priceCents: opt.priceCents })
    }
  }
  return labels
}

export async function quoteOrder(db: Db, customerId: string, input: CheckoutInput): Promise<Quote> {
  const problems: string[] = []
  const [store] = await db
    .select()
    .from(stores)
    .where(sql`lower(${stores.slug}) = ${input.storeSlug.toLowerCase()} and ${stores.isActive} = true`)
    .limit(1)
  if (!store) throw new OrderError('Loja não encontrada', 404)
  if (store.isPaused || !isOpenNow(store.openingHours)) problems.push('Loja fechada/pausada no momento')

  const productIds = [...new Set(input.items.map((i) => i.productId))]
  const menuProducts = await getMenuProductsByIds(db, store.id, productIds)
  const byId = new Map(menuProducts.map((p) => [p.id, p]))

  const items: QuotedItem[] = []
  let subtotalCents = 0
  for (const item of input.items) {
    const product = byId.get(item.productId)
    if (!product) {
      problems.push('Produto não encontrado no cardápio')
      continue
    }
    const menuProduct = product as MenuProduct
    const priced = calcItemPrice(menuProduct, item.selections)
    if (!priced.ok) {
      problems.push(`${product.name}: ${priced.error}`)
      continue
    }
    const totalCents = priced.totalCents * item.quantity
    subtotalCents += totalCents
    items.push({
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitPriceCents: priced.totalCents,
      totalCents,
      note: item.note ?? null,
      optionLabels: optionLabelsFor(menuProduct, item.selections),
    })
  }

  if (store.minOrderCents != null && subtotalCents < store.minOrderCents) {
    const min = (store.minOrderCents / 100).toFixed(2).replace('.', ',')
    problems.push(`Pedido mínimo não atingido (mínimo R$ ${min})`)
  }

  let deliveryFeeCents: number | null = null
  let distanceKm: number | null = null
  let address: Quote['address'] = null
  if (input.fulfillment === 'DELIVERY') {
    const addr = input.addressId ? await getAddress(db, customerId, input.addressId) : null
    if (!addr) {
      problems.push('Endereço não encontrado')
    } else {
      address = { text: addr.addressText, reference: addr.reference, lat: addr.lat, lng: addr.lng }
      distanceKm = haversineKm({ lat: store.lat, lng: store.lng }, { lat: addr.lat, lng: addr.lng })
      deliveryFeeCents = calcDeliveryFee(store, distanceKm)
      if (deliveryFeeCents == null) problems.push('Endereço fora do raio de entrega — só retirada')
    }
  }

  const totalCents = subtotalCents + (deliveryFeeCents ?? 0)
  return { storeId: store.id, items, subtotalCents, deliveryFeeCents, totalCents, distanceKm, address, problems }
}

async function findByIdempotency(db: Db, customerId: string, key: string) {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.idempotencyKey, key)))
    .limit(1)
  return row ?? null
}

export async function createOrder(db: Db, customerId: string, input: CheckoutInput) {
  if (input.paymentMethod === 'PIX_ONLINE') {
    throw new OrderError('Pagamento online em breve — use dinheiro ou maquininha', 400)
  }

  const existing = await findByIdempotency(db, customerId, input.idempotencyKey)
  if (existing) return existing

  const quote = await quoteOrder(db, customerId, input)
  if (quote.problems.length > 0) throw new OrderError(quote.problems.join('; '), 409)
  if (quote.items.length === 0) throw new OrderError('Nenhum item válido', 400)

  try {
    return await db.transaction(async (tx) => {
      const [order] = await tx
        .insert(orders)
        .values({
          storeId: quote.storeId,
          customerId,
          fulfillment: input.fulfillment,
          paymentMethod: input.paymentMethod,
          changeForCents: input.paymentMethod === 'CASH' ? (input.changeForCents ?? null) : null,
          subtotalCents: quote.subtotalCents,
          deliveryFeeCents: quote.deliveryFeeCents,
          totalCents: quote.totalCents,
          note: input.note ?? null,
          taxId: input.taxId ?? null,
          addressText: quote.address?.text ?? null,
          addressReference: quote.address?.reference ?? null,
          addressLat: quote.address?.lat ?? null,
          addressLng: quote.address?.lng ?? null,
          distanceKm: quote.distanceKm,
          idempotencyKey: input.idempotencyKey,
        })
        .returning()
      if (!order) throw new OrderError('Falha ao criar pedido', 400)

      for (const [i, item] of quote.items.entries()) {
        const [row] = await tx
          .insert(orderItems)
          .values({
            orderId: order.id,
            productId: item.productId,
            nameSnapshot: item.name,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            totalCents: item.totalCents,
            note: item.note,
            sortIndex: i,
          })
          .returning()
        if (!row) throw new OrderError('Falha ao criar item do pedido', 400)
        if (item.optionLabels.length > 0) {
          await tx.insert(orderItemOptions).values(
            item.optionLabels.map((o) => ({ orderItemId: row.id, label: o.label, priceCents: o.priceCents })),
          )
        }
      }

      await tx.insert(orderEvents).values({
        orderId: order.id,
        status: 'PENDING',
        actorRole: 'CUSTOMER',
        actorId: customerId,
      })
      return order
    })
  } catch (e) {
    if (isUniqueViolation(e)) {
      const raced = await findByIdempotency(db, customerId, input.idempotencyKey)
      if (raced) return raced
    }
    throw e
  }
}

export async function listCustomerOrders(db: Db, customerId: string) {
  return db.select().from(orders).where(eq(orders.customerId, customerId)).orderBy(desc(orders.createdAt)).limit(30)
}

export async function getCustomerOrder(db: Db, customerId: string, orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
    .limit(1)
  if (!order) return null
  const detail = await withDetail(db, order)
  const [store] = await db
    .select({ name: stores.name, phone: stores.phone, slug: stores.slug })
    .from(stores)
    .where(eq(stores.id, order.storeId))
    .limit(1)
  return { ...detail, storeName: store?.name ?? '', storePhone: store?.phone ?? null, storeSlug: store?.slug ?? '' }
}

const ACTIVE_STATUSES = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER', 'OUT_FOR_DELIVERY'] as const

export async function listStoreOrders(db: Db, storeId: string, scope: 'active' | 'done') {
  const rows = await db
    .select({
      order: orders,
      customerName: users.name,
      customerPhone: users.phone,
    })
    .from(orders)
    .innerJoin(users, eq(orders.customerId, users.id))
    .where(and(
      eq(orders.storeId, storeId),
      scope === 'active'
        ? inArray(orders.status, [...ACTIVE_STATUSES])
        : inArray(orders.status, ['DELIVERED', 'DELIVERY_FAILED', 'CANCELLED']),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(scope === 'active' ? 100 : 30)

  const result = []
  for (const r of rows) {
    const [prev] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(
        eq(orders.customerId, r.order.customerId),
        ne(orders.id, r.order.id),
        ne(orders.status, 'CANCELLED'),
        lt(orders.createdAt, r.order.createdAt),
      ))
      .limit(1)
    result.push({ ...r.order, customerName: r.customerName, customerPhone: r.customerPhone, isFirstOrder: !prev })
  }
  return result
}

export async function getStoreOrder(db: Db, storeId: string, orderId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
    .limit(1)
  if (!order) return null
  const [customer] = await db
    .select({ name: users.name, phone: users.phone })
    .from(users)
    .where(eq(users.id, order.customerId))
    .limit(1)
  const detail = await withDetail(db, order)
  return { ...detail, customerName: customer?.name ?? '', customerPhone: customer?.phone ?? null }
}

export async function withDetail(db: Db, order: typeof orders.$inferSelect) {
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(orderItems.sortIndex)
  const optionRows = items.length
    ? await db.select().from(orderItemOptions).where(inArray(orderItemOptions.orderItemId, items.map((i) => i.id)))
    : []
  const events = await db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, order.id))
    .orderBy(orderEvents.createdAt)
  return {
    ...order,
    items: items.map((i) => ({ ...i, options: optionRows.filter((o) => o.orderItemId === i.id) })),
    events,
  }
}

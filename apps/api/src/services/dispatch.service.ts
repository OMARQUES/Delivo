import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { DeliveryFailInput } from '@delivery/shared/schemas'
import type { OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { drivers, orderItems, orders, stores, users } from '../db/schema'
import { addEvent } from './order-status.service'
import { recordOrderLedger } from './finance.service'

export class DispatchError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(message)
  }
}

const ACCEPTABLE: OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER']
const COLLECTIBLE: OrderStatus[] = ['READY', 'AWAITING_DRIVER']

export async function ensureDriverProfile(db: Db, userId: string) {
  await db.insert(drivers).values({ userId }).onConflictDoNothing()
  const [row] = await db.select().from(drivers).where(eq(drivers.userId, userId))
  return row!
}

export async function setAvailability(db: Db, userId: string, isAvailable: boolean) {
  await ensureDriverProfile(db, userId)
  const [row] = await db.update(drivers).set({ isAvailable }).where(eq(drivers.userId, userId)).returning()
  return row!
}

export async function setFcmToken(db: Db, userId: string, token: string) {
  await ensureDriverProfile(db, userId)
  const [row] = await db.update(drivers).set({ fcmToken: token }).where(eq(drivers.userId, userId)).returning()
  return row!
}

export async function setDriverPixKey(db: Db, userId: string, pixKey: string | null) {
  await ensureDriverProfile(db, userId)
  const [row] = await db.update(drivers).set({ pixKey }).where(eq(drivers.userId, userId)).returning()
  return row!
}

export async function listAvailableDeliveries(db: Db, driverUserId: string) {
  const profile = await ensureDriverProfile(db, driverUserId)
  if (!profile.isAvailable) return []
  return db
    .select({
      orderId: orders.id,
      status: orders.status,
      deliveryFeeCents: orders.deliveryFeeCents,
      distanceKm: orders.distanceKm,
      createdAt: orders.createdAt,
      storeName: stores.name,
      storeAddressText: stores.addressText,
      storeLat: stores.lat,
      storeLng: stores.lng,
    })
    .from(orders)
    .innerJoin(stores, eq(orders.storeId, stores.id))
    .where(and(
      isNotNull(orders.driverRequestedAt),
      isNull(orders.driverId),
      isNull(orders.batchId),
      eq(orders.fulfillment, 'DELIVERY'),
      inArray(orders.status, ACCEPTABLE),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(50)
}

async function driverOrderDetail(db: Db, driverUserId: string, orderId: string) {
  const [row] = await db
    .select({
      order: orders,
      storeName: stores.name,
      storeAddressText: stores.addressText,
      storeLat: stores.lat,
      storeLng: stores.lng,
      storePhone: stores.phone,
      customerName: users.name,
      customerPhone: users.phone,
    })
    .from(orders)
    .innerJoin(stores, eq(orders.storeId, stores.id))
    .innerJoin(users, eq(orders.customerId, users.id))
    .where(and(eq(orders.id, orderId), eq(orders.driverId, driverUserId)))
  if (!row) throw new DispatchError('Entrega não encontrada', 404)
  const items = await db
    .select({
      nameSnapshot: orderItems.nameSnapshot,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.sortIndex)
  return {
    ...row.order,
    storeName: row.storeName,
    storeAddressText: row.storeAddressText,
    storeLat: row.storeLat,
    storeLng: row.storeLng,
    storePhone: row.storePhone,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    items,
  }
}

export async function acceptDelivery(db: Db, driverUserId: string, orderId: string) {
  await ensureDriverProfile(db, driverUserId)
  const rows = await db
    .update(orders)
    .set({ driverId: driverUserId, driverAssignedAt: new Date() })
    .where(and(
      eq(orders.id, orderId),
      isNull(orders.driverId),
      isNull(orders.batchId),
      isNotNull(orders.driverRequestedAt),
      eq(orders.fulfillment, 'DELIVERY'),
      inArray(orders.status, ACCEPTABLE),
    ))
    .returning({ id: orders.id, status: orders.status })
  if (rows.length === 0) throw new DispatchError('Pedido já foi pego ou não está disponível', 409)
  await addEvent(db, orderId, rows[0]!.status, 'DRIVER', driverUserId, 'entregador aceitou a entrega')
  return driverOrderDetail(db, driverUserId, orderId)
}

export async function releaseDelivery(db: Db, driverUserId: string, orderId: string) {
  const rows = await db
    .update(orders)
    .set({ driverId: null, driverAssignedAt: null })
    .where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      isNull(orders.batchId),
      inArray(orders.status, ACCEPTABLE),
    ))
    .returning({ id: orders.id, status: orders.status })
  if (rows.length === 0) throw new DispatchError('Não é possível liberar esta entrega', 409)
  await addEvent(db, orderId, rows[0]!.status, 'DRIVER', driverUserId, 'entregador liberou a entrega')
  return rows[0]!
}

export async function collectDelivery(db: Db, driverUserId: string, orderId: string) {
  const rows = await db
    .update(orders)
    .set({ status: 'OUT_FOR_DELIVERY' })
    .where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      isNull(orders.batchId),
      inArray(orders.status, COLLECTIBLE),
    ))
    .returning()
  if (rows.length === 0) throw new DispatchError('Pedido ainda não está pronto para coleta', 409)
  await addEvent(db, orderId, 'OUT_FOR_DELIVERY', 'DRIVER', driverUserId, 'coletado na loja')
  return rows[0]!
}

export async function completeDelivery(db: Db, driverUserId: string, orderId: string) {
  const rows = await db
    .update(orders)
    .set({ status: 'DELIVERED' })
    .where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      eq(orders.status, 'OUT_FOR_DELIVERY'),
    ))
    .returning()
  if (rows.length === 0) throw new DispatchError('Pedido não está em rota', 409)
  await addEvent(db, orderId, 'DELIVERED', 'DRIVER', driverUserId)
  await recordOrderLedger(db, orderId)
  return rows[0]!
}

export async function failDelivery(db: Db, driverUserId: string, orderId: string, input: DeliveryFailInput) {
  const rows = await db
    .update(orders)
    .set({ status: 'DELIVERY_FAILED', failReason: input.reason })
    .where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      eq(orders.status, 'OUT_FOR_DELIVERY'),
    ))
    .returning()
  if (rows.length === 0) throw new DispatchError('Pedido não está em rota', 409)
  await addEvent(db, orderId, 'DELIVERY_FAILED', 'DRIVER', driverUserId, input.note ?? input.reason)
  await recordOrderLedger(db, orderId)
  return rows[0]!
}

const DRIVER_ACTIVE: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER', 'OUT_FOR_DELIVERY']

export async function listDriverDeliveries(db: Db, driverUserId: string, scope: 'active' | 'done') {
  const rows = await db
    .select({
      order: orders,
      storeName: stores.name,
      storeAddressText: stores.addressText,
      storeLat: stores.lat,
      storeLng: stores.lng,
      storePhone: stores.phone,
      customerName: users.name,
      customerPhone: users.phone,
    })
    .from(orders)
    .innerJoin(stores, eq(orders.storeId, stores.id))
    .innerJoin(users, eq(orders.customerId, users.id))
    .where(and(
      eq(orders.driverId, driverUserId),
      scope === 'active'
        ? inArray(orders.status, DRIVER_ACTIVE)
        : inArray(orders.status, ['DELIVERED', 'DELIVERY_FAILED', 'CANCELLED']),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(scope === 'active' ? 50 : 30)
  return rows.map((r) => ({
    ...r.order,
    storeName: r.storeName,
    storeAddressText: r.storeAddressText,
    storeLat: r.storeLat,
    storeLng: r.storeLng,
    storePhone: r.storePhone,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
  }))
}

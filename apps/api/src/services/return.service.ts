import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { orders, stores, users } from '../db/schema'
import { addEvent } from './order-events'
import { recordReturnLedger } from './finance.service'

export class ReturnError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 409) {
    super(message)
  }
}

export async function markDriverReturned(db: Db, driverUserId: string, orderId: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ driverReturnedAt: orders.driverReturnedAt }).from(orders).where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      eq(orders.status, 'DELIVERY_FAILED'),
      isNotNull(orders.returnPendingAt),
      isNull(orders.returnedAt),
    )).for('update')
    if (!order) throw new ReturnError('Devolução pendente não encontrada', 404)
    if (order.driverReturnedAt) throw new ReturnError('Devolução já foi declarada', 409)
    const [marked] = await tx.update(orders).set({ driverReturnedAt: new Date() }).where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      eq(orders.status, 'DELIVERY_FAILED'),
      isNotNull(orders.returnPendingAt),
      isNull(orders.returnedAt),
      isNull(orders.driverReturnedAt),
    )).returning()
    if (!marked) throw new ReturnError('Devolução mudou — recarregue', 409)
    await addEvent(tx, orderId, 'DELIVERY_FAILED', 'DRIVER', driverUserId, 'entregador declarou devolução na loja')
    return marked
  })
}

export async function getDriverPendingReturn(db: Db, driverUserId: string, orderId: string) {
  const [order] = await db.select({
    id: orders.id,
    returnPhotoKeys: orders.returnPhotoKeys,
  }).from(orders).where(and(
    eq(orders.id, orderId),
    eq(orders.driverId, driverUserId),
    eq(orders.status, 'DELIVERY_FAILED'),
    isNotNull(orders.returnPendingAt),
    isNull(orders.returnedAt),
  )).limit(1)
  if (!order) throw new ReturnError('Devolução pendente não encontrada', 404)
  if (order.returnPhotoKeys.length >= 2) throw new ReturnError('Limite de 2 fotos atingido', 400)
  return order
}

export async function appendReturnPhotoKey(db: Db, driverUserId: string, orderId: string, key: string) {
  const [updated] = await db.update(orders).set({
    returnPhotoKeys: sql`${orders.returnPhotoKeys} || ${JSON.stringify([key])}::jsonb`,
  }).where(and(
    eq(orders.id, orderId),
    eq(orders.driverId, driverUserId),
    eq(orders.status, 'DELIVERY_FAILED'),
    isNotNull(orders.returnPendingAt),
    isNull(orders.returnedAt),
    sql`jsonb_array_length(${orders.returnPhotoKeys}) < 2`,
  )).returning({ returnPhotoKeys: orders.returnPhotoKeys })
  if (!updated) throw new ReturnError('Limite de fotos atingido ou devolução encerrada', 400)
  return updated
}

async function confirmReturn(db: Db, orderId: string, actorId: string, storeId?: string) {
  return db.transaction(async (tx) => {
    const filters = [eq(orders.id, orderId)]
    if (storeId) filters.push(eq(orders.storeId, storeId))
    const [order] = await tx.select().from(orders).where(and(...filters)).for('update')
    if (!order) throw new ReturnError('Pedido não encontrado', 404)
    if (order.status !== 'DELIVERY_FAILED' || order.returnPendingAt == null || order.returnedAt != null) {
      throw new ReturnError('Pedido não possui devolução pendente', 409)
    }
    const returnedAt = new Date()
    const [confirmed] = await tx.update(orders).set({ returnedAt, returnConfirmedBy: actorId }).where(and(
      eq(orders.id, orderId),
      eq(orders.status, 'DELIVERY_FAILED'),
      isNotNull(orders.returnPendingAt),
      isNull(orders.returnedAt),
    )).returning()
    if (!confirmed) throw new ReturnError('Devolução já foi confirmada', 409)
    await recordReturnLedger(tx, confirmed)
    await addEvent(
      tx, orderId, 'DELIVERY_FAILED', storeId ? 'STORE' : 'ADMIN', actorId,
      storeId ? 'devolução confirmada pela loja' : 'devolução confirmada pelo suporte',
    )
    return confirmed
  })
}

export function confirmOrderReturn(db: Db, storeId: string, orderId: string, actorId: string) {
  return confirmReturn(db, orderId, actorId, storeId)
}

export function adminConfirmOrderReturn(db: Db, orderId: string, actorId: string) {
  return confirmReturn(db, orderId, actorId)
}

export async function listPendingReturns(db: Db) {
  const rows = await db.select({
    order: orders,
    storeName: stores.name,
    driverName: users.name,
    driverPhone: users.phone,
  }).from(orders)
    .innerJoin(stores, eq(orders.storeId, stores.id))
    .innerJoin(users, eq(orders.driverId, users.id))
    .where(and(
      eq(orders.status, 'DELIVERY_FAILED'),
      isNotNull(orders.returnPendingAt),
      isNull(orders.returnedAt),
    ))
    .orderBy(asc(orders.returnPendingAt))
  const now = Date.now()
  return rows.map((row) => ({
    ...row.order,
    storeName: row.storeName,
    driverName: row.driverName,
    driverPhone: row.driverPhone,
    returnPendingAgeMinutes: Math.max(0, Math.floor((now - row.order.returnPendingAt!.getTime()) / 60_000)),
  }))
}

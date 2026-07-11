import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { orders, stores, users } from '../db/schema'
import { addEvent } from './order-events'
import { recordReturnLedger } from './finance.service'

export class ReturnError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 409) {
    super(message)
  }
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

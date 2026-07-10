import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { deliveryBatches, orderEvents, orders, stores } from '../db/schema'
import { ensureDriverProfile } from './dispatch.service'

export class BatchError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

const BATCHABLE_STATUSES: OrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY']

export async function createBatch(db: Db, storeId: string, orderIds: string[]) {
  const ids = [...new Set(orderIds)].sort()
  if (ids.length < 2) throw new BatchError('Selecione ao menos 2 pedidos', 400)

  return db.transaction(async (tx) => {
    // Lock all candidates in stable order so concurrent builders cannot claim
    // the same order into two different packages.
    const rows = await tx.select().from(orders).where(inArray(orders.id, ids)).orderBy(orders.id).for('update')
    if (rows.length !== ids.length) throw new BatchError('Pedido não encontrado', 404)
    for (const order of rows) {
      if (order.storeId !== storeId) throw new BatchError('Pedido de outra loja', 404)
      if (order.fulfillment !== 'DELIVERY') throw new BatchError('Só pedidos com entrega', 400)
      if (order.driverId) throw new BatchError('Pedido já tem entregador', 409)
      if (order.batchId) throw new BatchError('Pedido já está em um pacote', 409)
      if (!BATCHABLE_STATUSES.includes(order.status)) {
        throw new BatchError(`Pedido não pode ser agrupado (${order.status})`, 409)
      }
    }

    const [batch] = await tx.insert(deliveryBatches).values({ storeId }).returning()
    if (!batch) throw new BatchError('Não foi possível criar o pacote', 409)
    await tx.update(orders).set({ batchId: batch.id }).where(inArray(orders.id, ids))
    return batch
  })
}

export async function broadcastBatch(db: Db, storeId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.storeId, storeId)))
      .for('update')
    if (!batch) throw new BatchError('Pacote não encontrado', 404)
    if (batch.status !== 'OPEN') throw new BatchError('Pacote não está montando', 409)

    const batchOrders = await tx.select({ id: orders.id }).from(orders).where(eq(orders.batchId, batchId))
    if (batchOrders.length < 2) throw new BatchError('Pacote precisa de ao menos 2 pedidos', 400)

    const now = new Date()
    const [updated] = await tx.update(deliveryBatches)
      .set({ status: 'PENDING', updatedAt: now })
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.status, 'OPEN')))
      .returning()
    if (!updated) throw new BatchError('Pacote mudou — recarregue', 409)
    await tx.update(orders).set({ driverRequestedAt: now }).where(eq(orders.batchId, batchId))
    return updated
  })
}

export async function cancelBatch(db: Db, storeId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.storeId, storeId)))
      .for('update')
    if (!batch) throw new BatchError('Pacote não encontrado', 404)
    if (batch.status !== 'OPEN' && batch.status !== 'PENDING') {
      throw new BatchError('Pacote não pode ser cancelado agora', 409)
    }

    await tx.update(orders)
      .set({ batchId: null, driverRequestedAt: null })
      .where(eq(orders.batchId, batchId))
    const [updated] = await tx.update(deliveryBatches)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(and(eq(deliveryBatches.id, batchId), inArray(deliveryBatches.status, ['OPEN', 'PENDING'])))
      .returning()
    if (!updated) throw new BatchError('Pacote mudou — recarregue', 409)
    return updated
  })
}

/** Pacotes ativos da loja, com pedidos e soma dos fretes. */
export async function listStoreBatches(db: Db, storeId: string) {
  const batches = await db.select().from(deliveryBatches)
    .where(and(
      eq(deliveryBatches.storeId, storeId),
      inArray(deliveryBatches.status, ['OPEN', 'PENDING', 'ACCEPTED']),
    ))
    .orderBy(desc(deliveryBatches.createdAt))
  const result = []
  for (const batch of batches) {
    const batchOrders = await db.select({
      id: orders.id,
      status: orders.status,
      deliveryFeeCents: orders.deliveryFeeCents,
      addressText: orders.addressText,
    }).from(orders).where(eq(orders.batchId, batch.id))
    result.push({
      ...batch,
      count: batchOrders.length,
      orders: batchOrders,
      feeTotalCents: batchOrders.reduce((sum, order) => sum + (order.deliveryFeeCents ?? 0), 0),
    })
  }
  return result
}

export async function listAvailableBatches(db: Db, driverUserId: string) {
  const profile = await ensureDriverProfile(db, driverUserId)
  if (!profile.isAvailable) return []
  const batches = await db.select({
    batch: deliveryBatches,
    storeName: stores.name,
    storeAddressText: stores.addressText,
    storeLat: stores.lat,
    storeLng: stores.lng,
  }).from(deliveryBatches)
    .innerJoin(stores, eq(deliveryBatches.storeId, stores.id))
    .where(eq(deliveryBatches.status, 'PENDING'))
    .orderBy(desc(deliveryBatches.createdAt))
  const result = []
  for (const row of batches) {
    const batchOrders = await db.select({
      deliveryFeeCents: orders.deliveryFeeCents,
    }).from(orders).where(eq(orders.batchId, row.batch.id))
    result.push({
      batchId: row.batch.id,
      storeId: row.batch.storeId,
      storeName: row.storeName,
      storeAddressText: row.storeAddressText,
      storeLat: row.storeLat,
      storeLng: row.storeLng,
      count: batchOrders.length,
      feeTotalCents: batchOrders.reduce((sum, order) => sum + (order.deliveryFeeCents ?? 0), 0),
      createdAt: row.batch.createdAt,
    })
  }
  return result
}

export async function acceptBatch(db: Db, driverUserId: string, batchId: string) {
  const profile = await ensureDriverProfile(db, driverUserId)
  if (!profile.isAvailable) throw new BatchError('Fique disponível para aceitar pacotes', 409)

  return db.transaction(async (tx) => {
    const now = new Date()
    const [claimed] = await tx.update(deliveryBatches)
      .set({ driverId: driverUserId, status: 'ACCEPTED', updatedAt: now })
      .where(and(
        eq(deliveryBatches.id, batchId),
        isNull(deliveryBatches.driverId),
        eq(deliveryBatches.status, 'PENDING'),
      ))
      .returning()
    if (!claimed) throw new BatchError('Pacote já foi pego ou não está disponível', 409)

    const assigned = await tx.update(orders)
      .set({ driverId: driverUserId, driverAssignedAt: now })
      .where(eq(orders.batchId, batchId))
      .returning({ id: orders.id, status: orders.status })
    if (assigned.length === 0) throw new BatchError('Pacote sem pedidos ativos', 409)
    await tx.insert(orderEvents).values(assigned.map((order) => ({
      orderId: order.id,
      status: order.status,
      actorRole: 'DRIVER',
      actorId: driverUserId,
      note: 'entregador aceitou o pacote',
    })))
    return claimed
  })
}

export async function releaseBatch(db: Db, driverUserId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(
        eq(deliveryBatches.id, batchId),
        eq(deliveryBatches.driverId, driverUserId),
        eq(deliveryBatches.status, 'ACCEPTED'),
      ))
      .for('update')
    if (!batch) throw new BatchError('Pacote não pode ser liberado', 409)

    const released = await tx.update(orders)
      .set({ driverId: null, driverAssignedAt: null })
      .where(eq(orders.batchId, batchId))
      .returning({ id: orders.id, status: orders.status })
    const [updated] = await tx.update(deliveryBatches)
      .set({ driverId: null, status: 'PENDING', updatedAt: new Date() })
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.status, 'ACCEPTED')))
      .returning()
    if (!updated) throw new BatchError('Pacote mudou — recarregue', 409)
    if (released.length > 0) {
      await tx.insert(orderEvents).values(released.map((order) => ({
        orderId: order.id,
        status: order.status,
        actorRole: 'DRIVER',
        actorId: driverUserId,
        note: 'entregador liberou o pacote',
      })))
    }
    return updated
  })
}

export async function collectBatch(db: Db, driverUserId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(
        eq(deliveryBatches.id, batchId),
        eq(deliveryBatches.driverId, driverUserId),
        eq(deliveryBatches.status, 'ACCEPTED'),
      ))
      .for('update')
    if (!batch) throw new BatchError('Pacote não encontrado', 404)

    const batchOrders = await tx.select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.batchId, batchId))
      .for('update')
    if (batchOrders.length === 0) throw new BatchError('Pacote sem pedidos ativos', 409)
    if (!batchOrders.every((order) => order.status === 'READY')) {
      throw new BatchError('Aguarde todos os pedidos ficarem prontos', 409)
    }

    const collected = await tx.update(orders)
      .set({ status: 'OUT_FOR_DELIVERY' })
      .where(and(eq(orders.batchId, batchId), eq(orders.status, 'READY')))
      .returning({ id: orders.id })
    if (collected.length !== batchOrders.length) throw new BatchError('Pedidos mudaram — recarregue', 409)
    await tx.insert(orderEvents).values(collected.map((order) => ({
      orderId: order.id,
      status: 'OUT_FOR_DELIVERY' as const,
      actorRole: 'DRIVER',
      actorId: driverUserId,
      note: 'coletado (pacote)',
    })))
    const [updated] = await tx.update(deliveryBatches)
      .set({ status: 'COLLECTED', updatedAt: new Date() })
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.status, 'ACCEPTED')))
      .returning()
    if (!updated) throw new BatchError('Pacote mudou — recarregue', 409)
    return { ...updated, collected: collected.length }
  })
}

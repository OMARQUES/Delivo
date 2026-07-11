import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import type { DriverRequestTarget, OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { deliveryBatches, driverShifts, orderEvents, orders, storeDrivers, stores, users } from '../db/schema'
import { ensureDriverProfile } from './dispatch.service'
import { getActiveShift } from './shift.service'

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

export async function broadcastBatch(
  db: Db,
  storeId: string,
  batchId: string,
  opts: { target: DriverRequestTarget; requestedDriverId?: string } = { target: 'GENERAL' },
) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(deliveryBatches)
      .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.storeId, storeId)))
      .for('update')
    if (!batch) throw new BatchError('Pacote não encontrado', 404)
    if (batch.status !== 'OPEN' && batch.status !== 'PENDING') throw new BatchError('Pacote não pode ser redirecionado', 409)
    if (batch.status === 'PENDING' && batch.target === 'GENERAL' && opts.target !== 'GENERAL') {
      throw new BatchError('Pacote já foi enviado ao pool geral', 409)
    }
    if (opts.target === 'SPECIFIC') {
      if (!opts.requestedDriverId) throw new BatchError('Escolha o entregador', 400)
      const [active] = await tx.select({ id: driverShifts.id }).from(driverShifts)
        .innerJoin(storeDrivers, and(eq(storeDrivers.storeId, driverShifts.storeId), eq(storeDrivers.driverUserId, driverShifts.driverUserId)))
        .where(and(
        eq(driverShifts.storeId, storeId),
        eq(driverShifts.driverUserId, opts.requestedDriverId),
        eq(driverShifts.status, 'ACTIVE'),
        eq(storeDrivers.status, 'CONFIRMED'),
        or(isNull(storeDrivers.expiresAt), gt(storeDrivers.expiresAt, new Date())),
      )).limit(1)
      if (!active) throw new BatchError('Entregador não está em turno nesta loja', 409)
    }

    const batchOrders = await tx.select({ id: orders.id }).from(orders).where(eq(orders.batchId, batchId))
    if (batchOrders.length < 2) throw new BatchError('Pacote precisa de ao menos 2 pedidos', 400)

    const now = new Date()
    const [updated] = await tx.update(deliveryBatches)
      .set({
        status: 'PENDING', target: opts.target,
        requestedDriverId: opts.target === 'SPECIFIC' ? opts.requestedDriverId : null,
        refusedAt: null, updatedAt: now,
      })
      .where(and(
        eq(deliveryBatches.id, batchId),
        isNull(deliveryBatches.driverId),
        inArray(deliveryBatches.status, ['OPEN', 'PENDING']),
      ))
      .returning()
    if (!updated) throw new BatchError('Pacote mudou — recarregue', 409)
    await tx.update(orders).set({
      driverRequestedAt: now,
      driverRequestTarget: opts.target,
      requestedDriverId: null,
      driverRequestRefusedAt: null,
    }).where(eq(orders.batchId, batchId))
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
      .set({
        batchId: null, driverRequestedAt: null, driverRequestTarget: null,
        requestedDriverId: null, driverRequestRefusedAt: null, shiftId: null,
      })
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
  if (await getActiveShift(db, driverUserId)) return []
  const batches = await db.select({
    batch: deliveryBatches,
    storeName: stores.name,
    storeAddressText: stores.addressText,
    storeLat: stores.lat,
    storeLng: stores.lng,
  }).from(deliveryBatches)
    .innerJoin(stores, eq(deliveryBatches.storeId, stores.id))
    .where(and(eq(deliveryBatches.status, 'PENDING'), eq(deliveryBatches.target, 'GENERAL')))
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

export async function listShiftBatches(db: Db, driverUserId: string) {
  const [shift] = await db.select().from(driverShifts).where(and(
    eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.status, 'ACTIVE'),
  )).limit(1)
  if (!shift) return []
  const rows = await db.select({
    batch: deliveryBatches,
    storeName: stores.name,
    storeAddressText: stores.addressText,
  }).from(deliveryBatches).innerJoin(stores, eq(deliveryBatches.storeId, stores.id)).where(and(
    eq(deliveryBatches.storeId, shift.storeId),
    eq(deliveryBatches.status, 'PENDING'),
    isNull(deliveryBatches.refusedAt),
    or(
      eq(deliveryBatches.target, 'OWN'),
      and(eq(deliveryBatches.target, 'SPECIFIC'), eq(deliveryBatches.requestedDriverId, driverUserId)),
    ),
  )).orderBy(desc(deliveryBatches.createdAt))
  const result = []
  for (const row of rows) {
    const batchOrders = await db.select({ deliveryFeeCents: orders.deliveryFeeCents })
      .from(orders).where(eq(orders.batchId, row.batch.id))
    result.push({
      batchId: row.batch.id,
      storeId: row.batch.storeId,
      storeName: row.storeName,
      storeAddressText: row.storeAddressText,
      target: row.batch.target,
      requestedDriverId: row.batch.requestedDriverId,
      direct: row.batch.target === 'SPECIFIC',
      count: batchOrders.length,
      feeTotalCents: batchOrders.reduce((sum, order) => sum + (order.deliveryFeeCents ?? 0), 0),
      estimatedExtraCents: batchOrders.length * shift.perDeliveryCents,
      createdAt: row.batch.createdAt,
    })
  }
  return result
}

export async function acceptBatch(db: Db, driverUserId: string, batchId: string) {
  const profile = await ensureDriverProfile(db, driverUserId)

  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
    const [activeShift] = await tx.select().from(driverShifts).where(and(
      eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.status, 'ACTIVE'),
    )).for('update')
    if (!activeShift && !profile.isAvailable) throw new BatchError('Fique disponível para aceitar pacotes', 409)
    const now = new Date()
    const [claimed] = await tx.update(deliveryBatches)
      .set({ driverId: driverUserId, status: 'ACCEPTED', updatedAt: now })
      .where(and(
        eq(deliveryBatches.id, batchId),
        isNull(deliveryBatches.driverId),
        eq(deliveryBatches.status, 'PENDING'),
        activeShift
          ? and(
              eq(deliveryBatches.storeId, activeShift.storeId),
              isNull(deliveryBatches.refusedAt),
              or(
                eq(deliveryBatches.target, 'OWN'),
                and(eq(deliveryBatches.target, 'SPECIFIC'), eq(deliveryBatches.requestedDriverId, driverUserId)),
              ),
            )
          : eq(deliveryBatches.target, 'GENERAL'),
      ))
      .returning()
    if (!claimed) throw new BatchError('Pacote já foi pego ou não está disponível', 409)

    const assigned = await tx.update(orders)
      .set({ driverId: driverUserId, driverAssignedAt: now, shiftId: activeShift?.id ?? null })
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
      .set({ driverId: null, driverAssignedAt: null, shiftId: null })
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

export async function refuseBatch(db: Db, driverUserId: string, batchId: string) {
  const [refused] = await db.update(deliveryBatches).set({ refusedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(deliveryBatches.id, batchId),
    eq(deliveryBatches.status, 'PENDING'),
    eq(deliveryBatches.target, 'SPECIFIC'),
    eq(deliveryBatches.requestedDriverId, driverUserId),
    isNull(deliveryBatches.driverId),
    isNull(deliveryBatches.refusedAt),
  )).returning()
  if (!refused) throw new BatchError('Pacote não está direcionado a você', 409)
  return refused
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

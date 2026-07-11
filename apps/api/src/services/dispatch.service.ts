import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import type { DeliveryFailInput, DriverArrivalInput } from '@delivery/shared/schemas'
import type { OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import type { PaymentProvider } from '../lib/payment-provider'
import { driverShifts, drivers, orderItems, orders, stores, users } from '../db/schema'
import { addEvent } from './order-status.service'
import { recordHalfFee, recordOrderLedger } from './finance.service'
import { refundOrderPaymentIfAny } from './payment.service'
import { toActiveDriverDelivery, toDriverHistoryDelivery } from './driver-delivery.dto'

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
  const [activeShift] = await db.select({ id: driverShifts.id }).from(driverShifts)
    .where(and(eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.status, 'ACTIVE'))).limit(1)
  if (activeShift) return []
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
      eq(orders.driverRequestTarget, 'GENERAL'),
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
  return toActiveDriverDelivery(row, items)
}

export async function acceptDelivery(db: Db, driverUserId: string, orderId: string) {
  await ensureDriverProfile(db, driverUserId)
  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, driverUserId)).for('update')
    const [activeShift] = await tx.select({ id: driverShifts.id }).from(driverShifts)
      .where(and(eq(driverShifts.driverUserId, driverUserId), eq(driverShifts.status, 'ACTIVE'))).limit(1)
    if (activeShift) throw new DispatchError('Encerre o turno antes de aceitar pedidos do pool geral', 409)
    const [accepted] = await tx.update(orders).set({ driverId: driverUserId, driverAssignedAt: new Date() }).where(and(
      eq(orders.id, orderId),
      isNull(orders.driverId),
      isNull(orders.batchId),
      isNotNull(orders.driverRequestedAt),
      eq(orders.driverRequestTarget, 'GENERAL'),
      eq(orders.fulfillment, 'DELIVERY'),
      inArray(orders.status, ACCEPTABLE),
    )).returning({ id: orders.id, status: orders.status })
    if (!accepted) throw new DispatchError('Pedido já foi pego ou não está disponível', 409)
    await addEvent(tx, orderId, accepted.status, 'DRIVER', driverUserId, 'entregador aceitou a entrega')
  })
  return driverOrderDetail(db, driverUserId, orderId)
}

export async function releaseDelivery(db: Db, driverUserId: string, orderId: string) {
  const rows = await db
    .update(orders)
    .set({ driverId: null, driverAssignedAt: null, shiftId: null, driverArrivedAt: null })
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

export async function listShiftDeliveries(db: Db, driverUserId: string) {
  const [shift] = await db.select().from(driverShifts).where(and(
    eq(driverShifts.driverUserId, driverUserId),
    eq(driverShifts.status, 'ACTIVE'),
  )).limit(1)
  if (!shift) return []
  return db.select({
    orderId: orders.id,
    status: orders.status,
    deliveryFeeCents: orders.deliveryFeeCents,
    perDeliveryCents: driverShifts.perDeliveryCents,
    driverRequestTarget: orders.driverRequestTarget,
    requestedDriverId: orders.requestedDriverId,
    distanceKm: orders.distanceKm,
    createdAt: orders.createdAt,
    storeName: stores.name,
    storeAddressText: stores.addressText,
    storeLat: stores.lat,
    storeLng: stores.lng,
  }).from(orders)
    .innerJoin(stores, eq(orders.storeId, stores.id))
    .innerJoin(driverShifts, eq(driverShifts.id, shift.id))
    .where(and(
      eq(orders.storeId, shift.storeId),
      or(
        eq(orders.driverRequestTarget, 'OWN'),
        and(eq(orders.driverRequestTarget, 'SPECIFIC'), eq(orders.requestedDriverId, driverUserId)),
      ),
      isNull(orders.driverRequestRefusedAt),
      isNotNull(orders.driverRequestedAt),
      isNull(orders.driverId),
      isNull(orders.batchId),
      eq(orders.fulfillment, 'DELIVERY'),
      inArray(orders.status, ACCEPTABLE),
    ))
    .orderBy(desc(orders.createdAt)).limit(50)
}

export async function acceptShiftDelivery(db: Db, driverUserId: string, orderId: string) {
  await db.transaction(async (tx) => {
    const [shift] = await tx.select().from(driverShifts).where(and(
      eq(driverShifts.driverUserId, driverUserId),
      eq(driverShifts.status, 'ACTIVE'),
    )).for('update')
    if (!shift) throw new DispatchError('Inicie um turno para aceitar esta entrega', 409)
    const [accepted] = await tx.update(orders).set({
      driverId: driverUserId,
      shiftId: shift.id,
      driverAssignedAt: new Date(),
    }).where(and(
      eq(orders.id, orderId),
      eq(orders.storeId, shift.storeId),
      or(
        eq(orders.driverRequestTarget, 'OWN'),
        and(eq(orders.driverRequestTarget, 'SPECIFIC'), eq(orders.requestedDriverId, driverUserId)),
      ),
      isNull(orders.driverRequestRefusedAt),
      isNull(orders.driverId),
      isNull(orders.batchId),
      isNotNull(orders.driverRequestedAt),
      eq(orders.fulfillment, 'DELIVERY'),
      inArray(orders.status, ACCEPTABLE),
    )).returning({ id: orders.id, status: orders.status })
    if (!accepted) throw new DispatchError('Pedido já foi pego ou não está disponível para este turno', 409)
    await addEvent(tx, orderId, accepted.status, 'DRIVER', driverUserId, 'entregador próprio aceitou a entrega')
  })
  return driverOrderDetail(db, driverUserId, orderId)
}

export async function refuseDirectDelivery(db: Db, driverUserId: string, orderId: string) {
  return db.transaction(async (tx) => {
    const [refused] = await tx.update(orders).set({ driverRequestRefusedAt: new Date() }).where(and(
      eq(orders.id, orderId),
      eq(orders.driverRequestTarget, 'SPECIFIC'),
      eq(orders.requestedDriverId, driverUserId),
      isNull(orders.driverId),
      isNull(orders.batchId),
      isNull(orders.driverRequestRefusedAt),
    )).returning({ id: orders.id, status: orders.status, driverRequestRefusedAt: orders.driverRequestRefusedAt })
    if (!refused) throw new DispatchError('Pedido não está direcionado a você', 409)
    await addEvent(tx, orderId, refused.status, 'DRIVER', driverUserId, 'entregador recusou o direcionamento')
    return refused
  })
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

export async function confirmArrival(db: Db, driverUserId: string, orderId: string, gps: DriverArrivalInput) {
  return db.transaction(async (tx) => {
    const [arrived] = await tx.update(orders).set({ driverArrivedAt: new Date() }).where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      isNull(orders.batchId),
      isNull(orders.driverArrivedAt),
      inArray(orders.status, ACCEPTABLE),
    )).returning()
    if (!arrived) throw new DispatchError('Não é possível confirmar chegada para este pedido', 409)
    const coords = gps.lat != null && gps.lng != null ? ` (${gps.lat.toFixed(6)},${gps.lng.toFixed(6)})` : ''
    await addEvent(tx, orderId, arrived.status, 'DRIVER', driverUserId, `chegou na loja${coords}`)
    return arrived
  })
}

export async function storeReleaseDriver(db: Db, storeId: string, orderId: string, actorId: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, orderId), eq(orders.storeId, storeId),
    )).for('update')
    if (!order) throw new DispatchError('Pedido não encontrado', 404)
    if (order.batchId) throw new DispatchError('Desvincule o pacote inteiro pelo fluxo de pacotes', 409)
    if (!order.driverId || !ACCEPTABLE.includes(order.status)) {
      throw new DispatchError('Entregador não pode mais ser desvinculado', 409)
    }
    const releasedDriverId = order.driverId
    const halfFee = order.shiftId == null && order.driverArrivedAt != null
      ? Math.round((order.deliveryFeeCents ?? 0) / 2)
      : 0
    const nextStatus = order.status === 'AWAITING_DRIVER' ? 'READY' as const : order.status
    const [released] = await tx.update(orders).set({
      status: nextStatus,
      driverId: null, driverAssignedAt: null, shiftId: null, driverArrivedAt: null,
      driverRequestedAt: null, driverRequestTarget: null,
      requestedDriverId: null, driverRequestRefusedAt: null,
    }).where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, releasedDriverId),
      inArray(orders.status, ACCEPTABLE),
    )).returning()
    if (!released) throw new DispatchError('Pedido mudou — recarregue', 409)
    await recordHalfFee(tx, { orderId, storeId, driverUserId: releasedDriverId, amountCents: halfFee })
    await addEvent(
      tx, orderId, nextStatus, 'STORE', actorId,
      halfFee > 0 ? 'entregador desvinculado após chegada (meia-taxa)' : 'entregador desvinculado',
    )
    return released
  })
}

export async function completeDelivery(db: Db, driverUserId: string, orderId: string) {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({ shiftId: orders.shiftId }).from(orders).where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      eq(orders.status, 'OUT_FOR_DELIVERY'),
    )).limit(1)
    if (!candidate) throw new DispatchError('Pedido não está em rota', 409)
    // Ordem global dos locks: turno -> pedido. O aceite de reajuste usa a mesma
    // ordem, evitando que reajuste e conclusão creditem o mesmo pedido duas vezes.
    if (candidate.shiftId) {
      await tx.select({ id: driverShifts.id }).from(driverShifts)
        .where(eq(driverShifts.id, candidate.shiftId)).for('update')
    }
    const [delivered] = await tx.update(orders).set({ status: 'DELIVERED' }).where(and(
      eq(orders.id, orderId),
      eq(orders.driverId, driverUserId),
      eq(orders.status, 'OUT_FOR_DELIVERY'),
    )).returning()
    if (!delivered) throw new DispatchError('Pedido não está em rota', 409)
    await addEvent(tx, orderId, 'DELIVERED', 'DRIVER', driverUserId)
    await recordOrderLedger(tx, orderId)
    return delivered
  })
}

export async function failDelivery(
  db: Db,
  driverUserId: string,
  orderId: string,
  input: DeliveryFailInput,
  provider: PaymentProvider | null = null,
) {
  const [existing] = await db.select().from(orders).where(and(
    eq(orders.id, orderId), eq(orders.driverId, driverUserId),
  )).limit(1)
  let failed = existing
  if (existing?.status !== 'DELIVERY_FAILED' || existing.returnPendingAt == null) {
    failed = await db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(orders).where(and(
        eq(orders.id, orderId), eq(orders.driverId, driverUserId), eq(orders.status, 'OUT_FOR_DELIVERY'),
      )).limit(1)
      if (!candidate) throw new DispatchError('Pedido não está em rota', 409)
      let returnDriverPayCents = candidate.deliveryFeeCents ?? 0
      if (candidate.shiftId) {
        const [shift] = await tx.select().from(driverShifts).where(eq(driverShifts.id, candidate.shiftId)).for('update')
        if (shift && shift.storeId === candidate.storeId && shift.driverUserId === driverUserId) {
          returnDriverPayCents = shift.perDeliveryCents
        }
      }
      const now = new Date()
      const [updated] = await tx.update(orders).set({
        status: 'DELIVERY_FAILED', failReason: input.reason,
        returnPendingAt: now, returnDriverPayCents,
      }).where(and(
        eq(orders.id, orderId), eq(orders.driverId, driverUserId), eq(orders.status, 'OUT_FOR_DELIVERY'),
      )).returning()
      if (!updated) throw new DispatchError('Pedido não está em rota', 409)
      await addEvent(tx, orderId, 'DELIVERY_FAILED', 'DRIVER', driverUserId, input.note ?? input.reason)
      return updated
    })
  }
  if (!failed) throw new DispatchError('Pedido não está em rota', 409)
  await refundOrderPaymentIfAny(db, provider, orderId, {
    status: 'DELIVERY_FAILED', note: 'pagamento estornado após falha de entrega',
  })
  return failed
}

const DRIVER_ACTIVE: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'AWAITING_DRIVER', 'OUT_FOR_DELIVERY']

export async function listDriverDeliveries(db: Db, driverUserId: string, scope: 'active' | 'done' | 'returns') {
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
        : scope === 'done'
          ? inArray(orders.status, ['DELIVERED', 'DELIVERY_FAILED', 'CANCELLED'])
          : and(eq(orders.status, 'DELIVERY_FAILED'), isNotNull(orders.returnPendingAt), isNull(orders.returnedAt)),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(scope === 'active' ? 50 : scope === 'done' ? 30 : 500)
  return rows.map((row) => scope === 'active'
    ? toActiveDriverDelivery(row, [])
    : toDriverHistoryDelivery(row))
}

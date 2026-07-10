import { and, eq, inArray } from 'drizzle-orm'
import type { LedgerEntryType } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { driverShifts, ledgerEntries, orders, stores } from '../db/schema'

type LedgerInput = {
  party: 'STORE' | 'DRIVER'
  type: LedgerEntryType
  amountCents: number
  description: string
  uniqueKey: string
  orderId: string | null
  storeId?: string | null
  driverId?: string | null
}

const ONLINE = new Set(['PIX_ONLINE', 'CARD_ONLINE'])

function commissionCents(subtotalCents: number, commissionBps: number) {
  return Math.round((subtotalCents * commissionBps) / 10_000)
}

export type LedgerWriter = Pick<Db, 'insert'>
type LedgerDb = Pick<Db, 'select' | 'insert'>

async function insertEntries(db: LedgerWriter, entries: LedgerInput[]) {
  for (const entry of entries) {
    await db.insert(ledgerEntries).values(entry).onConflictDoNothing()
  }
}

export async function recordOrderLedger(db: LedgerDb, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) return []
  if (order.status !== 'DELIVERED' && order.status !== 'DELIVERY_FAILED') return []

  const [store] = await db.select({ commissionBps: stores.commissionBps }).from(stores).where(eq(stores.id, order.storeId)).limit(1)
  const commission = commissionCents(order.subtotalCents, store?.commissionBps ?? 0)
  const deliveryFee = order.deliveryFeeCents ?? 0
  const [loadedShift] = order.shiftId
    ? await db.select().from(driverShifts).where(eq(driverShifts.id, order.shiftId)).limit(1)
    : []
  const shift = loadedShift
    && loadedShift.storeId === order.storeId
    && loadedShift.driverUserId === order.driverId
    ? loadedShift
    : null
  const entries: LedgerInput[] = []

  if (order.status === 'DELIVERED') {
    if (ONLINE.has(order.paymentMethod)) {
      const storeCredit = order.subtotalCents - commission + (order.driverId && !shift ? 0 : deliveryFee)
      if (storeCredit > 0) {
        entries.push({
          party: 'STORE',
          type: 'STORE_SALE_CREDIT',
          amountCents: storeCredit,
          description: 'Repasse líquido da venda online',
          uniqueKey: `${order.id}:store-sale-credit`,
          orderId: order.id,
          storeId: order.storeId,
        })
      }
    } else {
      if (commission > 0) {
        entries.push({
          party: 'STORE',
          type: 'STORE_COMMISSION_DEBIT',
          amountCents: -commission,
          description: 'Comissão da plataforma',
          uniqueKey: `${order.id}:store-commission-debit`,
          orderId: order.id,
          storeId: order.storeId,
        })
      }
      if (order.driverId && !shift && deliveryFee > 0) {
        entries.push({
          party: 'STORE',
          type: 'STORE_DRIVER_FEE_DEBIT',
          amountCents: -deliveryFee,
          description: 'Frete do entregador',
          uniqueKey: `${order.id}:store-driver-fee-debit`,
          orderId: order.id,
          storeId: order.storeId,
        })
      }
    }
  }

  if (order.driverId && !shift && deliveryFee > 0) {
    entries.push({
      party: 'DRIVER',
      type: 'DRIVER_DELIVERY_CREDIT',
      amountCents: deliveryFee,
      description: order.status === 'DELIVERY_FAILED' ? 'Frete de entrega não realizada' : 'Frete do entregador',
      uniqueKey: `${order.id}:driver-delivery-credit`,
      orderId: order.id,
      driverId: order.driverId,
    })
  }

  if (order.status === 'DELIVERED' && shift && order.driverId && shift.perDeliveryCents > 0) {
    entries.push(
      {
        party: 'DRIVER',
        type: 'DRIVER_PER_DELIVERY_CREDIT',
        amountCents: shift.perDeliveryCents,
        description: 'Extra por entrega',
        uniqueKey: `${order.id}:driver-per-delivery`,
        orderId: order.id,
        driverId: order.driverId,
      },
      {
        party: 'STORE',
        type: 'STORE_PER_DELIVERY_DEBIT',
        amountCents: -shift.perDeliveryCents,
        description: 'Extra por entrega (entregador fixo)',
        uniqueKey: `${order.id}:store-per-delivery`,
        orderId: order.id,
        storeId: order.storeId,
      },
    )
  }

  await insertEntries(db, entries)
  return db.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, order.id))
}

export async function recordShiftDaily(
  db: LedgerWriter,
  shift: { id: string; storeId: string; driverUserId: string; dailyRateCents: number },
) {
  if (shift.dailyRateCents <= 0) return
  await insertEntries(db, [
    {
      party: 'DRIVER',
      type: 'DRIVER_DAILY_RATE_CREDIT',
      amountCents: shift.dailyRateCents,
      description: 'Diária do turno',
      uniqueKey: `${shift.id}:driver-daily`,
      orderId: null,
      driverId: shift.driverUserId,
    },
    {
      party: 'STORE',
      type: 'STORE_DAILY_RATE_DEBIT',
      amountCents: -shift.dailyRateCents,
      description: 'Diária do entregador',
      uniqueKey: `${shift.id}:store-daily`,
      orderId: null,
      storeId: shift.storeId,
    },
  ])
}

/**
 * Faz cada pedido entregue chegar ao novo valor total de extra. O saldo é lido
 * do ledger, não do valor anterior do turno: assim funciona mesmo após ajustes
 * não retroativos e vários valores históricos no mesmo turno.
 */
export async function recordPerDeliveryAdjustment(
  db: LedgerDb,
  input: {
    seq: number
    storeId: string
    driverUserId: string
    orderIds: string[]
    targetPerDeliveryCents: number
  },
) {
  if (input.orderIds.length === 0) return
  const credits = await db.select({
    orderId: ledgerEntries.orderId,
    amountCents: ledgerEntries.amountCents,
  }).from(ledgerEntries).where(and(
    inArray(ledgerEntries.orderId, input.orderIds),
    eq(ledgerEntries.party, 'DRIVER'),
    eq(ledgerEntries.type, 'DRIVER_PER_DELIVERY_CREDIT'),
    eq(ledgerEntries.driverId, input.driverUserId),
  ))
  const paidByOrder = new Map<string, number>()
  for (const credit of credits) {
    if (credit.orderId) paidByOrder.set(
      credit.orderId,
      (paidByOrder.get(credit.orderId) ?? 0) + credit.amountCents,
    )
  }
  const entries: LedgerInput[] = []
  for (const orderId of input.orderIds) {
    const delta = input.targetPerDeliveryCents - (paidByOrder.get(orderId) ?? 0)
    if (delta === 0) continue
    entries.push(
      {
        party: 'DRIVER', type: 'DRIVER_PER_DELIVERY_CREDIT', amountCents: delta,
        description: 'Ajuste de extra por entrega',
        uniqueKey: `${orderId}:driver-per-delivery-adj:v${input.seq}`,
        orderId, driverId: input.driverUserId,
      },
      {
        party: 'STORE', type: 'STORE_PER_DELIVERY_DEBIT', amountCents: -delta,
        description: 'Ajuste de extra por entrega (entregador fixo)',
        uniqueKey: `${orderId}:store-per-delivery-adj:v${input.seq}`,
        orderId, storeId: input.storeId,
      },
    )
  }
  await insertEntries(db, entries)
}

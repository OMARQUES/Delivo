import { eq } from 'drizzle-orm'
import type { LedgerEntryType } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { ledgerEntries, orders, stores } from '../db/schema'

type LedgerInput = {
  party: 'STORE' | 'DRIVER'
  type: LedgerEntryType
  amountCents: number
  description: string
  uniqueKey: string
  orderId: string
  storeId?: string | null
  driverId?: string | null
}

const ONLINE = new Set(['PIX_ONLINE', 'CARD_ONLINE'])

function commissionCents(subtotalCents: number, commissionBps: number) {
  return Math.round((subtotalCents * commissionBps) / 10_000)
}

async function insertEntries(db: Db, entries: LedgerInput[]) {
  for (const entry of entries) {
    await db.insert(ledgerEntries).values(entry).onConflictDoNothing()
  }
}

export async function recordOrderLedger(db: Db, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) return []
  if (order.status !== 'DELIVERED' && order.status !== 'DELIVERY_FAILED') return []

  const [store] = await db.select({ commissionBps: stores.commissionBps }).from(stores).where(eq(stores.id, order.storeId)).limit(1)
  const commission = commissionCents(order.subtotalCents, store?.commissionBps ?? 0)
  const deliveryFee = order.deliveryFeeCents ?? 0
  const entries: LedgerInput[] = []

  if (order.status === 'DELIVERED') {
    if (ONLINE.has(order.paymentMethod)) {
      const storeCredit = order.subtotalCents - commission + (order.driverId ? 0 : deliveryFee)
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
      if (order.driverId && deliveryFee > 0) {
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

  if (order.driverId && deliveryFee > 0) {
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

  await insertEntries(db, entries)
  return db.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, order.id))
}

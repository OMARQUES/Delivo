import { and, eq } from 'drizzle-orm'
import { formatBRL } from '@delivery/shared/constants'
import type { AmendmentProposalInput } from '@delivery/shared/schemas'
import type { Db } from '../db/client'
import { orderAmendmentItems, orderAmendments, orderItems, orders } from '../db/schema'
import type { PaymentProvider } from '../lib/payment-provider'
import { addEvent } from './order-events'
import { getOrderPayment, refundOrderPaymentIfAny } from './payment.service'

export class AmendmentError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

const PROPOSABLE = ['ACCEPTED', 'PREPARING'] as const

export async function getPendingAmendment(db: Db, orderId: string) {
  const [a] = await db.select().from(orderAmendments)
    .where(and(eq(orderAmendments.orderId, orderId), eq(orderAmendments.status, 'PROPOSED')))
  if (!a) return null
  const items = await db.select().from(orderAmendmentItems).where(eq(orderAmendmentItems.amendmentId, a.id))
  return { ...a, items }
}

export async function proposeAmendment(
  db: Db,
  storeId: string,
  proposedByUserId: string,
  orderId: string,
  input: AmendmentProposalInput,
) {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
  if (!order) throw new AmendmentError('Pedido não encontrado', 404)
  if (!(PROPOSABLE as readonly string[]).includes(order.status))
    throw new AmendmentError('Alteração só antes do pedido ficar pronto (aceito/em preparo)', 409)
  if (await getPendingAmendment(db, orderId))
    throw new AmendmentError('Já existe uma alteração aguardando o cliente', 409)

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
  const byId = new Map(items.map((i) => [i.id, i]))

  let reduced = false
  for (const change of input.items) {
    const item = byId.get(change.orderItemId)
    if (!item) throw new AmendmentError('Item não pertence ao pedido', 400)
    if (change.newQuantity > item.quantity) throw new AmendmentError('Só é possível reduzir quantidades', 400)
    if (change.newQuantity < item.quantity) reduced = true
  }
  if (!reduced) throw new AmendmentError('Nenhuma redução na proposta', 400)

  const changes = new Map(input.items.map((i) => [i.orderItemId, i.newQuantity]))
  const newSubtotalCents = items.reduce((acc, item) => {
    const qty = changes.get(item.id) ?? item.quantity
    return acc + item.unitPriceCents * qty
  }, 0)
  if (newSubtotalCents === 0) throw new AmendmentError('Não é possível remover todos os itens — cancele o pedido', 400)

  const newTotalCents = newSubtotalCents + (order.deliveryFeeCents ?? 0)
  const refundCents = order.totalCents - newTotalCents

  const amendment = await db.transaction(async (tx) => {
    const [amendment] = await tx.insert(orderAmendments).values({
      orderId,
      proposedByUserId,
      note: input.note ?? null,
      newSubtotalCents,
      newTotalCents,
      refundCents,
    }).returning()
    for (const change of input.items) {
      const item = byId.get(change.orderItemId)!
      if (change.newQuantity === item.quantity) continue
      await tx.insert(orderAmendmentItems).values({
        amendmentId: amendment!.id,
        orderItemId: item.id,
        nameSnapshot: item.nameSnapshot,
        oldQuantity: item.quantity,
        newQuantity: change.newQuantity,
        unitPriceCents: item.unitPriceCents,
      })
    }
    return amendment!
  })
  return (await getPendingAmendment(db, amendment.orderId)) ?? { ...amendment, items: [] }
}

export async function withdrawAmendment(db: Db, storeId: string, orderId: string) {
  const [order] = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
  if (!order) throw new AmendmentError('Pedido não encontrado', 404)
  const rows = await db.update(orderAmendments)
    .set({ status: 'EXPIRED', resolvedAt: new Date() })
    .where(and(eq(orderAmendments.orderId, orderId), eq(orderAmendments.status, 'PROPOSED')))
    .returning()
  if (rows.length === 0) throw new AmendmentError('Sem alteração pendente', 409)
  return rows[0]!
}

/** Chamado pelos fluxos de cancelamento — expira proposta pendente sem erro se não houver. */
export async function expirePendingAmendment(db: Db, orderId: string) {
  await db.update(orderAmendments)
    .set({ status: 'EXPIRED', resolvedAt: new Date() })
    .where(and(eq(orderAmendments.orderId, orderId), eq(orderAmendments.status, 'PROPOSED')))
}

export async function approveAmendment(db: Db, provider: PaymentProvider | null, customerId: string, orderId: string) {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
  if (!order) throw new AmendmentError('Pedido não encontrado', 404)
  const pending = await getPendingAmendment(db, orderId)
  if (!pending) throw new AmendmentError('Sem alteração pendente', 409)

  await db.transaction(async (tx) => {
    const claimed = await tx.update(orderAmendments)
      .set({ status: 'APPROVED', resolvedAt: new Date() })
      .where(and(eq(orderAmendments.id, pending.id), eq(orderAmendments.status, 'PROPOSED')))
      .returning()
    if (claimed.length === 0) throw new AmendmentError('Alteração não está mais pendente', 409)
    for (const change of pending.items) {
      if (change.newQuantity === 0) {
        await tx.delete(orderItems).where(eq(orderItems.id, change.orderItemId))
      } else {
        await tx.update(orderItems)
          .set({ quantity: change.newQuantity, totalCents: change.unitPriceCents * change.newQuantity })
          .where(eq(orderItems.id, change.orderItemId))
      }
    }
    await tx.update(orders)
      .set({ subtotalCents: pending.newSubtotalCents, totalCents: pending.newTotalCents })
      .where(eq(orders.id, orderId))
  })

  await addEvent(db, orderId, order.status, 'CUSTOMER', customerId, `pedido ajustado (-${formatBRL(pending.refundCents)})`)

  const payment = await getOrderPayment(db, orderId)
  if (payment?.status === 'APPROVED' && pending.refundCents > 0) {
    if (provider) await provider.refundPartial(payment.providerOrderId!, pending.refundCents)
    await addEvent(db, orderId, order.status, 'SYSTEM', null, `estorno parcial de ${formatBRL(pending.refundCents)}`)
  }
  return { ...pending, status: 'APPROVED' as const }
}

export async function rejectAmendment(db: Db, provider: PaymentProvider | null, customerId: string, orderId: string) {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
  if (!order) throw new AmendmentError('Pedido não encontrado', 404)
  const pending = await getPendingAmendment(db, orderId)
  if (!pending) throw new AmendmentError('Sem alteração pendente', 409)

  // mesma atomicidade do approve: claim + cancelamento na mesma tx
  const rows = await db.transaction(async (tx) => {
    const claimed = await tx.update(orderAmendments)
      .set({ status: 'REJECTED', resolvedAt: new Date() })
      .where(and(eq(orderAmendments.id, pending.id), eq(orderAmendments.status, 'PROPOSED')))
      .returning()
    if (claimed.length === 0) throw new AmendmentError('Alteração não está mais pendente', 409)

    return tx.update(orders)
      .set({ status: 'CANCELLED', batchId: null, cancelReason: 'Cliente recusou a alteração proposta' })
      .where(and(eq(orders.id, orderId), eq(orders.status, order.status)))
      .returning()
  })
  if (rows.length > 0) {
    await addEvent(db, orderId, 'CANCELLED', 'CUSTOMER', customerId, 'recusou alteração')
    await refundOrderPaymentIfAny(db, provider, orderId)
  }
  return { ...pending, status: 'REJECTED' as const }
}

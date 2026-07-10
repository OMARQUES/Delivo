import type { OrderStatus } from '@delivery/shared/constants'
import type { Db } from '../db/client'
import { orderEvents } from '../db/schema'

export async function addEvent(
  db: Pick<Db, 'insert'>,
  orderId: string,
  status: OrderStatus,
  actorRole: string,
  actorId: string | null,
  note?: string,
) {
  await db.insert(orderEvents).values({ orderId, status, actorRole, actorId, note: note ?? null })
}

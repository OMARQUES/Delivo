import { and, desc, eq } from 'drizzle-orm'
import type { AddressInput } from '@delivery/shared/schemas'
import type { Db } from '../db/client'
import { customerAddresses } from '../db/schema'

export async function listAddresses(db: Db, userId: string) {
  return db.select().from(customerAddresses)
    .where(eq(customerAddresses.userId, userId))
    .orderBy(desc(customerAddresses.createdAt))
}

export async function createAddress(db: Db, userId: string, input: AddressInput) {
  const [row] = await db.insert(customerAddresses)
    .values({ userId, ...input, label: input.label ?? null, reference: input.reference ?? null })
    .returning()
  return row!
}

export async function deleteAddress(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db.delete(customerAddresses)
    .where(and(eq(customerAddresses.id, id), eq(customerAddresses.userId, userId)))
    .returning({ id: customerAddresses.id })
  return rows.length > 0
}

export async function getAddress(db: Db, userId: string, id: string) {
  const [row] = await db.select().from(customerAddresses)
    .where(and(eq(customerAddresses.id, id), eq(customerAddresses.userId, userId)))
  return row ?? null
}

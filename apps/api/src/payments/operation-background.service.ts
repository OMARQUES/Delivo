import type { Env } from '../env'
import { createDb } from '../db/client'
import { createPaymentProvider } from './mercadopago'
import { claimPaymentOperationById } from './operation-queue.service'
import { processPaymentOperation } from './operation.service'

export async function processPaymentOperationInBackground(env: Env, operationId: string, now: Date): Promise<void> {
  const { db, client } = createDb(env)
  try {
    const provider = createPaymentProvider(env)
    if (!provider) return
    const leaseOwner = `request:${crypto.randomUUID()}`
    if (!await claimPaymentOperationById(db, operationId, now, leaseOwner)) return
    await processPaymentOperation(db, provider, operationId, leaseOwner, now)
  } finally {
    await client.end({ timeout: 5 })
  }
}

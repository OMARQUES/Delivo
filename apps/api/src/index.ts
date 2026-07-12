import { app } from './app'
import { createDb } from './db/client'
import type { Env } from './env'
import { createPaymentProvider } from './lib/mercadopago'
import { cancelStalePendingOrders } from './services/order-status.service'
import { expireStaleAwaitingPayment } from './services/payment.service'
import { autoApproveStaleShiftDailies } from './services/shift.service'
import { deleteExpiredRateLimitBuckets } from './security/rate-limit-cleanup'

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env) {
    const { db, client } = createDb(env)
    try {
      const provider = createPaymentProvider(env)
      const n = await cancelStalePendingOrders(db, 30, provider)
      if (n > 0) console.log(`cron: ${n} pedidos PENDING expirados cancelados`)
      const expired = await expireStaleAwaitingPayment(db, provider)
      if (expired > 0) console.log(`cron: ${expired} pagamentos expirados`)
      const dailies = await autoApproveStaleShiftDailies(db)
      if (dailies > 0) console.log(`cron: ${dailies} diárias de turno aprovadas automaticamente`)
      const buckets = await deleteExpiredRateLimitBuckets(db)
      if (buckets > 0) console.log(`cron: ${buckets} rate limit buckets expirados removidos`)
    } finally {
      await client.end()
    }
  },
}

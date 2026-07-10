import { app } from './app'
import { createDb } from './db/client'
import type { Env } from './env'
import { createPaymentProvider } from './lib/mercadopago'
import { cancelStalePendingOrders } from './services/order-status.service'
import { expireStaleAwaitingPayment } from './services/payment.service'

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
    } finally {
      await client.end()
    }
  },
}

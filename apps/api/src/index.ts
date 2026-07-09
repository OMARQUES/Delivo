import { app } from './app'
import { createDb } from './db/client'
import type { Env } from './env'
import { cancelStalePendingOrders } from './services/order-status.service'

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env) {
    const { db, client } = createDb(env)
    try {
      const n = await cancelStalePendingOrders(db, 30)
      if (n > 0) console.log(`cron: ${n} pedidos PENDING expirados cancelados`)
    } finally {
      await client.end()
    }
  },
}

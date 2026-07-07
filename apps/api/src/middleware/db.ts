import { createMiddleware } from 'hono/factory'
import { createDb } from '../db/client'
import type { AppContext } from '../env'

// One short-lived postgres.js client per request. Cleanup goes through
// executionCtx.waitUntil so the response is not delayed by pool teardown.
export const dbMiddleware = createMiddleware<AppContext>(async (c, next) => {
  const { db, client } = createDb(c.env)
  c.set('db', db)
  try {
    await next()
  } finally {
    const cleanup = client.end()
    try {
      c.executionCtx.waitUntil(cleanup)
    } catch {
      // No ExecutionContext (vitest node pool / app.request without one):
      // Hono's executionCtx getter throws, so settle the teardown inline.
      await cleanup
    }
  }
})

import { createRoute, z } from '@hono/zod-openapi'
import { sql } from 'drizzle-orm'
import { createRouter } from '../app-factory'

export const healthRoutes = createRouter()

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: {
      description: 'API is up',
      content: {
        'application/json': { schema: z.object({ status: z.literal('ok') }) },
      },
    },
  },
})

healthRoutes.openapi(healthRoute, (c) => c.json({ status: 'ok' as const }, 200))

const dbHealthRoute = createRoute({
  method: 'get',
  path: '/health/db',
  responses: {
    200: {
      description: 'Database reachable',
      content: {
        'application/json': { schema: z.object({ status: z.literal('ok') }) },
      },
    },
    503: {
      description: 'Database unreachable',
      content: {
        'application/json': { schema: z.object({ status: z.literal('degraded') }) },
      },
    },
  },
})

healthRoutes.openapi(dbHealthRoute, async (c) => {
  try {
    await c.get('db').execute(sql`select 1`)
    return c.json({ status: 'ok' as const }, 200)
  } catch (err) {
    console.error('db health check failed:', err)
    return c.json({ status: 'degraded' as const }, 503)
  }
})

import { createRoute, z } from '@hono/zod-openapi'
import { sql } from 'drizzle-orm'
import { createRouter } from '../app-factory'
import { createDb } from '../db/client'

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
  },
})

healthRoutes.openapi(dbHealthRoute, async (c) => {
  const db = createDb(c.env)
  await db.execute(sql`select 1`)
  return c.json({ status: 'ok' as const }, 200)
})

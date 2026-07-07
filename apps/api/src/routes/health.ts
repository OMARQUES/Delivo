import { createRoute, z } from '@hono/zod-openapi'
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

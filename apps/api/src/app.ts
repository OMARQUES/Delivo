import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { AppContext } from './env'
import { errorHandler } from './middleware/error-handler'
import { healthRoutes } from './routes/health'

export const app = new OpenAPIHono<AppContext>()

app.use('*', logger())
app.use('*', cors())
app.onError(errorHandler)
app.notFound((c) => c.json({ error: 'Not Found' }, 404))

app.route('/', healthRoutes)

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Delivery API', version: '0.0.1' },
})
app.get('/docs', swaggerUI({ url: '/openapi.json' }))

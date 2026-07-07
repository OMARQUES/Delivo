import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { createRouter } from './app-factory'
import { errorHandler } from './middleware/error-handler'
import { healthRoutes } from './routes/health'

export const app = createRouter()

app.use('*', logger())
// TODO(auth plan): restrict origin allowlist + credentials before shipping auth
app.use('*', cors())
app.onError(errorHandler)
app.notFound((c) => c.json({ error: 'Not Found' }, 404))

app.route('/', healthRoutes)

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Delivery API', version: '0.0.1' },
})
app.get('/docs', swaggerUI({ url: '/openapi.json' }))

import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { createRouter } from './app-factory'
import { dbMiddleware } from './middleware/db'
import { errorHandler } from './middleware/error-handler'
import { adminStoreRoutes } from './routes/admin-stores'
import { authRoutes } from './routes/auth'
import { healthRoutes } from './routes/health'
import { mediaRoutes } from './routes/media'
import { menuPublicRoutes } from './routes/menu-public'
import { storeCatalogRoutes } from './routes/store-catalog'
import { storeMeRoutes } from './routes/store-me'
import { publicStoreRoutes } from './routes/stores-public'

export const app = createRouter()

app.use('*', logger())
app.use('*', async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })(c, next)
})
app.use('*', dbMiddleware)
app.onError(errorHandler)
app.notFound((c) => c.json({ error: 'Not Found' }, 404))

app.route('/', healthRoutes)
app.route('/', authRoutes)
app.route('/', mediaRoutes)
app.route('/', adminStoreRoutes)
app.route('/', storeMeRoutes)
app.route('/', storeCatalogRoutes)
app.route('/', menuPublicRoutes)
app.route('/', publicStoreRoutes)

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Delivery API', version: '0.0.1' },
})
app.get('/docs', swaggerUI({ url: '/openapi.json' }))

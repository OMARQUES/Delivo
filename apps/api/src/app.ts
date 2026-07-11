import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { createRouter } from './app-factory'
import { dbMiddleware } from './middleware/db'
import { errorHandler } from './middleware/error-handler'
import { globalBodyLimit, localOnly, securityBaseline, securityHeaders } from './middleware/security-baseline'
import { addressRoutes } from './routes/addresses'
import { adminDriverRoutes } from './routes/admin-drivers'
import { adminStoreRoutes } from './routes/admin-stores'
import { adminReturnRoutes } from './routes/admin-returns'
import { authRoutes } from './routes/auth'
import { driverRoutes } from './routes/driver'
import { financeRoutes } from './routes/finance'
import { healthRoutes } from './routes/health'
import { mediaRoutes } from './routes/media'
import { menuPublicRoutes } from './routes/menu-public'
import { orderRoutes } from './routes/orders'
import { storeCatalogRoutes } from './routes/store-catalog'
import { storeMeRoutes } from './routes/store-me'
import { storeOrderRoutes } from './routes/store-orders'
import { storeDriverRoutes } from './routes/store-drivers'
import { publicStoreRoutes } from './routes/stores-public'
import { webhookRoutes } from './routes/webhooks'

export const app = createRouter()

app.use('*', logger())
app.use('*', globalBodyLimit)
app.use('*', securityHeaders)
app.use('*', securityBaseline)
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

app.use('/docs', localOnly)
app.use('/openapi.json', localOnly)
app.use('/health/db', localOnly)

app.route('/', healthRoutes)
app.route('/', authRoutes)
app.route('/', driverRoutes)
app.route('/', financeRoutes)
app.route('/', addressRoutes)
app.route('/', orderRoutes)
app.route('/', mediaRoutes)
app.route('/', adminDriverRoutes)
app.route('/', adminStoreRoutes)
app.route('/', adminReturnRoutes)
app.route('/', storeMeRoutes)
app.route('/', storeOrderRoutes)
app.route('/', storeDriverRoutes)
app.route('/', storeCatalogRoutes)
app.route('/', menuPublicRoutes)
app.route('/', publicStoreRoutes)
app.route('/', webhookRoutes)

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Delivery API', version: '0.0.1' },
})
app.get('/docs', swaggerUI({ url: '/openapi.json' }))

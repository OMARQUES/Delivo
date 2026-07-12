import { createMiddleware } from 'hono/factory'
import type { AppContext } from '../env'

export function requestId() {
  return createMiddleware<AppContext>(async (c, next) => {
    const id = crypto.randomUUID()
    c.set('requestId', id)
    c.header('X-Request-ID', id)
    await next()
  })
}

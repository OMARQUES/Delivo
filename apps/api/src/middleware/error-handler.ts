import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

export function errorHandler(err: Error, c: Context) {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  console.error('unhandled error', { path: c.req.path, message: err.message, stack: err.stack })
  return c.json({ error: 'Internal Server Error' }, 500)
}

import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { SecurityHttpError } from '../security/http'

const MAX_RETRY_AFTER_SECONDS = 86_400

function boundedRetryAfter(value: number): string | null {
  if (!Number.isFinite(value)) return null
  return String(Math.min(Math.max(Math.ceil(value), 0), MAX_RETRY_AFTER_SECONDS))
}

export function errorHandler(err: Error, c: Context) {
  if (err instanceof SecurityHttpError) {
    if (err.status === 429 && err.code === 'RATE_LIMITED' && err.retryAfterSeconds !== undefined) {
      const retryAfter = boundedRetryAfter(err.retryAfterSeconds)
      if (retryAfter !== null) c.header('Retry-After', retryAfter)
    }
    return c.json({ error: err.message, code: err.code }, err.status)
  }
  if (err instanceof HTTPException) {
    if (err.res) return err.res
    return c.json({ error: err.message }, err.status)
  }
  console.error('unhandled error', { path: c.req.path, message: err.message, stack: err.stack })
  return c.json({ error: 'Internal Server Error' }, 500)
}

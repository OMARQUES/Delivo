import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import type { AppContext } from '../env'

const GLOBAL_MAX_BYTES = 6 * 1024 * 1024
const JSON_MAX_BYTES = 256 * 1024

function isUploadPath(path: string) {
  return path.endsWith('/logo') || path.endsWith('/photo') || path.endsWith('/return-photo')
}

const globalNonUploadBodyLimit = bodyLimit({ maxSize: GLOBAL_MAX_BYTES })

export const globalBodyLimit = createMiddleware<AppContext>((c, next) => {
  if (isUploadPath(c.req.path)) return next()
  return globalNonUploadBodyLimit(c, next)
})
const jsonBodyLimit = bodyLimit({ maxSize: JSON_MAX_BYTES })

export const securityBaseline = createMiddleware<AppContext>(async (c, next) => {
  const contentType = c.req.header('content-type')
  const method = c.req.method
  const isUnsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  const hasBody = c.req.raw.body !== null
  const isJson = Boolean(contentType && /^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType))
  const isUpload = isUploadPath(c.req.path)
  const isCsv = c.req.path.endsWith('/catalog/import')
  const isWebhook = c.req.path.startsWith('/webhooks/')
  if (isUnsafe && hasBody && !isUpload && !isCsv && !isWebhook && !isJson) {
    return c.json({ error: 'Unsupported Media Type' }, 415)
  }
  if (isJson) {
    return jsonBodyLimit(c, next)
  }
  await next()
})

export const securityHeaders = createMiddleware<AppContext>(async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (c.env.APP_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  if (/^\/(auth|orders|me|driver|store|admin|private-media)(?:\/|$)/.test(c.req.path)
    && !c.res.headers.has('Cache-Control')) {
    c.header('Cache-Control', 'no-store')
  }
})

export const localOnly = createMiddleware<AppContext>(async (c, next) => {
  if (c.env.APP_ENV !== 'local') return c.json({ error: 'Not Found' }, 404)
  await next()
})

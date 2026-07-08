import { Hono } from 'hono'
import type { AppContext } from '../env'

/** Serve objetos do R2 (logos, fotos). Rota pública, cache forte (chaves imutáveis). */
export const mediaRoutes = new Hono<AppContext>()

mediaRoutes.get('/media/:key{.+}', async (c) => {
  const obj = await c.env.BUCKET.get(c.req.param('key'))
  if (!obj) return c.json({ error: 'Not Found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

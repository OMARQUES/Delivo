import { Hono } from 'hono'
import type { AppContext } from '../env'

/** Serve objetos do R2 (logos, fotos). Rota pública, cache forte (chaves imutáveis). */
export const mediaRoutes = new Hono<AppContext>()
const PUBLIC_MEDIA_KEY = /^(logos|products)\/[0-9a-f-]+\.(png|jpg|jpeg|webp)$/i

mediaRoutes.get('/media/:key{.+}', async (c) => {
  const key = c.req.param('key')
  if (!PUBLIC_MEDIA_KEY.test(key)) return c.json({ error: 'Not Found' }, 404)
  const obj = await c.env.BUCKET.get(key)
  if (!obj) return c.json({ error: 'Not Found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

import { HTTPException } from 'hono/http-exception'

export async function readLimitedArrayBuffer(req: Request, maxBytes: number, message: string) {
  const declaredLength = Number(req.headers.get('Content-Length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HTTPException(400, { message })
  }

  if (!req.body) return new ArrayBuffer(0)

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new HTTPException(400, { message })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}

import { describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: {} as never, client: { end: async () => {} } }) }
})

function envWith(bucket: Partial<R2Bucket>) {
  return {
    JWT_SECRET: 'test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
    BUCKET: bucket as R2Bucket,
  }
}

describe('GET /media/:key', () => {
  it('streams object with content-type and long cache', async () => {
    const obj = {
      body: new Blob(['fake-image']).stream(),
      httpMetadata: { contentType: 'image/png' },
    }
    const env = envWith({ get: vi.fn(async () => obj as unknown as R2ObjectBody) })
    const res = await app.request('/media/logos/11111111-1111-4111-8111-111111111111.png', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('public')
    expect(await res.text()).toBe('fake-image')
  })

  it('404 for missing object', async () => {
    const env = envWith({ get: vi.fn(async () => null) })
    const res = await app.request('/media/nope.png', {}, env)
    expect(res.status).toBe(404)
  })

  it('never looks up private or malformed keys', async () => {
    for (const key of ['returns/secret.jpg', 'unknown/a.png', '../returns/x.jpg']) {
      const get = vi.fn()
      const res = await app.request(`/media/${encodeURI(key)}`, {}, envWith({ get }))
      expect(res.status).toBe(404)
      expect(get).not.toHaveBeenCalled()
    }
  })
})

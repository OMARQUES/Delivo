import { describe, expect, it } from 'vitest'
import { app } from '../src/app'

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('unknown route', () => {
  it('returns structured 404', async () => {
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
  })
})

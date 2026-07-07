import { describe, expect, it } from 'vitest'
import { verify } from 'hono/jwt'
import { signAccessToken, generateRefreshToken, hashToken, ACCESS_TTL_SECONDS } from '../src/lib/tokens'

const SECRET = 'test-secret'

describe('access token', () => {
  it('signs a JWT with sub/role/name and 15min expiry', async () => {
    const token = await signAccessToken({ sub: 'user-1', role: 'CUSTOMER', name: 'Ana' }, SECRET)
    const payload = await verify(token, SECRET, 'HS256')
    expect(payload.sub).toBe('user-1')
    expect(payload.role).toBe('CUSTOMER')
    expect(payload.name).toBe('Ana')
    expect(Number(payload.exp) - Number(payload.iat)).toBe(ACCESS_TTL_SECONDS)
  })
})

describe('refresh token', () => {
  it('generates opaque token + sha256 hash, deterministic hashing', async () => {
    const { token, hash } = await generateRefreshToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(hash).toBe(await hashToken(token))
    expect(hash).not.toContain(token)
  })

  it('generates unique tokens', async () => {
    const a = await generateRefreshToken()
    const b = await generateRefreshToken()
    expect(a.token).not.toBe(b.token)
  })
})

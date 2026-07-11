import { describe, expect, it } from 'vitest'
import { decode } from 'hono/jwt'
import {
  signAccessToken, generateRefreshToken, hashToken, ACCESS_TTL_SECONDS,
} from '../src/lib/tokens'

const SECRET = 'test-secret'

describe('access token', () => {
  it('signs a complete session-bound JWT contract', async () => {
    const now = new Date('2026-07-11T12:00:00Z')
    const token = await signAccessToken(
      { sub: 'user-1', role: 'CUSTOMER', name: 'Ana', tokenVersion: 7 },
      SECRET,
      '11111111-1111-4111-8111-111111111111',
      now,
    )
    const { payload } = decode(token)
    expect(payload).toMatchObject({
      sub: 'user-1',
      role: 'CUSTOMER',
      name: 'Ana',
      ver: 7,
      sid: '11111111-1111-4111-8111-111111111111',
      iss: 'delivery-api',
      aud: 'delivery-clients',
    })
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/)
    expect(payload.nbf).toBe(payload.iat)
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

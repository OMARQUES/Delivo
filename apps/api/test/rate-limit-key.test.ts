import { describe, expect, it } from 'vitest'
import { hashRateLimitKey, normalizeLoginKey } from '../src/security/rate-limit-key'
import { POLICIES } from '../src/security/rate-limit-policies'

describe('rate limit keys', () => {
  it('normalizes email login identifiers before hashing', async () => {
    const normalized = normalizeLoginKey(' Ana@Email.COM ')
    expect(normalized).toBe('ana@email.com')
    expect(await hashRateLimitKey('secret', 'login-id', normalized))
      .toBe(await hashRateLimitKey('secret', 'login-id', 'ana@email.com'))
  })

  it('normalizes non-email login identifiers to digits only', () => {
    expect(normalizeLoginKey(' +55 (11) 98765-4321 ')).toBe('5511987654321')
  })

  it('is deterministic, domain separated, and emits a full base64url SHA-256 digest', async () => {
    const first = await hashRateLimitKey('secret', 'login-id', 'ana@email.com')
    const repeated = await hashRateLimitKey('secret', 'login-id', 'ana@email.com')
    const otherScope = await hashRateLimitKey('secret', 'register-id', 'ana@email.com')

    expect(first).toBe(repeated)
    expect(first).not.toBe(otherScope)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first).not.toContain('ana')
    expect(first).not.toContain('email.com')
  })
})

describe('rate limit policies', () => {
  it('defines all approved immutable policy values', () => {
    expect(POLICIES).toEqual({
      registerIdentityHour: { scope: 'register-identity-hour', limit: 3, windowMs: 3_600_000, retentionMs: 86_400_000 },
      registerIdentityDay: { scope: 'register-identity-day', limit: 10, windowMs: 86_400_000, retentionMs: 172_800_000 },
      registerIpHour: { scope: 'register-ip-hour', limit: 10, windowMs: 3_600_000, retentionMs: 86_400_000 },
      registerIpDay: { scope: 'register-ip-day', limit: 30, windowMs: 86_400_000, retentionMs: 172_800_000 },
      loginIp15Minutes: { scope: 'login-ip-15m', limit: 30, windowMs: 900_000, retentionMs: 3_600_000 },
      loginFailureIdentity15Minutes: { scope: 'login-failure-identity-15m', limit: 5, windowMs: 900_000, retentionMs: 3_600_000 },
      loginFailureIdentityHour: { scope: 'login-failure-identity-hour', limit: 10, windowMs: 3_600_000, retentionMs: 86_400_000, cooldownMs: 900_000 },
      refreshFingerprint10Minutes: { scope: 'refresh-fingerprint-10m', limit: 10, windowMs: 600_000, retentionMs: 3_600_000 },
      refreshIp10Minutes: { scope: 'refresh-ip-10m', limit: 60, windowMs: 600_000, retentionMs: 3_600_000 },
      orderQuoteUserMinute: { scope: 'order-quote-user-minute', limit: 30, windowMs: 60_000, retentionMs: 3_600_000 },
      orderQuoteUserDay: { scope: 'order-quote-user-day', limit: 300, windowMs: 86_400_000, retentionMs: 172_800_000 },
      orderQuoteIpMinute: { scope: 'order-quote-ip-minute', limit: 100, windowMs: 60_000, retentionMs: 3_600_000 },
      orderCreateUserHour: { scope: 'order-create-user-hour', limit: 10, windowMs: 3_600_000, retentionMs: 86_400_000 },
      orderCreateUserDay: { scope: 'order-create-user-day', limit: 30, windowMs: 86_400_000, retentionMs: 172_800_000 },
      orderCreateIpHour: { scope: 'order-create-ip-hour', limit: 30, windowMs: 3_600_000, retentionMs: 86_400_000 },
      logoUploadPrincipalHour: { scope: 'logo-upload-principal-hour', limit: 20, windowMs: 3_600_000, retentionMs: 86_400_000 },
      logoUploadPrincipalDay: { scope: 'logo-upload-principal-day', limit: 100, windowMs: 86_400_000, retentionMs: 172_800_000 },
      logoUploadIpHour: { scope: 'logo-upload-ip-hour', limit: 100, windowMs: 3_600_000, retentionMs: 86_400_000 },
      productUploadPrincipalHour: { scope: 'product-upload-principal-hour', limit: 20, windowMs: 3_600_000, retentionMs: 86_400_000 },
      productUploadPrincipalDay: { scope: 'product-upload-principal-day', limit: 100, windowMs: 86_400_000, retentionMs: 172_800_000 },
      productUploadIpHour: { scope: 'product-upload-ip-hour', limit: 100, windowMs: 3_600_000, retentionMs: 86_400_000 },
      returnUploadDriverHour: { scope: 'return-upload-driver-hour', limit: 10, windowMs: 3_600_000, retentionMs: 86_400_000 },
      returnUploadDriverDay: { scope: 'return-upload-driver-day', limit: 30, windowMs: 86_400_000, retentionMs: 172_800_000 },
      returnUploadIpHour: { scope: 'return-upload-ip-hour', limit: 50, windowMs: 3_600_000, retentionMs: 86_400_000 },
    })

    expect(Object.isFrozen(POLICIES)).toBe(true)
    for (const policy of Object.values(POLICIES)) {
      expect(Object.isFrozen(policy)).toBe(true)
      expect(policy.retentionMs).toBeGreaterThanOrEqual(policy.windowMs)
      if ('cooldownMs' in policy && policy.cooldownMs !== undefined) {
        expect(policy.retentionMs).toBeGreaterThanOrEqual(policy.cooldownMs)
      }
    }
  })
})

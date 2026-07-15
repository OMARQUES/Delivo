import { describe, expect, it } from 'vitest'
import { hashRateLimitKey, normalizeLoginKey } from '../src/security/rate-limit-key'
import { POLICIES } from '../src/security/rate-limit-policies'

describe('rate limit keys', () => {
  it('requires callers to choose identity or opaque normalization', () => {
    const missingSubjectKind = () => {
      // @ts-expect-error security-sensitive subject normalization must be explicit
      void hashRateLimitKey('secret', 'login-id', 'ana@email.com')
    }
    expect(missingSubjectKind).toBeTypeOf('function')
  })

  it('normalizes email login identifiers before hashing', async () => {
    const normalized = normalizeLoginKey(' Ana@Email.COM ')
    expect(normalized).toBe('ana@email.com')
    expect(await hashRateLimitKey('secret', 'login-id', ' Ana@Email.COM ', 'identity'))
      .toBe(await hashRateLimitKey('secret', 'login-id', 'ana@email.com', 'identity'))
    expect(await hashRateLimitKey('secret', 'login-id', normalized, 'identity'))
      .toBe(await hashRateLimitKey('secret', 'login-id', 'ana@email.com', 'identity'))
  })

  it('normalizes non-email login identifiers to digits only', () => {
    expect(normalizeLoginKey(' +55 (11) 98765-4321 ')).toBe('5511987654321')
  })

  it('is deterministic, domain separated, and emits a full base64url SHA-256 digest', async () => {
    const first = await hashRateLimitKey('secret', 'login-id', 'ana@email.com', 'identity')
    const repeated = await hashRateLimitKey('secret', 'login-id', 'ana@email.com', 'identity')
    const otherScope = await hashRateLimitKey('secret', 'register-id', 'ana@email.com', 'identity')

    expect(first).toBe(repeated)
    expect(first).not.toBe(otherScope)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first).not.toContain('ana')
    expect(first).not.toContain('email.com')
  })

  it('preserves opaque subjects outside identity scopes', async () => {
    expect(await hashRateLimitKey('secret', 'refresh-fingerprint-10m', 'Token-A', 'opaque'))
      .not.toBe(await hashRateLimitKey('secret', 'refresh-fingerprint-10m', 'token-a', 'opaque'))
  })

  it('uses an explicit subject kind rather than inferring semantics from scope names', async () => {
    expect(await hashRateLimitKey('secret', 'future-renamed-scope', ' Ana@Email.COM ', 'identity'))
      .toBe(await hashRateLimitKey('secret', 'future-renamed-scope', 'ana@email.com', 'identity'))
    expect(await hashRateLimitKey('secret', 'login-identity-looking', 'Token-A', 'opaque'))
      .not.toBe(await hashRateLimitKey('secret', 'login-identity-looking', 'token-a', 'opaque'))
  })
})

describe('rate limit policies', () => {
  it('defines all approved immutable policy values', () => {
    const valuesWithoutSubjectKind = Object.fromEntries(Object.entries(POLICIES).map(
      ([name, policy]) => {
        const { subjectKind, ...value } = policy
        void subjectKind
        return [name, value]
      },
    ))
    expect(valuesWithoutSubjectKind).toEqual({
      registerIdentityHour: { scope: 'register-identity-hour', limit: 3, windowMs: 3_600_000, retentionMs: 86_400_000 },
      registerIdentityDay: { scope: 'register-identity-day', limit: 10, windowMs: 86_400_000, retentionMs: 172_800_000 },
      registerIpHour: { scope: 'register-ip-hour', limit: 10, windowMs: 3_600_000, retentionMs: 86_400_000 },
      registerIpDay: { scope: 'register-ip-day', limit: 30, windowMs: 86_400_000, retentionMs: 172_800_000 },
      recoveryStartEmailHour: { scope: 'recovery-start-email-hour', limit: 5, windowMs: 3_600_000, retentionMs: 86_400_000 },
      recoveryStartEmailDay: { scope: 'recovery-start-email-day', limit: 10, windowMs: 86_400_000, retentionMs: 172_800_000 },
      recoveryStartIpHour: { scope: 'recovery-start-ip-hour', limit: 10, windowMs: 3_600_000, retentionMs: 86_400_000 },
      recoveryStartIpDay: { scope: 'recovery-start-ip-day', limit: 30, windowMs: 86_400_000, retentionMs: 172_800_000 },
      recoveryVerifyIpHour: { scope: 'recovery-verify-ip-hour', limit: 30, windowMs: 3_600_000, retentionMs: 86_400_000 },
      ticketUseIpHour: { scope: 'identity-ticket-use-ip-hour', limit: 30, windowMs: 3_600_000, retentionMs: 86_400_000 },
      ticketUseFingerprintHour: { scope: 'identity-ticket-use-fingerprint-hour', limit: 30, windowMs: 3_600_000, retentionMs: 86_400_000 },
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
      paymentWebhookInvalidIpMinute: { scope: 'payment-webhook-invalid-ip-minute', limit: 120, windowMs: 60_000, retentionMs: 3_600_000 },
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

    expect(Object.entries(POLICIES)
      .filter(([, value]) => value.subjectKind === 'identity')
      .map(([name]) => name))
      .toEqual([
        'registerIdentityHour',
        'registerIdentityDay',
        'recoveryStartEmailHour',
        'recoveryStartEmailDay',
        'loginFailureIdentity15Minutes',
        'loginFailureIdentityHour',
      ])
    expect(Object.values(POLICIES).filter((value) => value.subjectKind === 'opaque')).toHaveLength(26)

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

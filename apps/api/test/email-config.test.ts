import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { assertRecipientAllowed, resolveEmailConfig } from '../src/email/config'

function env(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'staging',
    HYPERDRIVE: { connectionString: 'postgres://example.invalid/test' } as Hyperdrive,
    BUCKET: {} as R2Bucket,
    JWT_SECRET: 'jwt-secret',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    RATE_LIMIT_HMAC_SECRET: 'rate-secret',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
    RESEND_API_KEY: 're_secret',
    AUTH_CODE_SECRET: 'auth-code-secret',
    EMAIL_FROM: 'Delivo <auth@example.com>',
    PUBLIC_WEB_URL: 'https://app.example.com',
    EMAIL_ALLOWED_RECIPIENTS: ' User@Example.com , second@example.com ',
    ...overrides,
  }
}

describe('email config', () => {
  it('resolves required Resend settings and normalized staging allowlist', () => {
    const config = resolveEmailConfig(env())

    expect(config).toEqual({
      apiKey: 're_secret',
      from: 'Delivo <auth@example.com>',
      publicWebUrl: 'https://app.example.com/',
      allowedRecipients: new Set(['user@example.com', 'second@example.com']),
      appEnv: 'staging',
    })
  })

  it.each([
    ['RESEND_API_KEY'],
    ['AUTH_CODE_SECRET'],
    ['EMAIL_FROM'],
    ['PUBLIC_WEB_URL'],
  ] as const)('fails closed when %s is missing', (key) => {
    expect(() => resolveEmailConfig(env({ [key]: '   ' }))).toThrow(/email configuration/i)
  })

  it('requires https public web url outside local', () => {
    expect(() => resolveEmailConfig(env({ PUBLIC_WEB_URL: 'http://app.example.com' }))).toThrow(/public web url/i)
    expect(resolveEmailConfig(env({
      APP_ENV: 'local',
      PUBLIC_WEB_URL: 'http://localhost:5173',
    })).publicWebUrl).toBe('http://localhost:5173/')
  })

  it('rejects production allowlists and unsafe sender addresses', () => {
    expect(() => resolveEmailConfig(env({
      APP_ENV: 'production',
      EMAIL_ALLOWED_RECIPIENTS: 'user@example.com',
    }))).toThrow(/allowlist/i)

    expect(() => resolveEmailConfig(env({
      APP_ENV: 'production',
      EMAIL_ALLOWED_RECIPIENTS: '',
      EMAIL_FROM: 'onboarding@resend.dev',
    }))).toThrow(/sender/i)

    expect(() => resolveEmailConfig(env({
      APP_ENV: 'production',
      EMAIL_ALLOWED_RECIPIENTS: '',
      EMAIL_FROM: 'not-an-email',
    }))).toThrow(/sender/i)
  })

  it('checks exact normalized recipients against an allowlist', () => {
    const config = resolveEmailConfig(env())

    expect(() => assertRecipientAllowed(config, 'USER@example.com')).not.toThrow()
    expect(() => assertRecipientAllowed(config, ' second@example.com ')).not.toThrow()
    expect(() => assertRecipientAllowed(config, 'other@example.com')).toThrow(/recipient/i)
    expect(() => assertRecipientAllowed(config, 'attacker+user@example.com')).toThrow(/recipient/i)
  })

  it('allows any syntactically valid recipient when no allowlist is configured', () => {
    const config = resolveEmailConfig(env({ EMAIL_ALLOWED_RECIPIENTS: '' }))

    expect(config.allowedRecipients).toBeNull()
    expect(() => assertRecipientAllowed(config, 'anyone@example.com')).not.toThrow()
    expect(() => assertRecipientAllowed(config, 'bad')).toThrow(/recipient/i)
  })
})

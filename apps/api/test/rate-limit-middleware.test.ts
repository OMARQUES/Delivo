import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { errorHandler } from '../src/middleware/error-handler'
import { rateLimitPolicies } from '../src/middleware/rate-limit'
import { SecurityHttpError } from '../src/security/http'
import type { AppContext, Env } from '../src/env'
import type { RateLimitDecision, RateLimiter, RateLimitPolicy } from '../src/security/rate-limit'

function policy(scope: string, limit = 1): RateLimitPolicy {
  return {
    scope,
    subjectKind: 'opaque',
    limit,
    windowMs: 60_000,
    retentionMs: 120_000,
  }
}

class FakeLimiter implements RateLimiter {
  readonly calls: Array<{ policy: RateLimitPolicy; subject: string }> = []

  constructor(private readonly decisions: RateLimitDecision[]) {}

  async consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitDecision> {
    this.calls.push({ policy, subject })
    return this.decisions.shift() ?? {
      allowed: true,
      count: 1,
      limit: policy.limit,
      retryAfterSeconds: 0,
      blockedUntil: null,
    }
  }

  async inspect(policy: RateLimitPolicy): Promise<RateLimitDecision> {
    return {
      allowed: true,
      count: 0,
      limit: policy.limit,
      retryAfterSeconds: 0,
      blockedUntil: null,
    }
  }

  async clear(): Promise<void> {}
}

function decision(overrides: Partial<RateLimitDecision> = {}): RateLimitDecision {
  return {
    allowed: true,
    count: 1,
    limit: 1,
    retryAfterSeconds: 0,
    blockedUntil: null,
    ...overrides,
  }
}

function appWithLimiter(limiter: FakeLimiter) {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.use('/limited', rateLimitPolicies([
    { policy: policy('short-window'), subject: () => 'customer-secret@example.test' },
    { policy: policy('long-window'), subject: 'customer-secret@example.test' },
  ], { limiter }))
  app.get('/limited', (c) => c.json({ ok: true }))
  return app
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'local',
    HYPERDRIVE: { connectionString: 'postgres://example.invalid/test' } as Hyperdrive,
    BUCKET: {} as R2Bucket,
    JWT_SECRET: 'jwt-secret',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    RATE_LIMIT_HMAC_SECRET: 'rate-secret',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
    ...overrides,
  }
}

describe('rate limit middleware', () => {
  it('returns a stable 429 envelope with Retry-After', async () => {
    const limiter = new FakeLimiter([
      decision({ allowed: false, count: 2, retryAfterSeconds: 42 }),
      decision(),
    ])

    const response = await appWithLimiter(limiter).request('/limited')

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('42')
    expect(await response.json()).toEqual({
      error: 'Muitas tentativas. Tente novamente mais tarde.',
      code: 'RATE_LIMITED',
    })
  })

  it('consumes policies in order and still records later policies after a rejection', async () => {
    const limiter = new FakeLimiter([
      decision({ allowed: false, count: 2, retryAfterSeconds: 42 }),
      decision({ allowed: true, count: 1 }),
    ])

    await appWithLimiter(limiter).request('/limited')

    expect(limiter.calls.map((call) => call.policy.scope)).toEqual(['short-window', 'long-window'])
    expect(limiter.calls.map((call) => call.subject)).toEqual([
      'customer-secret@example.test',
      'customer-secret@example.test',
    ])
  })

  it('does not expose subjects, scope names, counts, or block internals', async () => {
    const limiter = new FakeLimiter([
      decision({
        allowed: false,
        count: 99,
        retryAfterSeconds: 42,
        blockedUntil: new Date('2026-01-01T00:00:42.000Z'),
      }),
      decision(),
    ])

    const response = await appWithLimiter(limiter).request('/limited')
    const body = await response.text()

    expect(body).not.toContain('customer-secret')
    expect(body).not.toContain('short-window')
    expect(body).not.toContain('99')
    expect(body).not.toContain('blockedUntil')
  })

  it('fails closed when the production limiter secret is blank', async () => {
    const app = new Hono<AppContext>()
    app.onError(errorHandler)
    app.use('/limited', rateLimitPolicies([
      { policy: policy('short-window'), subject: 'subject' },
    ]))
    app.get('/limited', (c) => c.json({ ok: true }))

    const response = await app.request('/limited', undefined, env({ RATE_LIMIT_HMAC_SECRET: '   ' }))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Verificação de segurança temporariamente indisponível.',
      code: 'SECURITY_CHECK_UNAVAILABLE',
    })
  })

  it('bounds Retry-After for rate limit errors only', async () => {
    const app = new Hono()
    app.onError(errorHandler)
    app.get('/huge', () => {
      throw new SecurityHttpError(429, 'RATE_LIMITED', 'Muitas tentativas. Tente novamente mais tarde.', 999_999)
    })
    app.get('/turnstile', () => {
      throw new SecurityHttpError(403, 'TURNSTILE_REQUIRED', 'Verificação de segurança necessária.', 60)
    })

    const huge = await app.request('/huge')
    expect(huge.headers.get('Retry-After')).toBe('86400')
    expect(await huge.json()).toEqual({
      error: 'Muitas tentativas. Tente novamente mais tarde.',
      code: 'RATE_LIMITED',
    })

    const turnstile = await app.request('/turnstile')
    expect(turnstile.headers.get('Retry-After')).toBeNull()
    expect(await turnstile.json()).toEqual({
      error: 'Verificação de segurança necessária.',
      code: 'TURNSTILE_REQUIRED',
    })
  })
})

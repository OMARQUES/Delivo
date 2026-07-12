import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AuthChallengePurpose } from '../src/db/schema'
import { rateLimitBuckets } from '../src/db/schema'
import type { AppContext, Env } from '../src/env'
import { errorHandler } from '../src/middleware/error-handler'
import { protectCodeAttempt, protectCodeSend } from '../src/security/identity-abuse'
import { PostgresRateLimiter } from '../src/security/rate-limit'
import { CODE_RATE_LIMIT_POLICIES, POLICIES } from '../src/security/rate-limit-policies'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const PURPOSES: AuthChallengePurpose[] = [
  'REGISTRATION_VERIFY',
  'STORE_ACTIVATION',
  'ADMIN_ACTIVATION',
  'PASSWORD_RECOVERY',
]
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function env(): Env {
  return {
    APP_ENV: 'local',
    HYPERDRIVE: { connectionString: 'postgres://example.invalid/test' } as Hyperdrive,
    BUCKET: {} as R2Bucket,
    JWT_SECRET: 'jwt-secret',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    RATE_LIMIT_HMAC_SECRET: 'rate-secret',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  }
}

function abuseApp() {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('db', testDb)
    c.set('requestId', crypto.randomUUID())
    await next()
  })
  app.post('/send/:purpose', async (c) => {
    const purpose = c.req.param('purpose') as AuthChallengePurpose
    const input = await c.req.json<{ email: string; flowId: string; turnstileToken?: string }>()
    await protectCodeSend(c, purpose, input.email, input.flowId, input.turnstileToken)
    return c.json({ ok: true })
  })
  app.post('/attempt/:purpose', async (c) => {
    await protectCodeAttempt(c, c.req.param('purpose') as AuthChallengePurpose, crypto.randomUUID())
    return c.json({ ok: true })
  })
  return app
}

function post(app: Hono<AppContext>, path: string, body: object, ip = '203.0.113.7') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  }, env())
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('identity abuse policies', () => {
  it('defines the exact immutable purpose-specific code thresholds', () => {
    for (const purpose of PURPOSES) {
      const policies = CODE_RATE_LIMIT_POLICIES[purpose]
      expect(policies).toMatchObject({
        sendEmailMinute: { limit: 1, windowMs: MINUTE, retentionMs: HOUR, subjectKind: 'identity' },
        sendEmailHour: { limit: 5, windowMs: HOUR, retentionMs: DAY, subjectKind: 'identity' },
        sendEmailDay: { limit: 10, windowMs: DAY, retentionMs: 2 * DAY, subjectKind: 'identity' },
        sendIpHour: { limit: 20, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
        sendIpDay: { limit: 50, windowMs: DAY, retentionMs: 2 * DAY, subjectKind: 'opaque' },
        attemptIpHour: { limit: 30, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
      })
      expect(Object.isFrozen(policies)).toBe(true)
      expect(Object.values(policies).every(Object.isFrozen)).toBe(true)
    }

    for (const key of ['sendEmailMinute', 'sendEmailHour', 'sendEmailDay', 'sendIpHour', 'sendIpDay', 'attemptIpHour'] as const) {
      expect(new Set(PURPOSES.map((purpose) => CODE_RATE_LIMIT_POLICIES[purpose][key].scope)).size).toBe(PURPOSES.length)
    }
  })

  it('defines recovery and ticket scopes without sharing registration scopes', () => {
    expect(POLICIES).toMatchObject({
      recoveryStartEmailHour: { limit: 5, windowMs: HOUR, retentionMs: DAY, subjectKind: 'identity' },
      recoveryStartEmailDay: { limit: 10, windowMs: DAY, retentionMs: 2 * DAY, subjectKind: 'identity' },
      recoveryStartIpHour: { limit: 10, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
      recoveryStartIpDay: { limit: 30, windowMs: DAY, retentionMs: 2 * DAY, subjectKind: 'opaque' },
      recoveryVerifyIpHour: { limit: 30, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
      ticketUseIpHour: { limit: 30, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
    })
    expect(POLICIES.recoveryStartEmailHour.scope).not.toBe(POLICIES.registerIdentityHour.scope)
    expect(POLICIES.recoveryStartIpHour.scope).not.toBe(POLICIES.registerIpHour.scope)
  })

  it('requires Turnstile on the third resend for the same purpose, flow, and email', async () => {
    const app = abuseApp()
    const body = { email: 'person@example.com', flowId: crypto.randomUUID() }
    const adaptivePolicy = CODE_RATE_LIMIT_POLICIES.REGISTRATION_VERIFY.resendFlowHour
    const adaptiveSubject = `${body.email}\0${body.flowId}`
    const limiter = new PostgresRateLimiter(testDb, env().RATE_LIMIT_HMAC_SECRET)
    await limiter.consume(adaptivePolicy, adaptiveSubject)
    await limiter.consume(adaptivePolicy, adaptiveSubject)

    const third = await post(app, '/send/REGISTRATION_VERIFY', body)

    expect(third.status).toBe(403)
    expect(await third.json()).toEqual({
      error: 'Verificação de segurança necessária.',
      code: 'TURNSTILE_REQUIRED',
    })
  })

  it('stores only HMAC bucket keys for raw email and IP subjects', async () => {
    const email = 'Raw.Person+test@example.com'
    const ip = '203.0.113.91'
    const response = await post(abuseApp(), '/send/STORE_ACTIVATION', {
      email,
      flowId: crypto.randomUUID(),
    }, ip)

    expect(response.status).toBe(200)
    const rows = await testDb.select().from(rateLimitBuckets)
    expect(rows.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(email)
    expect(serialized).not.toContain(email.toLowerCase())
    expect(serialized).not.toContain(ip)
    expect(rows.every((row) => /^[A-Za-z0-9_-]{43}$/.test(row.keyHash))).toBe(true)
  })

  it('uses purpose-specific IP scope before any challenge lookup', async () => {
    const response = await post(abuseApp(), '/attempt/ADMIN_ACTIVATION', {})

    expect(response.status).toBe(200)
    const rows = await testDb.select().from(rateLimitBuckets)
    expect(rows.map((row) => row.scope)).toContain(CODE_RATE_LIMIT_POLICIES.ADMIN_ACTIVATION.attemptIpHour.scope)
  })
})

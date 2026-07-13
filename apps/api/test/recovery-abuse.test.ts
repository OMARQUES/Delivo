import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'

const verifyTurnstileMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../src/security/turnstile', async () => {
  const actual = await vi.importActual<typeof import('../src/security/turnstile')>('../src/security/turnstile')
  return {
    ...actual,
    createTurnstileVerifier: vi.fn(() => ({ verify: verifyTurnstileMock })),
  }
})

import { rateLimitBuckets } from '../src/db/schema'
import type { AppContext, Env } from '../src/env'
import { errorHandler } from '../src/middleware/error-handler'
import {
  protectRecoveryStart,
  protectRecoveryVerify,
  protectTicketUse,
} from '../src/security/identity-abuse'
import { SecurityHttpError, TURNSTILE_INVALID_MESSAGE } from '../src/security/http'
import { PostgresRateLimiter } from '../src/security/rate-limit'
import { hashRateLimitKey } from '../src/security/rate-limit-key'
import { POLICIES } from '../src/security/rate-limit-policies'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const HOUR = 60 * 60_000
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

function recoveryApp() {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('db', testDb)
    c.set('requestId', crypto.randomUUID())
    await next()
  })
  app.post('/start', async (c) => {
    const input = await c.req.json<{ email: string; turnstileToken: string }>()
    await protectRecoveryStart(c, input.email, input.turnstileToken)
    return c.json({ ok: true })
  })
  app.post('/verify', async (c) => {
    const input = await c.req.json<{ recoveryId: string }>()
    await protectRecoveryVerify(c, input.recoveryId)
    return c.json({ ok: true })
  })
  app.post('/ticket', async (c) => {
    const input = await c.req.json<{ resetTicket: string }>()
    await protectTicketUse(c, input.resetTicket)
    return c.json({ ok: true })
  })
  return app
}

function post(path: string, body: object, ip = '203.0.113.7') {
  return recoveryApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  }, env())
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  verifyTurnstileMock.mockReset()
  verifyTurnstileMock.mockResolvedValue(undefined)
})
afterAll(closeTestDb)

describe('password recovery abuse controls', () => {
  it('defines immutable recovery limits in scopes isolated from registration', () => {
    expect(POLICIES).toMatchObject({
      recoveryStartEmailHour: { limit: 5, windowMs: HOUR, retentionMs: DAY, subjectKind: 'identity' },
      recoveryStartEmailDay: { limit: 10, windowMs: DAY, retentionMs: 2 * DAY, subjectKind: 'identity' },
      recoveryStartIpHour: { limit: 10, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
      recoveryStartIpDay: { limit: 30, windowMs: DAY, retentionMs: 2 * DAY, subjectKind: 'opaque' },
      recoveryVerifyIpHour: { limit: 30, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
      ticketUseIpHour: { limit: 30, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
      ticketUseFingerprintHour: { limit: 30, windowMs: HOUR, retentionMs: DAY, subjectKind: 'opaque' },
    })
    const scopes = [
      POLICIES.recoveryStartEmailHour.scope,
      POLICIES.recoveryStartEmailDay.scope,
      POLICIES.recoveryStartIpHour.scope,
      POLICIES.recoveryStartIpDay.scope,
      POLICIES.recoveryVerifyIpHour.scope,
      POLICIES.ticketUseIpHour.scope,
      POLICIES.ticketUseFingerprintHour.scope,
    ]
    expect(new Set(scopes).size).toBe(scopes.length)
    expect(scopes).not.toContain(POLICIES.registerIdentityHour.scope)
    expect(scopes).not.toContain(POLICIES.registerIpHour.scope)
    expect(Object.isFrozen(POLICIES)).toBe(true)
    expect([
      POLICIES.recoveryStartEmailHour,
      POLICIES.recoveryStartEmailDay,
      POLICIES.recoveryStartIpHour,
      POLICIES.recoveryStartIpDay,
      POLICIES.recoveryVerifyIpHour,
      POLICIES.ticketUseIpHour,
      POLICIES.ticketUseFingerprintHour,
    ].every(Object.isFrozen)).toBe(true)
  })

  it('consumes IP limits, verifies Turnstile, then consumes normalized email limits', async () => {
    const email = 'person@example.com'
    const ip = '203.0.113.20'
    const response = await post('/start', { email, turnstileToken: 'turnstile-token' }, ip)

    expect(response.status).toBe(200)
    expect(verifyTurnstileMock).toHaveBeenCalledWith({
      token: 'turnstile-token',
      remoteIp: ip,
      action: 'password_recovery',
    })
    const scopes = (await testDb.select({ scope: rateLimitBuckets.scope }).from(rateLimitBuckets))
      .map((row) => row.scope)
    expect(scopes).toEqual(expect.arrayContaining([
      POLICIES.recoveryStartIpHour.scope,
      POLICIES.recoveryStartIpDay.scope,
      POLICIES.recoveryStartEmailHour.scope,
      POLICIES.recoveryStartEmailDay.scope,
    ]))
  })

  it('rejects exhausted IP before Turnstile and before touching email buckets', async () => {
    const ip = '203.0.113.21'
    const email = 'not-touched@example.com'
    const limiter = new PostgresRateLimiter(testDb, env().RATE_LIMIT_HMAC_SECRET)
    for (let i = 0; i < POLICIES.recoveryStartIpHour.limit; i++) {
      await limiter.consume(POLICIES.recoveryStartIpHour, ip)
    }

    const response = await post('/start', { email, turnstileToken: 'turnstile-token' }, ip)

    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' })
    expect(verifyTurnstileMock).not.toHaveBeenCalled()
    const emailKey = await hashRateLimitKey(
      env().RATE_LIMIT_HMAC_SECRET,
      POLICIES.recoveryStartEmailHour.scope,
      email,
      'identity',
    )
    const emailRows = await testDb.select().from(rateLimitBuckets).where(and(
      eq(rateLimitBuckets.scope, POLICIES.recoveryStartEmailHour.scope),
      eq(rateLimitBuckets.keyHash, emailKey),
    ))
    expect(emailRows).toHaveLength(0)
  })

  it('does not touch email buckets when Turnstile rejects the request', async () => {
    const email = 'blocked@example.com'
    verifyTurnstileMock.mockRejectedValueOnce(
      new SecurityHttpError(403, 'TURNSTILE_INVALID', TURNSTILE_INVALID_MESSAGE),
    )

    const response = await post('/start', { email, turnstileToken: 'bad-token' })

    expect(response.status).toBe(403)
    const rows = await testDb.select({ scope: rateLimitBuckets.scope }).from(rateLimitBuckets)
    expect(rows.map((row) => row.scope)).not.toContain(POLICIES.recoveryStartEmailHour.scope)
    expect(rows.map((row) => row.scope)).not.toContain(POLICIES.recoveryStartEmailDay.scope)
  })

  it('protects code verification with its dedicated IP bucket', async () => {
    const ip = '203.0.113.22'
    const response = await post('/verify', { recoveryId: crypto.randomUUID() }, ip)

    expect(response.status).toBe(200)
    const expected = await hashRateLimitKey(
      env().RATE_LIMIT_HMAC_SECRET,
      POLICIES.recoveryVerifyIpHour.scope,
      ip,
      'opaque',
    )
    const rows = await testDb.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.keyHash, expected))
    expect(rows).toHaveLength(1)
  })

  it('protects ticket use by IP and token fingerprint without storing either raw value', async () => {
    const ip = '203.0.113.23'
    const resetTicket = 'raw-reset-ticket-that-must-never-be-persisted-123456789'
    const response = await post('/ticket', { resetTicket }, ip)

    expect(response.status).toBe(200)
    const rows = await testDb.select().from(rateLimitBuckets)
    expect(rows.map((row) => row.scope)).toEqual(expect.arrayContaining([
      POLICIES.ticketUseIpHour.scope,
      POLICIES.ticketUseFingerprintHour.scope,
    ]))
    const expectedFingerprint = await hashRateLimitKey(
      env().RATE_LIMIT_HMAC_SECRET,
      POLICIES.ticketUseFingerprintHour.scope,
      resetTicket,
      'opaque',
    )
    expect(rows.map((row) => row.keyHash)).toContain(expectedFingerprint)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(resetTicket)
    expect(serialized).not.toContain(ip)
  })
})

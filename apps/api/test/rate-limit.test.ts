import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import { rateLimitBuckets } from '../src/db/schema'
import { hashRateLimitKey } from '../src/security/rate-limit-key'
import { PostgresRateLimiter, type RateLimitPolicy } from '../src/security/rate-limit'

const SECRET = 'rate-secret'

function policy(overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy {
  return {
    scope: 'test-2-minute',
    subjectKind: 'opaque',
    limit: 2,
    windowMs: 60_000,
    retentionMs: 120_000,
    ...overrides,
  }
}

const limiter = new PostgresRateLimiter(testDb, SECRET)

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('PostgresRateLimiter', () => {
  it('denies the first no-cooldown call over the fixed-window limit', async () => {
    const p = policy()
    const now = new Date('2026-01-01T00:00:00.000Z')

    expect((await limiter.consume(p, 'subject', now)).allowed).toBe(true)
    expect((await limiter.consume(p, 'subject', now)).allowed).toBe(true)
    const denied = await limiter.consume(p, 'subject', now)

    expect(denied).toMatchObject({
      allowed: false,
      count: 3,
      limit: 2,
      blockedUntil: null,
    })
    expect(denied.retryAfterSeconds).toBe(60)
  })

  it('allows exactly one of two concurrent calls racing for the last slot', async () => {
    const p = policy({ scope: 'test-last-slot', limit: 2 })
    const now = new Date('2026-01-01T00:00:00.000Z')
    await limiter.consume(p, 'subject', now)

    const results = await Promise.all([
      limiter.consume(p, 'subject', now),
      limiter.consume(p, 'subject', now),
    ])

    expect(results.filter((result) => result.allowed)).toHaveLength(1)
    expect(results.map((result) => result.count).sort((a, b) => a - b)).toEqual([2, 3])
  })

  it('rolls fixed buckets over on UTC boundaries', async () => {
    const p = policy({ scope: 'test-utc-rollover', limit: 1 })
    const beforeBoundary = new Date('2026-01-01T00:00:59.999Z')
    const atBoundary = new Date('2026-01-01T00:01:00.000Z')

    expect(await limiter.consume(p, 'subject', beforeBoundary)).toMatchObject({
      allowed: true,
      count: 1,
    })
    expect(await limiter.consume(p, 'subject', beforeBoundary)).toMatchObject({
      allowed: false,
      count: 2,
    })
    expect(await limiter.consume(p, 'subject', atBoundary)).toMatchObject({
      allowed: true,
      count: 1,
    })

    const keyHash = await hashRateLimitKey(SECRET, p.scope, 'subject', p.subjectKind)
    const rows = await testDb
      .select({ windowStart: rateLimitBuckets.windowStart, count: rateLimitBuckets.count })
      .from(rateLimitBuckets)
      .where(and(eq(rateLimitBuckets.scope, p.scope), eq(rateLimitBuckets.keyHash, keyHash)))
      .orderBy(rateLimitBuckets.windowStart)

    expect(rows).toEqual([
      { windowStart: new Date('2026-01-01T00:00:00.000Z'), count: 2 },
      { windowStart: new Date('2026-01-01T00:01:00.000Z'), count: 1 },
    ])
  })

  it('keeps equal subjects independent across scopes', async () => {
    const first = policy({ scope: 'test-scope-a', limit: 1 })
    const second = policy({ scope: 'test-scope-b', limit: 1 })
    const now = new Date('2026-01-01T00:00:00.000Z')

    expect(await limiter.consume(first, 'subject', now)).toMatchObject({ allowed: true, count: 1 })
    expect(await limiter.consume(first, 'subject', now)).toMatchObject({ allowed: false, count: 2 })
    expect(await limiter.consume(second, 'subject', now)).toMatchObject({ allowed: true, count: 1 })
  })

  it('inspects the current bucket without incrementing it', async () => {
    const p = policy({ scope: 'test-inspect', limit: 2 })
    const now = new Date('2026-01-01T00:00:00.000Z')
    await limiter.consume(p, 'subject', now)

    expect(await limiter.inspect(p, 'subject', now)).toMatchObject({
      allowed: true,
      count: 1,
      retryAfterSeconds: 0,
    })
    expect(await limiter.inspect(p, 'subject', now)).toMatchObject({ count: 1 })
    expect(await limiter.consume(p, 'subject', now)).toMatchObject({ allowed: true, count: 2 })
  })

  it('clears all hashed buckets for a subject across provided policies', async () => {
    const first = policy({ scope: 'test-clear-a' })
    const second = policy({ scope: 'test-clear-b' })
    const otherSubject = 'other-subject'
    const now = new Date('2026-01-01T00:00:00.000Z')

    await limiter.consume(first, 'subject', now)
    await limiter.consume(second, 'subject', now)
    await limiter.consume(first, otherSubject, now)
    await limiter.clear([first, second], 'subject')

    expect(await limiter.inspect(first, 'subject', now)).toMatchObject({ count: 0 })
    expect(await limiter.inspect(second, 'subject', now)).toMatchObject({ count: 0 })
    expect(await limiter.inspect(first, otherSubject, now)).toMatchObject({ count: 1 })
  })

  it('stores only HMAC key hashes and sets expires_at to the latest required retention time', async () => {
    const rawSubject = 'raw-user@example.test'
    const p = policy({
      scope: 'test-expiry-and-hash',
      subjectKind: 'identity',
      limit: 1,
      retentionMs: 60_000,
      cooldownMs: 180_000,
    })
    const now = new Date('2026-01-01T00:00:30.000Z')

    await limiter.consume(p, rawSubject, now)

    const expectedHash = await hashRateLimitKey(SECRET, p.scope, rawSubject, p.subjectKind)
    const rows = await testDb.select().from(rateLimitBuckets)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scope: p.scope,
      keyHash: expectedHash,
      windowStart: new Date('2026-01-01T00:00:00.000Z'),
      blockedUntil: new Date('2026-01-01T00:03:30.000Z'),
      expiresAt: new Date('2026-01-01T00:03:30.000Z'),
    })
    expect(JSON.stringify(rows)).not.toContain(rawSubject)
    expect(JSON.stringify(rows)).not.toContain('raw-user')
    expect(JSON.stringify(rows)).not.toContain('example.test')
  })

  it('allows the cooldown threshold-crossing call and denies following calls until the block expires', async () => {
    const p = policy({
      scope: 'test-cooldown',
      limit: 2,
      cooldownMs: 5 * 60_000,
    })
    const now = new Date('2026-01-01T00:00:00.000Z')

    expect(await limiter.consume(p, 'subject', now)).toMatchObject({
      allowed: true,
      count: 1,
      blockedUntil: null,
    })
    expect(await limiter.consume(p, 'subject', now)).toMatchObject({
      allowed: true,
      count: 2,
      blockedUntil: new Date('2026-01-01T00:05:00.000Z'),
    })
    const blocked = await limiter.consume(p, 'subject', new Date('2026-01-01T00:00:30.000Z'))
    expect(blocked).toMatchObject({
      allowed: false,
      count: 3,
      blockedUntil: new Date('2026-01-01T00:05:00.000Z'),
    })
    expect(blocked.retryAfterSeconds).toBe(270)

    expect(await limiter.consume(p, 'subject', new Date('2026-01-01T00:05:00.000Z'))).toMatchObject({
      allowed: true,
      count: 1,
    })
  })

  it('keeps cooldown blocks effective after the fixed window rolls over', async () => {
    const p = policy({
      scope: 'test-cooldown-window-rollover',
      limit: 1,
      cooldownMs: 5 * 60_000,
    })

    expect(await limiter.consume(p, 'subject', new Date('2026-01-01T00:00:00.000Z'))).toMatchObject({
      allowed: true,
      count: 1,
      blockedUntil: new Date('2026-01-01T00:05:00.000Z'),
    })

    const blocked = await limiter.consume(p, 'subject', new Date('2026-01-01T00:01:00.000Z'))
    expect(blocked).toMatchObject({
      allowed: false,
      count: 1,
      blockedUntil: new Date('2026-01-01T00:05:00.000Z'),
    })
    expect(blocked.retryAfterSeconds).toBe(240)
  })

  it('does not shorten an existing future cooldown block under concurrent consumes', async () => {
    const p = policy({
      scope: 'test-cooldown-concurrent',
      limit: 1,
      cooldownMs: 10 * 60_000,
    })
    await limiter.consume(p, 'subject', new Date('2026-01-01T00:00:00.000Z'))

    const results = await Promise.all([
      limiter.consume(p, 'subject', new Date('2026-01-01T00:01:00.000Z')),
      limiter.consume(p, 'subject', new Date('2026-01-01T00:01:00.000Z')),
    ])

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.allowed).toBe(false)
      expect(result.blockedUntil).toEqual(new Date('2026-01-01T00:10:00.000Z'))
    }

    const inspected = await limiter.inspect(p, 'subject', new Date('2026-01-01T00:01:00.000Z'))
    expect(inspected.blockedUntil).toEqual(new Date('2026-01-01T00:10:00.000Z'))
  })
})

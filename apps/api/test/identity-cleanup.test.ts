import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  authActionTickets,
  authChallenges,
  emailOutbox,
  identitySecurityEvents,
  pendingRegistrations,
  users,
} from '../src/db/schema'
import { cleanupIdentityState } from '../src/services/identity-cleanup.service'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const NOW = new Date('2026-07-12T12:00:00.000Z')
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('identity lifecycle cleanup', () => {
  it('applies exact retention boundaries without touching provisioned users', async () => {
    const activeUserId = crypto.randomUUID()
    const provisionedUserId = crypto.randomUUID()
    await testDb.insert(users).values([
      { id: activeUserId, name: 'Active', email: 'active@example.com', status: 'ACTIVE' },
      {
        id: provisionedUserId,
        name: 'Provisioned',
        email: 'provisioned@example.com',
        role: 'STORE',
        status: 'PENDING_EMAIL',
        registrationSource: 'ADMIN_PROVISIONED',
        createdAt: new Date(NOW.getTime() - 180 * DAY),
      },
    ])

    await testDb.insert(pendingRegistrations).values([
      { email: 'expired@example.com', name: 'Expired', role: 'CUSTOMER', passwordHash: 'hash', expiresAt: NOW },
      { email: 'future@example.com', name: 'Future', role: 'CUSTOMER', passwordHash: 'hash', expiresAt: new Date(NOW.getTime() + 1) },
      {
        email: 'consumed@example.com',
        name: 'Consumed',
        role: 'DRIVER',
        passwordHash: 'hash',
        expiresAt: new Date(NOW.getTime() + DAY),
        consumedAt: new Date(NOW.getTime() - DAY),
      },
    ])

    await testDb.insert(authChallenges).values([
      {
        purpose: 'PASSWORD_RECOVERY', email: 'expired-challenge@example.com', codeHash: 'hash-1',
        expiresAt: new Date(NOW.getTime() - DAY),
      },
      {
        purpose: 'PASSWORD_RECOVERY', email: 'newer-challenge@example.com', codeHash: 'hash-2',
        expiresAt: new Date(NOW.getTime() - DAY + 1),
      },
      {
        purpose: 'PASSWORD_RECOVERY', email: 'invalidated@example.com', codeHash: 'hash-3',
        expiresAt: new Date(NOW.getTime() + DAY), invalidatedAt: new Date(NOW.getTime() - DAY),
      },
    ])

    await testDb.insert(authActionTickets).values([
      {
        userId: activeUserId, purpose: 'PASSWORD_RESET', tokenHash: 'ticket-consumed',
        expiresAt: new Date(NOW.getTime() + DAY), consumedAt: new Date(NOW.getTime() - DAY),
      },
      {
        userId: activeUserId, purpose: 'PASSWORD_RESET', tokenHash: 'ticket-expired',
        expiresAt: new Date(NOW.getTime() - DAY),
      },
      {
        userId: activeUserId, purpose: 'PASSWORD_RESET', tokenHash: 'ticket-newer',
        expiresAt: new Date(NOW.getTime() + DAY), consumedAt: new Date(NOW.getTime() - DAY + 1),
      },
    ])

    const outboxRows = [
      { status: 'SENT' as const, age: 7 * DAY, id: crypto.randomUUID() },
      { status: 'CANCELLED' as const, age: 7 * DAY, id: crypto.randomUUID() },
      { status: 'FAILED' as const, age: 30 * DAY, id: crypto.randomUUID() },
      { status: 'SENT' as const, age: 7 * DAY - 1, id: crypto.randomUUID() },
      { status: 'FAILED' as const, age: 30 * DAY - 1, id: crypto.randomUUID() },
      { status: 'PENDING' as const, age: 60 * DAY, id: crypto.randomUUID() },
    ]
    await testDb.insert(emailOutbox).values(outboxRows.map((row, index) => ({
      id: row.id,
      template: 'ACCOUNT_EXISTS_NOTICE',
      recipient: `outbox-${index}@example.com`,
      idempotencyKey: `outbox:${row.id}`,
      status: row.status,
      createdAt: new Date(NOW.getTime() - row.age),
      updatedAt: new Date(NOW.getTime() - row.age),
      sentAt: row.status === 'SENT' ? new Date(NOW.getTime() - row.age) : null,
      nextAttemptAt: new Date(NOW.getTime() + DAY),
    })))

    await testDb.insert(identitySecurityEvents).values([
      { eventType: 'CLEANUP', result: 'SUCCESS', createdAt: new Date(NOW.getTime() - 90 * DAY) },
      { eventType: 'CLEANUP', result: 'SUCCESS', createdAt: new Date(NOW.getTime() - 90 * DAY + 1) },
    ])

    await expect(cleanupIdentityState(testDb, NOW)).resolves.toEqual({
      pendingRegistrations: 2,
      challenges: 2,
      tickets: 2,
      outbox: 3,
      events: 1,
    })

    const counts = await Promise.all([
      testDb.select({ count: sql<number>`count(*)::int` }).from(pendingRegistrations),
      testDb.select({ count: sql<number>`count(*)::int` }).from(authChallenges),
      testDb.select({ count: sql<number>`count(*)::int` }).from(authActionTickets),
      testDb.select({ count: sql<number>`count(*)::int` }).from(emailOutbox),
      testDb.select({ count: sql<number>`count(*)::int` }).from(identitySecurityEvents),
    ])
    expect(counts.map((rows) => rows[0]!.count)).toEqual([1, 1, 1, 3, 1])
    expect(await testDb.select().from(users).where(eq(users.id, provisionedUserId))).toHaveLength(1)
  })

  it('cancels stale code mail even when its next attempt is not due', async () => {
    const challengeId = crypto.randomUUID()
    await testDb.insert(authChallenges).values({
      id: challengeId,
      purpose: 'PASSWORD_RECOVERY',
      email: 'stale@example.com',
      codeHash: 'hash',
      expiresAt: new Date(NOW.getTime() - 1),
    })
    const outboxId = crypto.randomUUID()
    await testDb.insert(emailOutbox).values({
      id: outboxId,
      template: 'PASSWORD_RECOVERY',
      recipient: 'stale@example.com',
      challengeId,
      idempotencyKey: `outbox:${outboxId}`,
      nextAttemptAt: new Date(NOW.getTime() + DAY),
    })

    await expect(cleanupIdentityState(testDb, NOW)).resolves.toMatchObject({ outbox: 1, challenges: 0 })
    const [row] = await testDb.select().from(emailOutbox).where(eq(emailOutbox.id, outboxId))
    expect(row).toMatchObject({ status: 'CANCELLED', failureClass: 'CHALLENGE_INACTIVE', leasedUntil: null })
  })

  it('caps every invocation at 500 rows', async () => {
    await testDb.insert(identitySecurityEvents).values(Array.from({ length: 502 }, (_, index) => ({
      eventType: 'CLEANUP',
      result: 'SUCCESS',
      requestId: crypto.randomUUID(),
      subjectKey: `${String(index).padStart(43, '0')}`,
      createdAt: new Date(NOW.getTime() - (91 * DAY + index)),
    })))

    await expect(cleanupIdentityState(testDb, NOW, 1_000)).resolves.toMatchObject({ events: 500 })
    const [remaining] = await testDb.select({ count: sql<number>`count(*)::int` }).from(identitySecurityEvents)
    expect(remaining!.count).toBe(2)
  })
})

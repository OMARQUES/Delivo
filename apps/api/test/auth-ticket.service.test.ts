import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { authActionTickets, authChallenges, users } from '../src/db/schema'
import { hashActionTicket } from '../src/security/auth-code'
import {
  claimActionTicket,
  inspectActionTicket,
  issueActionTicket,
} from '../src/services/auth-ticket.service'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const SECRET = 'action-ticket-secret-with-at-least-32-bytes'
const NOW = new Date('2026-07-13T12:00:00.000Z')
const TEN_MINUTES = 10 * 60_000

async function ticketSubject(role: 'CUSTOMER' | 'DRIVER' = 'CUSTOMER') {
  const [user] = await testDb.insert(users).values({
    name: 'Ticket User',
    email: `ticket-${crypto.randomUUID()}@example.test`,
    role,
    status: role === 'DRIVER' ? 'PENDING_APPROVAL' : 'ACTIVE',
    emailVerifiedAt: NOW,
  }).returning()
  if (!user) throw new Error('ticket user was not created')

  const [challenge] = await testDb.insert(authChallenges).values({
    purpose: 'PASSWORD_RECOVERY',
    userId: user.id,
    codeHash: `challenge-${crypto.randomUUID()}`,
    expiresAt: new Date(NOW.getTime() + TEN_MINUTES),
    consumedAt: NOW,
    createdAt: NOW,
  }).returning()
  if (!challenge) throw new Error('ticket challenge was not created')
  return { user, challenge }
}

async function issueFixture(role: 'CUSTOMER' | 'DRIVER' = 'CUSTOMER') {
  const { user, challenge } = await ticketSubject(role)
  const issued = await testDb.transaction((tx) => issueActionTicket(tx, {
    userId: user.id,
    purpose: 'PASSWORD_RESET',
    challengeId: challenge.id,
    authCodeSecret: SECRET,
    now: NOW,
  }))
  return { user, challenge, issued }
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('auth action tickets', () => {
  it('persists only a keyed hash bound to user, purpose, challenge, and ten-minute expiry', async () => {
    const { user, challenge, issued } = await issueFixture()

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(issued.expiresAt).toEqual(new Date(NOW.getTime() + TEN_MINUTES))
    const [row] = await testDb.select().from(authActionTickets)
    expect(row).toMatchObject({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      challengeId: challenge.id,
      tokenHash: await hashActionTicket(SECRET, issued.token),
      expiresAt: issued.expiresAt,
      consumedAt: null,
      createdAt: NOW,
    })
    expect(row?.tokenHash).not.toBe(issued.token)
    expect(JSON.stringify(row)).not.toContain(issued.token)
  })

  it('rejects an unconsumed or cross-user challenge before ticket creation', async () => {
    const { user, challenge } = await ticketSubject()
    const [otherUser] = await testDb.insert(users).values({
      name: 'Other User',
      email: `other-${crypto.randomUUID()}@example.test`,
      status: 'ACTIVE',
    }).returning()
    if (!otherUser) throw new Error('other user was not created')

    await expect(testDb.transaction((tx) => issueActionTicket(tx, {
      userId: otherUser.id,
      purpose: 'PASSWORD_RESET',
      challengeId: challenge.id,
      authCodeSecret: SECRET,
      now: NOW,
    }))).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED' })

    await expect(testDb.transaction((tx) => issueActionTicket(tx, {
      userId: user.id,
      purpose: 'INITIAL_PASSWORD_SETUP',
      challengeId: challenge.id,
      authCodeSecret: SECRET,
      now: NOW,
    }))).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED' })

    await testDb.update(authChallenges).set({ consumedAt: null }).where(eq(authChallenges.id, challenge.id))
    await expect(testDb.transaction((tx) => issueActionTicket(tx, {
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      challengeId: challenge.id,
      authCodeSecret: SECRET,
      now: NOW,
    }))).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED' })
    expect(await testDb.select().from(authActionTickets)).toHaveLength(0)
  })

  it('issues at most one ticket from the same consumed challenge under concurrency', async () => {
    const { user, challenge } = await ticketSubject()
    const issue = () => testDb.transaction((tx) => issueActionTicket(tx, {
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      challengeId: challenge.id,
      authCodeSecret: SECRET,
      now: NOW,
    }))

    const results = await Promise.allSettled([issue(), issue()])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await testDb.select().from(authActionTickets)).toHaveLength(1)
  })

  it('inspects an active ticket without consuming it and returns the current user role', async () => {
    const { issued } = await issueFixture('DRIVER')

    await expect(inspectActionTicket(testDb, {
      token: issued.token,
      purpose: 'PASSWORD_RESET',
      authCodeSecret: SECRET,
      now: new Date(NOW.getTime() + TEN_MINUTES - 1),
    })).resolves.toMatchObject({ role: 'DRIVER', consumedAt: null })

    const [row] = await testDb.select().from(authActionTickets)
    expect(row?.consumedAt).toBeNull()
  })

  it('rejects wrong purpose, malformed secret, and the exact expiry boundary generically', async () => {
    const { issued } = await issueFixture()

    await expect(inspectActionTicket(testDb, {
      token: issued.token,
      purpose: 'INITIAL_PASSWORD_SETUP',
      authCodeSecret: SECRET,
      now: NOW,
    })).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED' })
    await expect(inspectActionTicket(testDb, {
      token: issued.token,
      purpose: 'PASSWORD_RESET',
      authCodeSecret: SECRET,
      now: new Date(NOW.getTime() + TEN_MINUTES),
    })).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED' })
    await expect(inspectActionTicket(testDb, {
      token: issued.token,
      purpose: 'PASSWORD_RESET',
      authCodeSecret: '   ',
      now: NOW,
    })).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED' })
  })

  it('claims once and rejects replay without changing the original consumption time', async () => {
    const { issued } = await issueFixture()
    const claimedAt = new Date(NOW.getTime() + 1_000)

    await expect(testDb.transaction((tx) => claimActionTicket(tx, {
      token: issued.token,
      purpose: 'PASSWORD_RESET',
      authCodeSecret: SECRET,
      now: claimedAt,
    }))).resolves.toMatchObject({ consumedAt: claimedAt })
    await expect(testDb.transaction((tx) => claimActionTicket(tx, {
      token: issued.token,
      purpose: 'PASSWORD_RESET',
      authCodeSecret: SECRET,
      now: new Date(claimedAt.getTime() + 1),
    }))).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED' })

    const [row] = await testDb.select().from(authActionTickets)
      .where(eq(authActionTickets.tokenHash, await hashActionTicket(SECRET, issued.token)))
    expect(row?.consumedAt).toEqual(claimedAt)
  })

  it('allows exactly one winner across concurrent claims', async () => {
    const { issued } = await issueFixture()
    const claim = () => testDb.transaction((tx) => claimActionTicket(tx, {
      token: issued.token,
      purpose: 'PASSWORD_RESET',
      authCodeSecret: SECRET,
      now: new Date(NOW.getTime() + 1_000),
    }))

    const results = await Promise.allSettled([claim(), claim()])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const [row] = await testDb.select().from(authActionTickets)
    expect(row?.consumedAt).toEqual(new Date(NOW.getTime() + 1_000))
  })
})

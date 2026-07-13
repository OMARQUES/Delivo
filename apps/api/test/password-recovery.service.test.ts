import { decode } from 'hono/jwt'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authActionTickets,
  authChallenges,
  authProviders,
  emailOutbox,
  identitySecurityEvents,
  refreshTokens,
  users,
} from '../src/db/schema'
import { verifyPassword } from '../src/lib/password'
import { signAccessToken } from '../src/lib/tokens'
import { deriveAuthCode, hashActionTicket } from '../src/security/auth-code'
import { issueSessionTokens, loginUser, rotateRefreshToken, toPublicUser } from '../src/services/auth.service'
import {
  resetPassword,
  startPasswordRecovery,
  verifyPasswordRecovery,
} from '../src/services/password-recovery.service'
import { resolveLivePrincipal } from '../src/services/security-session.service'
import {
  closeTestDb,
  createVerifiedTestUser,
  migrateTestDb,
  testDb,
  truncateAll,
} from './helpers/test-db'

const noticeFailure = vi.hoisted(() => ({ enabled: false }))

vi.mock('../src/email/outbox.service', async () => {
  const actual = await vi.importActual<typeof import('../src/email/outbox.service')>(
    '../src/email/outbox.service',
  )
  return {
    ...actual,
    enqueueNoticeEmail: (...args: Parameters<typeof actual.enqueueNoticeEmail>) => {
      if (noticeFailure.enabled) throw new Error('injected notice failure')
      return actual.enqueueNoticeEmail(...args)
    },
  }
})

const AUTH_CODE_SECRET = 'password-recovery-auth-code-secret-32-bytes'
const JWT_SECRET = 'password-recovery-jwt-secret'
const NOW = new Date('2026-07-13T12:00:00.000Z')
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PASSWORD = 'old-password-secure'
const NEW_PASSWORD = 'new-password-secure'

function context(now = NOW) {
  return {
    authCodeSecret: AUTH_CODE_SECRET,
    jwtSecret: JWT_SECRET,
    requestId: REQUEST_ID,
    now,
  }
}

async function startAndVerify(
  role: 'CUSTOMER' | 'DRIVER' | 'STORE' | 'ADMIN' = 'CUSTOMER',
) {
  const user = await createVerifiedTestUser({
    name: `Recovery ${role}`,
    email: `${role.toLowerCase()}-${crypto.randomUUID()}@example.test`,
    phone: role === 'DRIVER' ? '11999999999' : null,
    role,
    status: role === 'DRIVER' ? 'PENDING_APPROVAL' : 'ACTIVE',
    password: OLD_PASSWORD,
  })
  const started = await startPasswordRecovery(testDb, user.email, context())
  const code = await deriveAuthCode(AUTH_CODE_SECRET, {
    challengeId: started.response.recoveryId,
    purpose: 'PASSWORD_RECOVERY',
  })
  const verified = await verifyPasswordRecovery(
    testDb,
    started.response.recoveryId,
    code,
    context(),
  )
  return { user, started, verified }
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  noticeFailure.enabled = false
  await truncateAll()
})
afterAll(closeTestDb)

describe('password recovery start', () => {
  it.each([
    ['CUSTOMER', 'ACTIVE'],
    ['DRIVER', 'PENDING_APPROVAL'],
  ] as const)('creates one hash-only challenge and outbox for eligible %s account', async (role, status) => {
    const user = await createVerifiedTestUser({
      name: 'Eligible User',
      email: `  ELIGIBLE-${role}@EXAMPLE.TEST  `,
      phone: role === 'DRIVER' ? '11999999999' : null,
      role,
      status,
      password: OLD_PASSWORD,
    })

    const result = await startPasswordRecovery(testDb, user.email.toUpperCase(), context())

    expect(result.response).toEqual({
      recoveryId: expect.any(String),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    })
    expect(result.outboxId).toEqual(expect.any(String))
    const [challenge] = await testDb.select().from(authChallenges)
    const [outbox] = await testDb.select().from(emailOutbox)
    const code = await deriveAuthCode(AUTH_CODE_SECRET, {
      challengeId: result.response.recoveryId,
      purpose: 'PASSWORD_RECOVERY',
    })
    expect(challenge).toMatchObject({
      id: result.response.recoveryId,
      userId: user.id,
      purpose: 'PASSWORD_RECOVERY',
      expiresAt: new Date(result.response.expiresAt),
      consumedAt: null,
    })
    expect(challenge?.codeHash).not.toBe(code)
    expect(outbox).toMatchObject({
      id: result.outboxId,
      template: 'PASSWORD_RECOVERY',
      recipient: user.email,
      challengeId: challenge?.id,
    })
  })

  it.each([
    'UNKNOWN',
    'BLOCKED',
    'UNVERIFIED',
    'NO_PASSWORD',
    'PENDING_PRIVILEGED',
  ] as const)('returns synthetic-compatible response and sends no email for %s account', async (kind) => {
    const email = `${kind.toLowerCase()}@example.test`
    if (kind !== 'UNKNOWN') {
      const [user] = await testDb.insert(users).values({
        name: kind,
        email,
        role: kind === 'PENDING_PRIVILEGED' ? 'STORE' : 'CUSTOMER',
        status: kind === 'BLOCKED'
          ? 'BLOCKED'
          : kind === 'PENDING_PRIVILEGED'
            ? 'PENDING_APPROVAL'
            : 'ACTIVE',
        emailVerifiedAt: kind === 'UNVERIFIED' ? null : NOW,
      }).returning()
      if (!user) throw new Error('ineligible fixture user was not created')
      if (kind !== 'NO_PASSWORD') {
        await testDb.insert(authProviders).values({
          userId: user.id,
          provider: 'PASSWORD',
          passwordHash: 'irrelevant-existing-hash',
        })
      }
    }

    const result = await startPasswordRecovery(testDb, `  ${email.toUpperCase()}  `, context())

    expect(Object.keys(result.response).sort()).toEqual(['expiresAt', 'recoveryId'])
    expect(result.response.recoveryId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.response.expiresAt).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString())
    expect(result.outboxId).toBeNull()
    expect(await testDb.select().from(authChallenges)).toHaveLength(0)
    expect(await testDb.select().from(emailOutbox)).toHaveLength(0)
  })

  it('invalidates the previous live recovery flow when a new one starts', async () => {
    const user = await createVerifiedTestUser({
      name: 'Repeated Recovery',
      email: 'repeated@example.test',
      password: OLD_PASSWORD,
    })
    const first = await startPasswordRecovery(testDb, user.email, context())
    const secondNow = new Date(NOW.getTime() + 1_000)
    const second = await startPasswordRecovery(testDb, user.email, context(secondNow))

    const challenges = await testDb.select().from(authChallenges)
    const previous = challenges.find((row) => row.id === first.response.recoveryId)
    const current = challenges.find((row) => row.id === second.response.recoveryId)
    expect(previous).toMatchObject({ invalidatedAt: secondNow, invalidationReason: 'REPLACED' })
    expect(current?.invalidatedAt).toBeNull()
    const firstOutbox = await testDb
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.challengeId, first.response.recoveryId))
    expect(firstOutbox[0]).toMatchObject({ status: 'CANCELLED', failureClass: 'CHALLENGE_REPLACED' })
  })
})

describe('password recovery verification', () => {
  it('rejects synthetic, wrong, and expired flows with one generic error', async () => {
    const synthetic = await startPasswordRecovery(testDb, 'missing@example.test', context())
    await expect(verifyPasswordRecovery(
      testDb,
      synthetic.response.recoveryId,
      '123456',
      context(),
    )).rejects.toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })

    const user = await createVerifiedTestUser({
      name: 'Verify User',
      email: 'verify@example.test',
      password: OLD_PASSWORD,
    })
    const started = await startPasswordRecovery(testDb, user.email, context())
    await expect(verifyPasswordRecovery(
      testDb,
      started.response.recoveryId,
      '999999',
      context(),
    )).rejects.toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })
    await expect(verifyPasswordRecovery(
      testDb,
      started.response.recoveryId,
      await deriveAuthCode(AUTH_CODE_SECRET, {
        challengeId: started.response.recoveryId,
        purpose: 'PASSWORD_RECOVERY',
      }),
      context(new Date(NOW.getTime() + 10 * 60_000)),
    )).rejects.toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })
    expect(await testDb.select().from(authActionTickets)).toHaveLength(0)
  })

  it('consumes the correct challenge and returns a hash-only, single-use ticket', async () => {
    const { started, verified } = await startAndVerify()

    expect(verified).toEqual({
      resetTicket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    })
    const [challenge] = await testDb
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.id, started.response.recoveryId))
    const [ticket] = await testDb.select().from(authActionTickets)
    expect(challenge?.consumedAt).toEqual(NOW)
    expect(ticket).toMatchObject({
      challengeId: challenge?.id,
      purpose: 'PASSWORD_RESET',
      tokenHash: await hashActionTicket(AUTH_CODE_SECRET, verified.resetTicket),
      consumedAt: null,
    })
    expect(JSON.stringify(ticket)).not.toContain(verified.resetTicket)
  })
})

describe('password reset', () => {
  it.each([
    ['CUSTOMER', 'short', 'PASSWORD_TOO_SHORT'],
    ['DRIVER', 'short-pass', 'PASSWORD_TOO_SHORT'],
    ['DRIVER', 'passwordpassword', 'PASSWORD_TOO_COMMON'],
  ] as const)('enforces current %s password policy without consuming ticket', async (role, password, issue) => {
    const { verified } = await startAndVerify(role)

    await expect(resetPassword(testDb, verified.resetTicket, password, context())).rejects.toMatchObject({
      code: 'PASSWORD_POLICY_REJECTED',
      policyIssue: issue,
    })
    const [ticket] = await testDb.select().from(authActionTickets)
    expect(ticket?.consumedAt).toBeNull()
  })

  it('atomically replaces credentials, revokes sessions, audits, queues notice, and returns no session', async () => {
    const { user, verified } = await startAndVerify()
    const sessions = await testDb.transaction((tx) => issueSessionTokens(
      tx,
      toPublicUser(user),
      user.tokenVersion,
      JWT_SECRET,
      NOW,
    ))
    const [familyBefore] = await testDb
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, user.id))
    if (!familyBefore) throw new Error('session fixture was not created')
    const oldPayload = decode(sessions.accessToken).payload

    const result = await resetPassword(testDb, verified.resetTicket, NEW_PASSWORD, context())

    expect(result).toBeUndefined()
    const [provider] = await testDb
      .select()
      .from(authProviders)
      .where(and(eq(authProviders.userId, user.id), eq(authProviders.provider, 'PASSWORD')))
    expect(await verifyPassword(OLD_PASSWORD, provider?.passwordHash ?? '')).toBe(false)
    expect(await verifyPassword(NEW_PASSWORD, provider?.passwordHash ?? '')).toBe(true)
    const [updatedUser] = await testDb.select().from(users).where(eq(users.id, user.id))
    expect(updatedUser?.tokenVersion).toBe(1)
    const families = await testDb.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id))
    expect(families.every((token) => token.revokedAt?.getTime() === NOW.getTime())).toBe(true)
    const [event] = await testDb
      .select()
      .from(identitySecurityEvents)
      .where(eq(identitySecurityEvents.eventType, 'PASSWORD_RESET'))
    expect(event).toMatchObject({
      eventType: 'PASSWORD_RESET',
      result: 'SUCCESS',
      targetUserId: user.id,
      requestId: REQUEST_ID,
    })
    const notices = await testDb.select().from(emailOutbox).where(eq(emailOutbox.template, 'PASSWORD_CHANGED_NOTICE'))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ recipient: user.email, status: 'PENDING', challengeId: null })

    await expect(resolveLivePrincipal(testDb, oldPayload as never, NOW)).rejects.toMatchObject({ status: 401 })
    const forgedCurrentVersion = await signAccessToken(
      { sub: user.id, role: user.role, name: user.name, tokenVersion: 1 },
      JWT_SECRET,
      familyBefore.familyId,
      NOW,
    )
    await expect(resolveLivePrincipal(testDb, decode(forgedCurrentVersion).payload as never, NOW))
      .rejects.toMatchObject({ status: 401 })
    await expect(rotateRefreshToken(testDb, sessions.refreshToken, JWT_SECRET)).rejects.toMatchObject({ status: 401 })

    const freshLogin = await loginUser(testDb, { email: user.email, password: NEW_PASSWORD }, JWT_SECRET)
    await expect(resolveLivePrincipal(testDb, decode(freshLogin.accessToken).payload as never, new Date()))
      .resolves.toMatchObject({ sub: user.id, tokenVersion: 1 })
  })

  it('rolls back ticket, credential, version, sessions, audit, and notice on injected failure', async () => {
    const { user, verified } = await startAndVerify()
    await testDb.transaction((tx) => issueSessionTokens(
      tx,
      toPublicUser(user),
      user.tokenVersion,
      JWT_SECRET,
      NOW,
    ))
    const [providerBefore] = await testDb.select().from(authProviders).where(eq(authProviders.userId, user.id))
    noticeFailure.enabled = true

    await expect(resetPassword(testDb, verified.resetTicket, NEW_PASSWORD, context()))
      .rejects.toThrow('injected notice failure')

    const [ticket] = await testDb.select().from(authActionTickets)
    const [providerAfter] = await testDb.select().from(authProviders).where(eq(authProviders.userId, user.id))
    const [userAfter] = await testDb.select().from(users).where(eq(users.id, user.id))
    const families = await testDb.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id))
    expect(ticket?.consumedAt).toBeNull()
    expect(providerAfter?.passwordHash).toBe(providerBefore?.passwordHash)
    expect(userAfter?.tokenVersion).toBe(0)
    expect(families.every((token) => token.revokedAt === null)).toBe(true)
    expect(await testDb.select().from(identitySecurityEvents)).toHaveLength(1) // successful code proof only
    expect(await testDb.select().from(emailOutbox).where(eq(emailOutbox.template, 'PASSWORD_CHANGED_NOTICE')))
      .toHaveLength(0)
  })

  it('allows exactly one concurrent reset winner', async () => {
    const { user, verified } = await startAndVerify()

    const results = await Promise.allSettled([
      resetPassword(testDb, verified.resetTicket, NEW_PASSWORD, context()),
      resetPassword(testDb, verified.resetTicket, NEW_PASSWORD, context()),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'FLOW_INVALID_OR_EXPIRED' },
    })
    const [updated] = await testDb.select().from(users).where(eq(users.id, user.id))
    expect(updated?.tokenVersion).toBe(1)
    const notices = await testDb.select().from(emailOutbox).where(eq(emailOutbox.template, 'PASSWORD_CHANGED_NOTICE'))
    expect(notices).toHaveLength(1)
    expect((await testDb.select().from(identitySecurityEvents)).filter((row) => row.eventType === 'PASSWORD_RESET'))
      .toHaveLength(1)
  })
})

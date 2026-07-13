import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import {
  authChallenges,
  authProviders,
  emailOutbox,
  identitySecurityEvents,
  users,
} from '../src/db/schema'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const faults = vi.hoisted(() => ({ challenge: false, outbox: false }))

vi.mock('../src/services/auth-challenge.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/auth-challenge.service')>()
  return {
    ...actual,
    createChallenge: (...args: Parameters<typeof actual.createChallenge>) => {
      if (faults.challenge) throw new Error('injected challenge failure')
      return actual.createChallenge(...args)
    },
  }
})

vi.mock('../src/email/outbox.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/email/outbox.service')>()
  return {
    ...actual,
    enqueueChallengeEmail: (...args: Parameters<typeof actual.enqueueChallengeEmail>) => {
      if (faults.outbox) throw new Error('injected outbox failure')
      return actual.enqueueChallengeEmail(...args)
    },
  }
})

import {
  AdminBootstrapError,
  bootstrapAdmin,
  type BootstrapAdminInput,
} from '../src/services/admin-bootstrap.service'
import { confirmEmailFlow } from '../src/services/registration.service'
import { loginUser } from '../src/services/auth.service'
import { deriveAuthCode } from '../src/security/auth-code'
import { verifyPassword } from '../src/lib/password'

const NOW = new Date('2026-07-13T15:00:00.000Z')
const AUTH_CODE_SECRET = 'bootstrap-auth-code-secret-with-enough-entropy'
const JWT_SECRET = 'bootstrap-jwt-secret'
const input: BootstrapAdminInput = {
  name: '  Bootstrap Admin  ',
  email: '  ADMIN@Example.Test  ',
  password: 'bootstrap-admin-secret',
}

function context(now = NOW, requestId = crypto.randomUUID()) {
  return { authCodeSecret: AUTH_CODE_SECRET, requestId, now }
}

async function challengeCode(challengeId: string) {
  return deriveAuthCode(AUTH_CODE_SECRET, {
    challengeId,
    purpose: 'ADMIN_ACTIVATION',
  })
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  faults.challenge = false
  faults.outbox = false
  await truncateAll()
})
afterAll(closeTestDb)

describe('bootstrapAdmin', () => {
  it.each([
    [{ ...input, name: 'x' }, 'INVALID_INPUT'],
    [{ ...input, email: 'not-an-email' }, 'INVALID_INPUT'],
    [{ ...input, password: '12345678901234' }, 'PASSWORD_POLICY_REJECTED'],
    [{ ...input, password: 'x'.repeat(129) }, 'PASSWORD_POLICY_REJECTED'],
  ] as const)('rejects invalid bootstrap input without writes', async (invalid, code) => {
    await expect(bootstrapAdmin(testDb, invalid, context())).rejects.toMatchObject({ code })
    expect(await testDb.$count(users)).toBe(0)
    expect(await testDb.$count(authProviders)).toBe(0)
    expect(await testDb.$count(authChallenges)).toBe(0)
    expect(await testDb.$count(emailOutbox)).toBe(0)
  })

  it('creates one pending ADMIN atomically without exposing credentials', async () => {
    const result = await bootstrapAdmin(testDb, input, context())

    expect(result).toEqual({ state: 'CREATED', outboxId: expect.any(String) })
    expect(Object.keys(result).sort()).toEqual(['outboxId', 'state'])
    expect(JSON.stringify(result)).not.toContain(input.email.trim().toLowerCase())
    expect(JSON.stringify(result)).not.toContain(input.password)

    const [admin] = await testDb.select().from(users)
    expect(admin).toMatchObject({
      name: 'Bootstrap Admin',
      email: 'admin@example.test',
      role: 'ADMIN',
      status: 'PENDING_EMAIL',
      registrationSource: 'BOOTSTRAP',
      emailVerifiedAt: null,
      termsAcceptedAt: null,
    })
    const [provider] = await testDb.select().from(authProviders)
    expect(provider).toMatchObject({ userId: admin?.id, provider: 'PASSWORD', providerUserId: null })
    expect(provider?.passwordHash).toMatch(/^pbkdf2\$100000\$/)
    expect(await verifyPassword(input.password, provider?.passwordHash ?? '')).toBe(true)

    const [challenge] = await testDb.select().from(authChallenges)
    expect(challenge).toMatchObject({ purpose: 'ADMIN_ACTIVATION', userId: admin?.id })
    expect(challenge?.expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60_000))
    const code = await challengeCode(challenge!.id)
    expect(JSON.stringify(challenge)).not.toContain(code)
    const [outbox] = await testDb.select().from(emailOutbox)
    expect(outbox).toMatchObject({
      id: result.outboxId,
      template: 'VERIFICATION_CODE',
      recipient: 'admin@example.test',
      challengeId: challenge?.id,
      status: 'PENDING',
    })
    expect(await testDb.select().from(identitySecurityEvents)).toHaveLength(1)
  })

  it.each(['challenge', 'outbox'] as const)('rolls back all records when %s creation fails', async (fault) => {
    faults[fault] = true
    await expect(bootstrapAdmin(testDb, input, context())).rejects.toThrow(`injected ${fault} failure`)

    expect(await testDb.$count(users)).toBe(0)
    expect(await testDb.$count(authProviders)).toBe(0)
    expect(await testDb.$count(authChallenges)).toBe(0)
    expect(await testDb.$count(emailOutbox)).toBe(0)
  })

  it('blocks login until correct email confirmation, then allows normal password login', async () => {
    await bootstrapAdmin(testDb, input, context())
    const [challenge] = await testDb.select().from(authChallenges)

    await expect(loginUser(testDb, {
      email: 'admin@example.test',
      password: input.password,
    }, JWT_SECRET)).rejects.toMatchObject({ status: 403 })
    const correctCode = await challengeCode(challenge!.id)
    const wrongCode = `${correctCode[0] === '0' ? '1' : '0'}${correctCode.slice(1)}`
    await expect(confirmEmailFlow(testDb, {
      verificationId: challenge!.id,
      code: wrongCode,
    }, {
      ...context(),
      jwtSecret: JWT_SECRET,
    })).rejects.toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })
    await expect(loginUser(testDb, {
      email: 'admin@example.test',
      password: input.password,
    }, JWT_SECRET)).rejects.toMatchObject({ status: 403 })

    const result = await confirmEmailFlow(testDb, {
      verificationId: challenge!.id,
      code: correctCode,
    }, {
      ...context(NOW, crypto.randomUUID()),
      jwtSecret: JWT_SECRET,
    })
    expect(result).toEqual({ kind: 'EMAIL_VERIFIED' })
    await expect(loginUser(testDb, {
      email: 'admin@example.test',
      password: input.password,
    }, JWT_SECRET)).resolves.toMatchObject({
      user: { role: 'ADMIN', status: 'ACTIVE', email: 'admin@example.test' },
    })
  })

  it('replaces a pending activation after cooldown and invalidates the old challenge', async () => {
    await bootstrapAdmin(testDb, input, context())
    const [oldChallenge] = await testDb.select().from(authChallenges)
    await testDb.update(authChallenges).set({
      createdAt: new Date(NOW.getTime() - 61_000),
    }).where(eq(authChallenges.id, oldChallenge!.id))

    const result = await bootstrapAdmin(testDb, {
      ...input,
      email: 'admin@example.test',
      name: 'Ignored New Name',
    }, context(NOW, crypto.randomUUID()))

    expect(result).toEqual({ state: 'RESENT', outboxId: expect.any(String) })
    const challenges = await testDb.select().from(authChallenges).orderBy(desc(authChallenges.createdAt))
    expect(challenges).toHaveLength(2)
    expect(challenges.find((item) => item.id === oldChallenge!.id)).toMatchObject({
      invalidatedAt: NOW,
      invalidationReason: 'REPLACED',
    })
    expect(challenges.find((item) => item.id !== oldChallenge!.id)).toMatchObject({
      purpose: 'ADMIN_ACTIVATION',
      consumedAt: null,
      invalidatedAt: null,
    })
    expect(await testDb.$count(emailOutbox)).toBe(2)
  })

  it('enforces resend cooldown without replacing the pending challenge', async () => {
    await bootstrapAdmin(testDb, input, context())

    await expect(bootstrapAdmin(testDb, input, context(
      new Date(NOW.getTime() + 30_000),
      crypto.randomUUID(),
    ))).rejects.toMatchObject({ code: 'RESEND_TOO_SOON' })
    expect(await testDb.$count(authChallenges)).toBe(1)
    expect(await testDb.$count(emailOutbox)).toBe(1)
  })

  it('rejects a changed password while activation is pending', async () => {
    await bootstrapAdmin(testDb, input, context())
    const [challenge] = await testDb.select().from(authChallenges)
    await testDb.update(authChallenges).set({
      createdAt: new Date(NOW.getTime() - 61_000),
    }).where(eq(authChallenges.id, challenge!.id))

    await expect(bootstrapAdmin(testDb, {
      ...input,
      password: 'different-admin-secret',
    }, context(NOW, crypto.randomUUID()))).rejects.toMatchObject({ code: 'BOOTSTRAP_UNAVAILABLE' })
    expect(await testDb.$count(authChallenges)).toBe(1)
    expect(await testDb.$count(emailOutbox)).toBe(1)
  })

  it('fails closed with a bootstrap error when pending state has no replaceable challenge', async () => {
    await bootstrapAdmin(testDb, input, context())
    const [challenge] = await testDb.select().from(authChallenges)
    await testDb.update(authChallenges).set({
      createdAt: new Date(NOW.getTime() - 61_000),
      consumedAt: NOW,
    }).where(eq(authChallenges.id, challenge!.id))

    await expect(bootstrapAdmin(testDb, input, context(NOW, crypto.randomUUID())))
      .rejects.toMatchObject({ code: 'BOOTSTRAP_UNAVAILABLE' })
    expect(await testDb.$count(authChallenges)).toBe(1)
    expect(await testDb.$count(emailOutbox)).toBe(1)
  })

  it('returns ALREADY_ACTIVE without creating another challenge or email', async () => {
    await bootstrapAdmin(testDb, input, context())
    const [challenge] = await testDb.select().from(authChallenges)
    await confirmEmailFlow(testDb, {
      verificationId: challenge!.id,
      code: await challengeCode(challenge!.id),
    }, { ...context(), jwtSecret: JWT_SECRET })

    await expect(bootstrapAdmin(testDb, input, context(
      new Date(NOW.getTime() + 60_000),
      crypto.randomUUID(),
    ))).resolves.toEqual({ state: 'ALREADY_ACTIVE', outboxId: null })
    expect(await testDb.$count(users)).toBe(1)
    expect(await testDb.$count(authProviders)).toBe(1)
    expect(await testDb.$count(authChallenges)).toBe(1)
    expect(await testDb.$count(emailOutbox)).toBe(1)
  })

  it('rejects a second ADMIN identity', async () => {
    await bootstrapAdmin(testDb, input, context())

    await expect(bootstrapAdmin(testDb, {
      ...input,
      email: 'other-admin@example.test',
    }, context(NOW, crypto.randomUUID()))).rejects.toBeInstanceOf(AdminBootstrapError)
    expect(await testDb.$count(users)).toBe(1)
    expect(await testDb.$count(authProviders)).toBe(1)
  })

  it('serializes concurrent first-admin attempts and creates exactly one ADMIN', async () => {
    const attempts = await Promise.allSettled([
      bootstrapAdmin(testDb, input, context(NOW, crypto.randomUUID())),
      bootstrapAdmin(testDb, {
        ...input,
        email: 'other-admin@example.test',
      }, context(NOW, crypto.randomUUID())),
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    expect(await testDb.$count(users)).toBe(1)
    expect(await testDb.$count(authProviders)).toBe(1)
    expect(await testDb.$count(authChallenges)).toBe(1)
    expect(await testDb.$count(emailOutbox)).toBe(1)
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { signAccessToken } from '../src/lib/tokens'
import { refreshTokens, users } from '../src/db/schema'
import {
  resolveLivePrincipal,
  revokeAllSessions,
  revokeAllSessionsInTx,
} from '../src/services/security-session.service'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const secret = 'test-secret'
const now = new Date()

async function principalFixture() {
  const [user] = await testDb.insert(users).values({
    name: 'Ana', role: 'CUSTOMER', status: 'ACTIVE', email: 'ana@test.local',
  }).returning()
  if (!user) throw new Error('fixture user was not created')
  const familyId = crypto.randomUUID()
  await testDb.insert(refreshTokens).values({
    userId: user.id,
    familyId,
    tokenHash: `fixture-${crypto.randomUUID()}`,
    expiresAt: new Date(now.getTime() + 60_000),
  })
  const token = await signAccessToken(
    { sub: user.id, role: user.role, name: user.name, tokenVersion: user.tokenVersion },
    secret,
    familyId,
    now,
  )
  return { user, familyId, token }
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('resolveLivePrincipal', () => {
  it('accepts a current user and active refresh family', async () => {
    const { user, familyId, token } = await principalFixture()
    const payload = await import('hono/jwt').then(({ decode }) => decode(token).payload)
    await expect(resolveLivePrincipal(testDb, payload as never, now)).resolves.toMatchObject({
      sub: user.id,
      role: 'CUSTOMER',
      sessionFamilyId: familyId,
      tokenVersion: 0,
    })
  })

  it('rejects a stale token version and a revoked session family', async () => {
    const { user, familyId, token } = await principalFixture()
    const payload = await import('hono/jwt').then(({ decode }) => decode(token).payload)
    await testDb.update(users).set({ tokenVersion: 1 }).where(eq(users.id, user.id))
    await expect(resolveLivePrincipal(testDb, payload as never, now)).rejects.toMatchObject({ status: 401 })

    await testDb.update(users).set({ tokenVersion: 0 }).where(eq(users.id, user.id))
    await testDb.update(refreshTokens).set({ revokedAt: now }).where(and(
      eq(refreshTokens.userId, user.id), eq(refreshTokens.familyId, familyId),
    ))
    await expect(resolveLivePrincipal(testDb, payload as never, now)).rejects.toMatchObject({ status: 401 })
  })

  it('blocks a blocked account with an explicit forbidden result', async () => {
    const { user, token } = await principalFixture()
    const payload = await import('hono/jwt').then(({ decode }) => decode(token).payload)
    await testDb.update(users).set({ status: 'BLOCKED' }).where(eq(users.id, user.id))
    await expect(resolveLivePrincipal(testDb, payload as never, now)).rejects.toMatchObject({
      status: 403,
      code: 'ACCOUNT_BLOCKED',
    })
  })
})

describe('session revocation', () => {
  it('increments tokenVersion once and revokes every live family in the caller transaction', async () => {
    const { user } = await principalFixture()
    const alreadyRevokedAt = new Date(now.getTime() - 1_000)
    await testDb.insert(refreshTokens).values([
      {
        userId: user.id,
        familyId: crypto.randomUUID(),
        tokenHash: `live-${crypto.randomUUID()}`,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      {
        userId: user.id,
        familyId: crypto.randomUUID(),
        tokenHash: `revoked-${crypto.randomUUID()}`,
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: alreadyRevokedAt,
      },
    ])

    const nextVersion = await testDb.transaction((tx) => revokeAllSessionsInTx(tx, user.id, now))

    expect(nextVersion).toBe(1)
    const [updated] = await testDb.select().from(users).where(eq(users.id, user.id))
    expect(updated?.tokenVersion).toBe(1)
    const tokens = await testDb.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id))
    expect(tokens.filter((token) => token.revokedAt === null)).toHaveLength(0)
    expect(tokens.find((token) => token.revokedAt?.getTime() === alreadyRevokedAt.getTime())).toBeTruthy()
  })

  it('rolls back version and revocations when later work in the outer transaction fails', async () => {
    const { user } = await principalFixture()

    await expect(testDb.transaction(async (tx) => {
      await revokeAllSessionsInTx(tx, user.id, now)
      throw new Error('later mutation failed')
    })).rejects.toThrow('later mutation failed')

    const [unchanged] = await testDb.select().from(users).where(eq(users.id, user.id))
    expect(unchanged?.tokenVersion).toBe(0)
    const tokens = await testDb.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id))
    expect(tokens.every((token) => token.revokedAt === null)).toBe(true)
  })

  it('keeps the public helper behavior while using the transactional primitive', async () => {
    const { user } = await principalFixture()

    await revokeAllSessions(testDb, user.id, now)

    const [updated] = await testDb.select().from(users).where(eq(users.id, user.id))
    expect(updated?.tokenVersion).toBe(1)
    const tokens = await testDb.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id))
    expect(tokens.every((token) => token.revokedAt?.getTime() === now.getTime())).toBe(true)
  })
})

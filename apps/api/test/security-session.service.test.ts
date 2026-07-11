import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { signAccessToken } from '../src/lib/tokens'
import { refreshTokens, users } from '../src/db/schema'
import { resolveLivePrincipal } from '../src/services/security-session.service'
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

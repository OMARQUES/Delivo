import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { StoreCreateInput } from '@delivery/shared/schemas'
import {
  authChallenges,
  authProviders,
  emailOutbox,
  stores,
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

import { provisionStoreWithOwner } from '../src/services/store-provisioning.service'
import { getStoreBySlug, listPublicStores, setStoreSecurityStatus } from '../src/services/store.service'

const now = new Date('2026-07-13T12:00:00.000Z')
const ctx = {
  authCodeSecret: 'test-auth-code-secret-with-enough-entropy',
  jwtSecret: 'test-jwt-secret',
  requestId: '10000000-0000-4000-8000-000000000001',
  now,
}
const input: StoreCreateInput = {
  name: 'Pizzaria do João',
  slug: 'pizzaria-do-joao',
  category: 'PIZZARIA',
  phone: '4433334444',
  city: 'Cidade Exemplo',
  addressText: 'Rua Central, 100',
  lat: -23.5,
  lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com' },
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  faults.challenge = false
  faults.outbox = false
  await truncateAll()
})
afterAll(closeTestDb)

describe('provisionStoreWithOwner', () => {
  it('atomically creates a pending owner/store and activation email without credentials', async () => {
    const result = await provisionStoreWithOwner(testDb, input, ctx)

    expect(result.store).toMatchObject({
      ownerUserId: result.owner.id,
      slug: input.slug,
      securityStatus: 'PENDING_ACTIVATION',
    })
    expect(result.owner).toMatchObject({
      name: input.owner.name,
      email: input.owner.email,
      role: 'STORE',
      status: 'PENDING_EMAIL',
    })

    const [persistedOwner] = await testDb.select().from(users).where(eq(users.id, result.owner.id))
    expect(persistedOwner).toMatchObject({
      emailVerifiedAt: null,
      registrationSource: 'ADMIN_PROVISIONED',
    })
    expect(await testDb.select().from(authProviders).where(eq(authProviders.userId, result.owner.id))).toEqual([])

    const [challenge] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, result.verificationId))
    expect(challenge).toMatchObject({ purpose: 'STORE_ACTIVATION', userId: result.owner.id })
    expect(challenge?.expiresAt).toEqual(new Date(now.getTime() + 10 * 60_000))
    const [outbox] = await testDb.select().from(emailOutbox).where(eq(emailOutbox.id, result.outboxId))
    expect(outbox).toMatchObject({
      recipient: input.owner.email,
      challengeId: result.verificationId,
      status: 'PENDING',
    })

    expect(await listPublicStores(testDb)).toEqual([])
    expect(await getStoreBySlug(testDb, input.slug)).toBeNull()
  })

  it.each([
    ['slug', { slug: input.slug, owner: { ...input.owner, email: 'outro@email.com' } }],
    ['email', { slug: 'outra-loja', owner: input.owner }],
  ])('rolls back duplicate %s without orphan records', async (_field, duplicate) => {
    await provisionStoreWithOwner(testDb, input, ctx)
    const before = {
      users: await testDb.$count(users),
      stores: await testDb.$count(stores),
      challenges: await testDb.$count(authChallenges),
      outbox: await testDb.$count(emailOutbox),
    }

    await expect(provisionStoreWithOwner(testDb, { ...input, ...duplicate }, {
      ...ctx,
      requestId: crypto.randomUUID(),
    })).rejects.toMatchObject({ status: 409 })
    expect({
      users: await testDb.$count(users),
      stores: await testDb.$count(stores),
      challenges: await testDb.$count(authChallenges),
      outbox: await testDb.$count(emailOutbox),
    }).toEqual(before)
  })

  it.each(['challenge', 'outbox'] as const)('rolls back every insert when %s creation fails', async (fault) => {
    faults[fault] = true
    await expect(provisionStoreWithOwner(testDb, input, ctx)).rejects.toThrow(`injected ${fault} failure`)
    expect(await testDb.$count(users)).toBe(0)
    expect(await testDb.$count(stores)).toBe(0)
    expect(await testDb.$count(authChallenges)).toBe(0)
    expect(await testDb.$count(emailOutbox)).toBe(0)
  })

  it('rejects invalid identity context before writing any record', async () => {
    await expect(provisionStoreWithOwner(testDb, input, { ...ctx, authCodeSecret: '   ' })).rejects.toThrow(
      'Identity context is invalid',
    )
    expect(await testDb.$count(users)).toBe(0)
    expect(await testDb.$count(stores)).toBe(0)
  })

  it('rejects direct activation or suspension while allowing permanent closure', async () => {
    const { store } = await provisionStoreWithOwner(testDb, input, ctx)
    await expect(setStoreSecurityStatus(testDb, store.id, 'ACTIVE')).rejects.toMatchObject({ status: 409 })
    await expect(setStoreSecurityStatus(testDb, store.id, 'SUSPENDED')).rejects.toMatchObject({ status: 409 })
    expect((await setStoreSecurityStatus(testDb, store.id, 'CLOSED')).securityStatus).toBe('CLOSED')
    await expect(setStoreSecurityStatus(testDb, store.id, 'ACTIVE')).rejects.toMatchObject({ status: 409 })
  })
})

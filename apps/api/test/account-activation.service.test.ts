import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'

const auditFailure = vi.hoisted(() => ({ enabled: false }))

vi.mock('../src/services/identity-audit.service', async () => {
  const actual = await vi.importActual<typeof import('../src/services/identity-audit.service')>(
    '../src/services/identity-audit.service',
  )
  return {
    ...actual,
    appendIdentityEvent: async (...args: Parameters<typeof actual.appendIdentityEvent>) => {
      if (auditFailure.enabled) throw new Error('injected activation audit failure')
      return actual.appendIdentityEvent(...args)
    },
  }
})

import {
  authActionTickets,
  authChallenges,
  authProviders,
  identitySecurityEvents,
  refreshTokens,
  stores,
  users,
} from '../src/db/schema'
import { deriveAuthCode, hashActionTicket } from '../src/security/auth-code'
import { issueActionTicket } from '../src/services/auth-ticket.service'
import { createChallenge } from '../src/services/auth-challenge.service'
import { setupInitialPassword } from '../src/services/account-activation.service'
import { confirmEmailFlow, type IdentityContext } from '../src/services/registration.service'
import { provisionStoreWithOwner } from '../src/services/store-provisioning.service'
import { verifyPassword } from '../src/lib/password'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const SECRET = 'activation-code-secret-with-at-least-32-bytes'
const JWT_SECRET = 'activation-jwt-secret'
const NOW = new Date('2026-07-13T12:00:00.000Z')
const ctx: IdentityContext = {
  authCodeSecret: SECRET,
  jwtSecret: JWT_SECRET,
  requestId: '11111111-1111-4111-8111-111111111111',
  now: NOW,
}

const storeInput = {
  name: 'Loja Ativação',
  slug: 'loja-ativacao',
  category: 'OUTROS' as const,
  phone: '44999990000',
  city: 'Maringá',
  addressText: 'Rua Segura, 10',
  lat: -23.42,
  lng: -51.93,
  owner: { name: 'Dona da Loja', email: 'owner.activation@example.test' },
}

async function pendingStore(suffix = '') {
  const input = suffix
    ? {
        ...storeInput,
        slug: `${storeInput.slug}-${suffix}`,
        owner: { ...storeInput.owner, email: `owner.${suffix}@example.test` },
      }
    : storeInput
  const provisioned = await provisionStoreWithOwner(testDb, input, ctx)
  const code = await deriveAuthCode(SECRET, {
    challengeId: provisioned.verificationId,
    purpose: 'STORE_ACTIVATION',
  })
  return { ...provisioned, code }
}

async function confirmedStore(suffix = '') {
  const pending = await pendingStore(suffix)
  const confirmation = await confirmEmailFlow(testDb, {
    verificationId: pending.verificationId,
    code: pending.code,
  }, ctx)
  if (confirmation.kind !== 'PASSWORD_SETUP_REQUIRED') {
    throw new Error('store password setup ticket was not issued')
  }
  return { ...pending, confirmation }
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  auditFailure.enabled = false
  await truncateAll()
})
afterAll(closeTestDb)

describe('privileged email confirmation', () => {
  it('consumes STORE activation and returns one hash-only setup ticket without activating', async () => {
    const pending = await pendingStore()

    const result = await confirmEmailFlow(testDb, {
      verificationId: pending.verificationId,
      code: pending.code,
    }, ctx)

    expect(result).toMatchObject({
      kind: 'PASSWORD_SETUP_REQUIRED',
      passwordSetupTicket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    })
    if (result.kind !== 'PASSWORD_SETUP_REQUIRED') throw new Error('unexpected confirmation result')

    const [ticket] = await testDb.select().from(authActionTickets)
    expect(ticket).toMatchObject({
      userId: pending.owner.id,
      purpose: 'INITIAL_PASSWORD_SETUP',
      challengeId: pending.verificationId,
      tokenHash: await hashActionTicket(SECRET, result.passwordSetupTicket),
      consumedAt: null,
    })
    expect(JSON.stringify(ticket)).not.toContain(result.passwordSetupTicket)
    const [owner] = await testDb.select().from(users).where(eq(users.id, pending.owner.id))
    const [store] = await testDb.select().from(stores).where(eq(stores.id, pending.store.id))
    expect(owner).toMatchObject({ status: 'PENDING_EMAIL', emailVerifiedAt: null })
    expect(store?.securityStatus).toBe('PENDING_ACTIVATION')
    expect(await testDb.select().from(authProviders)).toHaveLength(0)
    expect(await testDb.select().from(refreshTokens)).toHaveLength(0)
  })

  it('activates ADMIN atomically after confirmation, without session or setup ticket', async () => {
    const [admin] = await testDb.insert(users).values({
      name: 'Bootstrap Admin',
      email: 'bootstrap-admin@example.test',
      role: 'ADMIN',
      status: 'PENDING_EMAIL',
      registrationSource: 'BOOTSTRAP',
      emailVerifiedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning()
    if (!admin) throw new Error('admin fixture was not created')
    await testDb.insert(authProviders).values({
      userId: admin.id,
      provider: 'PASSWORD',
      passwordHash: 'pbkdf2$100000$fixture$fixture',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const challenge = await testDb.transaction((tx) => createChallenge(tx, {
      purpose: 'ADMIN_ACTIVATION',
      userId: admin.id,
      authCodeSecret: SECRET,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
    }))
    const code = await deriveAuthCode(SECRET, { challengeId: challenge.id, purpose: challenge.purpose })

    const result = await confirmEmailFlow(testDb, { verificationId: challenge.id, code }, ctx)

    expect(result).toEqual({ kind: 'EMAIL_VERIFIED' })
    const [activated] = await testDb.select().from(users).where(eq(users.id, admin.id))
    expect(activated).toMatchObject({ status: 'ACTIVE', emailVerifiedAt: NOW })
    expect(await testDb.select().from(authActionTickets)).toHaveLength(0)
    expect(await testDb.select().from(refreshTokens)).toHaveLength(0)
  })

  it('rejects wrong codes and mismatched STORE state without issuing tickets or activating', async () => {
    const wrongCodeFlow = await pendingStore('wrong-code')
    const wrongCode = `${wrongCodeFlow.code[0] === '0' ? '1' : '0'}${wrongCodeFlow.code.slice(1)}`

    await expect(confirmEmailFlow(testDb, {
      verificationId: wrongCodeFlow.verificationId,
      code: wrongCode,
    }, ctx)).rejects.toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })
    expect(await testDb.select().from(authActionTickets)).toHaveLength(0)
    const [wrongCodeStore] = await testDb.select().from(stores).where(eq(stores.id, wrongCodeFlow.store.id))
    expect(wrongCodeStore?.securityStatus).toBe('PENDING_ACTIVATION')

    const mismatched = await pendingStore('missing-store')
    await testDb.delete(stores).where(eq(stores.id, mismatched.store.id))
    await expect(confirmEmailFlow(testDb, {
      verificationId: mismatched.verificationId,
      code: mismatched.code,
    }, ctx)).rejects.toMatchObject({ code: 'CODE_INVALID_OR_EXPIRED' })
    expect(await testDb.select().from(authActionTickets)).toHaveLength(0)
    const [consumed] = await testDb.select().from(authChallenges)
      .where(eq(authChallenges.id, mismatched.verificationId))
    expect(consumed?.consumedAt).toEqual(NOW)
    const [owner] = await testDb.select().from(users).where(eq(users.id, mismatched.owner.id))
    expect(owner).toMatchObject({ status: 'PENDING_EMAIL', emailVerifiedAt: null })
  })
})

describe('initial STORE password setup', () => {
  it('enforces STORE policy, creates one provider, activates owner/store, audits, and issues no session', async () => {
    const { owner, store, confirmation } = await confirmedStore()

    await expect(setupInitialPassword(
      testDb,
      confirmation.passwordSetupTicket,
      'short-password',
      ctx,
    )).rejects.toMatchObject({ code: 'PASSWORD_POLICY_REJECTED' })
    expect((await testDb.select().from(authActionTickets))[0]?.consumedAt).toBeNull()

    const password = 'a strong store password'
    await expect(setupInitialPassword(
      testDb,
      confirmation.passwordSetupTicket,
      password,
      ctx,
    )).resolves.toBeUndefined()

    const [provider] = await testDb.select().from(authProviders).where(and(
      eq(authProviders.userId, owner.id),
      eq(authProviders.provider, 'PASSWORD'),
    ))
    expect(provider?.passwordHash).toBeTruthy()
    expect(await verifyPassword(password, provider!.passwordHash!)).toBe(true)
    const [activatedOwner] = await testDb.select().from(users).where(eq(users.id, owner.id))
    const [activatedStore] = await testDb.select().from(stores).where(eq(stores.id, store.id))
    expect(activatedOwner).toMatchObject({ status: 'ACTIVE', emailVerifiedAt: NOW })
    expect(activatedStore?.securityStatus).toBe('ACTIVE')
    expect(await testDb.select().from(refreshTokens)).toHaveLength(0)
    expect(await testDb.select().from(identitySecurityEvents).where(and(
      eq(identitySecurityEvents.eventType, 'STORE_ACTIVATED'),
      eq(identitySecurityEvents.targetUserId, owner.id),
    ))).toHaveLength(1)
  })

  it('rejects wrong-purpose, expired, replayed, blocked, and closed flows generically', async () => {
    const first = await confirmedStore('invalid')
    await testDb.update(authActionTickets)
      .set({ expiresAt: NOW })
      .where(eq(authActionTickets.userId, first.owner.id))
    await expect(setupInitialPassword(
      testDb, first.confirmation.passwordSetupTicket, 'a strong store password', ctx,
    )).rejects.toMatchObject({ code: 'FLOW_INVALID_OR_EXPIRED' })

    const blocked = await confirmedStore('blocked')
    await testDb.update(users).set({ status: 'BLOCKED' }).where(eq(users.id, blocked.owner.id))
    await expect(setupInitialPassword(
      testDb, blocked.confirmation.passwordSetupTicket, 'a strong store password', ctx,
    )).rejects.toMatchObject({ code: 'FLOW_INVALID_OR_EXPIRED' })
    const [blockedTicket] = await testDb.select().from(authActionTickets)
      .where(eq(authActionTickets.userId, blocked.owner.id))
    expect(blockedTicket?.consumedAt).toBeNull()

    const closed = await confirmedStore('closed')
    await testDb.update(stores).set({ securityStatus: 'CLOSED' }).where(eq(stores.id, closed.store.id))
    await expect(setupInitialPassword(
      testDb, closed.confirmation.passwordSetupTicket, 'a strong store password', ctx,
    )).rejects.toMatchObject({ code: 'FLOW_INVALID_OR_EXPIRED' })

    const valid = await confirmedStore('replay')
    await setupInitialPassword(testDb, valid.confirmation.passwordSetupTicket, 'a strong store password', ctx)
    await expect(setupInitialPassword(
      testDb, valid.confirmation.passwordSetupTicket, 'another strong store password', ctx,
    )).rejects.toMatchObject({ code: 'FLOW_INVALID_OR_EXPIRED' })

    const [customer] = await testDb.insert(users).values({
      name: 'Customer', email: 'customer-ticket@example.test', status: 'ACTIVE', emailVerifiedAt: NOW,
    }).returning()
    const [recoveryChallenge] = await testDb.insert(authChallenges).values({
      purpose: 'PASSWORD_RECOVERY', userId: customer!.id, codeHash: 'x', consumedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000), createdAt: NOW,
    }).returning()
    const reset = await testDb.transaction((tx) => issueActionTicket(tx, {
      userId: customer!.id,
      purpose: 'PASSWORD_RESET',
      challengeId: recoveryChallenge!.id,
      authCodeSecret: SECRET,
      now: NOW,
    }))
    await expect(setupInitialPassword(testDb, reset.token, 'a strong store password', ctx))
      .rejects.toMatchObject({ code: 'FLOW_INVALID_OR_EXPIRED' })
  })

  it('allows exactly one concurrent setup winner and one PASSWORD provider', async () => {
    const flow = await confirmedStore('race')
    const setup = () => setupInitialPassword(
      testDb,
      flow.confirmation.passwordSetupTicket,
      'a strong store password',
      ctx,
    )

    const results = await Promise.allSettled([setup(), setup()])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await testDb.select().from(authProviders).where(eq(authProviders.userId, flow.owner.id)))
      .toHaveLength(1)
  })

  it('rolls back ticket claim and every state change when activation audit fails', async () => {
    const flow = await confirmedStore('rollback')
    auditFailure.enabled = true

    await expect(setupInitialPassword(
      testDb,
      flow.confirmation.passwordSetupTicket,
      'a strong store password',
      ctx,
    )).rejects.toThrow('injected activation audit failure')

    const [ticket] = await testDb.select().from(authActionTickets).where(eq(authActionTickets.userId, flow.owner.id))
    const [owner] = await testDb.select().from(users).where(eq(users.id, flow.owner.id))
    const [store] = await testDb.select().from(stores).where(eq(stores.id, flow.store.id))
    expect(ticket?.consumedAt).toBeNull()
    expect(owner).toMatchObject({ status: 'PENDING_EMAIL', emailVerifiedAt: null })
    expect(store?.securityStatus).toBe('PENDING_ACTIVATION')
    expect(await testDb.select().from(authProviders).where(eq(authProviders.userId, flow.owner.id)))
      .toHaveLength(0)
  })
})

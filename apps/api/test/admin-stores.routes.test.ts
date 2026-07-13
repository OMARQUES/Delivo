import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ providerMessageId: 'resend-store-id' })))

vi.mock('../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../src/db/client')>('../src/db/client')
  return { ...actual, createDb: () => ({ db: testDb, client: { end: async () => {} } }) }
})

vi.mock('../src/email/resend-sender', async () => {
  const actual = await vi.importActual<typeof import('../src/email/resend-sender')>('../src/email/resend-sender')
  return { ...actual, createResendSender: vi.fn(() => ({ send: sendEmailMock })) }
})

import { app } from '../src/app'
import { createTestSession } from './helpers/test-db'
import {
  authChallenges, emailOutbox, identitySecurityEvents, rateLimitBuckets, stores, users,
} from '../src/db/schema'
import { EmailDeliveryError } from '../src/email/resend-sender'
import { CODE_RATE_LIMIT_POLICIES } from '../src/security/rate-limit-policies'

const env = {
  APP_ENV: 'local' as const,
  JWT_SECRET: 'test-secret',
  RATE_LIMIT_HMAC_SECRET: 'admin-store-rate-limit-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
  TURNSTILE_EXPECTED_HOSTNAMES: 'localhost',
  AUTH_CODE_SECRET: 'admin-store-activation-secret',
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'Delivery <test@example.com>',
  PUBLIC_WEB_URL: 'http://localhost:5173/ativar-loja',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  HYPERDRIVE: { connectionString: 'unused' } as Hyperdrive,
  BUCKET: {} as R2Bucket,
}

const storeInput = {
  name: 'Pizzaria do João', slug: 'pizzaria-do-joao', category: 'PIZZARIA',
  phone: '(44) 3333-4444', city: 'Cidade Exemplo', addressText: 'Rua Central, 100',
  lat: -23.5, lng: -51.9,
  owner: { name: 'João', email: 'joao@email.com' },
}

async function adminToken() {
  return createTestSession({ sub: crypto.randomUUID(), role: 'ADMIN', name: 'Root' }, env.JWT_SECRET)
}
async function customerToken() {
  return createTestSession({ sub: crypto.randomUUID(), role: 'CUSTOMER', name: 'C' }, env.JWT_SECRET)
}
async function driverToken() {
  return createTestSession({ sub: crypto.randomUUID(), role: 'DRIVER', name: 'D' }, env.JWT_SECRET)
}
async function storeToken() {
  return createTestSession({ sub: crypto.randomUUID(), role: 'STORE', name: 'S' }, env.JWT_SECRET)
}

type StoreBody = { id: string; slug: string; securityStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | 'PENDING_ACTIVATION' }
type ProvisionBody = {
  store: StoreBody
  owner: { id: string; name: string; email: string; role: string; status: string }
  verification: { expiresAt: string; resendAt: string }
}

function req(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) }
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(path, { ...init, headers }, env)
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  sendEmailMock.mockReset()
  sendEmailMock.mockResolvedValue({ providerMessageId: 'resend-store-id' })
  await truncateAll()
})
afterAll(closeTestDb)

describe('POST /admin/stores', () => {
  it('provisions pending records, dispatches after commit and returns no credential/internal IDs', async () => {
    sendEmailMock.mockImplementationOnce(async () => {
      expect(await testDb.$count(stores)).toBe(1)
      expect((await testDb.select().from(emailOutbox))[0]?.status).toBe('PROCESSING')
      return { providerMessageId: 'resend-store-id' }
    })
    const res = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    expect(res.status).toBe(201)
    const body = (await res.json()) as ProvisionBody
    expect(body.store).toMatchObject({ slug: 'pizzaria-do-joao', securityStatus: 'PENDING_ACTIVATION' })
    expect(body.owner).toMatchObject({ email: 'joao@email.com', role: 'STORE', status: 'PENDING_EMAIL' })
    expect(new Date(body.verification.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(body.verification.resendAt).getTime()).toBeLessThan(new Date(body.verification.expiresAt).getTime())
    expect(JSON.stringify(body)).not.toMatch(/password|outboxId|verificationId/i)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect((await testDb.select().from(emailOutbox))[0]).toMatchObject({ status: 'SENT', recipient: 'joao@email.com' })
    expect((await testDb.select().from(identitySecurityEvents))[0]).toMatchObject({
      eventType: 'CHALLENGE_OUTCOME', result: 'ISSUED', targetUserId: body.owner.id,
    })
  })

  it('rejects owner password and fails closed on incomplete email configuration', async () => {
    const token = await adminToken()
    const password = await req('/admin/stores', {
      method: 'POST', body: JSON.stringify({ ...storeInput, owner: { ...storeInput.owner, password: 'admin-known-password' } }),
    }, token)
    expect(password.status).toBe(400)

    const { RESEND_API_KEY: _, ...missingEmailEnv } = env
    const missingConfig = await app.request('/admin/stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(storeInput),
    }, missingEmailEnv)
    expect(missingConfig.status).toBe(503)
    expect(await testDb.$count(stores)).toBe(0)
    expect(await testDb.$count(users)).toBe(1) // authenticated ADMIN only
    expect(await testDb.$count(emailOutbox)).toBe(0)
  })

  it('keeps retryable provider failure in outbox without rolling back provisioning', async () => {
    sendEmailMock.mockRejectedValueOnce(new EmailDeliveryError('NETWORK'))
    const res = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    expect(res.status).toBe(201)
    expect(await testDb.$count(stores)).toBe(1)
    expect((await testDb.select().from(emailOutbox))[0]).toMatchObject({
      status: 'PENDING', failureClass: 'NETWORK', attemptCount: 1,
    })
  })

  it('authorizes before lookup and exposes duplicate conflicts only to ADMIN', async () => {
    const body = JSON.stringify(storeInput)
    expect((await req('/admin/stores', { method: 'POST', body })).status).toBe(401)
    expect((await req('/admin/stores', { method: 'POST', body }, await customerToken())).status).toBe(403)
    expect((await req('/admin/stores', { method: 'POST', body }, await driverToken())).status).toBe(403)
    expect((await req('/admin/stores', { method: 'POST', body }, await storeToken())).status).toBe(403)

    const token = await adminToken()
    const reserved = await req('/admin/stores', { method: 'POST', body: JSON.stringify({ ...storeInput, slug: 'admin' }) }, await adminToken())
    expect(reserved.status).toBe(400)
    await req('/admin/stores', { method: 'POST', body }, token)
    expect((await req('/admin/stores', { method: 'POST', body })).status).toBe(401)
    const dup = await req('/admin/stores', { method: 'POST', body: JSON.stringify({ ...storeInput, owner: { ...storeInput.owner, email: 'z@y.com' } }) }, token)
    expect(dup.status).toBe(409)
  })
})

async function provisionPendingStore() {
  const response = await req('/admin/stores', {
    method: 'POST', body: JSON.stringify(storeInput),
  }, await adminToken())
  expect(response.status).toBe(201)
  return (await response.json()) as ProvisionBody
}

async function ageCurrentActivationChallenge(ownerId: string) {
  const [challenge] = await testDb.select().from(authChallenges)
    .where(eq(authChallenges.userId, ownerId))
    .orderBy(desc(authChallenges.createdAt))
    .limit(1)
  if (!challenge) throw new Error('activation challenge missing')
  await testDb.update(authChallenges)
    .set({ createdAt: new Date(Date.now() - 61_000) })
    .where(eq(authChallenges.id, challenge.id))
  return challenge
}

describe('POST /admin/stores/:id/activation/resend', () => {
  it('replaces challenge atomically, dispatches email and uses STORE_ACTIVATION limits', async () => {
    const created = await provisionPendingStore()
    const old = await ageCurrentActivationChallenge(created.owner.id)

    const res = await req(`/admin/stores/${created.store.id}/activation/resend`, {
      method: 'POST', body: JSON.stringify({}),
    }, await adminToken())
    expect(res.status).toBe(202)
    const body = (await res.json()) as { expiresAt: string; resendAt: string }
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'resendAt'])
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(new Date(body.resendAt).getTime())

    const [invalidated] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, old.id))
    expect(invalidated).toMatchObject({ invalidationReason: 'REPLACED' })
    expect(await testDb.$count(authChallenges)).toBe(2)
    expect(sendEmailMock).toHaveBeenCalledTimes(2)
    expect(await testDb.select().from(identitySecurityEvents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'CHALLENGE_OUTCOME', result: 'REISSUED' }),
    ]))

    const scopes = (await testDb.select({ scope: rateLimitBuckets.scope }).from(rateLimitBuckets)).map((row) => row.scope)
    expect(scopes).toContain(CODE_RATE_LIMIT_POLICIES.STORE_ACTIVATION.sendEmailMinute.scope)
    expect(scopes.some((scope) => scope.includes('registration-verify'))).toBe(false)
  })

  it('rate-limits repeated resend before creating another challenge', async () => {
    const created = await provisionPendingStore()
    await ageCurrentActivationChallenge(created.owner.id)
    const path = `/admin/stores/${created.store.id}/activation/resend`
    expect((await req(path, { method: 'POST', body: '{}' }, await adminToken())).status).toBe(202)
    const before = await testDb.$count(authChallenges)
    const limited = await req(path, { method: 'POST', body: '{}' }, await adminToken())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBeTruthy()
    expect(await testDb.$count(authChallenges)).toBe(before)
  })

  it('returns 202 and retains retryable delivery when resend provider is unavailable', async () => {
    const created = await provisionPendingStore()
    await ageCurrentActivationChallenge(created.owner.id)
    sendEmailMock.mockRejectedValueOnce(new EmailDeliveryError('PROVIDER_UNAVAILABLE'))

    const res = await req(`/admin/stores/${created.store.id}/activation/resend`, {
      method: 'POST', body: '{}',
    }, await adminToken())
    expect(res.status).toBe(202)
    const [pending] = await testDb.select().from(emailOutbox).where(eq(emailOutbox.status, 'PENDING'))
    expect(pending).toMatchObject({ failureClass: 'PROVIDER_UNAVAILABLE', attemptCount: 1 })
  })

  it('reissues a challenge invalidated by exhausted attempts', async () => {
    const created = await provisionPendingStore()
    const old = await ageCurrentActivationChallenge(created.owner.id)
    await testDb.update(authChallenges).set({
      attemptCount: 5,
      invalidatedAt: new Date(Date.now() - 60_000),
      invalidationReason: 'ATTEMPTS_EXHAUSTED',
    }).where(eq(authChallenges.id, old.id))

    const res = await req(`/admin/stores/${created.store.id}/activation/resend`, {
      method: 'POST', body: '{}',
    }, await adminToken())
    expect(res.status).toBe(202)
    const [replaced] = await testDb.select().from(authChallenges).where(eq(authChallenges.id, old.id))
    expect(replaced?.invalidationReason).toBe('REPLACED_AFTER_ATTEMPTS_EXHAUSTED')
  })

  it('rejects unknown/non-pending store or owner without leaking data to other roles', async () => {
    const unknown = `/admin/stores/${crypto.randomUUID()}/activation/resend`
    expect((await req(unknown, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await req(unknown, { method: 'POST', body: '{}' }, await customerToken())).status).toBe(403)
    expect((await req(unknown, { method: 'POST', body: '{}' }, await driverToken())).status).toBe(403)
    expect((await req(unknown, { method: 'POST', body: '{}' }, await storeToken())).status).toBe(403)
    expect((await req(unknown, { method: 'POST', body: '{}' }, await adminToken())).status).toBe(404)

    const created = await provisionPendingStore()
    await ageCurrentActivationChallenge(created.owner.id)
    await testDb.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, created.owner.id))
    expect((await req(`/admin/stores/${created.store.id}/activation/resend`, {
      method: 'POST', body: '{}',
    }, await adminToken())).status).toBe(409)
  })

  it.each(['ACTIVE', 'SUSPENDED', 'CLOSED'] as const)('rejects %s stores', async (securityStatus) => {
    const created = await provisionPendingStore()
    await ageCurrentActivationChallenge(created.owner.id)
    await testDb.update(stores).set({ securityStatus }).where(eq(stores.id, created.store.id))
    const res = await req(`/admin/stores/${created.store.id}/activation/resend`, {
      method: 'POST', body: '{}',
    }, await adminToken())
    expect(res.status).toBe(409)
  })
})

describe('GET /admin/stores + PATCH security status', () => {
  it('cannot publish or suspend a pending store', async () => {
    const created = await provisionPendingStore()
    for (const securityStatus of ['ACTIVE', 'SUSPENDED']) {
      const patch = await req(`/admin/stores/${created.store.id}/security-status`, {
        method: 'PATCH', body: JSON.stringify({ securityStatus }),
      }, await adminToken())
      expect(patch.status).toBe(409)
    }
  })

  it('lists all and permits closing a pending store', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { store: { id } } = (await create.json()) as ProvisionBody
    const patch = await req(`/admin/stores/${id}/security-status`, { method: 'PATCH', body: JSON.stringify({ securityStatus: 'CLOSED' }) }, await adminToken())
    expect(patch.status).toBe(200)
    const list = await req('/admin/stores', {}, await adminToken())
    const body = (await list.json()) as StoreBody[]
    expect(body).toHaveLength(1)
    expect(body[0]?.securityStatus).toBe('CLOSED')
  })
})

describe('PATCH /admin/stores/:id/commission', () => {
  it('admin define comissão (bps); reflete na listagem', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { store: { id } } = (await create.json()) as ProvisionBody
    const patch = await req(`/admin/stores/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: 1200 }) }, await adminToken())
    expect(patch.status).toBe(200)
    const list = await req('/admin/stores', {}, await adminToken())
    const body = (await list.json()) as { id: string; commissionBps: number }[]
    expect(body.find((s) => s.id === id)?.commissionBps).toBe(1200)
  })

  it('403 não-admin, 404 loja inexistente, 400 fora de 0..10000', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { store: { id } } = (await create.json()) as ProvisionBody
    expect((await req(`/admin/stores/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: 1000 }) }, await customerToken())).status).toBe(403)
    expect((await req(`/admin/stores/${crypto.randomUUID()}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: 1000 }) }, await adminToken())).status).toBe(404)
    expect((await req(`/admin/stores/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: 10001 }) }, await adminToken())).status).toBe(400)
    expect((await req(`/admin/stores/${id}/commission`, { method: 'PATCH', body: JSON.stringify({ commissionBps: -1 }) }, await adminToken())).status).toBe(400)
  })
})

describe('POST /admin/stores/:id/catalog/import', () => {
  it('imports csv, returns counts + line errors', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { store: { id } } = (await create.json()) as ProvisionBody
    const csv = 'Pizzas;Mussarela;;30,00\nPizzas;SemPreco;;\nBebidas;Coca;;10,00'
    const res = await req(`/admin/stores/${id}/catalog/import`, {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv,
    }, await adminToken())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { createdCategories: number; createdProducts: number; errors: { line: number }[] }
    expect(body.createdCategories).toBe(2)
    expect(body.createdProducts).toBe(2)
    expect(body.errors).toHaveLength(1)
  })

  it('400 non-uuid id', async () => {
    const res = await req('/admin/stores/abc/catalog/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await adminToken())
    expect(res.status).toBe(400)
  })

  it('400 csv over line cap', async () => {
    const create = await req('/admin/stores', { method: 'POST', body: JSON.stringify(storeInput) }, await adminToken())
    const { store: { id } } = (await create.json()) as ProvisionBody
    const csv = Array.from({ length: 2001 }, (_, i) => `Cat;Prod${i};;1,00`).join('\n')
    const res = await req(`/admin/stores/${id}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv }, await adminToken())
    expect(res.status).toBe(400)
  })

  it('403 non-admin, 404 unknown store', async () => {
    expect((await req(`/admin/stores/${crypto.randomUUID()}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await customerToken())).status).toBe(403)
    expect((await req(`/admin/stores/${crypto.randomUUID()}/catalog/import`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'X;Y;;1,00' }, await adminToken())).status).toBe(404)
  })
})

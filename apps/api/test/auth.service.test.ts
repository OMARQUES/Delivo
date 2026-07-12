import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'

const verifyPasswordCall = vi.hoisted(() => vi.fn())

vi.mock('../src/lib/password', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/password')>('../src/lib/password')
  return {
    ...actual,
    verifyPassword: async (password: string, stored: string) => {
      verifyPasswordCall(password, stored)
      return actual.verifyPassword(password, stored)
    },
  }
})
import {
  loginUser,
  rotateRefreshToken,
  revokeRefreshToken,
  AuthError,
} from '../src/services/auth.service'
import { createStoreWithOwner, setStoreSecurityStatus } from '../src/services/store.service'
import { authProviders, users } from '../src/db/schema'
import { hashPassword } from '../src/lib/password'

const SECRET = 'test-secret'
const ana = {
  name: 'Ana',
  phone: '44999998888',
  password: 'senha123',
  role: 'CUSTOMER' as const,
  acceptedTerms: true as const,
}

beforeAll(migrateTestDb)
beforeEach(async () => {
  await truncateAll()
  verifyPasswordCall.mockClear()
})
afterAll(closeTestDb)

describe('loginUser', () => {
  it('logs in only by normalized email', async () => {
    await createVerifiedTestAccount(testDb, { ...ana, email: 'ana@email.com' }, SECRET)
    const byEmail = await loginUser(testDb, { email: 'ana@email.com', password: 'senha123' }, SECRET)
    expect(byEmail.user.name).toBe('Ana')
  })

  it('rejects wrong password and unknown identifier with same error', async () => {
    await createVerifiedTestAccount(testDb, ana, SECRET)
    await expect(
      loginUser(testDb, { email: 'ana@email.com', password: 'errada12' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
    await expect(
      loginUser(testDb, { email: 'nao@existe.com', password: 'senha123' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
  })

  it('uses the same real dummy PBKDF2 path for unknown and missing-password accounts', async () => {
    await expect(loginUser(
      testDb,
      { email: 'unknown@example.test', password: 'senha123' },
      SECRET,
    )).rejects.toThrow('Credenciais inválidas')
    const unknownHash = verifyPasswordCall.mock.calls.at(-1)?.[1]
    verifyPasswordCall.mockClear()

    const [user] = await testDb.insert(users).values({
      name: 'Google User',
      email: 'google@example.test',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    }).returning()
    if (!user) throw new Error('test user was not created')
    await testDb.insert(authProviders).values({
      userId: user.id,
      provider: 'GOOGLE',
      providerUserId: 'google-sub',
    })

    await expect(
      loginUser(testDb, { email: 'google@example.test', password: 'senha123' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
    const missingProviderHash = verifyPasswordCall.mock.calls.at(-1)?.[1]
    expect(unknownHash).toMatch(/^pbkdf2\$100000\$/)
    expect(missingProviderHash).toBe(unknownHash)
  })

  it('blocks PENDING_APPROVAL driver with specific message', async () => {
    await createVerifiedTestAccount(testDb, { ...ana, email: 'driver@example.test', role: 'DRIVER' }, SECRET)
    await expect(
      loginUser(testDb, { email: 'driver@example.test', password: 'senha123' }, SECRET),
    ).rejects.toThrow('aguardando aprovação')
  })

  it('reveals account state only after the correct password', async () => {
    const states = [
      { status: 'PENDING_EMAIL' as const, email: 'pending-email@example.test', message: 'Confirme seu email' },
      { status: 'PENDING_APPROVAL' as const, email: 'pending-approval@example.test', message: 'aguardando aprovação' },
      { status: 'BLOCKED' as const, email: 'blocked@example.test', message: 'Conta bloqueada' },
    ]
    for (const state of states) {
      const [user] = await testDb.insert(users).values({
        name: state.status,
        email: state.email,
        role: state.status === 'PENDING_APPROVAL' ? 'DRIVER' : 'CUSTOMER',
        status: state.status,
        emailVerifiedAt: state.status === 'PENDING_EMAIL' ? null : new Date(),
      }).returning()
      await testDb.insert(authProviders).values({
        userId: user!.id,
        provider: 'PASSWORD',
        passwordHash: await hashPassword('senha123'),
      })

      await expect(loginUser(testDb, { email: state.email, password: 'wrong-password' }, SECRET))
        .rejects.toMatchObject({ status: 401, message: 'Credenciais inválidas' })
      await expect(loginUser(testDb, { email: state.email, password: 'senha123' }, SECRET))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining(state.message) })
    }
  })

  it('does not issue a session while the store is suspended or closed', async () => {
    const store = await createStoreWithOwner(testDb, {
      name: 'Loja suspensa', slug: 'loja-suspensa', category: 'PIZZARIA', phone: '4433330000',
      city: 'Cidade', addressText: 'Rua A, 1', lat: -23.5, lng: -51.9,
      owner: { name: 'Dono', email: 'dono@loja.test', password: 'senha123' },
    })
    await setStoreSecurityStatus(testDb, store.id, 'SUSPENDED')

    await expect(loginUser(
      testDb,
      { email: 'dono@loja.test', password: 'senha123' },
      SECRET,
    )).rejects.toMatchObject({ status: 403 })
  })
})

describe('refresh rotation', () => {
  it('rotates: old token single-use, reuse kills family', async () => {
    const r = await createVerifiedTestAccount(testDb, ana, SECRET)
    const rotated = await rotateRefreshToken(testDb, r.refreshToken!, SECRET)
    expect(rotated.refreshToken).not.toBe(r.refreshToken)
    await expect(rotateRefreshToken(testDb, r.refreshToken!, SECRET)).rejects.toThrow(AuthError)
    await expect(rotateRefreshToken(testDb, rotated.refreshToken, SECRET)).rejects.toThrow(AuthError)
  })

  it('revoke kills the family', async () => {
    const r = await createVerifiedTestAccount(testDb, ana, SECRET)
    await revokeRefreshToken(testDb, r.refreshToken!)
    await expect(rotateRefreshToken(testDb, r.refreshToken!, SECRET)).rejects.toThrow(AuthError)
  })

  it('rejects unknown token', async () => {
    await expect(rotateRefreshToken(testDb, 'token-inexistente-aaaa', SECRET)).rejects.toThrow(AuthError)
  })
})

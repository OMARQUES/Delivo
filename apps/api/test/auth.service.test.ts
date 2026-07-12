import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { createVerifiedTestAccount, migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import {
  loginUser,
  rotateRefreshToken,
  revokeRefreshToken,
  AuthError,
} from '../src/services/auth.service'
import { createStoreWithOwner, setStoreSecurityStatus } from '../src/services/store.service'
import { authProviders, users } from '../src/db/schema'

const SECRET = 'test-secret'
const ana = {
  name: 'Ana',
  phone: '44999998888',
  password: 'senha123',
  role: 'CUSTOMER' as const,
  acceptedTerms: true as const,
}

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('loginUser', () => {
  it('logs in by email and by phone', async () => {
    await createVerifiedTestAccount(testDb, { ...ana, email: 'ana@email.com' }, SECRET)
    const byEmail = await loginUser(testDb, { identifier: 'Ana@Email.com', password: 'senha123' }, SECRET)
    expect(byEmail.user.name).toBe('Ana')
    const byPhone = await loginUser(testDb, { identifier: '(44) 99999-8888', password: 'senha123' }, SECRET)
    expect(byPhone.user.name).toBe('Ana')
  })

  it('rejects wrong password and unknown identifier with same error', async () => {
    await createVerifiedTestAccount(testDb, ana, SECRET)
    await expect(
      loginUser(testDb, { identifier: '44999998888', password: 'errada12' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
    await expect(
      loginUser(testDb, { identifier: 'nao@existe.com', password: 'senha123' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
  })

  it('fails closed when a legacy phone identifier matches multiple accounts', async () => {
    await createVerifiedTestAccount(testDb, { ...ana, email: 'first@example.test' }, SECRET)
    await createVerifiedTestAccount(testDb, { ...ana, email: 'second@example.test' }, SECRET)

    await expect(
      loginUser(testDb, { identifier: '44999998888', password: 'senha123' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
  })

  it('rejects an existing non-password account with the same invalid-credentials error', async () => {
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
      loginUser(testDb, { identifier: 'google@example.test', password: 'senha123' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
  })

  it('blocks PENDING_APPROVAL driver with specific message', async () => {
    await createVerifiedTestAccount(testDb, { ...ana, role: 'DRIVER' }, SECRET)
    await expect(
      loginUser(testDb, { identifier: '44999998888', password: 'senha123' }, SECRET),
    ).rejects.toThrow('aguardando aprovação')
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
      { identifier: 'dono@loja.test', password: 'senha123' },
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

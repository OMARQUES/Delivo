import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { migrateTestDb, truncateAll, testDb, closeTestDb } from './helpers/test-db'
import {
  registerUser,
  loginUser,
  rotateRefreshToken,
  revokeRefreshToken,
  AuthError,
} from '../src/services/auth.service'

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

describe('registerUser', () => {
  it('creates user + password provider and returns tokens', async () => {
    const r = await registerUser(testDb, { ...ana, email: 'ana@email.com' }, SECRET)
    expect(r.user).toMatchObject({ name: 'Ana', role: 'CUSTOMER', status: 'ACTIVE' })
    expect(r.accessToken).toBeTruthy()
    expect(r.refreshToken).toBeTruthy()
  })

  it('driver registers as PENDING and gets no tokens', async () => {
    const r = await registerUser(testDb, { ...ana, role: 'DRIVER' }, SECRET)
    expect(r.user.status).toBe('PENDING')
    expect(r.accessToken).toBeNull()
    expect(r.refreshToken).toBeNull()
  })

  it('rejects duplicate email (case-insensitive) and duplicate phone', async () => {
    await registerUser(testDb, { ...ana, email: 'ana@email.com' }, SECRET)
    await expect(
      registerUser(testDb, { ...ana, phone: '44988887777', email: 'ANA@email.com' }, SECRET),
    ).rejects.toThrow(AuthError)
    await expect(registerUser(testDb, { ...ana }, SECRET)).rejects.toThrow(AuthError)
  })
})

describe('loginUser', () => {
  it('logs in by email and by phone', async () => {
    await registerUser(testDb, { ...ana, email: 'ana@email.com' }, SECRET)
    const byEmail = await loginUser(testDb, { identifier: 'Ana@Email.com', password: 'senha123' }, SECRET)
    expect(byEmail.user.name).toBe('Ana')
    const byPhone = await loginUser(testDb, { identifier: '(44) 99999-8888', password: 'senha123' }, SECRET)
    expect(byPhone.user.name).toBe('Ana')
  })

  it('rejects wrong password and unknown identifier with same error', async () => {
    await registerUser(testDb, ana, SECRET)
    await expect(
      loginUser(testDb, { identifier: '44999998888', password: 'errada12' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
    await expect(
      loginUser(testDb, { identifier: 'nao@existe.com', password: 'senha123' }, SECRET),
    ).rejects.toThrow('Credenciais inválidas')
  })

  it('blocks PENDING driver with specific message', async () => {
    await registerUser(testDb, { ...ana, role: 'DRIVER' }, SECRET)
    await expect(
      loginUser(testDb, { identifier: '44999998888', password: 'senha123' }, SECRET),
    ).rejects.toThrow('aguardando aprovação')
  })
})

describe('refresh rotation', () => {
  it('rotates: old token single-use, reuse kills family', async () => {
    const r = await registerUser(testDb, ana, SECRET)
    const rotated = await rotateRefreshToken(testDb, r.refreshToken!, SECRET)
    expect(rotated.refreshToken).not.toBe(r.refreshToken)
    await expect(rotateRefreshToken(testDb, r.refreshToken!, SECRET)).rejects.toThrow(AuthError)
    await expect(rotateRefreshToken(testDb, rotated.refreshToken, SECRET)).rejects.toThrow(AuthError)
  })

  it('revoke kills the family', async () => {
    const r = await registerUser(testDb, ana, SECRET)
    await revokeRefreshToken(testDb, r.refreshToken!)
    await expect(rotateRefreshToken(testDb, r.refreshToken!, SECRET)).rejects.toThrow(AuthError)
  })

  it('rejects unknown token', async () => {
    await expect(rotateRefreshToken(testDb, 'token-inexistente-aaaa', SECRET)).rejects.toThrow(AuthError)
  })
})

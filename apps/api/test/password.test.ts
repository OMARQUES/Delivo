import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/lib/password'

describe('password hashing (PBKDF2)', () => {
  it('hashes and verifies a correct password', async () => {
    const stored = await hashPassword('senha-secreta-123')
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
    expect(await verifyPassword('senha-secreta-123', stored)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('senha-certa')
    expect(await verifyPassword('senha-errada', stored)).toBe(false)
  })

  it('produces different hashes for same password (random salt)', async () => {
    const a = await hashPassword('mesma-senha')
    const b = await hashPassword('mesma-senha')
    expect(a).not.toBe(b)
    expect(await verifyPassword('mesma-senha', a)).toBe(true)
    expect(await verifyPassword('mesma-senha', b)).toBe(true)
  })

  it('rejects malformed stored strings without throwing', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false)
    expect(await verifyPassword('x', 'pbkdf2$abc$!!$??')).toBe(false)
  })
})

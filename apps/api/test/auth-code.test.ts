import { describe, expect, it } from 'vitest'
import type { AuthChallengePurpose } from '../src/db/schema'
import type { AuthCodeContext } from '../src/security/auth-code'
import {
  createActionTicket,
  deriveAuthCode,
  hashActionTicket,
  hashAuthCode,
  verifyAuthCode,
  __testOnlyDeriveSixDigitCode,
} from '../src/security/auth-code'

const secret = 'test-secret-with-enough-entropy'
const context: AuthCodeContext = {
  challengeId: '018ff9e2-f7aa-7c55-a7b8-9f4dd7799b2f',
  purpose: 'REGISTRATION_VERIFY' satisfies AuthChallengePurpose,
}

describe('auth code primitives', () => {
  it('derives deterministic six digit numeric codes including leading zeroes', async () => {
    const code = await deriveAuthCode(secret, context)

    expect(code).toMatch(/^\d{6}$/)
    expect(await deriveAuthCode(secret, context)).toBe(code)
  })

  it('domain-separates codes by purpose and challenge id', async () => {
    const base = await deriveAuthCode(secret, context)
    const otherPurpose = await deriveAuthCode(secret, {
      ...context,
      purpose: 'PASSWORD_RECOVERY',
    })
    const otherChallenge = await deriveAuthCode(secret, {
      ...context,
      challengeId: '018ff9e2-f7aa-7c55-a7b8-9f4dd7799b30',
    })

    expect(otherPurpose).not.toBe(base)
    expect(otherChallenge).not.toBe(base)
  })

  it('hashes and verifies only exact six digit codes', async () => {
    const code = await deriveAuthCode(secret, context)
    const hash = await hashAuthCode(secret, context, code)

    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(hash).not.toBe(code)
    expect(await verifyAuthCode(secret, context, code, hash)).toBe(true)
    expect(await verifyAuthCode(secret, context, '000000', hash)).toBe(code === '000000')
    expect(await verifyAuthCode(secret, context, '12345', hash)).toBe(false)
    expect(await verifyAuthCode(secret, context, '1234567', hash)).toBe(false)
    expect(await verifyAuthCode(secret, context, '12a456', hash)).toBe(false)
    await expect(hashAuthCode(secret, context, '12a456')).rejects.toThrow(/six digit/i)
  })

  it('keeps code hashes separated by purpose and challenge id', async () => {
    const code = await deriveAuthCode(secret, context)
    const hash = await hashAuthCode(secret, context, code)

    expect(await verifyAuthCode(secret, { ...context, purpose: 'PASSWORD_RECOVERY' }, code, hash)).toBe(false)
    expect(await verifyAuthCode(secret, { ...context, challengeId: crypto.randomUUID() }, code, hash)).toBe(false)
  })

  it('creates full entropy action tickets and stable keyed hashes', async () => {
    const first = await createActionTicket(secret)
    const second = await createActionTicket(secret)

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.token).not.toBe(second.token)
    expect(first.hash).toBe(await hashActionTicket(secret, first.token))
    expect(first.hash).not.toBe(first.token)
    expect(first.hash).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('skips biased HMAC values during six digit derivation', async () => {
    const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000
    const aboveLimit = limit
    const accepted = 42
    const values: number[] = []

    const code = await __testOnlyDeriveSixDigitCode(async (counter) => {
      values.push(counter)
      const value = counter === 0 ? aboveLimit : accepted
      const bytes = new Uint8Array(4)
      new DataView(bytes.buffer).setUint32(0, value, false)
      return bytes
    })

    expect(values).toEqual([0, 1])
    expect(code).toBe('000042')
  })
})

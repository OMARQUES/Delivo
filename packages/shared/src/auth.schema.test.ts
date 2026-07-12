import { describe, expect, it } from 'vitest'
import { LoginSchema, RegisterSchema } from './auth.schema'

describe('RegisterSchema', () => {
  const valid = {
    name: 'Ana Silva',
    phone: '(44) 99999-8888',
    password: 'senha123',
    acceptedTerms: true,
  }

  it('requires accepted terms (LGPD)', () => {
    expect(() => RegisterSchema.parse({ ...valid, acceptedTerms: false })).toThrow()
    expect(() => RegisterSchema.parse({ ...valid, acceptedTerms: undefined })).toThrow()
  })

  it('accepts minimal customer registration and normalizes phone to digits', () => {
    const r = RegisterSchema.parse(valid)
    expect(r.phone).toBe('44999998888')
    expect(r.role).toBe('CUSTOMER')
    expect(r.email).toBeUndefined()
  })

  it('normalizes email to lowercase/trimmed when present', () => {
    const r = RegisterSchema.parse({ ...valid, email: '  Ana@Email.COM ' })
    expect(r.email).toBe('ana@email.com')
  })

  it('accepts DRIVER role but rejects STORE/ADMIN self-registration', () => {
    expect(RegisterSchema.parse({ ...valid, role: 'DRIVER' }).role).toBe('DRIVER')
    expect(() => RegisterSchema.parse({ ...valid, role: 'STORE' })).toThrow()
    expect(() => RegisterSchema.parse({ ...valid, role: 'ADMIN' })).toThrow()
  })

  it('rejects short password and short phone', () => {
    expect(() => RegisterSchema.parse({ ...valid, password: '1234567' })).toThrow()
    expect(() => RegisterSchema.parse({ ...valid, phone: '123' })).toThrow()
  })

  it('accepts a missing Turnstile token', () => {
    expect(RegisterSchema.parse(valid).turnstileToken).toBeUndefined()
  })

  it('accepts and returns a supplied Turnstile token', () => {
    expect(RegisterSchema.parse({ ...valid, turnstileToken: 'test-token' }).turnstileToken).toBe('test-token')
  })

  it('rejects Turnstile tokens longer than 2048 characters', () => {
    expect(() => RegisterSchema.parse({ ...valid, turnstileToken: 'a'.repeat(2049) })).toThrow()
  })

  it('rejects empty and whitespace-only Turnstile tokens', () => {
    expect(() => RegisterSchema.parse({ ...valid, turnstileToken: '' })).toThrow()
    expect(() => RegisterSchema.parse({ ...valid, turnstileToken: '   ' })).toThrow()
  })
})

describe('LoginSchema', () => {
  it('accepts identifier (email or phone) + password', () => {
    expect(LoginSchema.parse({ identifier: 'a@b.com', password: 'senha123' }).identifier).toBe('a@b.com')
    expect(LoginSchema.parse({ identifier: '(44) 99999-8888', password: 'senha123' })).toBeTruthy()
  })

  it('accepts a missing Turnstile token', () => {
    const input = { identifier: 'a@b.com', password: 'senha123' }
    expect(LoginSchema.parse(input).turnstileToken).toBeUndefined()
  })

  it('accepts and returns a supplied Turnstile token', () => {
    const input = { identifier: 'a@b.com', password: 'senha123', turnstileToken: 'test-token' }
    expect(LoginSchema.parse(input).turnstileToken).toBe('test-token')
  })

  it('rejects Turnstile tokens longer than 2048 characters', () => {
    const input = { identifier: 'a@b.com', password: 'senha123', turnstileToken: 'a'.repeat(2049) }
    expect(() => LoginSchema.parse(input)).toThrow()
  })

  it('rejects empty and whitespace-only Turnstile tokens', () => {
    const input = { identifier: 'a@b.com', password: 'senha123' }
    expect(() => LoginSchema.parse({ ...input, turnstileToken: '' })).toThrow()
    expect(() => LoginSchema.parse({ ...input, turnstileToken: '   ' })).toThrow()
  })
})

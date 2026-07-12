import { describe, expect, it } from 'vitest'
import {
  ConfirmVerificationSchema,
  LoginSchema,
  RegisterSchema,
  ResendVerificationSchema,
  StartRegistrationSchema,
} from './auth.schema'

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

describe('StartRegistrationSchema', () => {
  const customer = {
    name: 'Ana Silva',
    email: '  Ana@Email.COM ',
    password: 'A7!bcdef',
    role: 'CUSTOMER' as const,
    acceptedTerms: true,
    turnstileToken: 'test-token',
  }

  const driver = {
    ...customer,
    role: 'DRIVER' as const,
    phone: '(44) 99999-8888',
    password: 'x'.repeat(15),
  }

  it('accepts a customer without phone and normalizes required email', () => {
    const result = StartRegistrationSchema.parse(customer)
    expect(result.email).toBe('ana@email.com')
    expect(result.phone).toBeUndefined()
    expect(result.password).toBe(customer.password)
  })

  it('requires a phone and at least 15 password characters for drivers', () => {
    expect(StartRegistrationSchema.parse(driver).phone).toBe('44999998888')
    expect(() => StartRegistrationSchema.parse({ ...driver, phone: undefined })).toThrow()
    expect(() => StartRegistrationSchema.parse({ ...driver, password: 'x'.repeat(14) })).toThrow()
  })

  it('rejects phone input containing non-formatting characters', () => {
    expect(() => StartRegistrationSchema.parse({ ...driver, phone: 'call-me 44 99999-8888' })).toThrow()
  })

  it('accepts exactly 8 password characters for customers', () => {
    expect(StartRegistrationSchema.parse(customer).password).toHaveLength(8)
    expect(() => StartRegistrationSchema.parse({ ...customer, password: 'x'.repeat(7) })).toThrow()
  })

  it('retains password whitespace verbatim', () => {
    const password = '  secure passphrase  '
    expect(StartRegistrationSchema.parse({ ...customer, password }).password).toBe(password)
  })

  it('accepts 128 password characters and rejects 129', () => {
    expect(StartRegistrationSchema.parse({ ...customer, password: 'x'.repeat(128) }).password).toHaveLength(128)
    expect(() => StartRegistrationSchema.parse({ ...customer, password: 'x'.repeat(129) })).toThrow()
  })

  it('rejects common passwords case-insensitively', () => {
    expect(() => StartRegistrationSchema.parse({ ...customer, password: 'SeNhA123' })).toThrow()
    expect(() => StartRegistrationSchema.parse({ ...driver, password: 'PASSWORDPASSWORD' })).toThrow()
  })

  it('requires an email, accepted terms, and a Turnstile token', () => {
    expect(() => StartRegistrationSchema.parse({ ...customer, email: undefined })).toThrow()
    expect(() => StartRegistrationSchema.parse({ ...customer, acceptedTerms: false })).toThrow()
    expect(() => StartRegistrationSchema.parse({ ...customer, turnstileToken: undefined })).toThrow()
    expect(() => StartRegistrationSchema.parse({ ...customer, turnstileToken: '   ' })).toThrow()
  })

  it('only permits explicit CUSTOMER or DRIVER roles', () => {
    expect(() => StartRegistrationSchema.parse({ ...customer, role: undefined })).toThrow()
    expect(() => StartRegistrationSchema.parse({ ...customer, role: 'STORE' })).toThrow()
    expect(() => StartRegistrationSchema.parse({ ...customer, role: 'ADMIN' })).toThrow()
  })

  it.each(['identifier', 'userId', 'targetUserId'])('strictly rejects unexpected %s selectors', (field) => {
    expect(() => StartRegistrationSchema.parse({ ...customer, [field]: 'attacker-controlled' })).toThrow()
  })
})

describe('ConfirmVerificationSchema', () => {
  const valid = { verificationId: '123e4567-e89b-42d3-a456-426614174000', code: '000000' }

  it('accepts exactly six ASCII digits', () => {
    expect(ConfirmVerificationSchema.parse(valid)).toEqual(valid)
    for (const code of ['12345', '1234567', '12a456', ' 123456 ']) {
      expect(() => ConfirmVerificationSchema.parse({ ...valid, code })).toThrow()
    }
  })

  it('requires a UUID and rejects unexpected identity fields', () => {
    expect(() => ConfirmVerificationSchema.parse({ ...valid, verificationId: 'not-a-uuid' })).toThrow()
    expect(() => ConfirmVerificationSchema.parse({ ...valid, email: 'other@example.com' })).toThrow()
  })
})

describe('ResendVerificationSchema', () => {
  const valid = { verificationId: '123e4567-e89b-42d3-a456-426614174000' }

  it('accepts adaptive Turnstile omission or a valid supplied token', () => {
    expect(ResendVerificationSchema.parse(valid)).toEqual(valid)
    expect(ResendVerificationSchema.parse({ ...valid, turnstileToken: ' token ' }).turnstileToken).toBe('token')
  })

  it('rejects invalid tokens and unexpected fields', () => {
    expect(() => ResendVerificationSchema.parse({ ...valid, turnstileToken: '' })).toThrow()
    expect(() => ResendVerificationSchema.parse({ ...valid, turnstileToken: 'x'.repeat(2049) })).toThrow()
    expect(() => ResendVerificationSchema.parse({ ...valid, email: 'other@example.com' })).toThrow()
    expect(() => ResendVerificationSchema.parse({ ...valid, code: '123456' })).toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { passwordMinLength, passwordPolicyIssue } from './password-policy'

describe('password policy', () => {
  it('uses 8 characters for customers and 15 for privileged roles', () => {
    expect(passwordMinLength('CUSTOMER')).toBe(8)
    expect(passwordMinLength('DRIVER')).toBe(15)
    expect(passwordMinLength('STORE')).toBe(15)
    expect(passwordMinLength('ADMIN')).toBe(15)
  })

  it.each([
    ['CUSTOMER', 8],
    ['DRIVER', 15],
    ['STORE', 15],
    ['ADMIN', 15],
  ] as const)('enforces the minimum for %s', (role, minimum) => {
    expect(passwordPolicyIssue('x'.repeat(minimum - 1), role)).toBe('PASSWORD_TOO_SHORT')
    expect(passwordPolicyIssue('x'.repeat(minimum), role)).toBeNull()
  })

  it('accepts 128 characters and rejects 129', () => {
    expect(passwordPolicyIssue('x'.repeat(128), 'CUSTOMER')).toBeNull()
    expect(passwordPolicyIssue('x'.repeat(129), 'CUSTOMER')).toBe('PASSWORD_TOO_LONG')
  })

  it('rejects exact common-password matches case-insensitively', () => {
    expect(passwordPolicyIssue('SeNhA123', 'CUSTOMER')).toBe('PASSWORD_TOO_COMMON')
    expect(passwordPolicyIssue('PASSWORDPASSWORD', 'DRIVER')).toBe('PASSWORD_TOO_COMMON')
  })

  it('does not trim passwords or reject non-exact blocklist matches', () => {
    expect(passwordPolicyIssue(' senha123 ', 'CUSTOMER')).toBeNull()
  })
})

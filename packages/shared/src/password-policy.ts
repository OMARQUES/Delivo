export type PasswordRole = 'CUSTOMER' | 'DRIVER' | 'STORE' | 'ADMIN'

export const PASSWORD_MAX_LENGTH = 128

// Versioned in source so policy changes are reviewable and deterministic.
// Matching is exact after Unicode/case normalization; user passwords are never mutated.
const COMMON_PASSWORDS_V1 = new Set([
  '00000000',
  '11111111',
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  '123456789a',
  '1234qwer',
  '1q2w3e4r',
  'abc12345',
  'admin123',
  'adminadmin',
  'changeme',
  'default',
  'dragon123',
  'football',
  'iloveyou',
  'letmein',
  'master123',
  'monkey123',
  'password',
  'password1',
  'password123',
  'passwordpassword',
  'princess',
  'qwerty12',
  'qwerty123',
  'qwertyuiop',
  'senha123',
  'senha1234',
  'senha12345',
  'senha@123',
  'sunshine',
  'superman',
  'trustno1',
  'welcome1',
  'whatever',
])

export function passwordMinLength(role: PasswordRole): 8 | 15 {
  return role === 'CUSTOMER' ? 8 : 15
}

export function passwordPolicyIssue(password: string, role: PasswordRole): string | null {
  if (password.length < passwordMinLength(role)) return 'PASSWORD_TOO_SHORT'
  if (password.length > PASSWORD_MAX_LENGTH) return 'PASSWORD_TOO_LONG'

  const comparisonValue = password.normalize('NFKC').toLowerCase()
  if (COMMON_PASSWORDS_V1.has(comparisonValue)) return 'PASSWORD_TOO_COMMON'

  return null
}

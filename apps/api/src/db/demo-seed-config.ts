import type { UserRole } from './schema'

export type DemoAccount = {
  key: string
  role: UserRole
  email: string
  password: string
  name: string
  phone: string | null
}

const ROLES = new Set<UserRole>(['ADMIN', 'CUSTOMER', 'STORE', 'DRIVER'])

/** Parses only the intentionally local credentials table from .demo-accounts.md. */
export function parseDemoAccounts(markdown: string): DemoAccount[] {
  const rows = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))

  const headerIndex = rows.findIndex((line) => line.toLowerCase().includes('| key |') && line.toLowerCase().includes('| role |'))
  if (headerIndex < 0) throw new Error('demo credentials table is missing')

  const accounts: DemoAccount[] = []
  const keys = new Set<string>()
  for (const row of rows.slice(headerIndex + 1)) {
    if (/^\|\s*:?-+/.test(row)) continue
    const cells = row.slice(1, -1).split('|').map((cell) => cell.trim())
    if (cells.length !== 6) throw new Error('demo credentials table row is malformed')
    const [key, role, email, password, name, phone] = cells
    if (!key || !role || !email || !password || !name) throw new Error('demo credentials table row is incomplete')
    if (!ROLES.has(role as UserRole)) throw new Error(`unsupported demo role: ${role}`)
    if (keys.has(key)) throw new Error(`duplicate demo account key: ${key}`)
    keys.add(key)
    accounts.push({
      key,
      role: role as UserRole,
      email: email.toLowerCase(),
      password,
      name,
      phone: phone || null,
    })
  }
  if (accounts.length === 0) throw new Error('demo credentials table is empty')
  return accounts
}

import { describe, expect, it } from 'vitest'
import { parseDemoAccounts } from './demo-seed-config'

describe('parseDemoAccounts', () => {
  it('parses the local credentials table and rejects duplicates', () => {
    const markdown = `
| key | role | email | password | name | phone |
| --- | --- | --- | --- | --- | --- |
| admin | ADMIN | admin@demo.local | AdminPass123! | Demo Admin | |
| customer_a | CUSTOMER | customer.a@demo.local | CustomerPass123! | Customer A | 44999990001 |
`

    expect(parseDemoAccounts(markdown)).toEqual([
      { key: 'admin', role: 'ADMIN', email: 'admin@demo.local', password: 'AdminPass123!', name: 'Demo Admin', phone: null },
      { key: 'customer_a', role: 'CUSTOMER', email: 'customer.a@demo.local', password: 'CustomerPass123!', name: 'Customer A', phone: '44999990001' },
    ])

    expect(() => parseDemoAccounts(markdown.replace('customer_a', 'admin'))).toThrow(/duplicate demo account key/i)
  })

  it('rejects malformed or unsupported account rows', () => {
    expect(() => parseDemoAccounts('| key | role | email | password | name | phone |\n|---|---|---|---|---|---|\n| x | HACKER | x@demo.local | pass | X | |')).toThrow(/unsupported demo role/i)
    expect(() => parseDemoAccounts('not a credentials table')).toThrow(/demo credentials table/i)
  })
})

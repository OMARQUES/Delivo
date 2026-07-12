import { describe, expect, it } from 'vitest'
import { UpdateCustomerContactSchema } from './user-profile.schema'

describe('UpdateCustomerContactSchema', () => {
  it('normalizes a formatted Brazilian contact phone', () => {
    expect(UpdateCustomerContactSchema.parse({ phone: '(44) 99999-8888' }))
      .toEqual({ phone: '44999998888' })
  })

  it('accepts explicit null to clear optional contact', () => {
    expect(UpdateCustomerContactSchema.parse({ phone: null })).toEqual({ phone: null })
  })

  it('rejects invalid lengths, letters, omission, and unexpected selectors', () => {
    for (const body of [
      { phone: '123' },
      { phone: 'call-me 44999998888' },
      {},
      { phone: '44999998888', userId: crypto.randomUUID() },
    ]) {
      expect(() => UpdateCustomerContactSchema.parse(body)).toThrow()
    }
  })
})

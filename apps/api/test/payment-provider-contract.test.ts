import { describe, expect, expectTypeOf, it } from 'vitest'
import { formatProviderAmount, parseProviderAmount } from '../src/payments/money'
import type { PaymentProvider, ProviderOrderSnapshot } from '../src/payments/provider'

describe('provider money', () => {
  it.each([
    ['0.01', 1],
    ['64.00', 6400],
    ['64', 6400],
  ])('parses %s to cents', (raw, cents) => {
    expect(parseProviderAmount(raw)).toBe(cents)
  })

  it.each(['', '1.001', '1e2', '-1.00', '90071992547410.00'])('rejects invalid amount %s', (raw) => {
    expect(() => parseProviderAmount(raw)).toThrow(/amount/i)
  })

  it('formats cents without floating point', () => {
    expect(formatProviderAmount(450)).toBe('4.50')
  })

  it('locks normalized provider contract', () => {
    expectTypeOf<ProviderOrderSnapshot>().toHaveProperty('providerOrderId')
    expectTypeOf<PaymentProvider>().toHaveProperty('createOrder')
  })
})

import { describe, expect, it } from 'vitest'
import { resolvePayerEmail } from '../src/lib/payer-email'

describe('resolvePayerEmail', () => {
  it('MP_TEST_PAYER_EMAIL override wins over the real customer email', () => {
    expect(
      resolvePayerEmail({ MP_TEST_PAYER_EMAIL: 'test-buyer@testuser.com' }, 'real@customer.com', 'abcdef12-3456'),
    ).toBe('test-buyer@testuser.com')
  })

  it('falls back to the customer email when no override is set', () => {
    expect(resolvePayerEmail({}, 'real@customer.com', 'abcdef12-3456')).toBe('real@customer.com')
  })

  it('falls back to a synthetic email when neither override nor customer email exist', () => {
    expect(resolvePayerEmail({}, null, 'abcdef12-3456')).toBe('cliente-abcdef12@pedidos.delivo.app')
  })
})

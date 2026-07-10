import { describe, expect, it } from 'vitest'
import { PAYMENT_STATUSES, PAYMENT_STATUS_LABELS } from './payment'

describe('payment constants', () => {
  it('exposes statuses with PT-BR labels', () => {
    expect(PAYMENT_STATUSES).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED'])
    expect(PAYMENT_STATUS_LABELS.APPROVED).toBe('Pago')
    expect(PAYMENT_STATUS_LABELS.EXPIRED).toBe('Expirado')
  })
})

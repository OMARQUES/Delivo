import { describe, expect, it } from 'vitest'
import { isPaidOnline, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PAYMENT_STATUSES, PAYMENT_STATUS_LABELS } from './payment'

describe('payment constants', () => {
  it('exposes statuses with PT-BR labels', () => {
    expect(PAYMENT_STATUSES).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED'])
    expect(PAYMENT_STATUS_LABELS.APPROVED).toBe('Pago')
    expect(PAYMENT_STATUS_LABELS.EXPIRED).toBe('Expirado')
  })
})

describe('payment methods', () => {
  it('lista os 4 métodos', () => {
    expect(PAYMENT_METHODS).toEqual(['CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE'])
  })

  it('labels pt-BR para todos os métodos', () => {
    expect(PAYMENT_METHOD_LABELS.CASH).toBe('Dinheiro')
    expect(PAYMENT_METHOD_LABELS.CARD_MACHINE).toBe('Maquininha')
    expect(PAYMENT_METHOD_LABELS.PIX_ONLINE).toBe('PIX pago online')
    expect(PAYMENT_METHOD_LABELS.CARD_ONLINE).toBe('Cartão pago online')
  })

  it('isPaidOnline: só métodos online', () => {
    expect(isPaidOnline('PIX_ONLINE')).toBe(true)
    expect(isPaidOnline('CARD_ONLINE')).toBe(true)
    expect(isPaidOnline('CASH')).toBe(false)
    expect(isPaidOnline('CARD_MACHINE')).toBe(false)
  })
})

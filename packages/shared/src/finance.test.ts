import { describe, expect, it } from 'vitest'
import {
  FINANCE_DOCUMENT_STATUS_LABELS,
  FINANCE_DOCUMENT_STATUSES,
  LEDGER_ENTRY_LABELS,
  LEDGER_ENTRY_TYPES,
} from './finance'

describe('finance constants', () => {
  it('exposes ledger entry types with labels', () => {
    expect(LEDGER_ENTRY_TYPES).toEqual([
      'STORE_SALE_CREDIT',
      'STORE_COMMISSION_DEBIT',
      'STORE_DRIVER_FEE_DEBIT',
      'DRIVER_DELIVERY_CREDIT',
      'STORE_PER_DELIVERY_DEBIT',
      'STORE_DAILY_RATE_DEBIT',
      'DRIVER_PER_DELIVERY_CREDIT',
      'DRIVER_DAILY_RATE_CREDIT',
      'DRIVER_HALF_FEE_CREDIT',
      'STORE_HALF_FEE_DEBIT',
    ])
    expect(LEDGER_ENTRY_LABELS.STORE_COMMISSION_DEBIT).toBe('Comissão da plataforma')
    expect(LEDGER_ENTRY_LABELS.DRIVER_DELIVERY_CREDIT).toBe('Frete do entregador')
    expect(LEDGER_ENTRY_LABELS.DRIVER_DAILY_RATE_CREDIT).toBe('Diária do turno')
    expect(LEDGER_ENTRY_LABELS.DRIVER_HALF_FEE_CREDIT).toBe('Meia-taxa (deslocamento)')
  })

  it('exposes finance document statuses with labels', () => {
    expect(FINANCE_DOCUMENT_STATUSES).toEqual(['OPEN', 'PAID'])
    expect(FINANCE_DOCUMENT_STATUS_LABELS.OPEN).toBe('Em aberto')
    expect(FINANCE_DOCUMENT_STATUS_LABELS.PAID).toBe('Pago')
  })
})

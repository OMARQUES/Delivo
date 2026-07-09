import { describe, expect, it } from 'vitest'
import { AddressSchema, CheckoutSchema, StatusUpdateSchema } from './order.schema'

const item = {
  productId: crypto.randomUUID(),
  quantity: 2,
  selections: [{ groupId: crypto.randomUUID(), optionIds: [crypto.randomUUID()] }],
}
const base = {
  storeSlug: 'pizzaria',
  fulfillment: 'PICKUP',
  paymentMethod: 'CASH',
  items: [item],
  idempotencyKey: crypto.randomUUID(),
}

describe('CheckoutSchema', () => {
  it('accepts pickup without address; delivery requires addressId', () => {
    expect(CheckoutSchema.parse(base).fulfillment).toBe('PICKUP')
    expect(() => CheckoutSchema.parse({ ...base, fulfillment: 'DELIVERY' })).toThrow()
    expect(
      CheckoutSchema.parse({ ...base, fulfillment: 'DELIVERY', addressId: crypto.randomUUID() }),
    ).toBeTruthy()
  })
  it('changeForCents only meaningful for CASH but schema tolerates absence', () => {
    expect(CheckoutSchema.parse({ ...base, changeForCents: 10000 }).changeForCents).toBe(10000)
    expect(() => CheckoutSchema.parse({ ...base, changeForCents: -1 })).toThrow()
  })
  it('taxId: optional, strips mask, requires 11 or 14 digits', () => {
    expect(CheckoutSchema.parse({ ...base, taxId: '123.456.789-09' }).taxId).toBe('12345678909')
    expect(() => CheckoutSchema.parse({ ...base, taxId: '123' })).toThrow()
  })
  it('bounds: quantity 1-50, items 1-50, note sizes', () => {
    expect(() => CheckoutSchema.parse({ ...base, items: [] })).toThrow()
    expect(() => CheckoutSchema.parse({ ...base, items: [{ ...item, quantity: 0 }] })).toThrow()
    expect(() => CheckoutSchema.parse({ ...base, items: [{ ...item, quantity: 51 }] })).toThrow()
    expect(() => CheckoutSchema.parse({ ...base, note: 'x'.repeat(281) })).toThrow()
  })
})

describe('AddressSchema', () => {
  it('requires text+coords, optional label/reference', () => {
    const a = AddressSchema.parse({ addressText: 'Rua A, 123 - Centro', lat: -23.5, lng: -51.9 })
    expect(a.label).toBeUndefined()
    expect(() => AddressSchema.parse({ addressText: 'x', lat: -23.5, lng: -51.9 })).toThrow()
  })
})

describe('StatusUpdateSchema', () => {
  it('accepts known status + optional reason', () => {
    expect(StatusUpdateSchema.parse({ to: 'ACCEPTED' }).to).toBe('ACCEPTED')
    expect(() => StatusUpdateSchema.parse({ to: 'NOPE' })).toThrow()
  })
})

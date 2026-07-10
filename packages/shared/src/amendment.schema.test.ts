import { describe, expect, it } from 'vitest'
import { AmendmentProposalSchema } from './amendment.schema'

const item = { orderItemId: crypto.randomUUID(), newQuantity: 1 }

describe('AmendmentProposalSchema', () => {
  it('accepts items with optional note', () => {
    const r = AmendmentProposalSchema.parse({ items: [item], note: 'acabou o catupiry' })
    expect(r.items).toHaveLength(1)
    expect(AmendmentProposalSchema.parse({ items: [item] }).note).toBeUndefined()
  })
  it('bounds: 1-50 items, quantity 0-50, note 280', () => {
    expect(() => AmendmentProposalSchema.parse({ items: [] })).toThrow()
    expect(() => AmendmentProposalSchema.parse({ items: [{ ...item, newQuantity: -1 }] })).toThrow()
    expect(() => AmendmentProposalSchema.parse({ items: [{ ...item, newQuantity: 51 }] })).toThrow()
    expect(() => AmendmentProposalSchema.parse({ items: [item], note: 'x'.repeat(281) })).toThrow()
  })
  it('rejects duplicate orderItemIds', () => {
    expect(() => AmendmentProposalSchema.parse({ items: [item, { ...item }] })).toThrow()
  })
})

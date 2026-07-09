import { describe, expect, it } from 'vitest'
import { DELIVERY_FAIL_REASONS, DELIVERY_FAIL_REASON_LABELS } from './dispatch'
import { AvailabilitySchema, DeliveryFailSchema, FcmTokenSchema } from './dispatch.schema'

describe('dispatch constants', () => {
  it('exposes fail reasons with PT-BR labels', () => {
    expect(DELIVERY_FAIL_REASONS).toEqual(['NO_ANSWER', 'WRONG_ADDRESS', 'REFUSED_PAYMENT', 'OTHER'])
    expect(DELIVERY_FAIL_REASON_LABELS.NO_ANSWER).toBe('Cliente não atendeu')
  })
})

describe('dispatch schemas', () => {
  it('AvailabilitySchema requires boolean', () => {
    expect(AvailabilitySchema.parse({ isAvailable: true }).isAvailable).toBe(true)
    expect(() => AvailabilitySchema.parse({})).toThrow()
  })
  it('DeliveryFailSchema requires known reason, optional note', () => {
    expect(DeliveryFailSchema.parse({ reason: 'NO_ANSWER' }).note).toBeUndefined()
    expect(DeliveryFailSchema.parse({ reason: 'OTHER', note: 'portao fechado' }).note).toBe('portao fechado')
    expect(() => DeliveryFailSchema.parse({ reason: 'NOPE' })).toThrow()
  })
  it('FcmTokenSchema bounds token size', () => {
    expect(FcmTokenSchema.parse({ token: 'x'.repeat(20) }).token).toHaveLength(20)
    expect(() => FcmTokenSchema.parse({ token: 'short' })).toThrow()
    expect(() => FcmTokenSchema.parse({ token: 'x'.repeat(5000) })).toThrow()
  })
})

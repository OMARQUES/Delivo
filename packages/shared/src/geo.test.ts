import { describe, expect, it } from 'vitest'
import { calcDeliveryFee, haversineKm } from './geo'

describe('haversineKm', () => {
  it('zero for same point, known distance for 1 degree lat', () => {
    expect(haversineKm({ lat: -23.5, lng: -51.9 }, { lat: -23.5, lng: -51.9 })).toBe(0)
    const d = haversineKm({ lat: -23, lng: -51 }, { lat: -24, lng: -51 })
    expect(d).toBeGreaterThan(110)
    expect(d).toBeLessThan(112)
  })
})

describe('calcDeliveryFee', () => {
  const fixed = { deliveryFeeMode: 'FIXED' as const, deliveryFixedFeeCents: 500, deliveryMinFeeCents: null, deliveryPerKmCents: null, deliveryMaxKm: null }
  const dist = { deliveryFeeMode: 'DISTANCE' as const, deliveryFixedFeeCents: null, deliveryMinFeeCents: 400, deliveryPerKmCents: 200, deliveryMaxKm: 8 }

  it('FIXED returns the fixed fee regardless of distance', () => {
    expect(calcDeliveryFee(fixed, 0.3)).toBe(500)
    expect(calcDeliveryFee(fixed, 12)).toBe(500)
  })

  it('DISTANCE rounds km up in 0.5 steps and applies floor (min fee)', () => {
    expect(calcDeliveryFee(dist, 1.2)).toBe(400) // 1.5km*200=300 → piso 400
    expect(calcDeliveryFee(dist, 3.1)).toBe(700) // 3.5km*200=700
  })

  it('DISTANCE beyond maxKm returns null (delivery unavailable)', () => {
    expect(calcDeliveryFee(dist, 8.4)).toBeNull()
  })

  it('unconfigured mode returns null', () => {
    expect(calcDeliveryFee({ ...dist, deliveryPerKmCents: null }, 2)).toBeNull()
    expect(calcDeliveryFee({ ...fixed, deliveryFixedFeeCents: null }, 2)).toBeNull()
  })
})

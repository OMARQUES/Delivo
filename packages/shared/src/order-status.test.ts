import { describe, expect, it } from 'vitest'
import { canTransition, ORDER_STATUSES, isTerminal } from './order-status'

describe('order status state machine', () => {
  it('online payment: order starts awaiting payment', () => {
    expect(canTransition('AWAITING_PAYMENT', 'PENDING')).toBe(true)
    expect(canTransition('AWAITING_PAYMENT', 'CANCELLED')).toBe(true) // PIX expirou
    expect(canTransition('AWAITING_PAYMENT', 'ACCEPTED')).toBe(false)
  })

  it('follows the happy path with external driver', () => {
    expect(canTransition('PENDING', 'ACCEPTED')).toBe(true)
    expect(canTransition('ACCEPTED', 'PREPARING')).toBe(true)
    expect(canTransition('PREPARING', 'READY')).toBe(true)
    expect(canTransition('READY', 'AWAITING_DRIVER')).toBe(true)
    expect(canTransition('AWAITING_DRIVER', 'OUT_FOR_DELIVERY')).toBe(true)
    expect(canTransition('OUT_FOR_DELIVERY', 'DELIVERED')).toBe(true)
  })

  it('allows store with own driver (or early-assigned driver) to skip AWAITING_DRIVER', () => {
    expect(canTransition('READY', 'OUT_FOR_DELIVERY')).toBe(true)
  })

  it('pickup: customer collects at counter from READY', () => {
    expect(canTransition('READY', 'DELIVERED')).toBe(true)
  })

  it('failed delivery: only from OUT_FOR_DELIVERY, and is terminal', () => {
    expect(canTransition('OUT_FOR_DELIVERY', 'DELIVERY_FAILED')).toBe(true)
    expect(canTransition('READY', 'DELIVERY_FAILED')).toBe(false)
    expect(canTransition('AWAITING_DRIVER', 'DELIVERY_FAILED')).toBe(false)
    expect(isTerminal('DELIVERY_FAILED')).toBe(true)
  })

  it('rejects skipping states', () => {
    expect(canTransition('PENDING', 'DELIVERED')).toBe(false)
    expect(canTransition('PENDING', 'OUT_FOR_DELIVERY')).toBe(false)
    expect(canTransition('ACCEPTED', 'READY')).toBe(false)
  })

  it('rejects moving backwards', () => {
    expect(canTransition('READY', 'PREPARING')).toBe(false)
    expect(canTransition('DELIVERED', 'PENDING')).toBe(false)
    expect(canTransition('PENDING', 'AWAITING_PAYMENT')).toBe(false)
  })

  it('allows cancellation until food leaves, not after', () => {
    expect(canTransition('AWAITING_PAYMENT', 'CANCELLED')).toBe(true)
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true)
    expect(canTransition('ACCEPTED', 'CANCELLED')).toBe(true)
    expect(canTransition('PREPARING', 'CANCELLED')).toBe(true)
    expect(canTransition('READY', 'CANCELLED')).toBe(true)
    expect(canTransition('AWAITING_DRIVER', 'CANCELLED')).toBe(true)
    expect(canTransition('OUT_FOR_DELIVERY', 'CANCELLED')).toBe(false)
  })

  it('terminal states have no exits', () => {
    expect(isTerminal('DELIVERED')).toBe(true)
    expect(isTerminal('CANCELLED')).toBe(true)
    expect(isTerminal('DELIVERY_FAILED')).toBe(true)
    expect(isTerminal('PENDING')).toBe(false)
    for (const to of ORDER_STATUSES) {
      expect(canTransition('DELIVERED', to)).toBe(false)
      expect(canTransition('CANCELLED', to)).toBe(false)
      expect(canTransition('DELIVERY_FAILED', to)).toBe(false)
    }
  })
})

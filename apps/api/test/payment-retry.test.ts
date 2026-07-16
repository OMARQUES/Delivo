import { describe, expect, it } from 'vitest'
import { nextAttemptAt } from '../src/payments/retry'

describe('payment retry', () => {
  const now = new Date('2026-07-15T00:00:00.000Z')

  it('uses exponential backoff, six-hour cap, and Retry-After floor', () => {
    expect(nextAttemptAt(now, 1, 0).toISOString()).toBe('2026-07-15T00:00:30.000Z')
    expect(nextAttemptAt(now, 20, 0).getTime() - now.getTime()).toBe(6 * 60 * 60_000)
    expect(nextAttemptAt(now, 1, 0, 120).getTime() - now.getTime()).toBe(120_000)
  })

  it('bounds jitter to 25 percent', () => {
    expect(nextAttemptAt(now, 1, 0.25).getTime() - now.getTime()).toBe(37_500)
    expect(nextAttemptAt(now, 1, 2).getTime() - now.getTime()).toBe(37_500)
    expect(nextAttemptAt(now, 1, -1).getTime() - now.getTime()).toBe(30_000)
  })

  it('caps excessive provider Retry-After at six hours', () => {
    expect(nextAttemptAt(now, 1, 0, 999_999).getTime() - now.getTime()).toBe(6 * 60 * 60_000)
  })
})

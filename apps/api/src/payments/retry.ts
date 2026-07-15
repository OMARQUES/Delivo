export const MAX_PAYMENT_OPERATION_ATTEMPTS = 8
const BASE_DELAY_MS = 30_000
const MAX_DELAY_MS = 6 * 60 * 60_000

export function nextAttemptAt(now: Date, attempt: number, jitterFraction: number, retryAfterSeconds?: number): Date {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const base = Math.min(BASE_DELAY_MS * 2 ** (safeAttempt - 1), MAX_DELAY_MS)
  const jitter = Math.max(0, Math.min(0.25, Number.isFinite(jitterFraction) ? jitterFraction : 0))
  const retryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds !== undefined
    ? Math.max(0, retryAfterSeconds) * 1000
    : 0
  return new Date(now.getTime() + Math.max(base + Math.floor(base * jitter), retryAfter))
}

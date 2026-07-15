export const MAX_PAYMENT_OPERATION_ATTEMPTS = 8
const BASE_DELAY_MS = 30_000
const MAX_DELAY_MS = 6 * 60 * 60_000

export type RetryDisposition =
  | { kind: 'RETRY'; nextAttemptAt: Date }
  | { kind: 'REVIEW_REQUIRED' }

export function nextAttemptAt(now: Date, attempt: number, jitterFraction: number, retryAfterSeconds?: number): Date {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const base = Math.min(BASE_DELAY_MS * 2 ** (safeAttempt - 1), MAX_DELAY_MS)
  const jitter = Math.max(0, Math.min(0.25, Number.isFinite(jitterFraction) ? jitterFraction : 0))
  const retryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds !== undefined
    ? Math.max(0, retryAfterSeconds) * 1000
    : 0
  return new Date(now.getTime() + Math.max(base + Math.floor(base * jitter), retryAfter))
}

export function retryDisposition(
  now: Date,
  attemptCount: number,
  jitterFraction: number,
  retryAfterSeconds?: number,
): RetryDisposition {
  if (attemptCount >= MAX_PAYMENT_OPERATION_ATTEMPTS) return { kind: 'REVIEW_REQUIRED' }
  return { kind: 'RETRY', nextAttemptAt: nextAttemptAt(now, attemptCount, jitterFraction, retryAfterSeconds) }
}

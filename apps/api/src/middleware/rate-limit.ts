import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppContext } from '../env'
import { PostgresRateLimiter, type RateLimitDecision, type RateLimiter, type RateLimitPolicy } from '../security/rate-limit'
import { RATE_LIMITED_MESSAGE, SecurityHttpError, SECURITY_CHECK_UNAVAILABLE_MESSAGE } from '../security/http'

type MaybePromise<T> = T | Promise<T>

export type RateLimitRule = Readonly<{
  policy: RateLimitPolicy
  subject: string | ((c: Context<AppContext>) => MaybePromise<string>)
}>

export type RateLimitMiddlewareOptions = Readonly<{
  limiter?: RateLimiter
}>

function requireRateLimitSecret(c: Context<AppContext>): string {
  const secret = c.env.RATE_LIMIT_HMAC_SECRET?.trim()
  if (!secret) {
    throw new SecurityHttpError(503, 'SECURITY_CHECK_UNAVAILABLE', SECURITY_CHECK_UNAVAILABLE_MESSAGE)
  }
  return secret
}

export function createRequestRateLimiter(c: Context<AppContext>): RateLimiter {
  return new PostgresRateLimiter(c.get('db'), requireRateLimitSecret(c))
}

function rateLimited(decision: RateLimitDecision): SecurityHttpError {
  return new SecurityHttpError(429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE, decision.retryAfterSeconds)
}

async function resolveSubject(c: Context<AppContext>, rule: RateLimitRule): Promise<string> {
  return typeof rule.subject === 'function' ? rule.subject(c) : rule.subject
}

export function rateLimitPolicies(
  rules: readonly RateLimitRule[],
  options: RateLimitMiddlewareOptions = {},
) {
  return createMiddleware<AppContext>(async (c, next) => {
    const limiter = options.limiter ?? createRequestRateLimiter(c)
    let firstDenied: RateLimitDecision | null = null

    for (const rule of rules) {
      const subject = await resolveSubject(c, rule)
      const decision = await limiter.consume(rule.policy, subject)
      if (!decision.allowed && firstDenied === null) {
        firstDenied = decision
      }
    }

    if (firstDenied !== null) throw rateLimited(firstDenied)
    await next()
  })
}

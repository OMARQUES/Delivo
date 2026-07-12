import type { Context } from 'hono'
import type { AppContext } from '../env'
import { createRequestRateLimiter } from '../middleware/rate-limit'
import { SecurityHttpError, RATE_LIMITED_MESSAGE, TURNSTILE_REQUIRED_MESSAGE } from './http'
import { resolveClientIp } from './client-ip'
import { POLICIES, type RateLimitPolicy } from './rate-limit-policies'
import type { RateLimitDecision } from './rate-limit'
import { createTurnstileVerifier } from './turnstile'

function rateLimited(decision: RateLimitDecision): never {
  throw new SecurityHttpError(429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE, decision.retryAfterSeconds)
}

export async function consumeAll(
  c: Context<AppContext>,
  policies: readonly RateLimitPolicy[],
  subject: string,
): Promise<void> {
  const limiter = createRequestRateLimiter(c)
  let firstDenied: RateLimitDecision | null = null
  for (const policy of policies) {
    const decision = await limiter.consume(policy, subject)
    if (!decision.allowed && firstDenied === null) firstDenied = decision
  }
  if (firstDenied) rateLimited(firstDenied)
}

function clientIp(c: Context<AppContext>): string {
  return resolveClientIp(c.env.APP_ENV, c.req.raw.headers)
}

export async function protectRegistration(
  c: Context<AppContext>,
  input: { email: string; turnstileToken: string },
): Promise<void> {
  const ip = clientIp(c)
  await consumeAll(c, [POLICIES.registerIpHour, POLICIES.registerIpDay], ip)
  await createTurnstileVerifier(c.env).verify({
    token: input.turnstileToken,
    remoteIp: ip,
    action: 'register',
  })
  await consumeAll(c, [POLICIES.registerIdentityHour, POLICIES.registerIdentityDay], input.email)
}

export async function protectLogin(
  c: Context<AppContext>,
  input: { identifier: string; turnstileToken?: string },
): Promise<void> {
  const ip = clientIp(c)
  await consumeAll(c, [POLICIES.loginIp15Minutes], ip)

  const limiter = createRequestRateLimiter(c)
  const cooldown = await limiter.inspect(POLICIES.loginFailureIdentityHour, input.identifier)
  if (!cooldown.allowed) rateLimited(cooldown)

  const adaptive = await limiter.inspect(POLICIES.loginFailureIdentity15Minutes, input.identifier)
  if (adaptive.count >= POLICIES.loginFailureIdentity15Minutes.limit) {
    if (!input.turnstileToken) {
      throw new SecurityHttpError(403, 'TURNSTILE_REQUIRED', TURNSTILE_REQUIRED_MESSAGE)
    }
    await createTurnstileVerifier(c.env).verify({
      token: input.turnstileToken,
      remoteIp: ip,
      action: 'login',
    })
  }
}

export async function recordLoginFailure(c: Context<AppContext>, identifier: string): Promise<void> {
  const limiter = createRequestRateLimiter(c)
  await limiter.consume(POLICIES.loginFailureIdentity15Minutes, identifier)
  await limiter.consume(POLICIES.loginFailureIdentityHour, identifier)
}

export async function clearLoginFailures(c: Context<AppContext>, identifier: string): Promise<void> {
  const limiter = createRequestRateLimiter(c)
  await limiter.clear([
    POLICIES.loginFailureIdentity15Minutes,
    POLICIES.loginFailureIdentityHour,
  ], identifier)
}

export async function protectRefresh(c: Context<AppContext>, refreshToken: string): Promise<void> {
  await consumeAll(c, [POLICIES.refreshIp10Minutes], clientIp(c))
  await consumeAll(c, [POLICIES.refreshFingerprint10Minutes], refreshToken)
}

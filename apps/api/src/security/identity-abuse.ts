import type { Context } from 'hono'
import type { AuthChallengePurpose } from '../db/schema'
import type { AppContext } from '../env'
import { createRequestRateLimiter } from '../middleware/rate-limit'
import { consumeAll } from './auth-abuse'
import { resolveClientIp } from './client-ip'
import { SecurityHttpError, RATE_LIMITED_MESSAGE, TURNSTILE_REQUIRED_MESSAGE } from './http'
import { normalizeLoginKey } from './rate-limit-key'
import { CODE_RATE_LIMIT_POLICIES, POLICIES } from './rate-limit-policies'
import type { RateLimitDecision } from './rate-limit'
import { createTurnstileVerifier } from './turnstile'

export type CodePurpose = AuthChallengePurpose

function clientIp(c: Context<AppContext>): string {
  return resolveClientIp(c.env.APP_ENV, c.req.raw.headers)
}

function rateLimited(decision: RateLimitDecision): never {
  throw new SecurityHttpError(429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE, decision.retryAfterSeconds)
}

function flowSubject(email: string, flowId: string): string {
  const normalizedEmail = normalizeLoginKey(email)
  if (!normalizedEmail || !flowId) throw new Error('Code flow identity is required')
  return `${normalizedEmail}\0${flowId}`
}

export async function protectCodeSend(
  c: Context<AppContext>,
  purpose: CodePurpose,
  email: string,
  flowId: string,
  turnstileToken?: string,
): Promise<void> {
  const policies = CODE_RATE_LIMIT_POLICIES[purpose]
  const ip = clientIp(c)
  await consumeAll(c, [policies.sendEmailMinute, policies.sendEmailHour, policies.sendEmailDay], email)
  await consumeAll(c, [policies.sendIpHour, policies.sendIpDay], ip)

  const adaptive = await createRequestRateLimiter(c).consume(
    policies.resendFlowHour,
    flowSubject(email, flowId),
  )
  if (!adaptive.allowed) rateLimited(adaptive)
  if (adaptive.count < 3) return
  if (!turnstileToken) {
    throw new SecurityHttpError(403, 'TURNSTILE_REQUIRED', TURNSTILE_REQUIRED_MESSAGE)
  }
  await createTurnstileVerifier(c.env).verify({
    token: turnstileToken,
    remoteIp: ip,
    action: 'email_resend',
  })
}

export async function protectCodeAttempt(
  c: Context<AppContext>,
  purpose: CodePurpose,
  flowId: string,
): Promise<void> {
  if (!flowId) throw new Error('Code flow identity is required')
  await consumeAll(c, [CODE_RATE_LIMIT_POLICIES[purpose].attemptIpHour], clientIp(c))
}

export async function protectRecoveryStart(
  c: Context<AppContext>,
  email: string,
  turnstileToken: string,
): Promise<void> {
  const normalizedEmail = normalizeLoginKey(email)
  if (!normalizedEmail) throw new Error('Recovery email is required')

  const ip = clientIp(c)
  await consumeAll(c, [POLICIES.recoveryStartIpHour, POLICIES.recoveryStartIpDay], ip)
  await createTurnstileVerifier(c.env).verify({
    token: turnstileToken,
    remoteIp: ip,
    action: 'password_recovery',
  })
  await consumeAll(
    c,
    [POLICIES.recoveryStartEmailHour, POLICIES.recoveryStartEmailDay],
    normalizedEmail,
  )
}

export async function protectRecoveryVerify(
  c: Context<AppContext>,
  recoveryId: string,
): Promise<void> {
  if (!recoveryId) throw new Error('Recovery flow identity is required')
  await consumeAll(c, [POLICIES.recoveryVerifyIpHour], clientIp(c))
}

export async function protectTicketUse(
  c: Context<AppContext>,
  ticket: string,
): Promise<void> {
  if (!ticket) throw new Error('Recovery ticket is required')
  await consumeAll(c, [POLICIES.ticketUseIpHour], clientIp(c))
  await consumeAll(c, [POLICIES.ticketUseFingerprintHour], ticket)
}

import { z } from 'zod'
import type { Env } from '../env'
import { SecurityHttpError, SECURITY_CHECK_UNAVAILABLE_MESSAGE, TURNSTILE_INVALID_MESSAGE } from './http'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const INVALID_PROVIDER_CODES = new Set(['invalid-input-response', 'timeout-or-duplicate'])
const CHALLENGE_MAX_AGE_MS = 300_000
const CHALLENGE_FUTURE_SKEW_MS = 30_000

const SiteverifyResponseSchema = z.object({
  success: z.boolean(),
  challenge_ts: z.string().optional(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  'error-codes': z.array(z.string()).optional(),
  metadata: z.object({
    result_with_testing_key: z.boolean().optional(),
  }).optional(),
})

export type TurnstileAction = 'register' | 'login' | 'email_resend' | 'password_recovery'

export interface TurnstileVerifier {
  verify(input: { token: string; remoteIp: string; action: TurnstileAction; now?: Date }): Promise<void>
}

export type CloudflareTurnstileVerifierOptions = Readonly<{
  secret: string
  expectedHostnames: readonly string[]
  environment?: Env['APP_ENV']
  fetch?: typeof fetch
  timeoutMs?: number
}>

type SiteverifyResponse = z.infer<typeof SiteverifyResponseSchema>
type TurnstileUnavailableReason = 'config' | 'transport' | 'http' | 'json' | 'schema' | 'provider'

function invalid(): never {
  throw new SecurityHttpError(403, 'TURNSTILE_INVALID', TURNSTILE_INVALID_MESSAGE)
}

function unavailable(reason: TurnstileUnavailableReason): never {
  console.warn('turnstile unavailable', { reason })
  throw new SecurityHttpError(503, 'SECURITY_CHECK_UNAVAILABLE', SECURITY_CHECK_UNAVAILABLE_MESSAGE)
}

function challengeTimestampValid(value: string, now: Date): boolean {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return false
  const diff = timestamp - now.getTime()
  return diff >= -CHALLENGE_MAX_AGE_MS && diff <= CHALLENGE_FUTURE_SKEW_MS
}

function isProviderTestingResponse(response: SiteverifyResponse): boolean {
  return response.success === true
    && response.hostname === 'example.com'
    && response.metadata?.result_with_testing_key === true
}

function assertProviderSuccess(response: SiteverifyResponse): void {
  if (response.success) return
  const codes = response['error-codes'] ?? []
  if (codes.some((code) => INVALID_PROVIDER_CODES.has(code))) invalid()
  unavailable('provider')
}

export class CloudflareTurnstileVerifier implements TurnstileVerifier {
  private readonly expectedHostnames: Set<string>
  private readonly environment: Env['APP_ENV']
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: CloudflareTurnstileVerifierOptions) {
    this.expectedHostnames = new Set(options.expectedHostnames.map((host) => host.trim().toLowerCase()).filter(Boolean))
    this.environment = options.environment ?? 'production'
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 3_000
  }

  async verify(input: { token: string; remoteIp: string; action: TurnstileAction; now?: Date }): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      const body = new URLSearchParams({
        secret: this.options.secret,
        response: input.token,
        remoteip: input.remoteIp,
        idempotency_key: crypto.randomUUID(),
      })
      response = await this.fetchImpl(SITEVERIFY_URL, {
        method: 'POST',
        body,
        signal: controller.signal,
      })
    } catch {
      unavailable('transport')
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) unavailable('http')

    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      unavailable('json')
    }

    const parsed = SiteverifyResponseSchema.safeParse(raw)
    if (!parsed.success) unavailable('schema')

    const siteverify = parsed.data
    if (this.environment === 'local' && isProviderTestingResponse(siteverify)) return

    assertProviderSuccess(siteverify)

    if (siteverify.action !== input.action) invalid()
    const hostname = siteverify.hostname?.toLowerCase()
    if (!hostname || !this.expectedHostnames.has(hostname)) invalid()
    if (!siteverify.challenge_ts || !challengeTimestampValid(siteverify.challenge_ts, input.now ?? new Date())) {
      invalid()
    }
  }
}

export function createTurnstileVerifier(env: Env): TurnstileVerifier {
  const secret = env.TURNSTILE_SECRET_KEY?.trim()
  const expectedHostnames = (env.TURNSTILE_EXPECTED_HOSTNAMES ?? '')
    .split(',')
    .map((hostname) => hostname.trim())
    .filter(Boolean)
  if (!secret || expectedHostnames.length === 0) unavailable('config')
  return new CloudflareTurnstileVerifier({
    secret,
    expectedHostnames,
    environment: env.APP_ENV,
  })
}

import type { Env } from '../env'

export type EmailConfig = {
  apiKey: string
  from: string
  publicWebUrl: string
  allowedRecipients: ReadonlySet<string> | null
  appEnv: Env['APP_ENV']
}

function configError(message: string): never {
  throw new Error(`Email configuration error: ${message}`)
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim()
  if (!trimmed) configError(`${name} is required`)
  return trimmed
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function senderAddress(from: string): string | null {
  const trimmed = from.trim()
  const match = trimmed.match(/<([^<>]+)>$/)
  return normalizeEmail(match?.[1] ?? trimmed)
}

function resolvePublicWebUrl(raw: string, appEnv: Env['APP_ENV']): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    configError('public web url is invalid')
  }
  if (appEnv !== 'local' && url.protocol !== 'https:') configError('public web url must be https outside local')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') configError('public web url is invalid')
  return url.href
}

function resolveAllowedRecipients(raw: string | undefined, appEnv: Env['APP_ENV']): ReadonlySet<string> | null {
  const recipients = (raw ?? '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean)
  if (appEnv === 'production' && recipients.length > 0) configError('EMAIL_ALLOWED_RECIPIENTS allowlist is not allowed in production')
  if (recipients.length === 0) return null
  for (const recipient of recipients) {
    if (!isEmail(recipient)) configError('EMAIL_ALLOWED_RECIPIENTS contains invalid recipient')
  }
  return new Set(recipients)
}

function assertSenderAllowed(from: string, appEnv: Env['APP_ENV']) {
  const address = senderAddress(from)
  if (!address || !isEmail(address)) configError('EMAIL_FROM sender is invalid')
  if (appEnv === 'production' && address.endsWith('@resend.dev')) {
    configError('EMAIL_FROM sender must use a verified domain')
  }
}

export function resolveEmailConfig(env: Env): EmailConfig {
  const apiKey = required(env.RESEND_API_KEY, 'RESEND_API_KEY')
  required(env.AUTH_CODE_SECRET, 'AUTH_CODE_SECRET')
  const from = required(env.EMAIL_FROM, 'EMAIL_FROM')
  const publicWebUrl = resolvePublicWebUrl(required(env.PUBLIC_WEB_URL, 'PUBLIC_WEB_URL'), env.APP_ENV)
  assertSenderAllowed(from, env.APP_ENV)
  return {
    apiKey,
    from,
    publicWebUrl,
    allowedRecipients: resolveAllowedRecipients(env.EMAIL_ALLOWED_RECIPIENTS, env.APP_ENV),
    appEnv: env.APP_ENV,
  }
}

export function assertRecipientAllowed(config: EmailConfig, recipient: string): void {
  const normalized = normalizeEmail(recipient)
  if (!isEmail(normalized)) throw new Error('Email recipient is invalid')
  if (config.allowedRecipients && !config.allowedRecipients.has(normalized)) {
    throw new Error('Email recipient is blocked by allowlist')
  }
}

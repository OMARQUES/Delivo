import type { Env } from '../env'

export function resolveClientIp(environment: Env['APP_ENV'], headers: Headers): string {
  const cloudflareIp = headers.get('CF-Connecting-IP')?.trim()
  if (cloudflareIp) return cloudflareIp
  if (environment === 'local') return '127.0.0.1'
  throw new Error('Trusted client IP unavailable')
}

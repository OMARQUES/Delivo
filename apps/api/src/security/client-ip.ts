import type { Env } from '../env'

function canonicalizeIpv4(value: string): string | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null
  const octets = value.split('.').map(Number)
  if (octets.some((octet) => octet > 255)) return null
  return octets.join('.')
}

function canonicalizeIpv6(value: string): string | null {
  if (value.length > 45 || !value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return null
  try {
    const hostname = new URL(`http://[${value}]/`).hostname
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null
    return hostname.slice(1, -1).toLowerCase()
  } catch {
    return null
  }
}

function canonicalizeClientIp(value: string): string | null {
  if (value.length === 0 || value.length > 45 || /[\u0000-\u001f\u007f,]/.test(value)) return null
  return canonicalizeIpv4(value) ?? canonicalizeIpv6(value)
}

export function resolveClientIp(environment: Env['APP_ENV'], headers: Headers): string {
  const cloudflareValue = headers.get('CF-Connecting-IP')
  if (cloudflareValue !== null) {
    const cloudflareIp = canonicalizeClientIp(cloudflareValue.trim())
    if (cloudflareIp) return cloudflareIp
    throw new Error('Trusted client IP unavailable')
  }
  if (environment === 'local') return '127.0.0.1'
  throw new Error('Trusted client IP unavailable')
}

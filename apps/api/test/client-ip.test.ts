import { describe, expect, it } from 'vitest'
import { resolveClientIp } from '../src/security/client-ip'

describe('trusted client IP resolution', () => {
  it.each(['staging', 'production'] as const)('uses only a nonblank Cloudflare IP in %s', (environment) => {
    expect(resolveClientIp(environment, new Headers({
      'CF-Connecting-IP': ' 203.0.113.7 ',
      'X-Forwarded-For': '198.51.100.9',
    }))).toBe('203.0.113.7')
  })

  it.each(['staging', 'production'] as const)('fails closed in %s when only spoofable forwarding data exists', (environment) => {
    expect(() => resolveClientIp(environment, new Headers({
      'X-Forwarded-For': '198.51.100.9',
    }))).toThrow('Trusted client IP unavailable')
    expect(() => resolveClientIp(environment, new Headers({
      'CF-Connecting-IP': '   ',
      'X-Forwarded-For': '198.51.100.9',
    }))).toThrow('Trusted client IP unavailable')
  })

  it('uses an explicit Cloudflare IP locally and otherwise falls back to loopback', () => {
    expect(resolveClientIp('local', new Headers({ 'CF-Connecting-IP': ' 192.0.2.5 ' }))).toBe('192.0.2.5')
    expect(resolveClientIp('local', new Headers({ 'X-Forwarded-For': '198.51.100.9' }))).toBe('127.0.0.1')
  })
})

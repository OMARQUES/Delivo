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
    expect(() => resolveClientIp('local', new Headers({ 'CF-Connecting-IP': '999.0.0.1' })))
      .toThrow('Trusted client IP unavailable')
  })

  it('accepts one IPv4 or IPv6 address and canonicalizes the result', () => {
    expect(resolveClientIp('production', new Headers({ 'CF-Connecting-IP': '192.0.2.7' }))).toBe('192.0.2.7')
    expect(resolveClientIp('production', new Headers({
      'CF-Connecting-IP': '2001:0DB8:0000:0000:0000:0000:0000:0001',
    }))).toBe('2001:db8::1')
  })

  it.each([
    '203.0.113.7, 198.51.100.9',
    '999.0.0.1',
    '1.2.3',
    'not-an-ip',
    '2001:db8::1%eth0',
    '1'.repeat(46),
  ])('rejects malformed or ambiguous Cloudflare source %j', (value) => {
    expect(() => resolveClientIp('production', new Headers({ 'CF-Connecting-IP': value })))
      .toThrow('Trusted client IP unavailable')
  })

  it('rejects control characters even if supplied by a nonstandard Headers implementation', () => {
    const headers = { get: () => '203.0.113.7\u0000evil' } as unknown as Headers
    expect(() => resolveClientIp('production', headers)).toThrow('Trusted client IP unavailable')
  })
})

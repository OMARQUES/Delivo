import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudflareTurnstileVerifier } from '../src/security/turnstile'
import { SecurityHttpError } from '../src/security/http'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function success(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    challenge_ts: NOW.toISOString(),
    hostname: 'localhost',
    action: 'register',
    ...overrides,
  }
}

function verifier(fetchSpy: typeof fetch, overrides: Partial<ConstructorParameters<typeof CloudflareTurnstileVerifier>[0]> = {}) {
  return new CloudflareTurnstileVerifier({
    secret: 'secret',
    expectedHostnames: ['localhost'],
    fetch: fetchSpy,
    timeoutMs: 3_000,
    environment: 'production',
    ...overrides,
  })
}

async function expectSecurityError(promise: Promise<unknown>, code: SecurityHttpError['code']) {
  await expect(promise).rejects.toMatchObject({ code })
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(SecurityHttpError)
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(JSON.stringify(error)).not.toContain('token')
  })
}

describe('CloudflareTurnstileVerifier', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts Siteverify form data and accepts a valid challenge', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse(success()))

    await expect(verifier(fetchSpy).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    })).resolves.toBeUndefined()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const body = init?.body as URLSearchParams
    expect(body.get('secret')).toBe('secret')
    expect(body.get('response')).toBe('token')
    expect(body.get('remoteip')).toBe('127.0.0.1')
    expect(body.get('idempotency_key')).toMatch(UUID_RE)
    expect(String(await verifier(fetchSpy).verify({
      token: 'token-2',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    }))).not.toContain('token-2')
  })

  it('calls the runtime fetch with the global execution context', async () => {
    const runtimeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(jsonResponse(success()))
    })

    await expect(verifier(runtimeFetch as typeof fetch).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    })).resolves.toBeUndefined()
  })

  it('accepts documented provider extensions without weakening challenge checks', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse(success({
      cdata: 'provider-owned-custom-data',
      metadata: { ephemeral_id: 'provider-owned-device-id' },
    })))

    await expect(verifier(fetchSpy).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    })).resolves.toBeUndefined()
  })

  it.each([
    [['invalid-input-response'], 'TURNSTILE_INVALID'],
    [['timeout-or-duplicate'], 'TURNSTILE_INVALID'],
    [['internal-error'], 'SECURITY_CHECK_UNAVAILABLE'],
    [['missing-input-secret'], 'SECURITY_CHECK_UNAVAILABLE'],
    [['invalid-input-secret'], 'SECURITY_CHECK_UNAVAILABLE'],
    [['bad-request'], 'SECURITY_CHECK_UNAVAILABLE'],
    [['unknown-provider-code'], 'SECURITY_CHECK_UNAVAILABLE'],
    [[], 'SECURITY_CHECK_UNAVAILABLE'],
  ] as const)('maps provider failure %j to %s', async (codes, code) => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse({ success: false, 'error-codes': codes }))

    await expectSecurityError(verifier(fetchSpy).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    }), code)
  })

  it('logs only a safe unavailable classification', async () => {
    const warn = vi.mocked(console.warn)
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse({
      success: false,
      'error-codes': ['internal-error'],
    }))

    await expectSecurityError(verifier(fetchSpy, { secret: 'provider-secret' }).verify({
      token: 'visitor-token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    }), 'SECURITY_CHECK_UNAVAILABLE')

    expect(warn).toHaveBeenCalledWith('turnstile unavailable', { reason: 'provider' })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('provider-secret')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('visitor-token')
  })

  it.each([
    [success({ action: 'login' }), 'TURNSTILE_INVALID'],
    [success({ hostname: 'evil.example' }), 'TURNSTILE_INVALID'],
    [success({ challenge_ts: new Date(NOW.getTime() - 301_000).toISOString() }), 'TURNSTILE_INVALID'],
    [success({ challenge_ts: new Date(NOW.getTime() + 31_000).toISOString() }), 'TURNSTILE_INVALID'],
    [success({ challenge_ts: 'not-a-date' }), 'TURNSTILE_INVALID'],
  ] as const)('rejects invalid successful response %#', async (body, code) => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse(body))

    await expectSecurityError(verifier(fetchSpy).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    }), code)
  })

  it.each([
    [jsonResponse({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } }), 'local', true],
    [jsonResponse({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } }), 'staging', false],
    [jsonResponse({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } }), 'production', false],
    [jsonResponse({ success: true, hostname: 'example.com' }), 'local', false],
  ] as const)('handles provider-owned local testing response in %s', async (response, environment, valid) => {
    const fetchSpy = vi.fn<typeof fetch>(async () => response)
    const promise = verifier(fetchSpy, {
      environment,
      expectedHostnames: ['localhost'],
    }).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    })

    if (valid) await expect(promise).resolves.toBeUndefined()
    else await expectSecurityError(promise, 'TURNSTILE_INVALID')
  })

  it.each([
    [jsonResponse({ ok: true }), 'SECURITY_CHECK_UNAVAILABLE'],
    [new Response('nope', { status: 200 }), 'SECURITY_CHECK_UNAVAILABLE'],
    [jsonResponse({ success: true }, 500), 'SECURITY_CHECK_UNAVAILABLE'],
  ] as const)('treats malformed or non-2xx response as unavailable %#', async (response, code) => {
    const fetchSpy = vi.fn<typeof fetch>(async () => response)

    await expectSecurityError(verifier(fetchSpy).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    }), code)
  })

  it('maps timeout abort and transport failure to unavailable without leaking token', async () => {
    const timeoutFetch = vi.fn<typeof fetch>((...args) => new Promise<Response>((resolve, reject) => {
      const init = args[1]
      void resolve
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))

    await expectSecurityError(verifier(timeoutFetch as typeof fetch, { timeoutMs: 1 }).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    }), 'SECURITY_CHECK_UNAVAILABLE')

    const failingFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('network token secret')
    })
    await expectSecurityError(verifier(failingFetch).verify({
      token: 'token',
      remoteIp: '127.0.0.1',
      action: 'register',
      now: NOW,
    }), 'SECURITY_CHECK_UNAVAILABLE')
  })
})

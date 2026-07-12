import { describe, expect, it, vi } from 'vitest'
import type { EmailConfig } from '../src/email/config'
import { EmailDeliveryError, createResendSender } from '../src/email/resend-sender'

function config(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    apiKey: 're_secret',
    from: 'Delivo <auth@example.com>',
    publicWebUrl: 'https://app.example.com/',
    allowedRecipients: null,
    appEnv: 'staging',
    ...overrides,
  }
}

function envelope() {
  return {
    to: 'user@example.com',
    subject: 'Codigo',
    html: '<p>123456</p>',
    text: '123456',
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function expectDeliveryError(promise: Promise<unknown>, failureClass: EmailDeliveryError['failureClass']) {
  await expect(promise).rejects.toMatchObject({ failureClass })
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(EmailDeliveryError)
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('provider-secret-body')
    expect(serialized).not.toContain('re_secret')
    expect(serialized).not.toContain('123456')
  })
}

describe('Resend sender', () => {
  it('posts Resend JSON with authorization and idempotency key', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'email_123' }))
    const sender = createResendSender(config(), fetchSpy)

    await expect(sender.send(envelope(), { idempotencyKey: 'idem-123' })).resolves.toEqual({
      providerMessageId: 'email_123',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.headers).toEqual({
      Authorization: 'Bearer re_secret',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-123',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'Delivo <auth@example.com>',
      to: ['user@example.com'],
      subject: 'Codigo',
      html: '<p>123456</p>',
      text: '123456',
    })
  })

  it.each([
    [400, 'PROVIDER_REJECTED'],
    [429, 'PROVIDER_RATE_LIMIT'],
    [500, 'PROVIDER_UNAVAILABLE'],
  ] as const)('maps HTTP %s without leaking provider body', async (status, failureClass) => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response('provider-secret-body 123456', { status }))

    await expectDeliveryError(
      createResendSender(config(), fetchSpy).send(envelope(), { idempotencyKey: 'idem-123' }),
      failureClass,
    )
  })

  it('maps malformed 2xx responses to provider rejection', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }))

    await expectDeliveryError(
      createResendSender(config(), fetchSpy).send(envelope(), { idempotencyKey: 'idem-123' }),
      'PROVIDER_REJECTED',
    )
  })

  it('maps network and timeout errors to sanitized failure classes', async () => {
    const networkFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('network provider-secret-body 123456')
    })
    await expectDeliveryError(
      createResendSender(config(), networkFetch).send(envelope(), { idempotencyKey: 'idem-123' }),
      'NETWORK',
    )

    const timeoutFetch = vi.fn<typeof fetch>(async () => {
      throw new DOMException('aborted provider-secret-body', 'AbortError')
    })
    await expectDeliveryError(
      createResendSender(config(), timeoutFetch).send(envelope(), { idempotencyKey: 'idem-123' }),
      'TIMEOUT',
    )
  })
})

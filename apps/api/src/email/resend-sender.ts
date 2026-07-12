import type { EmailConfig } from './config'
import { assertRecipientAllowed } from './config'
import type { EmailSender } from './sender'
import type { EmailEnvelope } from './types'

const RESEND_EMAILS_URL = 'https://api.resend.com/emails'

export type EmailFailureClass =
  | 'CONFIG'
  | 'RECIPIENT_BLOCKED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNAVAILABLE'

export class EmailDeliveryError extends Error {
  constructor(
    public readonly failureClass: EmailFailureClass,
    message = 'Email delivery failed',
  ) {
    super(message)
  }

  toJSON() {
    return { failureClass: this.failureClass, message: this.message }
  }
}

function deliveryError(failureClass: EmailFailureClass): never {
  throw new EmailDeliveryError(failureClass)
}

function mapProviderStatus(status: number): EmailFailureClass {
  if (status === 429) return 'PROVIDER_RATE_LIMIT'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REJECTED'
}

async function readProviderId(response: Response): Promise<string> {
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    deliveryError('PROVIDER_REJECTED')
  }
  const id = typeof raw === 'object' && raw !== null && 'id' in raw
    ? (raw as { id?: unknown }).id
    : null
  if (typeof id !== 'string' || id.trim().length === 0) deliveryError('PROVIDER_REJECTED')
  return id
}

function requestBody(config: EmailConfig, envelope: EmailEnvelope): string {
  return JSON.stringify({
    from: config.from,
    to: [envelope.to],
    subject: envelope.subject,
    html: envelope.html,
    text: envelope.text,
  })
}

export function createResendSender(config: EmailConfig, fetchFn: typeof fetch = fetch): EmailSender {
  return {
    async send(envelope, options) {
      try {
        assertRecipientAllowed(config, envelope.to)
      } catch {
        deliveryError('RECIPIENT_BLOCKED')
      }

      let response: Response
      try {
        response = await fetchFn(RESEND_EMAILS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': options.idempotencyKey,
          },
          body: requestBody(config, envelope),
          signal: AbortSignal.timeout(5_000),
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') deliveryError('TIMEOUT')
        deliveryError('NETWORK')
      }

      if (!response.ok) deliveryError(mapProviderStatus(response.status))
      return { providerMessageId: await readProviderId(response) }
    },
  }
}

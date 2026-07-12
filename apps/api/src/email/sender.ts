import type { EmailEnvelope } from './types'

export interface EmailSender {
  send(envelope: EmailEnvelope, options: { idempotencyKey: string }): Promise<{ providerMessageId: string }>
}

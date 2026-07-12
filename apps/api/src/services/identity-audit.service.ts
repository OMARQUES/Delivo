import { identitySecurityEvents, type AuthChallengePurpose } from '../db/schema'
import type { DbTx } from '../db/types'
import { hashRateLimitKey } from '../security/rate-limit-key'

const EVENT_TYPES = [
  'REGISTRATION_CONFIRMED',
  'CHALLENGE_OUTCOME',
  'PASSWORD_RESET',
  'SESSIONS_REVOKED',
  'STORE_ACTIVATED',
  'EMAIL_DELIVERY',
  'CLEANUP',
] as const
const PURPOSES = new Set<AuthChallengePurpose>([
  'REGISTRATION_VERIFY',
  'STORE_ACTIVATION',
  'ADMIN_ACTIVATION',
  'PASSWORD_RECOVERY',
])
const EVENT_FIELDS = new Set([
  'eventType',
  'result',
  'actorUserId',
  'targetUserId',
  'subjectKey',
  'requestId',
  'metadata',
])
const METADATA_FIELDS = new Set(['failureClass', 'purpose'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SUBJECT_KEY_RE = /^[A-Za-z0-9_-]{43}$/
const SAFE_VALUE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export type IdentityEventType = (typeof EVENT_TYPES)[number]
type IdentityEventBase = {
  result: string
  actorUserId?: string
  targetUserId?: string
  subjectKey?: string
  requestId: string
  metadata?: {
    failureClass?: string
    purpose?: AuthChallengePurpose
  }
}
export type IdentityEvent = {
  [K in IdentityEventType]: IdentityEventBase & { eventType: K }
}[IdentityEventType]

export async function hashIdentitySubject(
  secret: string,
  kind: 'email' | 'ip',
  subject: string,
): Promise<string> {
  if (!secret.trim()) throw new Error('Identity subject secret is required')
  return hashRateLimitKey(secret, `identity-audit-${kind}`, subject, kind === 'email' ? 'identity' : 'opaque')
}

function assertExactFields(value: object, allowed: ReadonlySet<string>, label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`Identity audit ${label} contains forbidden field`)
}

function assertUuid(value: string | undefined, label: string) {
  if (value !== undefined && !UUID_RE.test(value)) throw new Error(`Identity audit ${label} is invalid`)
}

function validateEvent(event: IdentityEvent) {
  if (!event || typeof event !== 'object') throw new Error('Identity audit event is invalid')
  assertExactFields(event, EVENT_FIELDS, 'event')
  if (!EVENT_TYPES.includes(event.eventType)) throw new Error('Identity audit event type is invalid')
  if (!SAFE_VALUE_RE.test(event.result)) throw new Error('Identity audit result is invalid')
  assertUuid(event.actorUserId, 'actor')
  assertUuid(event.targetUserId, 'target')
  assertUuid(event.requestId, 'request ID')
  if (event.subjectKey !== undefined && !SUBJECT_KEY_RE.test(event.subjectKey)) {
    throw new Error('Identity audit subject key is invalid')
  }
  if (event.metadata !== undefined) {
    if (!event.metadata || typeof event.metadata !== 'object' || Array.isArray(event.metadata)) {
      throw new Error('Identity audit metadata is invalid')
    }
    assertExactFields(event.metadata, METADATA_FIELDS, 'metadata')
    if (event.metadata.failureClass !== undefined && !SAFE_VALUE_RE.test(event.metadata.failureClass)) {
      throw new Error('Identity audit metadata failure class is invalid')
    }
    if (event.metadata.purpose !== undefined && !PURPOSES.has(event.metadata.purpose)) {
      throw new Error('Identity audit metadata purpose is invalid')
    }
  }
}

export async function appendIdentityEvent(tx: DbTx, event: IdentityEvent): Promise<void> {
  validateEvent(event)
  await tx.insert(identitySecurityEvents).values({
    eventType: event.eventType,
    result: event.result,
    actorUserId: event.actorUserId,
    targetUserId: event.targetUserId,
    subjectKey: event.subjectKey,
    requestId: event.requestId,
    metadata: event.metadata ?? {},
  })
}

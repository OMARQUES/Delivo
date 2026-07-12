import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { identitySecurityEvents } from '../src/db/schema'
import type { AppContext } from '../src/env'
import { requestId } from '../src/middleware/request-id'
import {
  appendIdentityEvent,
  hashIdentitySubject,
  type IdentityEvent,
} from '../src/services/identity-audit.service'
import { closeTestDb, migrateTestDb, testDb, truncateAll } from './helpers/test-db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

beforeAll(migrateTestDb)
beforeEach(truncateAll)
afterAll(closeTestDb)

describe('identity audit writer', () => {
  it('stores an allowlisted event with only a pseudonymous subject key', async () => {
    const rawEmail = 'Person@example.com'
    const subjectKey = await hashIdentitySubject('rate-secret', 'email', rawEmail)
    const requestId = crypto.randomUUID()

    await testDb.transaction((tx) => appendIdentityEvent(tx, {
      eventType: 'CHALLENGE_OUTCOME',
      result: 'SUCCESS',
      subjectKey,
      requestId,
      metadata: { purpose: 'REGISTRATION_VERIFY' },
    }))

    const rows = await testDb.select().from(identitySecurityEvents)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      eventType: 'CHALLENGE_OUTCOME',
      result: 'SUCCESS',
      subjectKey,
      requestId,
      metadata: { purpose: 'REGISTRATION_VERIFY' },
    })
    expect(subjectKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(rows)).not.toContain(rawEmail)
    expect(JSON.stringify(rows)).not.toContain(rawEmail.toLowerCase())
  })

  it.each(['email', 'phone', 'code', 'ticket', 'token', 'password'])('rejects forbidden metadata key %s', async (key) => {
    const event = {
      eventType: 'PASSWORD_RESET',
      result: 'SUCCESS',
      requestId: crypto.randomUUID(),
      metadata: { [key]: 'secret-value' },
    } as unknown as IdentityEvent

    await expect(testDb.transaction((tx) => appendIdentityEvent(tx, event))).rejects.toThrow(/metadata/i)
    expect(await testDb.select().from(identitySecurityEvents)).toHaveLength(0)
  })

  it('rejects raw subject keys and unknown top-level fields', async () => {
    await expect(testDb.transaction((tx) => appendIdentityEvent(tx, {
      eventType: 'EMAIL_DELIVERY',
      result: 'FAILURE',
      requestId: crypto.randomUUID(),
      subjectKey: 'person@example.com',
      metadata: { failureClass: 'NETWORK' },
    }))).rejects.toThrow(/subject/i)

    const event = {
      eventType: 'CLEANUP',
      result: 'SUCCESS',
      requestId: crypto.randomUUID(),
      requestBody: { code: '000000' },
    } as unknown as IdentityEvent
    await expect(testDb.transaction((tx) => appendIdentityEvent(tx, event))).rejects.toThrow(/field/i)
  })
})

describe('request ID middleware', () => {
  it('ignores inbound IDs and exposes the same server UUID to handlers and responses', async () => {
    const app = new Hono<AppContext>()
    app.use('*', requestId())
    app.get('/', (c) => c.json({ requestId: c.get('requestId') }))

    const response = await app.request('/', { headers: { 'X-Request-ID': 'attacker-controlled' } })
    const body = await response.json<{ requestId: string }>()

    expect(body.requestId).toMatch(UUID_RE)
    expect(body.requestId).not.toBe('attacker-controlled')
    expect(response.headers.get('X-Request-ID')).toBe(body.requestId)
  })
})

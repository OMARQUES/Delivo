import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { closeTestDb, migrateTestDb, testDb } from './helpers/test-db'

beforeAll(migrateTestDb)
afterAll(closeTestDb)

async function enumValues(name: string) {
  const rows = await testDb.execute<{ enumlabel: string }>(sql`
    select e.enumlabel
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typname = ${name}
    order by e.enumsortorder
  `)
  return rows.map((row) => row.enumlabel)
}

async function tableNames() {
  const rows = await testDb.execute<{ table_name: string }>(sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        'pending_registrations',
        'auth_challenges',
        'auth_action_tickets',
        'email_outbox',
        'identity_security_events'
      )
    order by table_name
  `)
  return rows.map((row) => row.table_name)
}

async function columnIsNullable(tableName: string, columnName: string) {
  const rows = await testDb.execute<{ is_nullable: 'YES' | 'NO' }>(sql`
    select is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = ${tableName}
      and column_name = ${columnName}
  `)
  return rows[0]?.is_nullable === 'YES'
}

describe('SEC-03A identity foundation schema', () => {
  it('adds compatible identity lifecycle enums and tables', async () => {
    expect(await enumValues('user_status')).toEqual([
      'ACTIVE',
      'PENDING',
      'PENDING_EMAIL',
      'PENDING_APPROVAL',
      'BLOCKED',
    ])
    expect(await enumValues('store_security_status')).toContain('PENDING_ACTIVATION')
    expect(await tableNames()).toEqual(expect.arrayContaining([
      'pending_registrations',
      'auth_challenges',
      'auth_action_tickets',
      'email_outbox',
      'identity_security_events',
    ]))
    expect(await columnIsNullable('users', 'email')).toBe(true)
  })

  it('rejects invalid identity security rows at the database level', async () => {
    const now = new Date()
    const future = new Date(now.getTime() + 10 * 60_000)

    await expect(testDb.execute(sql`
      insert into auth_challenges (purpose, email, code_hash, expires_at, attempt_count)
      values ('REGISTRATION_VERIFY', 'a@example.com', 'hash', ${future}, -1)
    `)).rejects.toThrow()

    await expect(testDb.execute(sql`
      insert into auth_challenges (purpose, email, expires_at)
      values ('REGISTRATION_VERIFY', 'a@example.com', ${future})
    `)).rejects.toThrow()

    await expect(testDb.execute(sql`
      insert into auth_challenges (purpose, code_hash, expires_at)
      values ('REGISTRATION_VERIFY', 'hash', ${future})
    `)).rejects.toThrow()

    await expect(testDb.execute(sql`
      insert into auth_challenges (purpose, email, user_id, code_hash, expires_at)
      values ('REGISTRATION_VERIFY', 'a@example.com', gen_random_uuid(), 'hash', ${future})
    `)).rejects.toThrow()

    await expect(testDb.execute(sql`
      insert into auth_action_tickets (purpose, token_hash, expires_at)
      values ('PASSWORD_RESET', 'hash', ${future})
    `)).rejects.toThrow()

    await expect(testDb.execute(sql`
      insert into email_outbox (template, recipient, idempotency_key, status, attempt_count, next_attempt_at)
      values ('VERIFICATION_CODE', 'a@example.com', gen_random_uuid()::text, 'PENDING', -1, ${now})
    `)).rejects.toThrow()
  })
})

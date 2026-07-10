import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrateTestDb, testDb, closeTestDb } from './helpers/test-db'

beforeAll(migrateTestDb)
afterAll(closeTestDb)

describe('payment schema migrations', () => {
  it('adds CARD_ONLINE, payments table and pix keys', async () => {
    const enumRows = await testDb.execute<{ enumlabel: string }>(sql`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'payment_method'
      order by enumsortorder
    `)
    expect(enumRows.map((row) => row.enumlabel)).toEqual(['CASH', 'CARD_MACHINE', 'PIX_ONLINE', 'CARD_ONLINE'])

    const paymentColumns = await testDb.execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'payments'
    `)
    expect(paymentColumns.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'id',
      'order_id',
      'provider',
      'provider_payment_id',
      'method',
      'status',
      'amount_cents',
      'qr_code',
      'qr_code_base64',
      'expires_at',
      'refunded_at',
      'created_at',
      'updated_at',
    ]))

    const pixKeyColumns = await testDb.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'pix_key' and table_name in ('stores', 'drivers')
      order by table_name
    `)
    expect(pixKeyColumns.map((row) => row.table_name)).toEqual(['drivers', 'stores'])
  })
})

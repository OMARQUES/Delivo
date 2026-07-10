import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { closeTestDb, migrateTestDb, testDb } from './helpers/test-db'

beforeAll(migrateTestDb)
afterAll(closeTestDb)

describe('finance schema', () => {
  it('has commission_bps on stores and finance tables', async () => {
    const rows = await testDb.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'ledger_entries',
          'store_invoices',
          'store_invoice_items',
          'store_payouts',
          'store_payout_items',
          'driver_payouts',
          'driver_payout_items'
        )
      order by table_name
    `)
    expect(rows.map((r) => r.table_name)).toEqual([
      'driver_payout_items',
      'driver_payouts',
      'ledger_entries',
      'store_invoice_items',
      'store_invoices',
      'store_payout_items',
      'store_payouts',
    ])

    const columns = await testDb.execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'stores'
        and column_name = 'commission_bps'
    `)
    expect(columns.map((r) => r.column_name)).toEqual(['commission_bps'])
  })
})

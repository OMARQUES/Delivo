import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrateTestDb, testDb, closeTestDb } from './helpers/test-db'

beforeAll(migrateTestDb)
afterAll(closeTestDb)

describe('payment schema migrations', () => {
  it('stores Order identity and durable payment work tables', async () => {
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
      'provider_order_id',
      'provider_transaction_id',
      'method',
      'status',
      'expected_amount_cents',
      'expected_currency',
      'expected_country',
      'expected_application_id',
      'expected_account_id',
      'expected_live_mode',
      'create_idempotency_key',
      'provider_status',
      'provider_status_detail',
      'reconciliation_state',
      'reconciliation_failure',
      'reconciliation_attempt_count',
      'refunded_amount_cents',
      'qr_code',
      'qr_code_base64',
      'expires_at',
      'next_reconcile_at',
      'created_at',
      'updated_at',
    ]))

    const paymentChecks = await testDb.execute<{ constraint_name: string }>(sql`
      select constraint_name
      from information_schema.table_constraints
      where table_schema = 'public'
        and table_name = 'payments'
        and constraint_type = 'CHECK'
    `)
    expect(paymentChecks.map((row) => row.constraint_name)).toContain('payments_reconciliation_attempt_count_valid')

    const tableNames = await testDb.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('payments', 'payment_webhook_inbox', 'payment_operations')
      order by table_name
    `)
    expect(tableNames.map((row) => row.table_name)).toEqual([
      'payment_operations',
      'payment_webhook_inbox',
      'payments',
    ])

    const uniqueIndexes = await testDb.execute<{ indexname: string }>(sql`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'payments_create_idempotency_unique',
          'payments_provider_order_unique',
          'payments_provider_transaction_unique',
          'payment_webhook_inbox_dedupe_unique',
          'payment_operations_business_key_unique'
        )
      order by indexname
    `)
    expect(uniqueIndexes.map((row) => row.indexname)).toEqual([
      'payment_operations_business_key_unique',
      'payment_webhook_inbox_dedupe_unique',
      'payments_create_idempotency_unique',
      'payments_provider_order_unique',
      'payments_provider_transaction_unique',
    ])

    const operationColumns = await testDb.execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'payment_operations'
    `)
    expect(operationColumns.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'expected_refunded_amount_cents',
      'depends_on_operation_id',
      'result_code',
    ]))

    const operationResultEnum = await testDb.execute<{ enumlabel: string }>(sql`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'payment_operation_result_code'
      order by enumsortorder
    `)
    expect(operationResultEnum.map((row) => row.enumlabel)).toEqual([
      'CANCELLED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'ESCALATED_TO_REFUND',
    ])

    const dependencyIndexes = await testDb.execute<{ indexname: string }>(sql`
      select indexname
      from pg_indexes
      where schemaname = 'public' and indexname = 'payment_operations_dependency_idx'
    `)
    expect(dependencyIndexes.map((row) => row.indexname)).toContain('payment_operations_dependency_idx')

    const foreignKeys = await testDb.execute<{ constraint_name: string }>(sql`
      select constraint_name
      from information_schema.table_constraints
      where table_schema = 'public'
        and table_name = 'payment_operations'
        and constraint_type = 'FOREIGN KEY'
    `)
    expect(foreignKeys.map((row) => row.constraint_name).some((name) => name.startsWith('payment_operations_depends_on_operation_id_payment_operations_i'))).toBe(true)

    const pixKeyColumns = await testDb.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'pix_key' and table_name in ('stores', 'drivers')
      order by table_name
    `)
    expect(pixKeyColumns.map((row) => row.table_name)).toEqual(['drivers', 'stores'])
  })
})

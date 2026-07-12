import { getTableColumns } from 'drizzle-orm'
import { getTableConfig, type AnyPgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../src/db/schema'

describe('rate limit bucket schema', () => {
  it('stores only hashed keys in expiring composite-key buckets', () => {
    const rateLimitBuckets = Reflect.get(schema, 'rateLimitBuckets') as AnyPgTable | undefined

    expect(rateLimitBuckets).toBeDefined()
    if (!rateLimitBuckets) return

    const columns = Object.values(getTableColumns(rateLimitBuckets))
    expect(columns.map((column) => column.name)).toEqual([
      'scope',
      'key_hash',
      'window_start',
      'count',
      'blocked_until',
      'expires_at',
    ])

    const config = getTableConfig(rateLimitBuckets)
    expect(config.primaryKeys).toHaveLength(1)
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'scope',
      'key_hash',
      'window_start',
    ])
    expect(config.indexes.map((index) => index.config.columns.map((column) => 'name' in column ? column.name : undefined)))
      .toContainEqual(['expires_at'])

    const rawSensitiveColumns = new Set(['key', 'ip', 'ip_address', 'email', 'phone', 'identifier'])
    expect(columns.map((column) => column.name).filter((name) => rawSensitiveColumns.has(name))).toEqual([])
  })
})

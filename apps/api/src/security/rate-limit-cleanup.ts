import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../db/schema'

type DbClient = Pick<PostgresJsDatabase<typeof schema>, 'execute'>

export async function deleteExpiredRateLimitBuckets(db: DbClient, now = new Date(), limit = 1_000) {
  const nowParam = now.toISOString()
  const rows = await db.execute(sql`
    delete from rate_limit_buckets
    where (scope, key_hash, window_start) in (
      select scope, key_hash, window_start
      from rate_limit_buckets
      where expires_at <= ${nowParam}::timestamptz
      order by expires_at asc
      limit ${limit}
    )
    returning scope
  `)
  return rows.length
}

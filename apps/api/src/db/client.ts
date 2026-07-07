import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { Env } from '../env'
import * as schema from './schema'

export function createDb(env: Env) {
  const client = postgres(env.HYPERDRIVE.connectionString, {
    max: 2,
    fetch_types: false,
    prepare: false,
  })
  return { db: drizzle(client, { schema }), client }
}

export type Db = ReturnType<typeof createDb>['db']

import 'dotenv/config'
import postgres from 'postgres'
import { assertDemoResetAllowed } from './demo-reset'

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

async function main(): Promise<void> {
  assertDemoResetAllowed(process.env)
  const client = postgres(requiredEnv('DATABASE_URL'), { max: 1, fetch_types: false })
  try {
    const tables = await client<{ schema_name: string; table_name: string }[]>`
      select table_schema as schema_name, table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
        and table_name <> '__drizzle_migrations'
      order by table_name
    `
    if (tables.length === 0) throw new Error('DEMO_RESET_NO_PUBLIC_TABLES')
    await client.begin(async (sql) => {
      const names = tables.map(({ schema_name, table_name }) => {
        const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
        return `${quote(schema_name)}.${quote(table_name)}`
      })
      await sql.unsafe(`truncate table ${names.join(', ')} restart identity cascade`)
    })
    console.log(`demo_reset=PASS tables=${tables.length}`)
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(`demo_reset=FAIL code=${error instanceof Error ? error.message : 'UNKNOWN'}`)
  process.exitCode = 1
})

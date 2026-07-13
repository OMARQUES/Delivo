/**
 * Bootstrap idempotente do primeiro ADMIN.
 * Segredos vêm somente do ambiente; nenhum argumento CLI é aceito ou impresso.
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { Env } from '../env'
import * as schema from './schema'
import { resolveEmailConfig } from '../email/config'
import { dispatchOutboxById } from '../email/outbox.service'
import { createResendSender } from '../email/resend-sender'
import { AdminBootstrapError, bootstrapAdmin } from '../services/admin-bootstrap.service'

class BootstrapConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BootstrapConfigError'
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new BootstrapConfigError(`${name}_REQUIRED`)
  return value
}

function appEnvironment(): Env['APP_ENV'] {
  const value = process.env.APP_ENV?.trim() || 'local'
  if (value !== 'local' && value !== 'staging' && value !== 'production') {
    throw new BootstrapConfigError('APP_ENV_INVALID')
  }
  return value
}

async function main(): Promise<void> {
  const databaseUrl = required('DATABASE_URL')
  const authCodeSecret = required('AUTH_CODE_SECRET')
  const runtimeEnv = {
    APP_ENV: appEnvironment(),
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    AUTH_CODE_SECRET: authCodeSecret,
    EMAIL_FROM: process.env.EMAIL_FROM,
    PUBLIC_WEB_URL: process.env.PUBLIC_WEB_URL,
    EMAIL_ALLOWED_RECIPIENTS: process.env.EMAIL_ALLOWED_RECIPIENTS,
  } as Env
  // Fail before DB mutation when email delivery cannot be configured safely.
  let emailConfig: ReturnType<typeof resolveEmailConfig>
  try {
    emailConfig = resolveEmailConfig(runtimeEnv)
  } catch {
    throw new BootstrapConfigError('EMAIL_CONFIG_INVALID')
  }

  const client = postgres(databaseUrl, { max: 1, fetch_types: false })
  const db = drizzle(client, { schema })

  try {
    const result = await bootstrapAdmin(db, {
      name: process.env.ADMIN_NAME?.trim() || 'Admin',
      email: required('ADMIN_EMAIL'),
      password: required('ADMIN_PASSWORD'),
    }, {
      authCodeSecret,
      requestId: crypto.randomUUID(),
    })

    let delivery = 'NOT_REQUIRED'
    if (result.outboxId) {
      try {
        const dispatched = await dispatchOutboxById(
          db,
          createResendSender(emailConfig),
          runtimeEnv,
          result.outboxId,
        )
        delivery = dispatched.status
      } catch {
        // Transaction is committed; cron/manual rerun can safely retry queued delivery.
        delivery = 'QUEUED'
      }
    }
    console.log(`admin bootstrap state=${result.state} delivery=${delivery}`)
  } finally {
    await client.end()
  }
}

try {
  await main()
} catch (error) {
  const code = error instanceof AdminBootstrapError || error instanceof BootstrapConfigError
    ? error.message
    : 'BOOTSTRAP_FAILED'
  console.error(`admin bootstrap state=FAILED code=${code}`)
  process.exitCode = 1
}

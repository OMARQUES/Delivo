import { and, eq, lte, or } from 'drizzle-orm'
import { app } from './app'
import { createDb } from './db/client'
import { emailOutbox } from './db/schema'
import type { Env } from './env'
import { resolveEmailConfig } from './email/config'
import { dispatchDueOutbox } from './email/outbox.service'
import { EmailDeliveryError, createResendSender } from './email/resend-sender'
import { createPaymentProvider } from './payments/mercadopago'
import { cleanupIdentityState } from './services/identity-cleanup.service'
import { cancelStalePendingOrders } from './services/order-status.service'
import { runPaymentReconciliation } from './payments/reconciliation.service'
import { autoApproveStaleShiftDailies } from './services/shift.service'
import { deleteExpiredRateLimitBuckets } from './security/rate-limit-cleanup'

function emailFailureClass(error: unknown): string {
  if (error instanceof EmailDeliveryError) return error.failureClass
  if (error instanceof Error && error.message.startsWith('Email configuration error:')) return 'CONFIG'
  return 'UNEXPECTED'
}

async function hasDueEmail(db: ReturnType<typeof createDb>['db'], now: Date): Promise<boolean> {
  const [due] = await db.select({ id: emailOutbox.id }).from(emailOutbox).where(or(
    and(eq(emailOutbox.status, 'PENDING'), lte(emailOutbox.nextAttemptAt, now)),
    and(eq(emailOutbox.status, 'PROCESSING'), lte(emailOutbox.leasedUntil, now)),
  )).limit(1)
  return Boolean(due)
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env) {
    const { db, client } = createDb(env)
    try {
      const now = new Date()
      try {
        if (await hasDueEmail(db, now)) {
          const emailConfig = resolveEmailConfig(env)
          const dispatch = await dispatchDueOutbox(db, createResendSender(emailConfig), env, now, 50)
          if (dispatch.claimed > 0) console.log('cron: email outbox processado', dispatch)
        }
      } catch (error) {
        console.error('cron: falha no email outbox', { failureClass: emailFailureClass(error) })
      }

      try {
        const identity = await cleanupIdentityState(db, now, 500)
        if (Object.values(identity).some((count) => count > 0)) {
          console.log('cron: identidade limpa', identity)
        }
      } catch {
        console.error('cron: falha na limpeza de identidade', { failureClass: 'UNEXPECTED' })
      }

      const n = await cancelStalePendingOrders(db, 30)
      if (n > 0) console.log(`cron: ${n} pedidos PENDING expirados cancelados`)
      const provider = createPaymentProvider(env)
      if (provider) {
        const reconciliation = await runPaymentReconciliation(db, provider, now)
        if (Object.values(reconciliation).some((count) => count > 0)) console.log('cron: pagamentos reconciliados', reconciliation)
      }
      const dailies = await autoApproveStaleShiftDailies(db)
      if (dailies > 0) console.log(`cron: ${dailies} diárias de turno aprovadas automaticamente`)
      const buckets = await deleteExpiredRateLimitBuckets(db)
      if (buckets > 0) console.log(`cron: ${buckets} rate limit buckets expirados removidos`)
    } finally {
      await client.end()
    }
  },
}

import { defineStore } from 'pinia'
import { api } from '../lib/api'

export type RecoveryFlow = { recoveryId: string; expiresAt: string }
export type ResetTicketFlow = { resetTicket: string; expiresAt: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validExpiry(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

function assertRecoveryFlow(value: RecoveryFlow): RecoveryFlow {
  if (!UUID.test(value.recoveryId) || !validExpiry(value.expiresAt)) {
    throw new Error('Não foi possível iniciar a recuperação de senha.')
  }
  return value
}

function assertResetTicketFlow(value: ResetTicketFlow): ResetTicketFlow {
  if (
    typeof value.resetTicket !== 'string'
    || value.resetTicket.length < 40
    || value.resetTicket.length > 512
    || !validExpiry(value.expiresAt)
  ) {
    throw new Error('Fluxo inválido ou expirado.')
  }
  return value
}

export const useRecoveryStore = defineStore('password-recovery', {
  state: () => ({
    // Intentionally memory-only. Never add Pinia persistence or browser storage here.
    resetTicket: null as string | null,
    resetExpiresAt: null as string | null,
  }),
  actions: {
    clear() {
      this.resetTicket = null
      this.resetExpiresAt = null
    },
    async start(email: string, turnstileToken: string): Promise<RecoveryFlow> {
      this.clear()
      const flow = await api<RecoveryFlow>('/auth/recovery/start', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), turnstileToken }),
      })
      return assertRecoveryFlow(flow)
    },
    async verify(recoveryId: string, code: string): Promise<ResetTicketFlow> {
      this.clear()
      const flow = assertResetTicketFlow(await api<ResetTicketFlow>('/auth/recovery/verify', {
        method: 'POST',
        body: JSON.stringify({ recoveryId, code }),
      }))
      this.resetTicket = flow.resetTicket
      this.resetExpiresAt = flow.expiresAt
      return flow
    },
    async reset(resetTicket: string, newPassword: string): Promise<void> {
      const expiresAt = this.resetExpiresAt ? Date.parse(this.resetExpiresAt) : Number.NaN
      if (
        !this.resetTicket
        || resetTicket !== this.resetTicket
        || !Number.isFinite(expiresAt)
        || expiresAt <= Date.now()
      ) {
        this.clear()
        throw new Error('Fluxo inválido ou expirado.')
      }
      await api<void>('/auth/recovery/reset', {
        method: 'POST',
        body: JSON.stringify({ resetTicket, newPassword }),
      })
      this.clear()
    },
  },
})

export const DEMO_RESET_CONFIRMATION = 'RESET_LOCAL_DEMO'

export function assertDemoResetAllowed(env: Record<string, string | undefined>): void {
  if ((env.APP_ENV?.trim() || 'local') !== 'local') throw new Error('DEMO_RESET_LOCAL_ONLY')
  if (env.DEMO_RESET_CONFIRM?.trim() !== DEMO_RESET_CONFIRMATION) throw new Error('DEMO_RESET_CONFIRM_REQUIRED')
}

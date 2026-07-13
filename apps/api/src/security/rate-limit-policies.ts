import type { AuthChallengePurpose } from '../db/schema'

export type RateLimitPolicy = Readonly<{
  scope: string
  subjectKind: 'identity' | 'opaque'
  limit: number
  windowMs: number
  retentionMs: number
  cooldownMs?: number
}>

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function policy(value: RateLimitPolicy): RateLimitPolicy {
  return Object.freeze(value)
}

function codePolicies(scope: string) {
  return Object.freeze({
    sendEmailMinute: policy({ scope: `identity-code-send-${scope}-email-minute`, subjectKind: 'identity', limit: 1, windowMs: MINUTE, retentionMs: HOUR }),
    sendEmailHour: policy({ scope: `identity-code-send-${scope}-email-hour`, subjectKind: 'identity', limit: 5, windowMs: HOUR, retentionMs: DAY }),
    sendEmailDay: policy({ scope: `identity-code-send-${scope}-email-day`, subjectKind: 'identity', limit: 10, windowMs: DAY, retentionMs: 2 * DAY }),
    sendIpHour: policy({ scope: `identity-code-send-${scope}-ip-hour`, subjectKind: 'opaque', limit: 20, windowMs: HOUR, retentionMs: DAY }),
    sendIpDay: policy({ scope: `identity-code-send-${scope}-ip-day`, subjectKind: 'opaque', limit: 50, windowMs: DAY, retentionMs: 2 * DAY }),
    attemptIpHour: policy({ scope: `identity-code-attempt-${scope}-ip-hour`, subjectKind: 'opaque', limit: 30, windowMs: HOUR, retentionMs: DAY }),
    resendFlowHour: policy({ scope: `identity-code-resend-${scope}-flow-hour`, subjectKind: 'opaque', limit: 10, windowMs: HOUR, retentionMs: DAY }),
  })
}

export const CODE_RATE_LIMIT_POLICIES = Object.freeze({
  REGISTRATION_VERIFY: codePolicies('registration-verify'),
  STORE_ACTIVATION: codePolicies('store-activation'),
  ADMIN_ACTIVATION: codePolicies('admin-activation'),
  PASSWORD_RECOVERY: codePolicies('password-recovery'),
} satisfies Record<AuthChallengePurpose, ReturnType<typeof codePolicies>>)

export const POLICIES = Object.freeze({
  registerIdentityHour: policy({ scope: 'register-identity-hour', subjectKind: 'identity', limit: 3, windowMs: HOUR, retentionMs: DAY }),
  registerIdentityDay: policy({ scope: 'register-identity-day', subjectKind: 'identity', limit: 10, windowMs: DAY, retentionMs: 2 * DAY }),
  registerIpHour: policy({ scope: 'register-ip-hour', subjectKind: 'opaque', limit: 10, windowMs: HOUR, retentionMs: DAY }),
  registerIpDay: policy({ scope: 'register-ip-day', subjectKind: 'opaque', limit: 30, windowMs: DAY, retentionMs: 2 * DAY }),

  recoveryStartEmailHour: policy({ scope: 'recovery-start-email-hour', subjectKind: 'identity', limit: 5, windowMs: HOUR, retentionMs: DAY }),
  recoveryStartEmailDay: policy({ scope: 'recovery-start-email-day', subjectKind: 'identity', limit: 10, windowMs: DAY, retentionMs: 2 * DAY }),
  recoveryStartIpHour: policy({ scope: 'recovery-start-ip-hour', subjectKind: 'opaque', limit: 10, windowMs: HOUR, retentionMs: DAY }),
  recoveryStartIpDay: policy({ scope: 'recovery-start-ip-day', subjectKind: 'opaque', limit: 30, windowMs: DAY, retentionMs: 2 * DAY }),
  recoveryVerifyIpHour: policy({ scope: 'recovery-verify-ip-hour', subjectKind: 'opaque', limit: 30, windowMs: HOUR, retentionMs: DAY }),
  ticketUseIpHour: policy({ scope: 'identity-ticket-use-ip-hour', subjectKind: 'opaque', limit: 30, windowMs: HOUR, retentionMs: DAY }),
  ticketUseFingerprintHour: policy({ scope: 'identity-ticket-use-fingerprint-hour', subjectKind: 'opaque', limit: 30, windowMs: HOUR, retentionMs: DAY }),

  loginIp15Minutes: policy({ scope: 'login-ip-15m', subjectKind: 'opaque', limit: 30, windowMs: 15 * MINUTE, retentionMs: HOUR }),
  loginFailureIdentity15Minutes: policy({ scope: 'login-failure-identity-15m', subjectKind: 'identity', limit: 5, windowMs: 15 * MINUTE, retentionMs: HOUR }),
  loginFailureIdentityHour: policy({ scope: 'login-failure-identity-hour', subjectKind: 'identity', limit: 10, windowMs: HOUR, retentionMs: DAY, cooldownMs: 15 * MINUTE }),

  refreshFingerprint10Minutes: policy({ scope: 'refresh-fingerprint-10m', subjectKind: 'opaque', limit: 10, windowMs: 10 * MINUTE, retentionMs: HOUR }),
  refreshIp10Minutes: policy({ scope: 'refresh-ip-10m', subjectKind: 'opaque', limit: 60, windowMs: 10 * MINUTE, retentionMs: HOUR }),

  orderQuoteUserMinute: policy({ scope: 'order-quote-user-minute', subjectKind: 'opaque', limit: 30, windowMs: MINUTE, retentionMs: HOUR }),
  orderQuoteUserDay: policy({ scope: 'order-quote-user-day', subjectKind: 'opaque', limit: 300, windowMs: DAY, retentionMs: 2 * DAY }),
  orderQuoteIpMinute: policy({ scope: 'order-quote-ip-minute', subjectKind: 'opaque', limit: 100, windowMs: MINUTE, retentionMs: HOUR }),
  orderCreateUserHour: policy({ scope: 'order-create-user-hour', subjectKind: 'opaque', limit: 10, windowMs: HOUR, retentionMs: DAY }),
  orderCreateUserDay: policy({ scope: 'order-create-user-day', subjectKind: 'opaque', limit: 30, windowMs: DAY, retentionMs: 2 * DAY }),
  orderCreateIpHour: policy({ scope: 'order-create-ip-hour', subjectKind: 'opaque', limit: 30, windowMs: HOUR, retentionMs: DAY }),

  logoUploadPrincipalHour: policy({ scope: 'logo-upload-principal-hour', subjectKind: 'opaque', limit: 20, windowMs: HOUR, retentionMs: DAY }),
  logoUploadPrincipalDay: policy({ scope: 'logo-upload-principal-day', subjectKind: 'opaque', limit: 100, windowMs: DAY, retentionMs: 2 * DAY }),
  logoUploadIpHour: policy({ scope: 'logo-upload-ip-hour', subjectKind: 'opaque', limit: 100, windowMs: HOUR, retentionMs: DAY }),
  productUploadPrincipalHour: policy({ scope: 'product-upload-principal-hour', subjectKind: 'opaque', limit: 20, windowMs: HOUR, retentionMs: DAY }),
  productUploadPrincipalDay: policy({ scope: 'product-upload-principal-day', subjectKind: 'opaque', limit: 100, windowMs: DAY, retentionMs: 2 * DAY }),
  productUploadIpHour: policy({ scope: 'product-upload-ip-hour', subjectKind: 'opaque', limit: 100, windowMs: HOUR, retentionMs: DAY }),

  returnUploadDriverHour: policy({ scope: 'return-upload-driver-hour', subjectKind: 'opaque', limit: 10, windowMs: HOUR, retentionMs: DAY }),
  returnUploadDriverDay: policy({ scope: 'return-upload-driver-day', subjectKind: 'opaque', limit: 30, windowMs: DAY, retentionMs: 2 * DAY }),
  returnUploadIpHour: policy({ scope: 'return-upload-ip-hour', subjectKind: 'opaque', limit: 50, windowMs: HOUR, retentionMs: DAY }),
})

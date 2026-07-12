export type EmailTemplate =
  | 'VERIFICATION_CODE'
  | 'PASSWORD_RECOVERY'
  | 'ACCOUNT_EXISTS_NOTICE'
  | 'PASSWORD_CHANGED_NOTICE'

export type EmailEnvelope = {
  to: string
  subject: string
  html: string
  text: string
}

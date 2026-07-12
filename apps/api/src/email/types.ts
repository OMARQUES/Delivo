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

export type ChallengeEmailInput = {
  template: 'VERIFICATION_CODE' | 'PASSWORD_RECOVERY'
  recipient: string
  challengeId: string
  flowId: string
}

export type NoticeEmailInput = {
  template: 'ACCOUNT_EXISTS_NOTICE' | 'PASSWORD_CHANGED_NOTICE'
  recipient: string
  dedupeSubjectKey: string
}

export type DispatchSummary = {
  claimed: number
  sent: number
  retryScheduled: number
  cancelled: number
  failed: number
}

export type DispatchResult =
  | { status: 'SENT'; providerMessageId: string }
  | { status: 'RETRY_SCHEDULED'; nextAttemptAt: Date }
  | { status: 'CANCELLED' | 'FAILED'; failureClass: string }
  | { status: 'NOT_CLAIMED' }

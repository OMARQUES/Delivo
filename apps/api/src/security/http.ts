export type SecurityHttpCode =
  | 'RATE_LIMITED'
  | 'TURNSTILE_REQUIRED'
  | 'TURNSTILE_INVALID'
  | 'SECURITY_CHECK_UNAVAILABLE'
  | 'FLOW_INVALID_OR_EXPIRED'
  | 'CODE_INVALID_OR_EXPIRED'
  | 'PASSWORD_POLICY_REJECTED'
  | 'EMAIL_DELIVERY_UNAVAILABLE'

export class SecurityHttpError extends Error {
  constructor(
    public status: 400 | 403 | 429 | 503,
    public code: SecurityHttpCode,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'SecurityHttpError'
  }
}

export const RATE_LIMITED_MESSAGE = 'Muitas tentativas. Tente novamente mais tarde.'
export const SECURITY_CHECK_UNAVAILABLE_MESSAGE = 'Verificação de segurança temporariamente indisponível.'
export const TURNSTILE_INVALID_MESSAGE = 'Verificação de segurança inválida.'
export const TURNSTILE_REQUIRED_MESSAGE = 'Verificação de segurança necessária.'
export const FLOW_INVALID_OR_EXPIRED_MESSAGE = 'Fluxo inválido ou expirado.'
export const CODE_INVALID_OR_EXPIRED_MESSAGE = 'Código inválido ou expirado.'
export const PASSWORD_POLICY_REJECTED_MESSAGE = 'A senha não atende à política de segurança.'
export const EMAIL_DELIVERY_UNAVAILABLE_MESSAGE = 'Serviço de email temporariamente indisponível.'

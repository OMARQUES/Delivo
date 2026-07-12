export type SecurityHttpCode =
  | 'RATE_LIMITED'
  | 'TURNSTILE_REQUIRED'
  | 'TURNSTILE_INVALID'
  | 'SECURITY_CHECK_UNAVAILABLE'

export class SecurityHttpError extends Error {
  constructor(
    public status: 403 | 429 | 503,
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

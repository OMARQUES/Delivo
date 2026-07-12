import type { Db } from './db/client'
import type { LivePrincipal } from './services/security-session.service'

export type Env = {
  APP_ENV: 'local' | 'staging' | 'production'
  HYPERDRIVE: Hyperdrive
  BUCKET: R2Bucket
  JWT_SECRET: string
  RATE_LIMIT_HMAC_SECRET: string
  TURNSTILE_SECRET_KEY: string
  TURNSTILE_EXPECTED_HOSTNAMES: string
  ALLOWED_ORIGINS: string
  RESEND_API_KEY?: string
  AUTH_CODE_SECRET?: string
  EMAIL_FROM?: string
  PUBLIC_WEB_URL?: string
  EMAIL_ALLOWED_RECIPIENTS?: string
  FIREBASE_PROJECT_ID?: string
  FIREBASE_SERVICE_ACCOUNT?: string
  MP_ACCESS_TOKEN?: string
  MP_PUBLIC_KEY?: string
  MP_WEBHOOK_SECRET?: string
  /** Sandbox: força o email do comprador de TESTE (MP recusa emails reais com credencial de teste). Vazio em produção. */
  MP_TEST_PAYER_EMAIL?: string
  /** URL pública da API (webhook). Vazio em dev sem tunnel. */
  PUBLIC_API_URL?: string
}

export type AppContext = {
  Bindings: Env
  Variables: {
    db: Db
    requestId: string
    auth?: LivePrincipal
  }
}

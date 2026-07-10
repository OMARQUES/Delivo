import type { Db } from './db/client'
import type { AccessTokenPayload } from './lib/tokens'

export type Env = {
  HYPERDRIVE: Hyperdrive
  BUCKET: R2Bucket
  JWT_SECRET: string
  ALLOWED_ORIGINS: string
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
    auth?: AccessTokenPayload
  }
}

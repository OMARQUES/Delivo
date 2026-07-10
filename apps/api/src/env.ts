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

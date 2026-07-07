import type { Db } from './db/client'

export type Env = {
  HYPERDRIVE: Hyperdrive
}

export type AppContext = {
  Bindings: Env
  Variables: {
    db: Db
  }
}

import type { Db } from './client'

export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

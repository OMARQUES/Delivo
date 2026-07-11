import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { refreshTokens, stores, users } from '../db/schema'
import type { AccessTokenPayload } from '../lib/tokens'

export type LivePrincipal = {
  sub: string
  role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'
  name: string
  tokenVersion: number
  sessionFamilyId: string
  jti: string
  storeId: string | null
}

export class PrincipalError extends Error {
  constructor(
    public code: 'INVALID' | 'ACCOUNT_BLOCKED' | 'STORE_SUSPENDED',
    public status: 401 | 403,
  ) {
    super(code === 'INVALID' ? 'Sessão inválida ou expirada' : 'Acesso bloqueado')
  }
}

export async function resolveLivePrincipal(db: Db, p: AccessTokenPayload, now = new Date()) {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      status: users.status,
      tokenVersion: users.tokenVersion,
      storeId: stores.id,
      storeSecurityStatus: stores.securityStatus,
    })
    .from(users)
    .leftJoin(stores, eq(stores.ownerUserId, users.id))
    .where(eq(users.id, p.sub))
    .limit(1)

  if (!row) throw new PrincipalError('INVALID', 401)
  if (row.status !== 'ACTIVE') throw new PrincipalError('ACCOUNT_BLOCKED', 403)
  if (row.role !== p.role || row.tokenVersion !== p.ver) throw new PrincipalError('INVALID', 401)
  if (row.role === 'STORE' && row.storeSecurityStatus !== 'ACTIVE') {
    throw new PrincipalError('STORE_SUSPENDED', 403)
  }

  const [family] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(
      eq(refreshTokens.userId, row.id),
      eq(refreshTokens.familyId, p.sid),
      isNull(refreshTokens.revokedAt),
      gt(refreshTokens.expiresAt, now),
    ))
    .limit(1)
  if (!family) throw new PrincipalError('INVALID', 401)

  return {
    sub: row.id,
    role: row.role,
    name: row.name,
    tokenVersion: row.tokenVersion,
    sessionFamilyId: p.sid,
    jti: p.jti,
    storeId: row.storeId,
  } satisfies LivePrincipal
}

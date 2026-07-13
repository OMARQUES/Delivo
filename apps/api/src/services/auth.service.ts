import { and, eq, isNull, sql } from 'drizzle-orm'
import type { LoginInput } from '@delivery/shared/schemas'
import type { Db } from '../db/client'
import { authProviders, refreshTokens, stores, users } from '../db/schema'
import type { DbTx } from '../db/types'
import { verifyPassword } from '../lib/password'
import {
  generateRefreshToken,
  hashToken,
  refreshExpiry,
  signAccessToken,
} from '../lib/tokens'

const DUMMY_PASSWORD_HASH = 'pbkdf2$100000$BwcHBwcHBwcHBwcHBwcHBw$mdYCrNcRSwFlHgsgl9HK3YnDB2AaT90NWiNZ9jZFctg'

/** Erro de auth com status HTTP — rotas convertem em HTTPException. */
export class AuthError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 409 = 401,
  ) {
    super(message)
  }
}

/**
 * Detecta unique_violation (SQLSTATE 23505) do postgres.js.
 * Drizzle embrulha o erro em DrizzleQueryError, então o código do driver
 * fica em `e.cause.code` (o topo não tem `.code`).
 */
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.code
  const causeCode = (e as { cause?: { code?: string } })?.cause?.code
  return code === '23505' || causeCode === '23505'
}

export type PublicUser = {
  id: string
  name: string
  role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'
  status: 'ACTIVE' | 'PENDING_EMAIL' | 'PENDING_APPROVAL' | 'BLOCKED'
  phone: string | null
  email: string
}

export function toPublicUser(u: typeof users.$inferSelect): PublicUser {
  return { id: u.id, name: u.name, role: u.role, status: u.status, phone: u.phone, email: u.email }
}

export async function issueSessionTokens(
  tx: DbTx,
  user: PublicUser,
  tokenVersion: number,
  secret: string,
  now = new Date(),
  familyId: string = crypto.randomUUID(),
) {
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role, name: user.name, tokenVersion },
    secret,
    familyId,
    now,
  )
  const refresh = await generateRefreshToken()
  await tx.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refresh.hash,
    familyId,
    expiresAt: refreshExpiry(now),
  })
  return { accessToken, refreshToken: refresh.token }
}

async function issueTokens(db: Db, user: PublicUser, tokenVersion: number, secret: string, familyId?: string) {
  const resolvedFamilyId = familyId ?? crypto.randomUUID()
  return db.transaction((tx) => issueSessionTokens(tx, user, tokenVersion, secret, new Date(), resolvedFamilyId))
}

type AuthReader = Pick<Db, 'select'>

async function assertLoginable(db: AuthReader, user: typeof users.$inferSelect) {
  if (user.status === 'BLOCKED') throw new AuthError('Conta bloqueada — contate o suporte', 403)
  if (!user.emailVerifiedAt) throw new AuthError('Confirme seu email para entrar', 403)
  if (user.status === 'PENDING_EMAIL')
    throw new AuthError('Confirme seu email para entrar', 403)
  if (user.status === 'PENDING_APPROVAL')
    throw new AuthError('Cadastro aguardando aprovação do administrador', 403)
  if (user.role === 'STORE') {
    const [store] = await db
      .select({ securityStatus: stores.securityStatus })
      .from(stores)
      .where(eq(stores.ownerUserId, user.id))
      .limit(1)
    if (!store || store.securityStatus !== 'ACTIVE') {
      throw new AuthError('Loja suspensa ou encerrada', 403)
    }
  }
}

export async function loginUser(db: Db, input: LoginInput, secret: string) {
  const [credential] = await db
    .select({ user: users, passwordHash: authProviders.passwordHash })
    .from(users)
    .leftJoin(authProviders, and(
      eq(authProviders.userId, users.id),
      eq(authProviders.provider, 'PASSWORD'),
    ))
    .where(sql`lower(${users.email}) = ${input.email}`)
    .limit(1)
  if (!credential) {
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH)
    throw new AuthError('Credenciais inválidas', 401)
  }
  if (!credential.passwordHash) {
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH)
    throw new AuthError('Credenciais inválidas', 401)
  }
  if (!(await verifyPassword(input.password, credential.passwordHash)))
    throw new AuthError('Credenciais inválidas', 401)

  const user = credential.user
  await assertLoginable(db, user)
  const pub = toPublicUser(user)
  return { user: pub, ...(await issueTokens(db, pub, user.tokenVersion, secret)) }
}

export async function rotateRefreshToken(db: Db, rawToken: string, secret: string) {
  const hash = await hashToken(rawToken)
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1)
    if (!row) throw new AuthError('Sessão inválida', 401)

    const now = new Date()
    if (row.revokedAt || row.expiresAt < now) throw new AuthError('Sessão expirada', 401)

    const [claimed] = await tx
      .update(refreshTokens)
      .set({ usedAt: now })
      .where(and(
        eq(refreshTokens.id, row.id),
        isNull(refreshTokens.usedAt),
        isNull(refreshTokens.revokedAt),
      ))
      .returning({ id: refreshTokens.id })
    if (!claimed) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)))
      return null
    }

    const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1)
    if (!user) throw new AuthError('Sessão inválida', 401)
    await assertLoginable(tx, user)

    const pub = toPublicUser(user)
    const accessToken = await signAccessToken(
      { sub: pub.id, role: pub.role, name: pub.name, tokenVersion: user.tokenVersion },
      secret,
      row.familyId,
      now,
    )
    const replacement = await generateRefreshToken()
    await tx.insert(refreshTokens).values({
      userId: pub.id,
      tokenHash: replacement.hash,
      familyId: row.familyId,
      expiresAt: refreshExpiry(now),
    })
    return { user: pub, accessToken, refreshToken: replacement.token }
  })
  if (!result) throw new AuthError('Sessão inválida', 401)
  return result
}

export async function revokeRefreshToken(db: Db, rawToken: string) {
  const hash = await hashToken(rawToken)
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1)
  if (!row) return
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)))
}

import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { RegisterInput, LoginInput } from '@delivery/shared/schemas'
import { normalizePhone } from '@delivery/shared/schemas'
import type { Db } from '../db/client'
import { authProviders, refreshTokens, users } from '../db/schema'
import { hashPassword, verifyPassword } from '../lib/password'
import {
  generateRefreshToken,
  hashToken,
  refreshExpiry,
  signAccessToken,
} from '../lib/tokens'

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
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.code
  const causeCode = (e as { cause?: { code?: string } })?.cause?.code
  return code === '23505' || causeCode === '23505'
}

export type PublicUser = {
  id: string
  name: string
  role: 'CUSTOMER' | 'STORE' | 'DRIVER' | 'ADMIN'
  status: 'ACTIVE' | 'PENDING' | 'BLOCKED'
  phone: string | null
  email: string | null
  tokenVersion: number
}

function toPublic(u: typeof users.$inferSelect): PublicUser {
  return {
    id: u.id, name: u.name, role: u.role, status: u.status, phone: u.phone, email: u.email,
    tokenVersion: u.tokenVersion,
  }
}

async function issueTokens(db: Db, user: PublicUser, secret: string, familyId?: string) {
  const resolvedFamilyId = familyId ?? crypto.randomUUID()
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role, name: user.name, tokenVersion: user.tokenVersion },
    secret,
    resolvedFamilyId,
  )
  const { token, hash } = await generateRefreshToken()
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hash,
    familyId: resolvedFamilyId,
    expiresAt: refreshExpiry(),
  })
  return { accessToken, refreshToken: token }
}

export async function registerUser(db: Db, input: RegisterInput, secret: string) {
  const email = input.email ? input.email.trim().toLowerCase() : null
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        eq(users.phone, input.phone),
        email ? sql`lower(${users.email}) = ${email}` : sql`false`,
      ),
    )
    .limit(1)
  if (existing.length > 0) throw new AuthError('Telefone ou email já cadastrado', 409)

  const status = input.role === 'DRIVER' ? ('PENDING' as const) : ('ACTIVE' as const)
  let user: typeof users.$inferSelect | undefined
  try {
    const rows = await db
      .insert(users)
      .values({
        name: input.name,
        phone: input.phone,
        email,
        role: input.role,
        status,
        termsAcceptedAt: new Date(),
      })
      .returning()
    user = rows[0]
  } catch (e) {
    // Rede de segurança p/ corrida (TOCTOU): pre-check + INSERT não é atômico.
    if (isUniqueViolation(e)) throw new AuthError('Telefone ou email já cadastrado', 409)
    throw e
  }
  if (!user) throw new AuthError('Falha ao criar usuário', 400)

  await db.insert(authProviders).values({
    userId: user.id,
    provider: 'PASSWORD',
    passwordHash: await hashPassword(input.password),
  })

  const pub = toPublic(user)
  if (status === 'PENDING') return { user: pub, accessToken: null, refreshToken: null }
  return { user: pub, ...(await issueTokens(db, pub, secret)) }
}

function assertLoginable(user: typeof users.$inferSelect) {
  if (user.status === 'BLOCKED') throw new AuthError('Conta bloqueada — contate o suporte', 403)
  if (user.status === 'PENDING')
    throw new AuthError('Cadastro aguardando aprovação do administrador', 403)
}

export async function loginUser(db: Db, input: LoginInput, secret: string) {
  const raw = input.identifier.trim()
  const asEmail = raw.toLowerCase()
  const asPhone = normalizePhone(raw)
  const [user] = await db
    .select()
    .from(users)
    .where(
      or(
        sql`lower(${users.email}) = ${asEmail}`,
        asPhone.length >= 10 ? eq(users.phone, asPhone) : sql`false`,
      ),
    )
    .limit(1)
  if (!user) throw new AuthError('Credenciais inválidas', 401)

  const [provider] = await db
    .select()
    .from(authProviders)
    .where(and(eq(authProviders.userId, user.id), eq(authProviders.provider, 'PASSWORD')))
    .limit(1)
  if (!provider?.passwordHash) throw new AuthError('Credenciais inválidas', 401)
  if (!(await verifyPassword(input.password, provider.passwordHash)))
    throw new AuthError('Credenciais inválidas', 401)

  assertLoginable(user)
  const pub = toPublic(user)
  return { user: pub, ...(await issueTokens(db, pub, secret)) }
}

export async function rotateRefreshToken(db: Db, rawToken: string, secret: string) {
  const hash = await hashToken(rawToken)
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1)
  if (!row) throw new AuthError('Sessão inválida', 401)

  const now = new Date()
  if (row.revokedAt || row.expiresAt < now) throw new AuthError('Sessão expirada', 401)
  if (row.usedAt) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)))
    throw new AuthError('Sessão inválida', 401)
  }

  const updated = await db
    .update(refreshTokens)
    .set({ usedAt: now })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.usedAt)))
    .returning({ id: refreshTokens.id })
  if (updated.length === 0) throw new AuthError('Sessão inválida', 401)

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1)
  if (!user) throw new AuthError('Sessão inválida', 401)
  assertLoginable(user)

  const pub = toPublic(user)
  return { user: pub, ...(await issueTokens(db, pub, secret, row.familyId)) }
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

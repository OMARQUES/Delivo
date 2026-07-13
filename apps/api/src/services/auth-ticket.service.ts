import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  authActionTickets,
  authActionTicketPurpose,
  authChallenges,
  type UserRole,
  users,
} from '../db/schema'
import type { DbTx } from '../db/types'
import { createActionTicket, hashActionTicket } from '../security/auth-code'

const TICKET_TTL_MS = 10 * 60_000

export type ActionTicketPurpose = (typeof authActionTicketPurpose.enumValues)[number]
export type AuthActionTicket = typeof authActionTickets.$inferSelect

export type IssueTicketInput = {
  userId: string
  purpose: ActionTicketPurpose
  challengeId: string
  authCodeSecret: string
  now?: Date
}

export type ClaimTicketInput = {
  token: string
  purpose: ActionTicketPurpose
  authCodeSecret: string
  now?: Date
}

export class ActionTicketError extends Error {
  readonly code = 'INVALID_OR_EXPIRED' as const

  constructor() {
    super('Action ticket invalid or expired')
    this.name = 'ActionTicketError'
  }
}

function invalidTicket(): never {
  throw new ActionTicketError()
}

function validContext(secret: string, now: Date): boolean {
  return Boolean(secret.trim()) && Number.isFinite(now.getTime())
}

function challengePurposeFor(ticketPurpose: ActionTicketPurpose) {
  return ticketPurpose === 'PASSWORD_RESET' ? 'PASSWORD_RECOVERY' : 'STORE_ACTIVATION'
}

export async function issueActionTicket(
  tx: DbTx,
  input: IssueTicketInput,
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date()
  if (!validContext(input.authCodeSecret, now) || !input.userId || !input.challengeId) invalidTicket()

  const [challenge] = await tx
    .select({ id: authChallenges.id })
    .from(authChallenges)
    .where(and(
      eq(authChallenges.id, input.challengeId),
      eq(authChallenges.userId, input.userId),
      eq(authChallenges.purpose, challengePurposeFor(input.purpose)),
      isNotNull(authChallenges.consumedAt),
      isNull(authChallenges.invalidatedAt),
      gt(authChallenges.expiresAt, now),
    ))
    .for('update')
  if (!challenge) invalidTicket()

  const [existing] = await tx
    .select({ id: authActionTickets.id })
    .from(authActionTickets)
    .where(and(
      eq(authActionTickets.challengeId, challenge.id),
      eq(authActionTickets.purpose, input.purpose),
    ))
    .limit(1)
  if (existing) invalidTicket()

  const material = await createActionTicket(input.authCodeSecret)
  const expiresAt = new Date(now.getTime() + TICKET_TTL_MS)
  const [created] = await tx.insert(authActionTickets).values({
    userId: input.userId,
    purpose: input.purpose,
    challengeId: challenge.id,
    tokenHash: material.hash,
    expiresAt,
    createdAt: now,
  }).returning({ id: authActionTickets.id })
  if (!created) throw new Error('Action ticket was not created')
  return { token: material.token, expiresAt }
}

function ticketContext(input: ClaimTicketInput): { now: Date; tokenHash: Promise<string> } {
  const now = input.now ?? new Date()
  if (!validContext(input.authCodeSecret, now) || !input.token) invalidTicket()
  return { now, tokenHash: hashActionTicket(input.authCodeSecret, input.token) }
}

export async function inspectActionTicket(
  db: Db,
  input: ClaimTicketInput,
): Promise<AuthActionTicket & { role: UserRole }> {
  const { now, tokenHash } = ticketContext(input)
  const [row] = await db
    .select({ ticket: authActionTickets, role: users.role })
    .from(authActionTickets)
    .innerJoin(users, eq(users.id, authActionTickets.userId))
    .where(and(
      eq(authActionTickets.tokenHash, await tokenHash),
      eq(authActionTickets.purpose, input.purpose),
      isNull(authActionTickets.consumedAt),
      gt(authActionTickets.expiresAt, now),
    ))
    .limit(1)
  if (!row) invalidTicket()
  return { ...row.ticket, role: row.role }
}

export async function claimActionTicket(
  tx: DbTx,
  input: ClaimTicketInput,
): Promise<AuthActionTicket> {
  const { now, tokenHash } = ticketContext(input)
  const [claimed] = await tx
    .update(authActionTickets)
    .set({ consumedAt: now })
    .where(and(
      eq(authActionTickets.tokenHash, await tokenHash),
      eq(authActionTickets.purpose, input.purpose),
      isNull(authActionTickets.consumedAt),
      gt(authActionTickets.expiresAt, now),
    ))
    .returning()
  if (!claimed) invalidTicket()
  return claimed
}

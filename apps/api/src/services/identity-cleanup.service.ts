import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'

const MAX_CLEANUP_BATCH = 500
const DAY_MS = 24 * 60 * 60_000

export type CleanupSummary = {
  pendingRegistrations: number
  challenges: number
  tickets: number
  outbox: number
  events: number
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_CLEANUP_BATCH
  return Math.min(MAX_CLEANUP_BATCH, Math.max(0, Math.floor(limit)))
}

function timestamp(value: Date): string {
  return value.toISOString()
}

export async function cleanupIdentityState(
  db: Db,
  now = new Date(),
  limit = MAX_CLEANUP_BATCH,
): Promise<CleanupSummary> {
  const batch = boundedLimit(limit)
  const summary: CleanupSummary = {
    pendingRegistrations: 0,
    challenges: 0,
    tickets: 0,
    outbox: 0,
    events: 0,
  }
  if (batch === 0) return summary

  const nowParam = timestamp(now)
  const oneDayAgo = timestamp(new Date(now.getTime() - DAY_MS))
  const sevenDaysAgo = timestamp(new Date(now.getTime() - 7 * DAY_MS))
  const thirtyDaysAgo = timestamp(new Date(now.getTime() - 30 * DAY_MS))
  const ninetyDaysAgo = timestamp(new Date(now.getTime() - 90 * DAY_MS))

  const cancelledOutbox = await db.execute<{ id: string }>(sql`
    with stale as (
      select outbox.id
      from email_outbox as outbox
      where outbox.status in ('PENDING', 'PROCESSING')
        and outbox.template in ('VERIFICATION_CODE', 'PASSWORD_RECOVERY')
        and (
          outbox.challenge_id is null
          or not exists (
            select 1
            from auth_challenges as challenge
            left join pending_registrations as pending
              on pending.id = challenge.pending_registration_id
            where challenge.id = outbox.challenge_id
              and challenge.consumed_at is null
              and challenge.invalidated_at is null
              and challenge.attempt_count < 5
              and challenge.expires_at > ${nowParam}::timestamptz
              and (
                challenge.pending_registration_id is null
                or (
                  pending.expires_at > ${nowParam}::timestamptz
                  and pending.consumed_at is null
                )
              )
          )
        )
      order by outbox.next_attempt_at asc, outbox.id asc
      limit ${batch}
      for update skip locked
    )
    update email_outbox as outbox
    set status = 'CANCELLED',
        failure_class = 'CHALLENGE_INACTIVE',
        leased_until = null,
        updated_at = ${nowParam}::timestamptz
    from stale
    where outbox.id = stale.id
    returning outbox.id
  `)
  summary.outbox += cancelledOutbox.length

  const outboxDeleteLimit = batch - summary.outbox
  if (outboxDeleteLimit > 0) {
    const deletedOutbox = await db.execute<{ id: string }>(sql`
      with doomed as (
        select id
        from email_outbox
        where (
          status = 'SENT'
          and coalesce(sent_at, updated_at, created_at) <= ${sevenDaysAgo}::timestamptz
        ) or (
          status = 'CANCELLED'
          and updated_at <= ${sevenDaysAgo}::timestamptz
        ) or (
          status = 'FAILED'
          and updated_at <= ${thirtyDaysAgo}::timestamptz
        )
        order by updated_at asc, id asc
        limit ${outboxDeleteLimit}
      )
      delete from email_outbox as outbox
      using doomed
      where outbox.id = doomed.id
      returning outbox.id
    `)
    summary.outbox += deletedOutbox.length
  }

  const deletedTickets = await db.execute<{ id: string }>(sql`
    with doomed as (
      select id
      from auth_action_tickets
      where expires_at <= ${oneDayAgo}::timestamptz
        or consumed_at <= ${oneDayAgo}::timestamptz
      order by expires_at asc, id asc
      limit ${batch}
    )
    delete from auth_action_tickets as ticket
    using doomed
    where ticket.id = doomed.id
    returning ticket.id
  `)
  summary.tickets = deletedTickets.length

  const deletedChallenges = await db.execute<{ id: string }>(sql`
    with doomed as (
      select id
      from auth_challenges
      where expires_at <= ${oneDayAgo}::timestamptz
        or consumed_at <= ${oneDayAgo}::timestamptz
        or invalidated_at <= ${oneDayAgo}::timestamptz
      order by expires_at asc, id asc
      limit ${batch}
    )
    delete from auth_challenges as challenge
    using doomed
    where challenge.id = doomed.id
    returning challenge.id
  `)
  summary.challenges = deletedChallenges.length

  const deletedPending = await db.execute<{ id: string }>(sql`
    with doomed as (
      select id
      from pending_registrations
      where expires_at <= ${nowParam}::timestamptz
        or consumed_at <= ${oneDayAgo}::timestamptz
      order by expires_at asc, id asc
      limit ${batch}
    )
    delete from pending_registrations as pending
    using doomed
    where pending.id = doomed.id
    returning pending.id
  `)
  summary.pendingRegistrations = deletedPending.length

  const deletedEvents = await db.execute<{ id: string }>(sql`
    with doomed as (
      select id
      from identity_security_events
      where created_at <= ${ninetyDaysAgo}::timestamptz
      order by created_at asc, id asc
      limit ${batch}
    )
    delete from identity_security_events as event
    using doomed
    where event.id = doomed.id
    returning event.id
  `)
  summary.events = deletedEvents.length

  return summary
}

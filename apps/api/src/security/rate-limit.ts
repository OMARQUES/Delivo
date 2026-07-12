import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../db/schema'
import { hashRateLimitKey, type RateLimitSubjectKind } from './rate-limit-key'

export type RateLimitPolicy = Readonly<{
  scope: string
  subjectKind: RateLimitSubjectKind
  limit: number
  windowMs: number
  retentionMs: number
  cooldownMs?: number
}>

export type RateLimitDecision = {
  allowed: boolean
  count: number
  limit: number
  retryAfterSeconds: number
  blockedUntil: Date | null
}

export interface RateLimiter {
  consume(policy: RateLimitPolicy, subject: string, now?: Date): Promise<RateLimitDecision>
  inspect(policy: RateLimitPolicy, subject: string, now?: Date): Promise<RateLimitDecision>
  clear(policies: readonly RateLimitPolicy[], subject: string): Promise<void>
}

type DbClient = Pick<PostgresJsDatabase<typeof schema>, 'execute'>

type BucketRow = {
  count: number
  blockedUntil: Date | string | null
  wasBlocked: boolean
}

const NEVER = sql`'-infinity'::timestamptz`

function windowStartFor(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

function ceilSeconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000))
}

function timestampParam(value: Date | null): string | null {
  return value?.toISOString() ?? null
}

function parseBlockedUntil(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '-infinity') return null
  return value instanceof Date ? value : new Date(value)
}

function decide(policy: RateLimitPolicy, row: BucketRow | undefined, now: Date, windowStart: Date): RateLimitDecision {
  const count = row?.count ?? 0
  const blockedUntil = parseBlockedUntil(row?.blockedUntil)
  const blocked = blockedUntil !== null && blockedUntil.getTime() > now.getTime()
  const overLimit = count > policy.limit
  const allowed = !row?.wasBlocked && !overLimit

  let retryAfterSeconds = 0
  if (!allowed) {
    if (blocked) {
      retryAfterSeconds = ceilSeconds(blockedUntil.getTime() - now.getTime())
    } else {
      retryAfterSeconds = ceilSeconds(windowStart.getTime() + policy.windowMs - now.getTime())
    }
  }

  return { allowed, count, limit: policy.limit, retryAfterSeconds, blockedUntil }
}

export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly db: DbClient, private readonly secret: string) {}

  async consume(policy: RateLimitPolicy, subject: string, now = new Date()): Promise<RateLimitDecision> {
    const keyHash = await hashRateLimitKey(this.secret, policy.scope, subject, policy.subjectKind)
    const windowStart = windowStartFor(now, policy.windowMs)
    const baseExpiresAt = new Date(windowStart.getTime() + policy.retentionMs)
    const cooldownUntil = policy.cooldownMs === undefined ? null : new Date(now.getTime() + policy.cooldownMs)
    const nowParam = timestampParam(now)
    const windowStartParam = timestampParam(windowStart)
    const baseExpiresAtParam = timestampParam(baseExpiresAt)
    const cooldownUntilParam = timestampParam(cooldownUntil)

    const rows = await this.db.execute(sql`
      with prior_block as (
        select max(blocked_until) as blocked_until
        from rate_limit_buckets
        where scope = ${policy.scope}
          and key_hash = ${keyHash}
          and blocked_until > ${nowParam}::timestamptz
      ),
      inserted as (
        insert into rate_limit_buckets (
          scope,
          key_hash,
          window_start,
          count,
          blocked_until,
          expires_at
        )
        select
          ${policy.scope},
          ${keyHash},
          ${windowStartParam}::timestamptz,
          1,
          case
            when prior_block.blocked_until is not null then prior_block.blocked_until
            when ${cooldownUntilParam}::timestamptz is not null and 1 >= ${policy.limit}
              then ${cooldownUntilParam}::timestamptz
            else prior_block.blocked_until
          end,
          greatest(
            ${baseExpiresAtParam}::timestamptz,
            coalesce(
              case
                when prior_block.blocked_until is not null then prior_block.blocked_until
                when ${cooldownUntilParam}::timestamptz is not null and 1 >= ${policy.limit}
                  then ${cooldownUntilParam}::timestamptz
                else prior_block.blocked_until
              end,
              ${baseExpiresAtParam}::timestamptz
            )
          )
        from prior_block
        on conflict (scope, key_hash, window_start) do update set
          count = rate_limit_buckets.count + 1,
          blocked_until = case
            when greatest(
              coalesce(rate_limit_buckets.blocked_until, ${NEVER}),
              coalesce((select blocked_until from prior_block), ${NEVER})
            ) > ${nowParam}::timestamptz
              then greatest(
                coalesce(rate_limit_buckets.blocked_until, ${NEVER}),
                coalesce((select blocked_until from prior_block), ${NEVER})
              )
            when ${cooldownUntilParam}::timestamptz is not null
              and rate_limit_buckets.count + 1 >= ${policy.limit}
              then ${cooldownUntilParam}::timestamptz
            else nullif(
              greatest(
                coalesce(rate_limit_buckets.blocked_until, ${NEVER}),
                coalesce((select blocked_until from prior_block), ${NEVER})
              ),
              ${NEVER}
            )
          end,
          expires_at = greatest(
            ${baseExpiresAtParam}::timestamptz,
            coalesce(
              case
                when greatest(
                  coalesce(rate_limit_buckets.blocked_until, ${NEVER}),
                  coalesce((select blocked_until from prior_block), ${NEVER})
                ) > ${nowParam}::timestamptz
                  then greatest(
                    coalesce(rate_limit_buckets.blocked_until, ${NEVER}),
                    coalesce((select blocked_until from prior_block), ${NEVER})
                  )
                when ${cooldownUntilParam}::timestamptz is not null
                  and rate_limit_buckets.count + 1 >= ${policy.limit}
                  then ${cooldownUntilParam}::timestamptz
                else nullif(
                  greatest(
                    coalesce(rate_limit_buckets.blocked_until, ${NEVER}),
                    coalesce((select blocked_until from prior_block), ${NEVER})
                  ),
                  ${NEVER}
                )
              end,
              ${baseExpiresAtParam}::timestamptz
            )
          )
        returning
          count,
          blocked_until as "blockedUntil",
          coalesce((select blocked_until from prior_block) > ${nowParam}::timestamptz, false) as "wasBlocked"
      )
      select count, "blockedUntil", "wasBlocked" from inserted
    `) as unknown as BucketRow[]

    return decide(policy, rows[0], now, windowStart)
  }

  async inspect(policy: RateLimitPolicy, subject: string, now = new Date()): Promise<RateLimitDecision> {
    const keyHash = await hashRateLimitKey(this.secret, policy.scope, subject, policy.subjectKind)
    const windowStart = windowStartFor(now, policy.windowMs)
    const nowParam = timestampParam(now)
    const windowStartParam = timestampParam(windowStart)
    const rows = await this.db.execute(sql`
      with current_bucket as (
        select count, blocked_until
        from rate_limit_buckets
        where scope = ${policy.scope}
          and key_hash = ${keyHash}
          and window_start = ${windowStartParam}::timestamptz
      ),
      prior_block as (
        select max(blocked_until) as blocked_until
        from rate_limit_buckets
        where scope = ${policy.scope}
          and key_hash = ${keyHash}
          and blocked_until > ${nowParam}::timestamptz
      )
      select
        coalesce((select count from current_bucket), 0) as count,
        greatest(
          coalesce((select blocked_until from current_bucket), ${NEVER}),
          coalesce((select blocked_until from prior_block), ${NEVER})
        ) as "blockedUntil",
        coalesce((select blocked_until from prior_block) > ${nowParam}::timestamptz, false) as "wasBlocked"
    `) as unknown as BucketRow[]
    return decide(policy, rows[0], now, windowStart)
  }

  async clear(policies: readonly RateLimitPolicy[], subject: string): Promise<void> {
    if (policies.length === 0) return
    const keys = await Promise.all(policies.map(async (policy) => ({
      scope: policy.scope,
      keyHash: await hashRateLimitKey(this.secret, policy.scope, subject, policy.subjectKind),
    })))

    await this.db.execute(sql`
      delete from rate_limit_buckets
      where (scope, key_hash) in (${sql.join(
        keys.map((key) => sql`(${key.scope}, ${key.keyHash})`),
        sql`, `,
      )})
    `)
  }
}

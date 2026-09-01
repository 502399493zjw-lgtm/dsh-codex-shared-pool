/** Per-Team-API-key failure containment shared by the Responses gateway. */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

const TRAILING_WINDOW_MS = 60_000

export type TeamTrafficResult = 'success' | 'failure' | 'neutral'

export type TeamTrafficGuardReason =
  | 'circuit_open'
  | 'concurrency'
  | 'rate_limit'
  | 'revoked'
  | 'lease_expired'

export interface TeamTrafficLease {
  renew(): Promise<void>
  finish(result: TeamTrafficResult): Promise<void>
}

export interface TeamTrafficGuard {
  acquire(keyId: string): Promise<TeamTrafficLease>
}

export interface TeamTrafficGuardOptions {
  readonly requestsPerMinute: number
  readonly maxConcurrency: number
  readonly failureThreshold: number
  readonly circuitOpenMs: number
  readonly leaseTtlMs: number
  readonly now?: () => number
  readonly id?: () => string
}

export class TeamTrafficGuardError extends Error {
  readonly code = 'TEAM_TRAFFIC_GUARD' as const

  constructor(
    message: string,
    readonly reason: TeamTrafficGuardReason,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

interface MemoryTrafficLeaseState {
  expiresAt: number
}

interface MemoryTrafficState {
  timestamps: number[]
  leases: Map<string, MemoryTrafficLeaseState>
  consecutiveFailures: number
  openUntil: number
}

/** Process-local fallback used when the Team store itself is process-local. */
export class MemoryTeamTrafficGuard implements TeamTrafficGuard {
  private readonly states = new Map<string, MemoryTrafficState>()
  private readonly options: Required<TeamTrafficGuardOptions>

  constructor(options: TeamTrafficGuardOptions) {
    this.options = {
      requestsPerMinute: positiveInteger(options.requestsPerMinute, 'requestsPerMinute'),
      maxConcurrency: positiveInteger(options.maxConcurrency, 'maxConcurrency'),
      failureThreshold: positiveInteger(options.failureThreshold, 'failureThreshold'),
      circuitOpenMs: positiveInteger(options.circuitOpenMs, 'circuitOpenMs'),
      leaseTtlMs: positiveInteger(options.leaseTtlMs, 'leaseTtlMs'),
      now: options.now ?? Date.now,
      id: options.id ?? randomUUID,
    }
  }

  async acquire(keyId: string): Promise<TeamTrafficLease> {
    const normalizedKeyId = nonEmptyKeyId(keyId)
    const now = this.options.now()
    const state = this.states.get(normalizedKeyId) ?? {
      timestamps: [],
      leases: new Map(),
      consecutiveFailures: 0,
      openUntil: 0,
    }
    this.states.set(normalizedKeyId, state)
    state.timestamps = state.timestamps.filter(timestamp => timestamp > now - TRAILING_WINDOW_MS)
    for (const [leaseId, lease] of state.leases) {
      if (lease.expiresAt <= now) state.leases.delete(leaseId)
    }
    if (state.openUntil > now) {
      throw limited(
        'Team API key circuit is temporarily open',
        'circuit_open',
        retrySeconds(state.openUntil - now),
      )
    }
    if (state.leases.size >= this.options.maxConcurrency) {
      throw limited('Team API key concurrency limit reached', 'concurrency', 1)
    }
    if (state.timestamps.length >= this.options.requestsPerMinute) {
      const oldest = state.timestamps[0] ?? now
      throw limited(
        'Team API key rate limit reached',
        'rate_limit',
        retrySeconds(oldest + TRAILING_WINDOW_MS - now),
      )
    }

    const leaseId = this.options.id()
    const leaseState = { expiresAt: now + this.options.leaseTtlMs }
    state.timestamps.push(now)
    state.leases.set(leaseId, leaseState)
    let finished = false

    return {
      renew: async () => {
        if (finished || state.leases.get(leaseId) !== leaseState || leaseState.expiresAt <= this.options.now()) {
          state.leases.delete(leaseId)
          throw expiredLease()
        }
        leaseState.expiresAt = this.options.now() + this.options.leaseTtlMs
      },
      finish: async (result) => {
        if (finished) return
        finished = true
        state.leases.delete(leaseId)
        if (result === 'success') state.consecutiveFailures = 0
        if (result === 'failure') {
          state.consecutiveFailures += 1
          if (state.consecutiveFailures >= this.options.failureThreshold) {
            state.openUntil = this.options.now() + this.options.circuitOpenMs
            state.consecutiveFailures = 0
          }
        }
      },
    }
  }
}

export interface PostgresTeamTrafficGuardOptions extends TeamTrafficGuardOptions {
  readonly pool: Pool
}

interface PostgresTrafficStateRow extends QueryResultRow {
  consecutive_failures: number
  open_until: string | number
}

interface PostgresTrafficCountRow extends QueryResultRow {
  count: string | number
  oldest?: string | number | null
}

/** PostgreSQL-backed guard shared by every Host replica using the same Team store. */
export class PostgresTeamTrafficGuard implements TeamTrafficGuard {
  private readonly pool: Pool
  private readonly options: Required<TeamTrafficGuardOptions>

  constructor(options: PostgresTeamTrafficGuardOptions) {
    this.pool = options.pool
    this.options = {
      requestsPerMinute: positiveInteger(options.requestsPerMinute, 'requestsPerMinute'),
      maxConcurrency: positiveInteger(options.maxConcurrency, 'maxConcurrency'),
      failureThreshold: positiveInteger(options.failureThreshold, 'failureThreshold'),
      circuitOpenMs: positiveInteger(options.circuitOpenMs, 'circuitOpenMs'),
      leaseTtlMs: positiveInteger(options.leaseTtlMs, 'leaseTtlMs'),
      now: options.now ?? Date.now,
      id: options.id ?? randomUUID,
    }
  }

  async acquire(keyId: string): Promise<TeamTrafficLease> {
    const normalizedKeyId = nonEmptyKeyId(keyId)
    const now = this.options.now()
    const leaseId = this.options.id()
    await this.transaction(async (client) => {
      const key = await client.query<{ revoked_at: string | number | null }>(
        'SELECT revoked_at FROM team_api_keys WHERE id = $1 FOR SHARE',
        [normalizedKeyId],
      )
      if (key.rows[0] === undefined || key.rows[0].revoked_at !== null) throw revokedKey()
      await client.query(`
        INSERT INTO team_api_key_traffic_state
          (key_id, consecutive_failures, open_until, updated_at)
        VALUES ($1, 0, 0, $2)
        ON CONFLICT (key_id) DO NOTHING
      `, [normalizedKeyId, now])
      const stateResult = await client.query<PostgresTrafficStateRow>(`
        SELECT consecutive_failures, open_until
        FROM team_api_key_traffic_state
        WHERE key_id = $1
        FOR UPDATE
      `, [normalizedKeyId])
      const state = stateResult.rows[0]
      if (state === undefined) throw new Error('Team API key traffic state is unavailable')
      await client.query(`
        DELETE FROM team_api_key_traffic_leases
        WHERE key_id = $1 AND started_at <= $2
          AND (finished_at IS NOT NULL OR expires_at <= $3)
      `, [normalizedKeyId, now - TRAILING_WINDOW_MS, now])

      const rpmResult = await client.query<PostgresTrafficCountRow>(`
        SELECT COUNT(*) AS count, MIN(started_at) AS oldest
        FROM team_api_key_traffic_leases
        WHERE key_id = $1 AND started_at > $2
      `, [normalizedKeyId, now - TRAILING_WINDOW_MS])
      const concurrencyResult = await client.query<PostgresTrafficCountRow>(`
        SELECT COUNT(*) AS count
        FROM team_api_key_traffic_leases
        WHERE key_id = $1 AND finished_at IS NULL AND expires_at > $2
      `, [normalizedKeyId, now])
      const openUntil = storedInteger(state.open_until, 'open_until')
      if (openUntil > now) {
        throw limited('Team API key circuit is temporarily open', 'circuit_open', retrySeconds(openUntil - now))
      }
      if (storedInteger(concurrencyResult.rows[0]?.count ?? 0, 'concurrency count') >= this.options.maxConcurrency) {
        throw limited('Team API key concurrency limit reached', 'concurrency', 1)
      }
      const rpm = rpmResult.rows[0]
      if (storedInteger(rpm?.count ?? 0, 'RPM count') >= this.options.requestsPerMinute) {
        const oldest = storedInteger(rpm?.oldest ?? now, 'oldest request timestamp')
        throw limited('Team API key rate limit reached', 'rate_limit', retrySeconds(oldest + TRAILING_WINDOW_MS - now))
      }
      await client.query(`
        INSERT INTO team_api_key_traffic_leases
          (id, key_id, started_at, expires_at, finished_at, result)
        VALUES ($1, $2, $3, $4, NULL, NULL)
      `, [leaseId, normalizedKeyId, now, now + this.options.leaseTtlMs])
    })

    let finished = false
    return {
      renew: async () => {
        if (finished) throw expiredLease()
        const renewalTime = this.options.now()
        const result = await this.pool.query(`
          UPDATE team_api_key_traffic_leases
          SET expires_at = $1
          WHERE id = $2 AND key_id = $3
            AND finished_at IS NULL AND expires_at > $4
        `, [renewalTime + this.options.leaseTtlMs, leaseId, normalizedKeyId, renewalTime])
        if (result.rowCount !== 1) throw expiredLease()
      },
      finish: async (result) => {
        if (finished) return
        const didFinish = await this.finishLease(normalizedKeyId, leaseId, result)
        finished = finished || didFinish
      },
    }
  }

  private async finishLease(keyId: string, leaseId: string, result: TeamTrafficResult): Promise<boolean> {
    return this.transaction(async (client) => {
      const stateResult = await client.query<PostgresTrafficStateRow>(`
        SELECT consecutive_failures, open_until
        FROM team_api_key_traffic_state
        WHERE key_id = $1
        FOR UPDATE
      `, [keyId])
      const state = stateResult.rows[0]
      if (state === undefined) return true
      const now = this.options.now()
      const completion = await client.query(`
        UPDATE team_api_key_traffic_leases
        SET finished_at = $1, result = $2
        WHERE id = $3 AND key_id = $4 AND finished_at IS NULL
        RETURNING id
      `, [now, result, leaseId, keyId])
      if (completion.rowCount !== 1) return true

      let consecutiveFailures = state.consecutive_failures
      let openUntil = storedInteger(state.open_until, 'open_until')
      if (result === 'success') consecutiveFailures = 0
      if (result === 'failure') {
        consecutiveFailures += 1
        if (consecutiveFailures >= this.options.failureThreshold) {
          consecutiveFailures = 0
          openUntil = now + this.options.circuitOpenMs
        }
      }
      await client.query(`
        UPDATE team_api_key_traffic_state
        SET consecutive_failures = $1, open_until = $2, updated_at = $3
        WHERE key_id = $4
      `, [consecutiveFailures, openUntil, now, keyId])
      return true
    })
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

function limited(message: string, reason: TeamTrafficGuardReason, retryAfterSeconds: number): TeamTrafficGuardError {
  return new TeamTrafficGuardError(message, reason, 429, retryAfterSeconds)
}

function expiredLease(): TeamTrafficGuardError {
  return new TeamTrafficGuardError('Team API key traffic lease expired', 'lease_expired', 503)
}

function revokedKey(): TeamTrafficGuardError {
  return new TeamTrafficGuardError('Team API key is revoked', 'revoked', 401)
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000))
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe integer`)
  return value
}

function nonEmptyKeyId(value: string): string {
  const keyId = value.trim()
  if (keyId.length === 0 || keyId.length > 240) throw new Error('keyId must be between 1 and 240 characters')
  return keyId
}

function storedInteger(value: string | number, field: string): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(result)) throw new Error(`stored ${field} is invalid`)
  return result
}

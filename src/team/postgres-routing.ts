/** PostgreSQL-backed Team admission leases for multi-Host coordination. */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import {
  TeamRouteCapacityError,
} from './routing.ts'
import type {
  TeamQuotaSnapshot,
  TeamRequestAdmissionRouter,
  TeamRouteAccountInspection,
  TeamRouteCandidate,
  TeamRouteLease,
  TeamRouteRequest,
  TeamRouteSelection,
  TeamRouteSettleResult,
  TeamRouteSource,
} from './routing.ts'
import type { TeamContributionAccountSummary, TeamContributionStatus, TeamStatus } from './types.ts'
import { safeTeamErrorMessage } from './safe-message.ts'

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000
const DEFAULT_DRAIN_POLL_MS = 100
const MAX_SESSION_ID_LENGTH = 240
const MAX_MODEL_NAME_LENGTH = 120
const MAX_CANDIDATES = 128

export interface PostgresTeamRequestRouterOptions {
  readonly pool: Pool
  readonly now?: () => number
  readonly id?: () => string
  /** Active requests must renew before this deadline to keep their slot. */
  readonly leaseTtlMs?: number
  readonly drainPollMs?: number
}

interface ContributionRoutingRow extends QueryResultRow {
  id: string
  team_id: string
  owner_member_id: string
  label: string
  status: TeamContributionStatus
  personal_reserve_percent: number
  max_shared_requests_per_window: number | null
  max_shared_concurrency: number
  allowed_models: unknown
  created_at: string | number
  updated_at: string | number
  last_error: string | null
}

interface TeamStatusRow extends QueryResultRow {
  status: TeamStatus
}

interface BindingRow extends QueryResultRow {
  account_id: string
}

interface CountRow extends QueryResultRow {
  count: string | number
}

interface LeaseRow extends QueryResultRow {
  id: string
  team_id: string
  consumer_member_id: string
  account_id: string
  session_id: string
  model: string
  source: TeamRouteSource
  is_shared: boolean
  status: 'in_progress' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  reset_at: string | number | null
  reserved_at: string | number
  expires_at: string | number
  settled_at: string | number | null
}

interface LockedCandidate extends TeamRouteCandidate {
  readonly account: TeamContributionAccountSummary
}

/**
 * Serializes admission on contribution rows, making the concurrency and local
 * request-window guards atomic across every Host sharing the same database.
 */
export class PostgresTeamRequestRouter implements TeamRequestAdmissionRouter {
  private readonly pool: Pool
  private readonly now: () => number
  private readonly id: () => string
  private readonly leaseTtlMs: number
  private readonly drainPollMs: number

  constructor(options: PostgresTeamRequestRouterOptions) {
    this.pool = options.pool
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
    this.leaseTtlMs = boundedInteger(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, 'leaseTtlMs', 1_000, 24 * 60 * 60 * 1000)
    this.drainPollMs = boundedInteger(options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS, 'drainPollMs', 1, 5_000)
  }

  async route(request: TeamRouteRequest): Promise<TeamRouteSelection> {
    if (request.teamStatus !== 'active') {
      throw new TeamRouteCapacityError('Team is paused; no new requests are admitted', ['team_paused'])
    }
    const sessionId = boundedText(request.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH)
    const model = boundedText(request.model, 'model', MAX_MODEL_NAME_LENGTH)
    const candidates = uniqueCandidates(request.candidates.filter(candidate => candidate.account.teamId === request.teamId))
    if (candidates.length === 0) {
      throw new TeamRouteCapacityError('no Team capacity is configured for this request', ['no_candidates'])
    }
    if (candidates.length > MAX_CANDIDATES) throw new Error(`a Team request cannot include more than ${MAX_CANDIDATES} candidates`)

    return this.transaction(async (client) => {
      const team = await client.query<TeamStatusRow>('SELECT status FROM teams WHERE id = $1 FOR SHARE', [request.teamId])
      if (team.rows[0]?.status !== 'active') {
        throw new TeamRouteCapacityError('Team is paused; no new requests are admitted', ['team_paused'])
      }

      const ids = candidates.map(candidate => candidate.account.id).sort()
      const placeholders = ids.map((_, index) => `$${index + 2}`).join(', ')
      const rows = await client.query<ContributionRoutingRow>(`
        SELECT * FROM team_contributions
        WHERE team_id = $1 AND id IN (${placeholders})
        ORDER BY id FOR UPDATE
      `, [request.teamId, ...ids])
      const stored = new Map(rows.rows.map(row => [row.id, row]))
      const locked = candidates.flatMap(candidate => {
        const row = stored.get(candidate.account.id)
        return row === undefined ? [] : [{ account: contributionSummary(row), quota: candidate.quota }]
      })

      const binding = await client.query<BindingRow>(`
        SELECT account_id FROM team_session_bindings
        WHERE team_id = $1 AND consumer_member_id = $2 AND session_id = $3
      `, [request.teamId, request.consumerMemberId, sessionId])
      const boundId = binding.rows[0]?.account_id
      let selected: { candidate: LockedCandidate; source: TeamRouteSource } | undefined
      if (boundId !== undefined) {
        const bound = locked.find(candidate => candidate.account.id === boundId)
        if (bound !== undefined && await this.hasCapacity(client, bound, request.consumerMemberId, model)) {
          selected = { candidate: bound, source: 'session' }
        }
      }

      selected ??= await this.pick(client, locked
        .filter(candidate => candidate.account.ownerMemberId === request.consumerMemberId)
        .sort(compareCandidates), request.consumerMemberId, model, 'own')
      selected ??= await this.pick(client, locked
        .filter(candidate => candidate.account.ownerMemberId !== request.consumerMemberId)
        .sort(compareCandidates), request.consumerMemberId, model, 'shared')
      if (selected === undefined) {
        throw new TeamRouteCapacityError('no shared capacity is available for this request', [
          boundId === undefined ? 'session_unbound' : 'session_bound_unavailable',
          'own_unavailable',
          'shared_unavailable',
        ])
      }

      const now = this.now()
      const isShared = selected.candidate.account.ownerMemberId !== request.consumerMemberId
      const resetAt = isShared ? validResetAt(selected.candidate.quota.resetAt) ?? null : null
      const lease: TeamRouteLease = {
        id: this.id(),
        teamId: request.teamId,
        sessionId,
        consumerMemberId: request.consumerMemberId,
        accountId: selected.candidate.account.id,
        source: selected.source,
        reservedAt: now,
      }
      await client.query(`
        INSERT INTO team_route_leases
          (id, team_id, consumer_member_id, account_id, session_id, model,
           source, is_shared, status, reset_at, reserved_at, expires_at, settled_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress', $9, $10, $11, NULL)
      `, [
        lease.id, lease.teamId, lease.consumerMemberId, lease.accountId,
        lease.sessionId, model, lease.source, isShared, resetAt, now, now + this.leaseTtlMs,
      ])
      await client.query(`
        INSERT INTO team_session_bindings
          (team_id, consumer_member_id, session_id, account_id, bound_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (team_id, consumer_member_id, session_id)
        DO UPDATE SET account_id = EXCLUDED.account_id, updated_at = EXCLUDED.updated_at
      `, [request.teamId, request.consumerMemberId, sessionId, lease.accountId, now])
      return { lease, account: selected.candidate.account, source: selected.source }
    })
  }

  async settle(lease: TeamRouteLease, result: TeamRouteSettleResult): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query<LeaseRow>(`
        SELECT * FROM team_route_leases
        WHERE id = $1 AND team_id = $2 AND account_id = $3 FOR UPDATE
      `, [lease.id, lease.teamId, lease.accountId])
      const row = current.rows[0]
      if (row === undefined || row.status !== 'in_progress') {
        throw new Error('Team route lease is unknown or already settled')
      }
      await client.query(`
        UPDATE team_route_leases SET status = $1, settled_at = $2
        WHERE id = $3 AND team_id = $4
      `, [settledStatus(result), this.now(), lease.id, lease.teamId])
    })
  }

  async inspectAccount(teamId: string, accountId: string, resetAt?: number): Promise<TeamRouteAccountInspection> {
    const id = boundedText(accountId, 'accountId', 128)
    const active = await this.pool.query<CountRow>(`
      SELECT COUNT(*) AS count FROM team_route_leases
      WHERE team_id = $1 AND account_id = $2 AND is_shared = true
        AND status = 'in_progress' AND expires_at > $3
    `, [teamId, id, this.now()])
    if (resetAt === undefined) return { sharedInFlight: countValue(active.rows[0]) }
    const validReset = validResetAt(resetAt)
    if (validReset === undefined) throw new Error('resetAt is invalid')
    const used = await this.pool.query<CountRow>(`
      SELECT COUNT(*) AS count FROM team_route_leases
      WHERE team_id = $1 AND account_id = $2 AND is_shared = true AND reset_at = $3
    `, [teamId, id, validReset])
    return {
      sharedInFlight: countValue(active.rows[0]),
      sharedRequestsUsed: countValue(used.rows[0]),
    }
  }

  /** Extend a live lease; the eventual proxy should call this for long streams. */
  async renewLease(lease: TeamRouteLease): Promise<void> {
    const now = this.now()
    const result = await this.pool.query(`
      UPDATE team_route_leases SET expires_at = $1
      WHERE id = $2 AND team_id = $3 AND account_id = $4
        AND status = 'in_progress' AND expires_at > $5
    `, [now + this.leaseTtlMs, lease.id, lease.teamId, lease.accountId, now])
    if (result.rowCount !== 1) throw new Error('Team route lease cannot be renewed')
  }

  async drainAccount(accountId: string): Promise<void> {
    const id = boundedText(accountId, 'accountId', 128)
    while (true) {
      const now = this.now()
      await this.pool.query(`
        UPDATE team_route_leases SET status = 'expired', settled_at = $1
        WHERE account_id = $2 AND status = 'in_progress' AND expires_at <= $1
      `, [now, id])
      const result = await this.pool.query<CountRow>(`
        SELECT COUNT(*) AS count FROM team_route_leases
        WHERE account_id = $1 AND status = 'in_progress' AND expires_at > $2
      `, [id, now])
      if (countValue(result.rows[0]) === 0) return
      await delay(this.drainPollMs)
    }
  }

  async unbindSession(
    teamId: string,
    consumerMemberId: string,
    sessionId: string,
    accountId?: string,
  ): Promise<void> {
    const values: unknown[] = [
      teamId,
      boundedText(consumerMemberId, 'consumerMemberId', 128),
      boundedText(sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
    ]
    const accountClause = accountId === undefined ? '' : ' AND account_id = $4'
    if (accountId !== undefined) values.push(accountId)
    await this.pool.query(`
      DELETE FROM team_session_bindings
      WHERE team_id = $1 AND consumer_member_id = $2 AND session_id = $3${accountClause}
    `, values)
  }

  private async pick(
    client: PoolClient,
    candidates: readonly LockedCandidate[],
    consumerMemberId: string,
    model: string,
    source: 'own' | 'shared',
  ): Promise<{ candidate: LockedCandidate; source: TeamRouteSource } | undefined> {
    for (const candidate of candidates) {
      if (await this.hasCapacity(client, candidate, consumerMemberId, model)) return { candidate, source }
    }
    return undefined
  }

  private async hasCapacity(
    client: PoolClient,
    candidate: LockedCandidate,
    consumerMemberId: string,
    model: string,
  ): Promise<boolean> {
    const account = candidate.account
    const quota = candidate.quota
    const shared = account.ownerMemberId !== consumerMemberId
    if (account.status !== 'active' || !quota.healthy) return false
    if (account.allowedModels.length > 0 && !account.allowedModels.includes(model)) return false
    const remaining = validPercent(quota.remainingPercent)
    if (remaining === undefined) {
      if (shared) return false
    } else if (remaining <= 0 || (shared && remaining <= account.personalReservePercent)) {
      return false
    }
    if (!shared) return true

    const now = this.now()
    const active = await client.query<CountRow>(`
      SELECT COUNT(*) AS count FROM team_route_leases
      WHERE account_id = $1 AND is_shared = true
        AND status = 'in_progress' AND expires_at > $2
    `, [account.id, now])
    if (countValue(active.rows[0]) >= account.maxSharedConcurrency) return false
    if (account.maxSharedRequestsPerWindow === null) return true
    const resetAt = validResetAt(quota.resetAt)
    if (resetAt === undefined) return false
    const used = await client.query<CountRow>(`
      SELECT COUNT(*) AS count FROM team_route_leases
      WHERE account_id = $1 AND is_shared = true AND reset_at = $2
    `, [account.id, resetAt])
    return countValue(used.rows[0]) < account.maxSharedRequestsPerWindow
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const value = await operation(client)
      await client.query('COMMIT')
      return value
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

function uniqueCandidates(candidates: readonly TeamRouteCandidate[]): TeamRouteCandidate[] {
  const result = new Map<string, TeamRouteCandidate>()
  for (const candidate of candidates) result.set(candidate.account.id, candidate)
  return [...result.values()]
}

function contributionSummary(row: ContributionRoutingRow): TeamContributionAccountSummary {
  const models = parseModels(row.allowed_models)
  return {
    id: row.id,
    teamId: row.team_id,
    ownerMemberId: row.owner_member_id,
    label: row.label,
    status: row.status,
    personalReservePercent: row.personal_reserve_percent,
    maxSharedRequestsPerWindow: row.max_shared_requests_per_window,
    maxSharedConcurrency: row.max_shared_concurrency,
    allowedModels: models,
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    ...(row.last_error === null ? {} : { lastError: safeTeamErrorMessage(row.last_error) }),
  }
}

function parseModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('stored contribution model allow-list is invalid')
  }
  return [...new Set(value)]
}

function validPercent(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

function validResetAt(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function compareCandidates(left: TeamRouteCandidate, right: TeamRouteCandidate): number {
  const leftRemaining = validPercent(left.quota.remainingPercent) ?? -1
  const rightRemaining = validPercent(right.quota.remainingPercent) ?? -1
  return rightRemaining - leftRemaining || left.account.id.localeCompare(right.account.id)
}

function countValue(row: CountRow | undefined): number {
  const count = Number(row?.count ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('PostgreSQL returned an invalid count')
  return count
}

function numberValue(value: string | number): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('PostgreSQL returned an invalid integer')
  return result
}

function boundedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) throw new Error(`${field} is invalid`)
  return normalized
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} is outside the allowed range`)
  return value
}

function settledStatus(result: TeamRouteSettleResult): LeaseRow['status'] {
  switch (result) {
    case 'success': return 'succeeded'
    case 'error': return 'failed'
    case 'cancelled': return 'cancelled'
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

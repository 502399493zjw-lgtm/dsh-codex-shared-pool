/** Host-only Team request selection and in-process admission accounting. */

import { randomUUID } from 'node:crypto'
import type { TeamContributionAccountSummary, TeamStatus } from './types.ts'

export interface TeamQuotaSnapshot {
  readonly subscription?: import('../shared/subscription.ts').CodexSubscription
  /** The latest provider health result for this upstream account. */
  readonly healthy: boolean
  /** Effective provider remaining percentage after applying all known limits. */
  readonly remainingPercent?: number | null
  /** Longest provider-window reset used to scope the optional local request cap. */
  readonly resetAt?: number | null
}

export interface TeamRouteCandidate {
  readonly account: TeamContributionAccountSummary
  readonly quota: TeamQuotaSnapshot
}

export interface TeamRouteRequest {
  readonly teamId: string
  readonly teamStatus: TeamStatus
  readonly consumerMemberId: string
  readonly sessionId: string
  readonly model: string
  readonly candidates: readonly TeamRouteCandidate[]
}

export type TeamRouteSource = 'session' | 'own' | 'shared'

export interface TeamRouteLease {
  readonly id: string
  readonly teamId: string
  readonly sessionId: string
  readonly consumerMemberId: string
  readonly accountId: string
  readonly model: string
  readonly source: TeamRouteSource
  readonly reservedAt: number
}

export interface TeamRouteSelection {
  readonly lease: TeamRouteLease
  readonly account: TeamContributionAccountSummary
  readonly source: TeamRouteSource
}

export type TeamRouteSettleResult = 'success' | 'error' | 'cancelled'

/** Snapshot used only for owner-facing contribution diagnostics. */
export interface TeamRouteAccountInspection {
  readonly sharedInFlight: number
  readonly sharedRequestsUsed?: number
}

export class TeamRouteCapacityError extends Error {
  readonly code = 'TEAM_CAPACITY_UNAVAILABLE' as const
  readonly reasons: readonly string[]

  constructor(message = 'no Team capacity is available', reasons: readonly string[] = []) {
    super(message)
    this.name = 'TeamRouteCapacityError'
    this.reasons = reasons
  }
}

interface AccountState {
  inFlight: number
  sharedInFlight: number
  sharedRequestsByReset: Map<number, number>
}

interface LeaseState {
  readonly accountId: string
  readonly shared: boolean
}

export interface TeamRequestRouterOptions {
  now?: () => number
  id?: () => string
}

/** Admission seam implemented in-memory or with database-atomic leases. */
export interface TeamRequestAdmissionRouter {
  route(request: TeamRouteRequest): TeamRouteSelection | Promise<TeamRouteSelection>
  inspectAccount(teamId: string, accountId: string, resetAt?: number): TeamRouteAccountInspection | Promise<TeamRouteAccountInspection>
  renewLease(lease: TeamRouteLease): void | Promise<void>
  settle(lease: TeamRouteLease, result: TeamRouteSettleResult): void | Promise<void>
  drainAccount(accountId: string): Promise<void>
  unbindSession(teamId: string, consumerMemberId: string, sessionId: string, accountId?: string): void | Promise<void>
}

/**
 * Deterministic Team route selector.
 *
 * The router only admits a request; the caller still owns the provider call and
 * must settle the returned lease in a finally block. Request caps count admitted
 * attempts, while settle releases only the in-flight concurrency slot. This
 * deliberately avoids pretending that a failed HTTP call can be refunded from
 * an upstream subscription quota that may already have been consumed.
 */
export class TeamRequestRouter implements TeamRequestAdmissionRouter {
  private readonly now: () => number
  private readonly id: () => string
  private readonly bindings = new Map<string, string>()
  private readonly accounts = new Map<string, AccountState>()
  private readonly leases = new Map<string, LeaseState>()
  private readonly blockedAccounts = new Set<string>()
  private readonly drainWaiters = new Map<string, Set<() => void>>()

  constructor(options: TeamRequestRouterOptions = {}) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
  }

  route(request: TeamRouteRequest): TeamRouteSelection {
    if (request.teamStatus !== 'active') {
      throw new TeamRouteCapacityError('Team is paused; no new requests are admitted', ['team_paused'])
    }
    const candidates = request.candidates.filter(candidate => candidate.account.teamId === request.teamId)
    if (candidates.length === 0) {
      throw new TeamRouteCapacityError('no Team capacity is configured for this request', ['no_candidates'])
    }

    const sessionKey = bindingKey(request.teamId, request.consumerMemberId, request.sessionId)
    const boundId = this.bindings.get(sessionKey)
    if (boundId !== undefined) {
      const bound = candidates.find(candidate => candidate.account.id === boundId)
      if (bound !== undefined && this.isAvailable(bound, request, bound.account.ownerMemberId !== request.consumerMemberId)) {
        return this.reserve(bound, request, sessionKey, 'session')
      }
    }

    const own = candidates
      .filter(candidate => candidate.account.ownerMemberId === request.consumerMemberId)
      .filter(candidate => this.isAvailable(candidate, request, false))
      .sort(compareCandidates)
    const ownCandidate = own[0]
    if (ownCandidate !== undefined) return this.reserve(ownCandidate, request, sessionKey, 'own')

    const shared = candidates
      .filter(candidate => candidate.account.ownerMemberId !== request.consumerMemberId)
      .filter(candidate => this.isAvailable(candidate, request, true))
      .sort(compareCandidates)
    const sharedCandidate = shared[0]
    if (sharedCandidate !== undefined) return this.reserve(sharedCandidate, request, sessionKey, 'shared')

    throw new TeamRouteCapacityError('no shared capacity is available for this request', [
      boundId === undefined ? 'session_unbound' : 'session_bound_unavailable',
      'own_unavailable',
      'shared_unavailable',
    ])
  }

  /** Release the concurrency slot after the provider attempt settles. */
  settle(lease: TeamRouteLease, _result: TeamRouteSettleResult): void {
    const state = this.leases.get(lease.id)
    if (state === undefined || state.accountId !== lease.accountId) {
      throw new Error('Team route lease is unknown or already settled')
    }
    this.leases.delete(lease.id)
    const account = this.accountState(lease.accountId)
    account.inFlight = Math.max(0, account.inFlight - 1)
    if (state.shared) account.sharedInFlight = Math.max(0, account.sharedInFlight - 1)
    if (account.inFlight === 0) {
      for (const resolve of this.drainWaiters.get(lease.accountId) ?? []) resolve()
      this.drainWaiters.delete(lease.accountId)
    }
  }

  inspectAccount(_teamId: string, accountId: string, resetAt?: number): TeamRouteAccountInspection {
    const state = this.accountState(accountId)
    return {
      sharedInFlight: state.sharedInFlight,
      ...resetAt === undefined ? {} : { sharedRequestsUsed: state.sharedRequestsByReset.get(resetAt) ?? 0 },
    }
  }

  renewLease(lease: TeamRouteLease): void {
    const state = this.leases.get(lease.id)
    if (state === undefined || state.accountId !== lease.accountId) {
      throw new Error('Team route lease is unknown or already settled')
    }
  }

  /** Block new admission and resolve after all current requests have settled. */
  drainAccount(accountId: string): Promise<void> {
    this.blockedAccounts.add(accountId)
    if (this.accountState(accountId).inFlight === 0) return Promise.resolve()
    return new Promise(resolve => {
      const waiters = this.drainWaiters.get(accountId) ?? new Set<() => void>()
      waiters.add(resolve)
      this.drainWaiters.set(accountId, waiters)
    })
  }

  /** Remove only this member's binding after its upstream account becomes hard-unavailable. */
  unbindSession(teamId: string, consumerMemberId: string, sessionId: string, accountId?: string): void {
    const key = bindingKey(teamId, consumerMemberId, sessionId)
    if (accountId === undefined || this.bindings.get(key) === accountId) this.bindings.delete(key)
  }

  private reserve(
    candidate: TeamRouteCandidate,
    request: TeamRouteRequest,
    sessionKey: string,
    source: TeamRouteSource,
  ): TeamRouteSelection {
    const shared = candidate.account.ownerMemberId !== request.consumerMemberId
    const state = this.accountState(candidate.account.id)
    state.inFlight += 1
    if (shared) {
      state.sharedInFlight += 1
      const resetAt = validResetAt(candidate.quota.resetAt)
      if (resetAt !== undefined) {
        state.sharedRequestsByReset.set(resetAt, (state.sharedRequestsByReset.get(resetAt) ?? 0) + 1)
      }
    }
    const lease: TeamRouteLease = {
      id: this.id(),
      teamId: request.teamId,
      sessionId: request.sessionId,
      consumerMemberId: request.consumerMemberId,
      accountId: candidate.account.id,
      model: request.model,
      source,
      reservedAt: this.now(),
    }
    this.leases.set(lease.id, { accountId: lease.accountId, shared })
    this.bindings.set(sessionKey, candidate.account.id)
    return { lease, account: candidate.account, source }
  }

  private isAvailable(candidate: TeamRouteCandidate, request: TeamRouteRequest, shared: boolean): boolean {
    const account = candidate.account
    const quota = candidate.quota
    if (this.blockedAccounts.has(account.id)) return false
    if (account.status !== 'active' || !quota.healthy) return false
    if (account.allowedModels.length > 0 && !account.allowedModels.includes(request.model)) return false
    const remaining = validPercent(quota.remainingPercent)
    if (remaining === undefined) {
      // A contributor's personal account may still be attempted when the
      // provider has not supplied a quota signal. Shared capacity may not.
      if (shared) return false
    } else if (remaining <= 0 || (shared && remaining <= account.personalReservePercent)) {
      return false
    }

    const state = this.accountState(account.id)
    if (shared && state.sharedInFlight >= account.maxSharedConcurrency) return false
    if (!shared || account.maxSharedRequestsPerWindow === null) return true
    const resetAt = validResetAt(quota.resetAt)
    if (resetAt === undefined) return false
    return (state.sharedRequestsByReset.get(resetAt) ?? 0) < account.maxSharedRequestsPerWindow
  }

  private accountState(accountId: string): AccountState {
    const existing = this.accounts.get(accountId)
    if (existing !== undefined) return existing
    const created: AccountState = { inFlight: 0, sharedInFlight: 0, sharedRequestsByReset: new Map() }
    this.accounts.set(accountId, created)
    return created
  }
}

function bindingKey(teamId: string, consumerMemberId: string, sessionId: string): string {
  return JSON.stringify([teamId, consumerMemberId, sessionId])
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

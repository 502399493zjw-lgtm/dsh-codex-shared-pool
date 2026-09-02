/** Host-owned Team service boundary. */

import type { TeamStore } from './store.ts'
import { MemoryTeamStore, TeamDailyCreditsLimitError, TeamWeeklyEstimatedCostLimitError } from './store.ts'
import type { TeamAuthContext } from './store.ts'
import type {
  TeamContributionCapacityBucketId,
  TeamContributionCapacityBucketSummary,
  TeamContributionCapacityReason,
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamDissolutionInput,
  TeamDissolutionResult,
  TeamMemberDepartureResult,
  TeamMemberSummary,
  TeamOAuthBrokerChallenge,
  TeamOAuthMethod,
  TeamOAuthStartResult,
  TeamOwnershipTransferAcceptanceResult,
  TeamOwnershipTransferSummary,
  TeamOverview,
  TeamOverviewProjection,
  TeamUsageEventSummary,
  TeamUsageAggregates,
  TeamUsageEventStatus,
  TeamUsageProjection,
} from './types.ts'
import type { TeamCredentialBroker } from './credentials.ts'
import { LocalTeamCredentialBroker } from './credentials.ts'
import type { TeamCredentialHandoffEnvelope } from './oauth-handoff.ts'
import type {
  TeamQuotaSnapshot,
  TeamRequestAdmissionRouter,
  TeamRouteLease,
  TeamRouteSelection,
  TeamRouteSettleResult,
} from './routing.ts'
import { TeamRequestRouter, TeamRouteCapacityError } from './routing.ts'
import { TeamCapacityProvider } from './capacity.ts'
import { safeTeamErrorMessage, safeTeamOAuthErrorMessage } from './safe-message.ts'
import { openAICodexQuotaBucket } from '../account-allocation.ts'
import { TEAM_SHARED_CREDIT_RESERVATION } from './credits.ts'
import {
  estimateTeamUsageCostUsdMicros,
  TEAM_ESTIMATED_COST_PRICING_CATALOG_VERSION,
  type TeamProviderTokenUsage,
} from './credits.ts'

const CAPACITY_MODELS: Readonly<Record<TeamContributionCapacityBucketId, string>> = {
  codex: 'gpt-5-codex',
  codex_spark: 'gpt-5.3-codex-spark',
}
const DEFAULT_CAPACITY_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1_000
const DEFAULT_CAPACITY_REFRESH_CONCURRENCY = 4
const DEFAULT_INVITE_ENVELOPE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000
const MAX_INVITE_ENVELOPE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_REVOKED_CLEANUP_RETRY_MS = 1_000
const MAX_REVOKED_CLEANUP_RETRY_MS = 60_000

export interface TeamServiceOptions {
  store?: TeamStore
  broker?: TeamCredentialBroker
  router?: TeamRequestAdmissionRouter
  capacity?: TeamCapacityProvider
  /** Base delay for retrying durable cleanup markers after a committed revoke. */
  revokedCleanupRetryMs?: number
}

export interface TeamCapacityMonitoringOptions {
  /** Host-only background cadence; request admission still refreshes stale cache itself. */
  readonly intervalMs?: number
  /** Bound provider pressure when one Host serves many Teams. */
  readonly maxConcurrency?: number
}

export interface TeamInviteEnvelopeSweepingOptions {
  /** Host-only retention cadence; bounded so ciphertext never waits over 24 hours. */
  readonly intervalMs?: number
}

export interface TeamRequestCapacitySignal extends TeamQuotaSnapshot {
  readonly accountId: string
}

export interface TeamRequestAdmissionInput {
  readonly sessionId: string
  readonly model: string
  readonly capacities: readonly TeamRequestCapacitySignal[]
}

export interface TeamRequestAdmission extends TeamRouteSelection {
  readonly usage: TeamUsageEventSummary
}

export interface TeamContributionOAuthCancelOptions {
  /** Remove a placeholder that never completed its first authorization. */
  readonly discardInitial?: boolean
}

export class TeamService {
  readonly store: TeamStore
  readonly broker: TeamCredentialBroker
  readonly router: TeamRequestAdmissionRouter
  readonly capacity: TeamCapacityProvider
  private capacityMonitor: ReturnType<typeof setInterval> | undefined
  private capacityRefresh: Promise<void> | undefined
  private inviteEnvelopeSweepMonitor: ReturnType<typeof setInterval> | undefined
  private inviteEnvelopeSweep: Promise<number> | undefined
  private readonly revokedCleanupRetryMs: number
  private revokedCleanupTimer: ReturnType<typeof setTimeout> | undefined
  private revokedCleanupRefresh: Promise<void> | undefined
  private revokedCleanupRetryAttempt = 0
  private disposed = false

  constructor(options: TeamServiceOptions = {}) {
    this.store = options.store ?? new MemoryTeamStore()
    this.broker = options.broker ?? new LocalTeamCredentialBroker({
      onStatusChange: async (
        teamId,
        accountId,
        status,
        lastError,
        expectedStatus,
        providerAuthenticatedLabel,
      ) => {
        await this.store.setContributionAccountStatus(
          teamId,
          accountId,
          status,
          lastError,
          expectedStatus,
          providerAuthenticatedLabel,
        )
      },
    })
    this.router = options.router ?? new TeamRequestRouter()
    this.capacity = options.capacity ?? new TeamCapacityProvider(this.broker)
    this.revokedCleanupRetryMs = boundedRevokedCleanupRetry(options.revokedCleanupRetryMs)
  }

  async listContributionAccounts(auth: TeamAuthContext): Promise<readonly TeamContributionAccountSummary[]> {
    return this.store.listContributionAccounts(auth)
  }

  /**
   * Return only this member's contribution ids whose isolated credential matches
   * the supplied provider identity. The identity itself never enters a projection.
   */
  async findOwnedProviderAccountMatches(
    auth: TeamAuthContext,
    providerAccountId: string,
  ): Promise<readonly string[]> {
    const accounts = (await this.store.listContributionAccounts(auth)).filter(account => (
      account.ownerMemberId === auth.memberId
      && account.status !== 'authorizing'
      && account.status !== 'revoked'
    ))
    const matches = await Promise.all(accounts.map(async account => (
      await this.broker.matchesProviderAccount(
        { teamId: account.teamId, accountId: account.id },
        providerAccountId,
      )
        ? account.id
        : undefined
    )))
    return matches.filter((accountId): accountId is string => accountId !== undefined)
  }

  /** Add live capacity only to accounts owned by the authenticated member. */
  async overview(auth: TeamAuthContext): Promise<TeamOverview> {
    const overview = await this.store.overview(auth)
    const contributions = await Promise.all(overview.contributions.map(async account => {
      if (account.ownerMemberId !== auth.memberId || account.status !== 'active') return account
      return this.projectOwnedCapacity(account)
    }))
    return { ...overview, contributions }
  }

  /** Minimum role-shaped document for authenticated HTTP callers. */
  async overviewProjection(auth: TeamAuthContext): Promise<TeamOverviewProjection> {
    const overview = await this.overview(auth)
    const isOwner = auth.role === 'owner'
    const liveKeyMemberIds = new Set(
      overview.apiKeys
        .filter(key => key.revokedAt === undefined)
        .map(key => key.memberId),
    )
    const base = {
      team: overview.team,
      currentMember: projectPublicMember(overview.currentMember),
      members: overview.members
        .filter(member => member.status === 'active')
        .map(member => ({
          ...projectPublicMember(member),
          canReceiveOwnership: isOwner
            && member.id !== auth.memberId
            && member.role !== 'owner'
            && liveKeyMemberIds.has(member.id),
        })),
      contributions: overview.contributions.filter(account => account.ownerMemberId === auth.memberId),
      activeSharedAccounts: overview.contributions
        .filter(account => account.status === 'active')
        .map(account => ({
          id: account.id,
          label: account.label,
          ownerMemberId: account.ownerMemberId,
          status: 'active' as const,
        })),
      ...(overview.displayNameMigrationNotice === undefined
        ? {}
        : {
            displayNameMigrationNotice: {
              migrationVersion: overview.displayNameMigrationNotice.migrationVersion,
            },
          }),
      ...(overview.ownershipTransfer === undefined
        ? {}
        : { ownershipTransfer: overview.ownershipTransfer }),
    }
    return isOwner
      ? { viewerRole: 'owner', ...base, invites: overview.invites }
      : { viewerRole: 'member', ...base }
  }

  async startContributionOAuth(
    auth: TeamAuthContext,
    label: string,
    method: TeamOAuthMethod = 'device_code',
  ): Promise<TeamOAuthStartResult> {
    const account = await this.store.createContributionAccount(auth, label)
    let challenge: TeamOAuthBrokerChallenge
    try {
      challenge = await this.broker.startOAuth({ teamId: account.teamId, accountId: account.id }, method)
    } catch (error: unknown) {
      const projectedError = safeTeamOAuthErrorMessage(error)
      const rolledBack = await this.store.setContributionAccountStatus(
        account.teamId,
        account.id,
        'revoked',
        projectedError,
        'authorizing',
      )
      if (rolledBack.status === 'revoked') await this.cleanupCommittedRevokedContributions([rolledBack])
      throw new Error(projectedError)
    }

    let current: TeamContributionAccountSummary | undefined
    try {
      current = (await this.store.listContributionAccounts(auth)).find(item => item.id === account.id)
    } catch (error: unknown) {
      await this.cleanupCommittedRevokedContributions([account])
      throw error
    }
    if (current === undefined || current.status === 'revoked') {
      await this.cleanupCommittedRevokedContributions([account])
      throw new Error('contribution account was revoked during authorization')
    }
    return { account: current, ...challenge }
  }

  async cancelContributionOAuth(
    auth: TeamAuthContext,
    accountId: string,
    options: TeamContributionOAuthCancelOptions = {},
  ): Promise<TeamContributionAccountSummary> {
    const account = await this.store.updateContributionAccount(auth, accountId, {})
    if (account.status === 'reauth_required' && options.discardInitial === true) {
      const discarded = await this.store.revokeContributionAccount(auth, account.id)
      await this.cleanupCommittedRevokedContributions([discarded])
      return discarded
    }
    if (account.status !== 'authorizing') return account
    await this.broker.cancelOAuth({ teamId: account.teamId, accountId: account.id })
    const cancelled = await this.store.setContributionAccountStatus(
      account.teamId,
      account.id,
      options.discardInitial === true ? 'revoked' : 'reauth_required',
      'authorization cancelled',
      'authorizing',
    )
    if (cancelled.status === 'revoked') await this.cleanupCommittedRevokedContributions([cancelled])
    return cancelled
  }

  async reauthorizeContributionOAuth(
    auth: TeamAuthContext,
    accountId: string,
    method: TeamOAuthMethod = 'device_code',
  ): Promise<TeamOAuthStartResult> {
    const account = await this.store.beginContributionReauthorization(auth, accountId)
    let challenge: TeamOAuthBrokerChallenge
    try {
      challenge = await this.broker.restartOAuth({ teamId: account.teamId, accountId: account.id }, method)
    } catch (error: unknown) {
      const projectedError = safeTeamOAuthErrorMessage(error)
      await this.store.setContributionAccountStatus(
        account.teamId,
        account.id,
        'reauth_required',
        projectedError,
        'authorizing',
      )
      throw new Error(projectedError)
    }

    const current = (await this.store.listContributionAccounts(auth)).find(item => item.id === account.id)
    if (current === undefined) {
      await this.broker.revoke({ teamId: account.teamId, accountId: account.id })
      throw new Error('contribution account disappeared during authorization')
    }
    if (current.status === 'revoked') {
      await this.broker.revoke({ teamId: account.teamId, accountId: account.id })
      throw new Error('contribution account was revoked during authorization')
    }
    return { account: current, ...challenge }
  }

  async completeContributionOAuthHandoff(
    auth: TeamAuthContext,
    accountId: string,
    envelope: TeamCredentialHandoffEnvelope,
  ): Promise<TeamContributionAccountSummary> {
    const account = await this.store.updateContributionAccount(auth, accountId, {})
    if (account.status !== 'authorizing' && account.status !== 'active') {
      throw new Error('contribution account is not awaiting authorization')
    }
    const ref = { teamId: account.teamId, accountId: account.id }
    let brokerCompleted = false
    try {
      const activation = await this.broker.completeOAuthHandoff(ref, envelope)
      brokerCompleted = true
      if (account.status === 'active') return account
      const current = await this.store.setContributionAccountStatus(
        account.teamId,
        account.id,
        'active',
        undefined,
        'authorizing',
        activation.accountLabel,
      )
      if (current.status !== 'active') {
        await this.broker.revoke(ref)
        if (current.status === 'revoked') throw new Error('contribution account was revoked during authorization')
        throw new Error('contribution account state changed during authorization')
      }
      return current
    } catch (error: unknown) {
      const projectedError = safeTeamOAuthErrorMessage(error)
      if (account.status === 'authorizing' && !brokerCompleted) {
        await this.store.setContributionAccountStatus(
          account.teamId,
          account.id,
          'reauth_required',
          projectedError,
          'authorizing',
        ).catch(() => undefined)
      }
      throw new Error(projectedError)
    }
  }

  async reconcileContributionAuthorizations(): Promise<void> {
    const revoked = await this.store.listContributionAccountsByStatus('revoked')
    await this.cleanupCommittedRevokedContributions(revoked)
    const accounts = await this.store.listContributionAccountsByStatus('authorizing')
    for (const account of accounts) {
      let state: Awaited<ReturnType<TeamCredentialBroker['inspectAuthorization']>>
      try {
        state = await this.broker.inspectAuthorization({ teamId: account.teamId, accountId: account.id })
      } catch {
        state = {
          status: 'reauth_required',
          lastError: 'credential state could not be inspected; authorize this account again',
        }
      }
      // An out-of-process broker may still be completing the OAuth operation.
      // Its client-side monitor will publish the terminal state asynchronously.
      if (state.status === 'authorizing') continue
      const lastError = state.status === 'reauth_required' ? state.lastError : undefined
      await this.store.setContributionAccountStatus(
        account.teamId,
        account.id,
        state.status,
        lastError === undefined ? undefined : safeTeamOAuthErrorMessage(lastError),
        'authorizing',
        state.status === 'active' ? state.accountLabel : undefined,
      )
    }
  }

  async leaveTeam(auth: TeamAuthContext): Promise<TeamMemberDepartureResult> {
    const departure = await this.store.leaveTeam(auth)
    await this.cleanupCommittedRevokedContributions(departure.contributions)
    return departure
  }

  async requestOwnershipTransfer(
    auth: TeamAuthContext,
    targetMemberId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    return this.store.requestOwnershipTransfer(auth, targetMemberId)
  }

  async acceptOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferAcceptanceResult> {
    return this.store.acceptOwnershipTransfer(auth, transferId)
  }

  async rejectOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    return this.store.rejectOwnershipTransfer(auth, transferId)
  }

  async revokeOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    return this.store.revokeOwnershipTransfer(auth, transferId)
  }

  /**
   * Dissolution is committed by the store before any external credential work.
   * Broker/router cleanup is deliberately detached: durable revoked rows are the
   * retry markers, so an unavailable provider cannot make a committed terminal
   * transition appear to have failed.
   */
  async dissolveTeam(
    auth: TeamAuthContext,
    input: TeamDissolutionInput,
  ): Promise<TeamDissolutionResult> {
    const result = await this.store.dissolveTeam(auth, input)
    void this.cleanupDissolvedTeamContributions(result.teamId)
    return result
  }

  async removeMember(auth: TeamAuthContext, memberId: string): Promise<TeamMemberDepartureResult> {
    const departure = await this.store.removeMember(auth, memberId)
    await this.cleanupCommittedRevokedContributions(departure.contributions)
    return departure
  }

  async updateContributionAccount(
    auth: TeamAuthContext,
    accountId: string,
    patch: TeamContributionAccountPatch,
  ): Promise<TeamContributionAccountSummary> {
    return this.store.updateContributionAccount(auth, accountId, patch)
  }

  async revokeContributionAccount(auth: TeamAuthContext, accountId: string): Promise<TeamContributionAccountSummary> {
    const account = await this.store.revokeContributionAccount(auth, accountId)
    await this.cleanupCommittedRevokedContributions([account])
    return account
  }

  async admitRequest(auth: TeamAuthContext, input: TeamRequestAdmissionInput): Promise<TeamRequestAdmission> {
    const overview = await this.store.overview(auth)
    const capacities = new Map(input.capacities.map(capacity => [capacity.accountId, capacity]))
    const selection = await this.router.route({
      teamId: auth.teamId,
      teamStatus: overview.team.status,
      consumerMemberId: auth.memberId,
      sessionId: input.sessionId,
      model: input.model,
      candidates: overview.contributions.flatMap(account => {
        const capacity = capacities.get(account.id)
        return capacity === undefined ? [] : [{ account, quota: capacity }]
      }),
    })
    try {
      const usage = await this.store.beginUsageEvent(
        auth,
        selection.lease.id,
        selection.account.id,
        input.model,
        selection.account.ownerMemberId === auth.memberId ? 0 : TEAM_SHARED_CREDIT_RESERVATION,
      )
      return { ...selection, usage }
    } catch (error: unknown) {
      await this.router.settle(selection.lease, 'error')
      if (error instanceof TeamDailyCreditsLimitError) {
        throw new TeamRouteCapacityError(error.message, ['daily_shared_credits_reached'])
      }
      if (error instanceof TeamWeeklyEstimatedCostLimitError) {
        throw new TeamRouteCapacityError(error.message, ['weekly_shared_cost_reached'])
      }
      throw error
    }
  }

  async admitLiveRequest(
    auth: TeamAuthContext,
    input: Omit<TeamRequestAdmissionInput, 'capacities'> & { readonly excludedAccountIds?: readonly string[] },
  ): Promise<TeamRequestAdmission> {
    const overview = await this.store.overview(auth)
    const excluded = new Set(input.excludedAccountIds ?? [])
    const capacities = await Promise.all(overview.contributions
      .filter(account => account.status === 'active' && !excluded.has(account.id))
      .map(async account => ({
        accountId: account.id,
        ...await this.capacity.read({ teamId: account.teamId, accountId: account.id }, input.model),
      })))
    return this.admitRequest(auth, { sessionId: input.sessionId, model: input.model, capacities })
  }

  /**
   * Refresh all active contribution snapshots without exposing credentials or
   * provider payloads outside the Host. Concurrent sweeps coalesce.
   */
  async refreshActiveContributionCapacities(maxConcurrency = DEFAULT_CAPACITY_REFRESH_CONCURRENCY): Promise<void> {
    if (this.disposed) return
    const existing = this.capacityRefresh
    if (existing !== undefined) return existing
    const concurrency = boundedCapacityRefreshConcurrency(maxConcurrency)
    const refreshing = this.refreshActiveContributions(concurrency)
    this.capacityRefresh = refreshing
    try {
      await refreshing
    } finally {
      if (this.capacityRefresh === refreshing) this.capacityRefresh = undefined
    }
  }

  /** Start the Host-owned warm-cache monitor without blocking Host startup on provider I/O. */
  startCapacityMonitoring(options: TeamCapacityMonitoringOptions = {}): void {
    if (this.disposed) throw new Error('Team service is disposed')
    const intervalMs = boundedCapacityRefreshInterval(
      options.intervalMs ?? DEFAULT_CAPACITY_REFRESH_INTERVAL_MS,
    )
    const maxConcurrency = boundedCapacityRefreshConcurrency(
      options.maxConcurrency ?? DEFAULT_CAPACITY_REFRESH_CONCURRENCY,
    )
    if (this.capacityMonitor !== undefined) return
    this.capacityMonitor = setInterval(() => {
      void this.refreshActiveContributionCapacities(maxConcurrency).catch(() => undefined)
    }, intervalMs)
    this.capacityMonitor.unref?.()
  }

  /** Start Host-owned ciphertext retention without blocking startup on storage I/O. */
  startInviteEnvelopeSweeping(options: TeamInviteEnvelopeSweepingOptions = {}): void {
    if (this.disposed) throw new Error('Team service is disposed')
    const intervalMs = boundedInviteEnvelopeSweepInterval(
      options.intervalMs ?? DEFAULT_INVITE_ENVELOPE_SWEEP_INTERVAL_MS,
    )
    if (this.inviteEnvelopeSweepMonitor !== undefined) return
    this.inviteEnvelopeSweepMonitor = setInterval(() => {
      void this.sweepExpiredInviteEnvelopes().catch(() => undefined)
    }, intervalMs)
    this.inviteEnvelopeSweepMonitor.unref?.()
    void this.sweepExpiredInviteEnvelopes().catch(() => undefined)
  }

  /** Coalesce manual and timer-triggered sweeps onto one storage operation. */
  sweepExpiredInviteEnvelopes(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error('Team service is disposed'))
    if (this.inviteEnvelopeSweep !== undefined) return this.inviteEnvelopeSweep
    const sweeping = Promise.resolve().then(() => this.store.sweepExpiredInviteEnvelopes())
    this.inviteEnvelopeSweep = sweeping
    void sweeping.then(
      () => { if (this.inviteEnvelopeSweep === sweeping) this.inviteEnvelopeSweep = undefined },
      () => { if (this.inviteEnvelopeSweep === sweeping) this.inviteEnvelopeSweep = undefined },
    )
    return sweeping
  }

  async renewRequest(lease: TeamRouteLease): Promise<void> {
    await this.router.renewLease(lease)
  }

  invalidateCapacity(teamId: string, accountId: string): void {
    this.capacity.invalidate({ teamId, accountId })
  }

  async settleRequest(
    lease: TeamRouteLease,
    result: TeamRouteSettleResult,
    usage?: TeamProviderTokenUsage,
  ): Promise<TeamUsageEventSummary> {
    await this.router.settle(lease, result)
    const estimatedCostUsdMicros = usage === undefined
      ? undefined
      : estimateTeamUsageCostUsdMicros(lease.model, usage)
    return this.store.settleUsageEvent(
      lease.teamId,
      lease.id,
      usageStatus(result),
      usage,
      estimatedCostUsdMicros === undefined ? undefined : {
        estimatedCostUsdMicros,
        pricingCatalogVersion: TEAM_ESTIMATED_COST_PRICING_CATALOG_VERSION,
      },
    )
  }

  async listUsageEvents(auth: TeamAuthContext, limit = 100): Promise<readonly TeamUsageEventSummary[]> {
    return this.store.listUsageEvents(auth, limit)
  }

  async listUsageAggregates(auth: TeamAuthContext): Promise<TeamUsageAggregates> {
    return this.store.listUsageAggregates(auth)
  }

  async readUsageProjection(auth: TeamAuthContext): Promise<TeamUsageProjection> {
    return this.store.readUsageProjection(auth)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.capacityMonitor !== undefined) {
      clearInterval(this.capacityMonitor)
      this.capacityMonitor = undefined
    }
    if (this.inviteEnvelopeSweepMonitor !== undefined) {
      clearInterval(this.inviteEnvelopeSweepMonitor)
      this.inviteEnvelopeSweepMonitor = undefined
    }
    if (this.revokedCleanupTimer !== undefined) {
      clearTimeout(this.revokedCleanupTimer)
      this.revokedCleanupTimer = undefined
    }
    await this.capacityRefresh?.catch(() => undefined)
    await this.inviteEnvelopeSweep?.catch(() => undefined)
    await this.revokedCleanupRefresh?.catch(() => undefined)
    await this.broker.dispose()
    await this.store.dispose()
  }

  /**
   * The store transition is the source of truth and already committed. A
   * revoked contribution remains a durable cleanup marker, so transient
   * router/broker failures must not turn a successful departure into a 5xx.
   */
  private async cleanupCommittedRevokedContributions(
    accounts: readonly TeamContributionAccountSummary[],
  ): Promise<void> {
    try {
      await this.cleanupRevokedContributions(accounts)
    } catch {
      this.scheduleRevokedCleanupRetry()
    }
  }

  private async cleanupDissolvedTeamContributions(teamId: string): Promise<void> {
    try {
      const accounts = await this.store.listContributionAccountsByStatus('revoked')
      await this.cleanupRevokedContributions(accounts.filter(account => account.teamId === teamId))
    } catch {
      this.scheduleRevokedCleanupRetry()
    }
  }

  private async cleanupRevokedContributions(
    accounts: readonly TeamContributionAccountSummary[],
  ): Promise<void> {
    await Promise.all(accounts.map(async account => {
      await this.router.drainAccount(account.id)
      await this.broker.revoke({ teamId: account.teamId, accountId: account.id })
    }))
  }

  private scheduleRevokedCleanupRetry(): void {
    if (this.disposed || this.revokedCleanupTimer !== undefined) return
    const delay = Math.min(
      this.revokedCleanupRetryMs * (2 ** this.revokedCleanupRetryAttempt),
      MAX_REVOKED_CLEANUP_RETRY_MS,
    )
    this.revokedCleanupRetryAttempt += 1
    this.revokedCleanupTimer = setTimeout(() => {
      this.revokedCleanupTimer = undefined
      const refreshing = this.retryPersistedRevokedContributions()
      this.revokedCleanupRefresh = refreshing
      void refreshing.finally(() => {
        if (this.revokedCleanupRefresh === refreshing) this.revokedCleanupRefresh = undefined
      })
    }, delay)
    this.revokedCleanupTimer.unref?.()
  }

  private async retryPersistedRevokedContributions(): Promise<void> {
    try {
      const accounts = await this.store.listContributionAccountsByStatus('revoked')
      await this.cleanupRevokedContributions(accounts)
      this.revokedCleanupRetryAttempt = 0
    } catch {
      this.scheduleRevokedCleanupRetry()
    }
  }

  private async projectOwnedCapacity(
    account: TeamContributionAccountSummary,
  ): Promise<TeamContributionAccountSummary> {
    const buckets = contributionBuckets(account)
    const projections = await Promise.all(buckets.map(async id => {
      const quota = await this.capacity.read(
        { teamId: account.teamId, accountId: account.id },
        CAPACITY_MODELS[id],
      )
      const resetAt = validCapacityReset(quota.resetAt)
      let inspection: Awaited<ReturnType<TeamRequestAdmissionRouter['inspectAccount']>> | undefined
      try {
        inspection = await this.router.inspectAccount(account.teamId, account.id, resetAt)
      } catch {
        // The overview remains usable when an observational router read fails.
      }
      const remainingPercent = validCapacityPercent(quota.remainingPercent)
      const bucket: TeamContributionCapacityBucketSummary = {
        id,
        reason: capacityReason(account, quota.healthy, remainingPercent, resetAt, inspection),
        ...remainingPercent === undefined ? {} : { remainingPercent },
        ...resetAt === undefined ? {} : { resetAt },
        ...inspection?.sharedRequestsUsed === undefined
          ? {}
          : { sharedRequestsUsed: inspection.sharedRequestsUsed },
      }
      return { bucket, sharedInFlight: inspection?.sharedInFlight }
    }))
    const sharedInFlight = projections.find(item => item.sharedInFlight !== undefined)?.sharedInFlight
    return {
      ...account,
      capacity: {
        ...sharedInFlight === undefined ? {} : { sharedInFlight },
        buckets: projections.map(item => item.bucket),
      },
    }
  }

  private async refreshActiveContributions(maxConcurrency: number): Promise<void> {
    const accounts = await this.store.listContributionAccountsByStatus('active')
    for (let start = 0; start < accounts.length; start += maxConcurrency) {
      await Promise.all(accounts.slice(start, start + maxConcurrency).map(async account => {
        const bucket = contributionBuckets(account)[0] ?? 'codex'
        await this.capacity.refresh(
          { teamId: account.teamId, accountId: account.id },
          CAPACITY_MODELS[bucket],
        )
      }))
    }
  }
}

function projectPublicMember(member: TeamMemberSummary): TeamMemberSummary {
  return {
    ...member,
    role: member.role === 'owner' ? 'owner' : 'member',
  }
}

function usageStatus(result: TeamRouteSettleResult): Exclude<TeamUsageEventStatus, 'in_progress'> {
  switch (result) {
    case 'success': return 'succeeded'
    case 'error': return 'failed'
    case 'cancelled': return 'cancelled'
  }
}

function contributionBuckets(account: TeamContributionAccountSummary): readonly TeamContributionCapacityBucketId[] {
  if (account.allowedModels.length === 0) return ['codex', 'codex_spark']
  return [...new Set(account.allowedModels.map(openAICodexQuotaBucket))]
}

function capacityReason(
  account: TeamContributionAccountSummary,
  healthy: boolean,
  remainingPercent: number | undefined,
  resetAt: number | undefined,
  inspection: Awaited<ReturnType<TeamRequestAdmissionRouter['inspectAccount']>> | undefined,
): TeamContributionCapacityReason {
  if (!healthy) return 'provider_unavailable'
  if (remainingPercent === undefined) return 'quota_unavailable'
  if (remainingPercent <= 0) return 'quota_exhausted'
  if (remainingPercent <= account.personalReservePercent) return 'reserve_reached'
  if (inspection === undefined) return 'runtime_unavailable'
  if (inspection.sharedInFlight >= account.maxSharedConcurrency) return 'shared_concurrency_reached'
  if (account.maxSharedRequestsPerWindow === null) return 'ready'
  if (resetAt === undefined) return 'request_cap_reset_unavailable'
  if (inspection.sharedRequestsUsed === undefined) return 'runtime_unavailable'
  return inspection.sharedRequestsUsed >= account.maxSharedRequestsPerWindow
    ? 'request_cap_reached'
    : 'ready'
}

function validCapacityPercent(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

function validCapacityReset(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function boundedCapacityRefreshInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 24 * 60 * 60 * 1_000) {
    throw new Error('Team capacity refresh interval is outside the allowed range')
  }
  return value
}

function boundedCapacityRefreshConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error('Team capacity refresh concurrency is outside the allowed range')
  }
  return value
}

function boundedInviteEnvelopeSweepInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_INVITE_ENVELOPE_SWEEP_INTERVAL_MS) {
    throw new Error('Team invitation envelope sweep interval is outside the allowed range')
  }
  return value
}

function boundedRevokedCleanupRetry(value = DEFAULT_REVOKED_CLEANUP_RETRY_MS): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REVOKED_CLEANUP_RETRY_MS) {
    throw new Error('Team revoked cleanup retry delay is outside the allowed range')
  }
  return value
}

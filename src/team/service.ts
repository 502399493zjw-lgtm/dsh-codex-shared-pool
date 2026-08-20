/** Host-owned Team service boundary. */

import type { TeamStore } from './store.ts'
import { MemoryTeamStore } from './store.ts'
import type { TeamAuthContext } from './store.ts'
import type {
  TeamContributionCapacityBucketId,
  TeamContributionCapacityBucketSummary,
  TeamContributionCapacityReason,
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamMemberDepartureResult,
  TeamOAuthStartResult,
  TeamOverview,
  TeamUsageEventSummary,
  TeamUsageEventStatus,
} from './types.ts'
import type { TeamCredentialBroker } from './credentials.ts'
import { LocalTeamCredentialBroker } from './credentials.ts'
import type {
  TeamQuotaSnapshot,
  TeamRequestAdmissionRouter,
  TeamRouteLease,
  TeamRouteSelection,
  TeamRouteSettleResult,
} from './routing.ts'
import { TeamRequestRouter } from './routing.ts'
import { TeamCapacityProvider } from './capacity.ts'
import { safeTeamErrorMessage } from './safe-message.ts'
import { openAICodexQuotaBucket } from '../account-allocation.ts'

const CAPACITY_MODELS: Readonly<Record<TeamContributionCapacityBucketId, string>> = {
  codex: 'gpt-5-codex',
  codex_spark: 'gpt-5.3-codex-spark',
}

export interface TeamServiceOptions {
  store?: TeamStore
  broker?: TeamCredentialBroker
  router?: TeamRequestAdmissionRouter
  capacity?: TeamCapacityProvider
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

export class TeamService {
  readonly store: TeamStore
  readonly broker: TeamCredentialBroker
  readonly router: TeamRequestAdmissionRouter
  readonly capacity: TeamCapacityProvider

  constructor(options: TeamServiceOptions = {}) {
    this.store = options.store ?? new MemoryTeamStore()
    this.broker = options.broker ?? new LocalTeamCredentialBroker({
      onStatusChange: async (teamId, accountId, status, lastError, expectedStatus) => {
        await this.store.setContributionAccountStatus(teamId, accountId, status, lastError, expectedStatus)
      },
    })
    this.router = options.router ?? new TeamRequestRouter()
    this.capacity = options.capacity ?? new TeamCapacityProvider(this.broker)
  }

  async listContributionAccounts(auth: TeamAuthContext): Promise<readonly TeamContributionAccountSummary[]> {
    return this.store.listContributionAccounts(auth)
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

  async startContributionOAuth(auth: TeamAuthContext, label: string): Promise<TeamOAuthStartResult> {
    const account = await this.store.createContributionAccount(auth, label)
    try {
      const challenge = await this.broker.startOAuth({ teamId: account.teamId, accountId: account.id })
      return { account, ...challenge }
    } catch (error: unknown) {
      await this.store.setContributionAccountStatus(
        account.teamId,
        account.id,
        'reauth_required',
        safeTeamErrorMessage(error),
        'authorizing',
      )
      throw error
    }
  }

  async cancelContributionOAuth(auth: TeamAuthContext, accountId: string): Promise<TeamContributionAccountSummary> {
    const account = await this.store.updateContributionAccount(auth, accountId, {})
    if (account.status !== 'authorizing') return account
    await this.broker.cancelOAuth({ teamId: account.teamId, accountId: account.id })
    return this.store.setContributionAccountStatus(
      account.teamId,
      account.id,
      'reauth_required',
      'authorization cancelled',
      'authorizing',
    )
  }

  async reauthorizeContributionOAuth(auth: TeamAuthContext, accountId: string): Promise<TeamOAuthStartResult> {
    const account = await this.store.beginContributionReauthorization(auth, accountId)
    let challenge: Omit<TeamOAuthStartResult, 'account'>
    try {
      challenge = await this.broker.restartOAuth({ teamId: account.teamId, accountId: account.id })
    } catch (error: unknown) {
      await this.store.setContributionAccountStatus(
        account.teamId,
        account.id,
        'reauth_required',
        safeTeamErrorMessage(error),
        'authorizing',
      )
      throw error
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

  async reconcileContributionAuthorizations(): Promise<void> {
    const revoked = await this.store.listContributionAccountsByStatus('revoked')
    await this.cleanupRevokedContributions(revoked)
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
      await this.store.setContributionAccountStatus(
        account.teamId,
        account.id,
        state.status,
        state.lastError,
        'authorizing',
      )
    }
  }

  async leaveTeam(auth: TeamAuthContext): Promise<TeamMemberDepartureResult> {
    const departure = await this.store.leaveTeam(auth)
    await this.cleanupRevokedContributions(departure.contributions)
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
    await this.router.drainAccount(account.id)
    await this.broker.revoke({ teamId: account.teamId, accountId: account.id })
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
      const usage = await this.store.beginUsageEvent(auth, selection.lease.id, selection.account.id, input.model)
      return { ...selection, usage }
    } catch (error: unknown) {
      await this.router.settle(selection.lease, 'error')
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

  async renewRequest(lease: TeamRouteLease): Promise<void> {
    await this.router.renewLease(lease)
  }

  invalidateCapacity(teamId: string, accountId: string): void {
    this.capacity.invalidate({ teamId, accountId })
  }

  async settleRequest(
    lease: TeamRouteLease,
    result: TeamRouteSettleResult,
  ): Promise<TeamUsageEventSummary> {
    await this.router.settle(lease, result)
    return this.store.settleUsageEvent(lease.teamId, lease.id, usageStatus(result))
  }

  async listUsageEvents(auth: TeamAuthContext, limit = 100): Promise<readonly TeamUsageEventSummary[]> {
    return this.store.listUsageEvents(auth, limit)
  }

  async dispose(): Promise<void> {
    await this.broker.dispose()
    await this.store.dispose()
  }

  private async cleanupRevokedContributions(
    accounts: readonly TeamContributionAccountSummary[],
  ): Promise<void> {
    await Promise.all(accounts.map(account => this.router.drainAccount(account.id)))
    await Promise.all(accounts.map(account => this.broker.revoke({
      teamId: account.teamId,
      accountId: account.id,
    })))
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

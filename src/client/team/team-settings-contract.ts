import type {
  TeamManagementContributionSummary,
  TeamManagementMemberSummary,
} from '../../shared/team-management.ts'
import type {
  TeamInviteStatus,
  TeamMemberSummary,
  TeamRole,
} from '../../team/types.ts'

export const MAX_PERSONAL_RESERVE_PERCENT = 99
export const MAX_SHARED_REQUESTS_PER_WINDOW = 1_000_000
export const MIN_WEEKLY_LIMIT_USD_MICROS = 10_000
export const MAX_WEEKLY_LIMIT_USD_MICROS = 10_000_000_000
export const MAX_ALLOWED_MODELS = 32
export const MAX_ALLOWED_MODEL_LENGTH = 120

export interface ContributionProtectionDraft {
  readonly reserve: string
  readonly requestCap: string
  readonly weeklyLimitUsd?: string
  readonly models: string
}

export interface WeeklySharingLimitDraft {
  readonly weeklyLimitUsd: string
}

export interface TeamContributionGroups {
  readonly shared: readonly TeamManagementContributionSummary[]
  readonly unshared: readonly TeamManagementContributionSummary[]
}

/**
 * The account directory is personal management, not Team inventory. Keep both
 * groups restricted to the authenticated member even if an upstream response
 * accidentally contains another contributor's summary.
 */
export function groupTeamContributions(
  contributions: readonly TeamManagementContributionSummary[],
  currentMemberId: string,
): TeamContributionGroups {
  const ownContributions = contributions.filter(account => account.ownerMemberId === currentMemberId)
  return {
    shared: ownContributions.filter(account => account.status === 'active'),
    unshared: ownContributions.filter(account =>
      account.status !== 'active'
      && account.status !== 'authorizing'
      && account.status !== 'revoked'),
  }
}

export function localProfilesAvailableForTeam<T extends { readonly id: string }>(
  profiles: readonly T[],
  contributions: readonly TeamManagementContributionSummary[],
  currentMemberId: string,
): readonly T[] {
  const represented = new Set(contributions
    .filter(account => account.ownerMemberId === currentMemberId && account.status !== 'revoked')
    .map(account => account.sourceLocalProfileId)
    .filter((id): id is string => id !== undefined))
  return profiles.filter(profile => !represented.has(profile.id))
}

export type ContributionProtectionDraftResult = {
  readonly ok: true
  readonly patch: {
    readonly personalReservePercent: number
    readonly maxSharedRequestsPerWindow: number | null
    readonly weeklySharedEstimatedApiCostLimitMicros: number | null
    readonly allowedModels: readonly string[]
  }
} | {
  readonly ok: false
  readonly field: 'reserve' | 'requestCap' | 'weeklyLimitUsd' | 'allowedModels'
}

export type WeeklySharingLimitDraftResult = {
  readonly ok: true
  readonly patch: {
    readonly weeklySharedEstimatedApiCostLimitMicros: number | null
  }
} | {
  readonly ok: false
  readonly field: 'weeklyLimitUsd'
}

export function parseWeeklySharingLimitDraft(
  draft: WeeklySharingLimitDraft,
): WeeklySharingLimitDraftResult {
  const weeklyLimitText = draft.weeklyLimitUsd.trim()
  const weeklyLimitUsd = weeklyLimitText.length === 0 ? null : Number(weeklyLimitText)
  const weeklyLimitMicros = weeklyLimitUsd === null ? null : Math.round(weeklyLimitUsd * 1_000_000)
  if (
    weeklyLimitMicros !== null
    && (weeklyLimitUsd === null
      || !Number.isFinite(weeklyLimitUsd)
      || weeklyLimitMicros < MIN_WEEKLY_LIMIT_USD_MICROS
      || weeklyLimitMicros > MAX_WEEKLY_LIMIT_USD_MICROS
      || Math.abs(weeklyLimitMicros / 1_000_000 - weeklyLimitUsd) > Number.EPSILON)
  ) return { ok: false, field: 'weeklyLimitUsd' }

  return {
    ok: true,
    patch: { weeklySharedEstimatedApiCostLimitMicros: weeklyLimitMicros },
  }
}

/**
 * Parse the text-field representation into the exact limits accepted by both
 * Team store implementations, so invalid settings never become a failed HTTP
 * round trip.
 */
export function parseContributionProtectionDraft(
  draft: ContributionProtectionDraft,
): ContributionProtectionDraftResult {
  const reserveText = draft.reserve.trim()
  const reserve = Number(reserveText)
  if (
    reserveText.length === 0
    || !Number.isSafeInteger(reserve)
    || reserve < 0
    || reserve > MAX_PERSONAL_RESERVE_PERCENT
  ) return { ok: false, field: 'reserve' }

  const requestCapText = draft.requestCap.trim()
  const requestCap = requestCapText.length === 0 ? null : Number(requestCapText)
  if (
    requestCap !== null
    && (
      !Number.isSafeInteger(requestCap)
      || requestCap < 1
      || requestCap > MAX_SHARED_REQUESTS_PER_WINDOW
    )
  ) return { ok: false, field: 'requestCap' }

  const weeklyLimitResult = parseWeeklySharingLimitDraft({ weeklyLimitUsd: draft.weeklyLimitUsd ?? '' })
  if (!weeklyLimitResult.ok) return weeklyLimitResult

  const allowedModels = draft.models.split(',').map(value => value.trim()).filter(Boolean)
  if (
    allowedModels.length > MAX_ALLOWED_MODELS
    || allowedModels.some(model => model.length > MAX_ALLOWED_MODEL_LENGTH)
  ) return { ok: false, field: 'allowedModels' }

  return {
    ok: true,
    patch: {
      personalReservePercent: reserve,
      maxSharedRequestsPerWindow: requestCap,
      ...weeklyLimitResult.patch,
      allowedModels,
    },
  }
}

export function canMemberLeaveTeam(role: TeamRole): boolean {
  return role !== 'owner'
}

export function canRevokeTeamInvite(role: TeamRole, status: TeamInviteStatus): boolean {
  return role === 'owner' && status === 'pending'
}

export function canTransferTeamOwnership(
  currentMember: TeamMemberSummary,
  candidate: TeamManagementMemberSummary,
): boolean {
  return currentMember.role === 'owner'
    && currentMember.status === 'active'
    && candidate.canReceiveOwnership
    && candidate.teamId === currentMember.teamId
    && candidate.id !== currentMember.id
    && candidate.status === 'active'
    && candidate.role === 'member'
}

export function canRemoveTeamMember(
  currentMember: TeamMemberSummary,
  candidate: TeamManagementMemberSummary,
): boolean {
  if (
    currentMember.status !== 'active'
    || candidate.teamId !== currentMember.teamId
    || candidate.id === currentMember.id
    || candidate.status !== 'active'
    || candidate.role === 'owner'
  ) return false
  return currentMember.role === 'owner'
}

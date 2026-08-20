/** JSON-safe Team control-plane types shared by Host routes and the Browser. */

export const TEAM_PATH_PREFIX = '/plugins/dsh-codex-shared-pool/team'
export const TEAM_BOOTSTRAP_PATH = `${TEAM_PATH_PREFIX}/bootstrap`
export const TEAM_OVERVIEW_PATH = `${TEAM_PATH_PREFIX}/overview`
export const TEAM_STATUS_PATH = `${TEAM_PATH_PREFIX}/status`
export const TEAM_INVITES_PATH = `${TEAM_PATH_PREFIX}/invites`
export const TEAM_INVITES_REVOKE_PATH = `${TEAM_INVITES_PATH}/revoke`
export const TEAM_JOIN_PATH = `${TEAM_PATH_PREFIX}/join`
export const TEAM_OWNERSHIP_TRANSFER_PATH = `${TEAM_PATH_PREFIX}/ownership/transfer`
export const TEAM_MEMBERS_LEAVE_PATH = `${TEAM_PATH_PREFIX}/members/leave`
export const TEAM_KEYS_PATH = `${TEAM_PATH_PREFIX}/keys`
export const TEAM_KEYS_REVOKE_PATH = `${TEAM_KEYS_PATH}/revoke`
/** Revoke exactly the API key authenticating this request. */
export const TEAM_CURRENT_KEY_REVOKE_PATH = `${TEAM_KEYS_PATH}/current/revoke`
export const TEAM_CONTRIBUTIONS_PATH = `${TEAM_PATH_PREFIX}/contributions`
export const TEAM_CONTRIBUTION_OAUTH_START_PATH = `${TEAM_CONTRIBUTIONS_PATH}/oauth/start`
export const TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH = `${TEAM_CONTRIBUTIONS_PATH}/oauth/cancel`
export const TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH = `${TEAM_CONTRIBUTIONS_PATH}/oauth/reauthorize`
export const TEAM_CONTRIBUTION_UPDATE_PATH = `${TEAM_CONTRIBUTIONS_PATH}/update`
export const TEAM_CONTRIBUTION_REVOKE_PATH = `${TEAM_CONTRIBUTIONS_PATH}/revoke`
export const TEAM_USAGE_PATH = `${TEAM_PATH_PREFIX}/usage`
export const TEAM_RESPONSES_PATH = `${TEAM_PATH_PREFIX}/responses`
/** Codex-native pi-ai clients append `/codex/responses` to their configured base URL. */
export const TEAM_CODEX_RESPONSES_PATH = `${TEAM_PATH_PREFIX}/codex/responses`

export type TeamRole = 'owner' | 'admin' | 'member'
export type TeamStatus = 'active' | 'paused'
export type TeamMemberStatus = 'active' | 'suspended' | 'removed'
export type TeamInviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked'
export type TeamContributionStatus = 'authorizing' | 'active' | 'paused' | 'revoked' | 'reauth_required'
export type TeamUsageEventStatus = 'in_progress' | 'succeeded' | 'failed' | 'cancelled'
export type TeamContributionCapacityBucketId = 'codex' | 'codex_spark'
export type TeamContributionCapacityReason =
  | 'ready'
  | 'provider_unavailable'
  | 'quota_unavailable'
  | 'quota_exhausted'
  | 'reserve_reached'
  | 'shared_concurrency_reached'
  | 'request_cap_reset_unavailable'
  | 'request_cap_reached'
  | 'runtime_unavailable'

export interface TeamSummary {
  readonly id: string
  readonly name: string
  readonly status: TeamStatus
  readonly createdAt: number
}

export interface TeamMemberSummary {
  readonly id: string
  readonly teamId: string
  readonly displayName: string
  readonly role: TeamRole
  readonly status: TeamMemberStatus
  readonly joinedAt: number
}

export interface TeamInviteSummary {
  readonly id: string
  readonly teamId: string
  readonly invitedByMemberId: string
  readonly status: TeamInviteStatus
  readonly expiresAt: number
  readonly createdAt: number
  readonly acceptedAt?: number
}

export interface TeamApiKeySummary {
  readonly id: string
  readonly teamId: string
  readonly memberId: string
  readonly label: string
  readonly prefix: string
  readonly createdAt: number
  readonly lastUsedAt?: number
  readonly revokedAt?: number
}

export interface TeamOverview {
  readonly team: TeamSummary
  readonly currentMember: TeamMemberSummary
  readonly members: readonly TeamMemberSummary[]
  readonly invites: readonly TeamInviteSummary[]
  readonly apiKeys: readonly TeamApiKeySummary[]
  readonly contributions: readonly TeamContributionAccountSummary[]
}

/** Secret-free result of a durable non-owner Team departure. */
export interface TeamMemberDepartureResult {
  readonly member: TeamMemberSummary
  readonly contributions: readonly TeamContributionAccountSummary[]
}

/** Secret-free result of an atomic Team ownership role swap. */
export interface TeamOwnershipTransferResult {
  readonly formerOwner: TeamMemberSummary
  readonly owner: TeamMemberSummary
}

/** Secret-free contribution-account state owned by one Team member. */
export interface TeamContributionAccountSummary {
  readonly id: string
  readonly teamId: string
  readonly ownerMemberId: string
  readonly label: string
  readonly status: TeamContributionStatus
  /** Keep this percentage for the contributor before shared scheduling. */
  readonly personalReservePercent: number
  /** Optional hard request-count cap for the longest observed provider window. */
  readonly maxSharedRequestsPerWindow: number | null
  /** Fixed safety guard; not a member consumption quota. */
  readonly maxSharedConcurrency: number
  readonly allowedModels: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastError?: string
  /** Live, secret-free sharing state; projected only to this contribution's owner. */
  readonly capacity?: TeamContributionCapacitySummary
}

export interface TeamContributionCapacityBucketSummary {
  readonly id: TeamContributionCapacityBucketId
  readonly reason: TeamContributionCapacityReason
  readonly remainingPercent?: number
  /** Longest observed provider-window reset, in epoch milliseconds. */
  readonly resetAt?: number
  readonly sharedRequestsUsed?: number
}

export interface TeamContributionCapacitySummary {
  readonly sharedInFlight?: number
  readonly buckets: readonly TeamContributionCapacityBucketSummary[]
}

export interface TeamContributionAccountPatch {
  readonly label?: string
  readonly status?: 'active' | 'paused'
  readonly personalReservePercent?: number
  readonly maxSharedRequestsPerWindow?: number | null
  readonly maxSharedConcurrency?: number
  readonly allowedModels?: readonly string[]
}

/** Browser-completable OAuth ceremony that keeps the credential exchange on the Team Host. */
export interface TeamOAuthDeviceChallenge {
  readonly method: 'device_code'
  readonly verificationUrl: string
  readonly userCode: string
  readonly expiresAt: number
}

export interface TeamOAuthStartResult extends TeamOAuthDeviceChallenge {
  readonly account: TeamContributionAccountSummary
}

/** Prompt-free audit record for one admitted upstream request. */
export interface TeamUsageEventSummary {
  readonly id: string
  readonly teamId: string
  readonly consumerMemberId: string
  readonly upstreamOwnerMemberId: string
  readonly upstreamAccountId: string
  readonly model: string
  readonly unit: 'request'
  readonly status: TeamUsageEventStatus
  readonly startedAt: number
  readonly finishedAt?: number
}

/** One-time result returned immediately after a Team bootstrap. */
export interface TeamBootstrapResult {
  readonly team: TeamSummary
  readonly member: TeamMemberSummary
  readonly apiKey: string
}

/** One-time result returned immediately after creating an invite. */
export interface TeamInviteResult {
  readonly invite: TeamInviteSummary
  readonly inviteToken: string
}

/** One-time result returned immediately after accepting an invite. */
export interface TeamJoinResult {
  readonly team: TeamSummary
  readonly member: TeamMemberSummary
  readonly apiKey: string
}

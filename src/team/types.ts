/** JSON-safe Team control-plane types shared by Host routes and the Browser. */

export const TEAM_PATH_PREFIX = '/plugins/dsh-codex-shared-pool/team'
export const TEAM_BOOTSTRAP_PATH = `${TEAM_PATH_PREFIX}/bootstrap`
export const TEAM_OVERVIEW_PATH = `${TEAM_PATH_PREFIX}/overview`
export const TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH = `${TEAM_PATH_PREFIX}/display-name-migration/ack`
export const TEAM_STATUS_PATH = `${TEAM_PATH_PREFIX}/status`
export const TEAM_DISSOLVE_PATH = `${TEAM_PATH_PREFIX}/dissolve`
export const TEAM_DISSOLVE_RESULT_PATH = `${TEAM_DISSOLVE_PATH}/result`
export const TEAM_DISSOLVE_ACK_PATH = `${TEAM_DISSOLVE_PATH}/ack`
export const TEAM_CONNECTION_TERMINAL_PATH = `${TEAM_PATH_PREFIX}/connection-terminal`
export const TEAM_INVITES_PATH = `${TEAM_PATH_PREFIX}/invites`
export const TEAM_INVITES_PREVIEW_PATH = `${TEAM_INVITES_PATH}/preview`
export const TEAM_INVITES_REVEAL_PATH = `${TEAM_INVITES_PATH}/reveal`
export const TEAM_INVITES_REVOKE_PATH = `${TEAM_INVITES_PATH}/revoke`
export const TEAM_JOIN_PATH = `${TEAM_PATH_PREFIX}/join`
export const TEAM_OWNERSHIP_TRANSFER_PATH = `${TEAM_PATH_PREFIX}/ownership/transfer`
export const TEAM_OWNERSHIP_TRANSFER_ACCEPT_PATH = `${TEAM_OWNERSHIP_TRANSFER_PATH}/accept`
export const TEAM_OWNERSHIP_TRANSFER_REJECT_PATH = `${TEAM_OWNERSHIP_TRANSFER_PATH}/reject`
export const TEAM_OWNERSHIP_TRANSFER_REVOKE_PATH = `${TEAM_OWNERSHIP_TRANSFER_PATH}/revoke`
export const TEAM_MEMBERS_REMOVE_PATH = `${TEAM_PATH_PREFIX}/members/remove`
export const TEAM_MEMBERS_LEAVE_PATH = `${TEAM_PATH_PREFIX}/members/leave`
export const TEAM_KEYS_PATH = `${TEAM_PATH_PREFIX}/keys`
export const TEAM_KEYS_REVOKE_PATH = `${TEAM_KEYS_PATH}/revoke`
/** Revoke exactly the API key authenticating this request. */
export const TEAM_CURRENT_KEY_REVOKE_PATH = `${TEAM_KEYS_PATH}/current/revoke`
export const TEAM_CONTRIBUTIONS_PATH = `${TEAM_PATH_PREFIX}/contributions`
export const TEAM_CONTRIBUTION_PROVIDER_ACCOUNT_MATCHES_PATH = `${TEAM_CONTRIBUTIONS_PATH}/provider-account/matches`
export const TEAM_CONTRIBUTION_OAUTH_START_PATH = `${TEAM_CONTRIBUTIONS_PATH}/oauth/start`
export const TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH = `${TEAM_CONTRIBUTIONS_PATH}/oauth/cancel`
export const TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH = `${TEAM_CONTRIBUTIONS_PATH}/oauth/reauthorize`
export const TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH = `${TEAM_CONTRIBUTIONS_PATH}/oauth/handoff/complete`
export const TEAM_CONTRIBUTION_UPDATE_PATH = `${TEAM_CONTRIBUTIONS_PATH}/update`
export const TEAM_CONTRIBUTION_REVOKE_PATH = `${TEAM_CONTRIBUTIONS_PATH}/revoke`
export const TEAM_USAGE_PATH = `${TEAM_PATH_PREFIX}/usage`
export const TEAM_RESPONSES_PATH = `${TEAM_PATH_PREFIX}/responses`
/** Codex-native pi-ai clients append `/codex/responses` to their configured base URL. */
export const TEAM_CODEX_RESPONSES_PATH = `${TEAM_PATH_PREFIX}/codex/responses`

export type TeamRole = 'owner' | 'admin' | 'member'
export type TeamStatus = 'active' | 'paused' | 'dissolved'
export type TeamMemberStatus = 'active' | 'suspended' | 'removed'
export type TeamInviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked'
export type TeamContributionStatus = 'authorizing' | 'active' | 'paused' | 'revoked' | 'reauth_required'
export type TeamOwnershipTransferStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'canceled'
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
  | 'weekly_shared_cost_reached'
  | 'runtime_unavailable'

export interface TeamSummary {
  readonly id: string
  readonly name: string
  readonly status: TeamStatus
  readonly lifecycleRevision: number
  readonly dissolvedAt?: number
  readonly createdAt: number
}

/** One optimistic, idempotent active/paused lifecycle write. */
export interface TeamLifecycleTransitionInput {
  readonly operationId: string
  readonly expectedLifecycleRevision: number
  readonly status: Exclude<TeamStatus, 'dissolved'>
}

/** Owner-authorized input for the single irreversible Team transition. */
export interface TeamDissolutionInput {
  readonly operationId: string
  readonly expectedLifecycleRevision: number
  /** Must match the stored Team name byte-for-byte. */
  readonly confirmationName: string
  /** SHA-256 of a Host-held recovery secret. The raw secret never crosses this boundary. */
  readonly recoverySecretHash: string
}

/** Authenticated Owner result returned by the destructive submission itself. */
export interface TeamDissolutionResult {
  readonly operationId: string
  readonly teamId: string
  readonly teamName: string
  readonly status: 'dissolved'
  readonly lifecycleRevision: number
  readonly dissolvedAt: number
  readonly terminatedMemberCount: number
  readonly revokedInviteCount: number
  readonly revokedKeyCount: number
  readonly revokedContributionCount: number
}

/** Unauthenticated recovery projection; deliberately excludes all Team metadata. */
export interface TeamDissolutionRecoveryResult {
  readonly operationType: 'team_dissolution'
  readonly status: 'dissolved'
}

/** Coarse terminal reason; never reveals Team, membership, or key metadata. */
export type TeamConnectionTerminalCode =
  | 'member_removed'
  | 'member_left'
  | 'team_dissolved'
  | 'device_revoked'

export interface TeamConnectionTerminal {
  readonly code: TeamConnectionTerminalCode
}

export interface TeamMemberSummary {
  readonly id: string
  readonly teamId: string
  readonly displayName: string
  readonly role: TeamRole
  readonly status: TeamMemberStatus
  readonly joinedAt: number
}

export type TeamMembershipAuditAction =
  | 'ownership_transferred'
  | 'role_changed'
  | 'member_removed'
  | 'member_left'

/** Append-only record for a successful Team membership or permission transition. */
export interface TeamMembershipAuditEventSummary {
  readonly id: string
  readonly teamId: string
  readonly actorMemberId: string
  readonly targetMemberId: string
  readonly action: TeamMembershipAuditAction
  readonly previousRole: TeamRole
  readonly nextRole?: TeamRole
  readonly result: 'succeeded'
  readonly createdAt: number
}

/** Host-only, secret-free record emitted for each successful invitation reveal. */
export interface TeamInviteRevealAuditEventSummary {
  readonly id: string
  readonly teamId: string
  readonly actorMemberId: string
  readonly inviteId: string
  readonly createdAt: number
}

export interface TeamInviteSummary {
  readonly id: string
  readonly teamId: string
  readonly invitedByMemberId: string
  readonly label: string
  readonly status: TeamInviteStatus
  /** True only when the current valid token has a Host-decryptable envelope. */
  readonly revealable: boolean
  readonly expiresAt: number
  readonly createdAt: number
  readonly acceptedAt?: number
}

/** Secret-free invitation details returned before a one-time acceptance. */
export interface TeamInvitePreview {
  readonly teamName: string
  readonly label: string
  readonly expiresAt: number
  readonly teamStatus: TeamStatus
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

/** Minimum Browser-safe signal that the authenticated member has one migration notice to acknowledge. */
export interface TeamDisplayNameMigrationNotice {
  readonly migrationVersion: number
}

/** Version-bound acknowledgement; stale UI cannot acknowledge a later migration. */
export interface TeamDisplayNameMigrationAcknowledgement {
  readonly migrationVersion: number
  readonly acknowledged: true
}

export interface TeamOverview {
  readonly team: TeamSummary
  readonly currentMember: TeamMemberSummary
  readonly members: readonly TeamMemberSummary[]
  readonly invites: readonly TeamInviteSummary[]
  readonly apiKeys: readonly TeamApiKeySummary[]
  readonly contributions: readonly TeamContributionAccountSummary[]
  readonly displayNameMigrationNotice?: TeamDisplayNameMigrationNotice
  /** Visible only to the current Owner/requester and the requested target while pending. */
  readonly ownershipTransfer?: TeamOwnershipTransferSummary
}

/** Member row prepared by the Host; raw Team API-key metadata never crosses the route. */
export interface TeamOverviewMemberSummary extends TeamMemberSummary {
  readonly canReceiveOwnership: boolean
}

/** Minimum Team-wide directory row for one account that is currently shared. */
export interface TeamSharedAccountDirectoryEntry {
  readonly id: string
  readonly label: string
  readonly ownerMemberId: string
  readonly status: 'active'
}

interface TeamOverviewProjectionBase {
  readonly team: TeamSummary
  readonly currentMember: TeamMemberSummary
  readonly members: readonly TeamOverviewMemberSummary[]
  /** A caller can manage and inspect only contribution accounts they own. */
  readonly contributions: readonly TeamContributionAccountSummary[]
  /** Team-wide active accounts, projected without private policy, capacity, usage, or credentials. */
  readonly activeSharedAccounts: readonly TeamSharedAccountDirectoryEntry[]
  readonly displayNameMigrationNotice?: TeamDisplayNameMigrationNotice
  /** Visible only to the current Owner/requester and the requested target while pending. */
  readonly ownershipTransfer?: TeamOwnershipTransferSummary
}

/** Exact owners receive Team invitation metadata; legacy admins are projected as members. */
export type TeamOverviewProjection =
  | (TeamOverviewProjectionBase & {
      readonly viewerRole: 'owner'
      readonly invites: readonly TeamInviteSummary[]
    })
  | (TeamOverviewProjectionBase & {
      readonly viewerRole: 'member'
    })

/** Secret-free result of a durable non-owner Team departure. */
export interface TeamMemberDepartureResult {
  readonly member: TeamMemberSummary
  readonly contributions: readonly TeamContributionAccountSummary[]
}

/** Secret-free, server-timed state for a two-party ownership transfer. */
export interface TeamOwnershipTransferSummary {
  readonly id: string
  readonly teamId: string
  readonly requestedByMemberId: string
  readonly targetMemberId: string
  readonly status: TeamOwnershipTransferStatus
  readonly createdAt: number
  /** Exactly 24 hours after `createdAt`. */
  readonly expiresAt: number
  /** Present for every terminal status and absent while pending. */
  readonly resolvedAt?: number
}

/** Secret-free result of the target accepting and atomically swapping roles. */
export interface TeamOwnershipTransferAcceptanceResult {
  readonly transfer: TeamOwnershipTransferSummary
  readonly formerOwner: TeamMemberSummary
  readonly owner: TeamMemberSummary
}

/** @deprecated Use `TeamOwnershipTransferAcceptanceResult`. */
export type TeamOwnershipTransferResult = TeamOwnershipTransferAcceptanceResult

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
  /** Optional UTC-day budget for requests consumed by other Team members. */
  readonly dailySharedCreditLimit: number | null
  /** Optional API-equivalent USD budget for shared requests in one UTC ISO week. */
  readonly weeklySharedEstimatedApiCostLimitMicros: number | null
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
  readonly dailySharedCreditLimit?: number | null
  readonly weeklySharedEstimatedApiCostLimitMicros?: number | null
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

/** The local Browser flow is preferred; device code remains an explicit headless fallback. */
export type TeamOAuthMethod = 'browser' | 'device_code'

/** One-use public offer issued by the credential-owning Team Host. */
export interface TeamOAuthHandoffChallenge {
  readonly method: 'browser_handoff'
  readonly handoff: import('./oauth-handoff.ts').TeamCredentialHandoffOffer
}

export type TeamOAuthBrokerChallenge = TeamOAuthDeviceChallenge | TeamOAuthHandoffChallenge

export type TeamOAuthStartResult = TeamOAuthBrokerChallenge & {
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
  /** Settled weighted-token Credits. Omitted while unmeasured or in progress. */
  readonly credits?: number
  readonly creditsFormulaVersion?: 'credits-v1'
  /** Total provider-reported input and output Tokens. */
  readonly totalTokens?: number
  /** Estimated standard-API equivalent cost in integer micro-USD. */
  readonly estimatedCostUsdMicros?: string
  readonly pricingCatalogVersion?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Request-attempt and measured-Credits totals; unmeasured attempts remain visible. */
export interface TeamUsageTotals {
  readonly requestCount: number
  readonly measuredRequestCount: number
  readonly credits: number
}

/** Rolling 24-hour shared use of one contribution account. */
export interface TeamAccountUsage24HourSummary extends TeamUsageTotals {
  readonly upstreamAccountId: string
}

/** One UTC calendar day's shared use of one account by one Team member. */
export interface TeamMemberDailyUsageSummary extends TeamUsageTotals {
  readonly upstreamAccountId: string
  readonly consumerMemberId: string
  readonly dayStartedAt: number
}

/** Secret-free aggregates for the account detail and seven-day member chart. */
export interface TeamUsageAggregates {
  readonly generatedAt: number
  readonly last24HoursStartedAt: number
  readonly last7DaysStartedAt: number
  readonly accountTotals24Hours: readonly TeamAccountUsage24HourSummary[]
  readonly memberDaily7Days: readonly TeamMemberDailyUsageSummary[]
}

/** Aggregate-only usage wire shape. Counts describe admitted cross-member attempts. */
export interface TeamUsageAggregateSummary {
  readonly requestCount: number
  readonly tokenMeasuredRequestCount: number
  readonly pricedRequestCount: number
  /** Decimal bigint string; null means no attempt in the window had valid Token data. */
  readonly totalTokens: string | null
  /** Decimal bigint string in micro-USD; null means no attempt was reliably priceable. */
  readonly estimatedCostUsdMicros: string | null
}

export interface TeamUsageWindow {
  readonly startedAt: number
  readonly endedAt: number
}

/** Browser-safe recent request for an account owned by the current member. */
export interface TeamOwnedAccountRecentRequest {
  readonly id: string
  readonly model: string
  readonly status: TeamUsageEventStatus
  readonly startedAt: number
  readonly finishedAt?: number
  readonly totalTokens?: number
  readonly estimatedCostUsdMicros?: string
}

/** One explicit account-usage window; avoids relabelling a rolling aggregate in the Browser. */
export interface TeamOwnedAccountWindowedUsageSummary {
  readonly window: TeamUsageWindow
  readonly aggregate: TeamUsageAggregateSummary
}

/** Current ISO week in UTC, including the next reset boundary. */
export interface TeamOwnedAccountCurrentUtcWeekUsageSummary extends TeamOwnedAccountWindowedUsageSummary {
  readonly resetAt: number
}

/** Seven-day projection for one contribution account owned by the current member. */
export interface TeamOwnedAccountUsageSummary {
  readonly accountId: string
  /** Legacy rolling seven-day aggregate retained for compatible Hosts and recent-request detail. */
  readonly window: TeamUsageWindow
  readonly aggregate: TeamUsageAggregateSummary
  readonly currentUtcWeek?: TeamOwnedAccountCurrentUtcWeekUsageSummary
  readonly last24Hours?: TeamOwnedAccountWindowedUsageSummary
  readonly recentRequests: readonly TeamOwnedAccountRecentRequest[]
}

/** Browser-safe role projection. A member response structurally cannot contain Team totals. */
export type TeamUsageProjection =
  | {
      readonly role: 'owner'
      readonly window: TeamUsageWindow
      readonly currency: 'USD'
      readonly team: TeamUsageAggregateSummary
      readonly mine: TeamUsageAggregateSummary
      readonly ownedAccounts: readonly TeamOwnedAccountUsageSummary[]
    }
  | {
      readonly role: 'member'
      readonly window: TeamUsageWindow
      readonly currency: 'USD'
      readonly mine: TeamUsageAggregateSummary
      readonly ownedAccounts: readonly TeamOwnedAccountUsageSummary[]
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

/** Narrow no-store response for an Owner's explicit invitation reveal. */
export interface TeamInviteRevealResult {
  readonly inviteId: string
  readonly inviteToken: string
  readonly expiresAt: number
}

/** One-time result returned immediately after accepting an invite. */
export interface TeamJoinResult {
  readonly team: TeamSummary
  readonly member: TeamMemberSummary
  readonly apiKey: string
}

/** Secret-free result when the joining Host supplied and retained the key. */
export interface TeamJoinAcceptedResult {
  readonly team: TeamSummary
  readonly member: TeamMemberSummary
}

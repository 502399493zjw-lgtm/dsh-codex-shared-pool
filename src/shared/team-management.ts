/** JSON-safe contract between the Browser settings page and its local Host proxy. */

import type {
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamConnectionTerminalCode,
  TeamDisplayNameMigrationAcknowledgement,
  TeamDisplayNameMigrationNotice,
  TeamInvitePreview,
  TeamInviteRevealResult,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamOwnershipTransferAcceptanceResult,
  TeamOwnershipTransferSummary,
  TeamSharedAccountDirectoryEntry,
  TeamStatus,
  TeamSummary,
  TeamUsageProjection,
} from '../team/types.ts'

export const TEAM_MANAGEMENT_PATH_PREFIX = '/plugins/dsh-codex-shared-pool/team-client'
export const TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE = 'team_authorization_network_unavailable'
export const TEAM_AUTHORIZATION_FAILED_CODE = 'team_authorization_failed'
export const TEAM_MANAGEMENT_CONTEXT_CHANGED_MESSAGE = 'Team connection changed; refresh before trying again'
export const TEAM_MANAGEMENT_SESSION_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/session`
export const TEAM_MANAGEMENT_CAPABILITY_HEADER = 'x-dsh-team-management-capability'
export const TEAM_MANAGEMENT_STATUS_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/status`
export const TEAM_MANAGEMENT_JOIN_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/join`
export const TEAM_MANAGEMENT_JOIN_RECOVER_PATH = `${TEAM_MANAGEMENT_JOIN_PATH}/recover`
export const TEAM_MANAGEMENT_JOIN_DISCARD_PATH = `${TEAM_MANAGEMENT_JOIN_PATH}/discard`
export const TEAM_MANAGEMENT_DISCONNECT_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/disconnect`
export const TEAM_MANAGEMENT_LEAVE_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/leave`
export const TEAM_MANAGEMENT_DISSOLVE_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/dissolve`
export const TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/dissolution/recover`
export const TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/dissolution/clear`
export const TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/connection-terminal/clear`
export const TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/ownership/transfer`
export const TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH = `${TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH}/accept`
export const TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH = `${TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH}/reject`
export const TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH = `${TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH}/revoke`
export const TEAM_MANAGEMENT_OVERVIEW_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/overview`
export const TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/display-name-migration/ack`
export const TEAM_MANAGEMENT_INVITES_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/invites`
export const TEAM_MANAGEMENT_INVITES_PREVIEW_PATH = `${TEAM_MANAGEMENT_INVITES_PATH}/preview`
export const TEAM_MANAGEMENT_INVITES_REVEAL_PATH = `${TEAM_MANAGEMENT_INVITES_PATH}/reveal`
export const TEAM_MANAGEMENT_INVITES_REVOKE_PATH = `${TEAM_MANAGEMENT_INVITES_PATH}/revoke`
export const TEAM_MANAGEMENT_MEMBERS_REMOVE_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/members/remove`
export const TEAM_MANAGEMENT_TEAM_STATUS_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/team-status`
export const TEAM_MANAGEMENT_CONTRIBUTIONS_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/contributions`
export const TEAM_MANAGEMENT_OAUTH_START_PATH = `${TEAM_MANAGEMENT_CONTRIBUTIONS_PATH}/oauth/start`
export const TEAM_MANAGEMENT_OAUTH_CANCEL_PATH = `${TEAM_MANAGEMENT_CONTRIBUTIONS_PATH}/oauth/cancel`
export const TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH = `${TEAM_MANAGEMENT_CONTRIBUTIONS_PATH}/oauth/reauthorize`
export const TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH = `${TEAM_MANAGEMENT_CONTRIBUTIONS_PATH}/update`
export const TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH = `${TEAM_MANAGEMENT_CONTRIBUTIONS_PATH}/revoke`
export const TEAM_MANAGEMENT_USAGE_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/usage`

export interface TeamManagementStatus {
  readonly enabled: boolean
  readonly keyConfigured: boolean
  readonly keyWritable: boolean
  readonly pendingJoinConfigured: boolean
  readonly keySource?: string
  readonly serverOrigin?: string
  readonly dissolution?: TeamDissolutionView
  readonly connectionTerminal?: TeamConnectionTerminalView
}

/** Minimum, secret-free Browser projection of a terminal Team connection. */
export interface TeamConnectionTerminalView {
  readonly code: TeamConnectionTerminalCode
  readonly localCleanup: 'completed' | 'retry_required' | 'manual_required'
}

export type TeamConnectionTerminalClearResult = TeamConnectionTerminalView | { readonly cleared: true }

/** Minimum, secret-free Browser projection of an in-flight or terminal Team dissolution. */
export type TeamDissolutionView =
  | {
      readonly state: 'confirming'
      readonly teamName: string
      readonly requestedAt: number
    }
  | {
      readonly state: 'confirmed'
      /** Present only when this Host submitted the dissolution operation. */
      readonly teamName?: string
      /** Present only when this Host submitted the dissolution operation. */
      readonly dissolvedAt?: number
      readonly localCleanup: 'completed' | 'retry_required' | 'manual_required'
    }

export type TeamDissolutionClearResult = TeamDissolutionView | { readonly cleared: true }

export interface TeamDissolutionInput {
  readonly confirmationName: string
  readonly expectedLifecycleRevision: number
}

/**
 * Browser-observed Team identity bound to an authenticated mutation.
 *
 * The Host re-resolves its credential and verifies this snapshot immediately
 * before writing so a stale tab cannot act on a replacement Team connection.
 */
export interface TeamManagementExpectedContext {
  readonly serverOrigin: string
  readonly teamId: string
  readonly currentMemberId: string
}

/** Short-lived, process-local CSRF capability. Browser memory is its only client-side storage. */
export interface TeamManagementSession {
  readonly capability: string
  readonly expiresAt: number
}

/** Browser-safe member projection with Host-computed ownership eligibility. */
export interface TeamManagementMemberSummary extends TeamMemberSummary {
  /** True only when this caller may target the member and a live Team key exists. */
  readonly canReceiveOwnership: boolean
}

/** Browser projection deliberately enumerates and excludes Host-only policy fields. */
export type TeamManagementContributionSummary = Pick<TeamContributionAccountSummary,
  | 'id'
  | 'teamId'
  | 'ownerMemberId'
  | 'label'
  | 'status'
  | 'personalReservePercent'
  | 'maxSharedRequestsPerWindow'
  | 'weeklySharedEstimatedApiCostLimitMicros'
  | 'maxSharedConcurrency'
  | 'allowedModels'
  | 'createdAt'
  | 'updatedAt'
  | 'lastError'
  | 'capacity'
>

/** Explicit minimum Browser projection for the Team-wide active sharing directory. */
export type TeamManagementSharedAccountDirectoryEntry = Pick<TeamSharedAccountDirectoryEntry,
  | 'id'
  | 'label'
  | 'ownerMemberId'
  | 'status'
>

/** Browser writes may change only this explicit sharing-control allow-list. */
export type TeamManagementContributionPatch = Pick<TeamContributionAccountPatch,
  | 'label'
  | 'status'
  | 'personalReservePercent'
  | 'maxSharedRequestsPerWindow'
  | 'weeklySharedEstimatedApiCostLimitMicros'
  | 'maxSharedConcurrency'
  | 'allowedModels'
>

export interface TeamManagementContributionResult {
  readonly account: TeamManagementContributionSummary
}

/** Deliberately omits API-key summaries; the Browser never manages raw Team credentials. */
interface TeamManagementOverviewBase {
  readonly team: TeamSummary
  readonly currentMember: TeamMemberSummary
  readonly members: readonly TeamManagementMemberSummary[]
  readonly contributions: readonly TeamManagementContributionSummary[]
  readonly activeSharedAccounts: readonly TeamManagementSharedAccountDirectoryEntry[]
  readonly displayNameMigrationNotice?: TeamDisplayNameMigrationNotice
  /** Present only for the current Owner or the nominated target while pending. */
  readonly ownershipTransfer?: TeamOwnershipTransferSummary
}

export type TeamManagementOverview =
  | (TeamManagementOverviewBase & {
      readonly viewerRole: 'owner'
      readonly invites: readonly TeamInviteSummary[]
    })
  | (TeamManagementOverviewBase & {
      readonly viewerRole: 'member'
    })

export type TeamManagementDisplayNameMigrationAcknowledgement = TeamDisplayNameMigrationAcknowledgement

export interface TeamManagementConnectionResult {
  readonly team: TeamSummary
  readonly member: TeamMemberSummary
}

/** Minimum Browser projection after the Host has completed a durable Team departure. */
export interface TeamManagementDepartureResult {
  readonly member: TeamMemberSummary
}

export type TeamManagementOwnershipTransferSummary = TeamOwnershipTransferSummary

/** Minimum Browser projection after the target accepted the transfer. */
export type TeamManagementOwnershipTransferAcceptanceResult = TeamOwnershipTransferAcceptanceResult

/** @deprecated Use `TeamManagementOwnershipTransferAcceptanceResult`. */
export type TeamManagementOwnershipTransferResult = TeamManagementOwnershipTransferAcceptanceResult

export interface TeamManagementInviteResult {
  readonly invite: TeamInviteSummary
  /** One-time value intentionally shown so an administrator can send it to a friend. */
  readonly inviteToken: string
}

export type TeamManagementInviteRevealResult = TeamInviteRevealResult

/** Secret-free invitation identity plus an opaque, short-lived Host-local join capability. */
export interface TeamManagementInvitePreview extends TeamInvitePreview {
  readonly joinHandle: string
}

export interface TeamManagementMemberResult {
  readonly member: TeamMemberSummary
}

export interface TeamManagementInviteRevocationResult {
  readonly invite: TeamInviteSummary
}

export interface TeamManagementBrowserOAuthResult {
  readonly account: TeamManagementContributionSummary
  readonly method: 'browser'
  /** Provider authorization URL opened by the local Browser; no handoff material is exposed. */
  readonly authorizationUrl: string
  readonly expiresAt: number
}

export interface TeamManagementDeviceOAuthResult {
  readonly account: TeamManagementContributionSummary
  readonly method: 'device_code'
  /** Provider verification URL intentionally returned; credentials remain on the Host. */
  readonly verificationUrl: string
  readonly userCode: string
  readonly expiresAt: number
}

export type TeamManagementOAuthResult = TeamManagementBrowserOAuthResult | TeamManagementDeviceOAuthResult

export type TeamManagementUsageResult = TeamUsageProjection

export interface TeamManagementTeamStatusResult {
  readonly team: TeamSummary & { readonly status: TeamStatus }
}

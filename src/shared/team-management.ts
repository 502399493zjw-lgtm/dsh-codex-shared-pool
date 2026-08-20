/** JSON-safe contract between the Browser settings page and its local Host proxy. */

import type {
  TeamContributionAccountSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamStatus,
  TeamSummary,
  TeamUsageEventSummary,
} from '../team/types.ts'

export const TEAM_MANAGEMENT_PATH_PREFIX = '/plugins/dsh-codex-shared-pool/team-client'
export const TEAM_MANAGEMENT_STATUS_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/status`
export const TEAM_MANAGEMENT_CONNECT_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/connect`
export const TEAM_MANAGEMENT_JOIN_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/join`
export const TEAM_MANAGEMENT_DISCONNECT_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/disconnect`
export const TEAM_MANAGEMENT_LEAVE_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/leave`
export const TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/ownership/transfer`
export const TEAM_MANAGEMENT_OVERVIEW_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/overview`
export const TEAM_MANAGEMENT_INVITES_PATH = `${TEAM_MANAGEMENT_PATH_PREFIX}/invites`
export const TEAM_MANAGEMENT_INVITES_REVOKE_PATH = `${TEAM_MANAGEMENT_INVITES_PATH}/revoke`
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
  readonly keySource?: string
  readonly serverOrigin?: string
}

/** Browser-safe member projection with Host-computed ownership eligibility. */
export interface TeamManagementMemberSummary extends TeamMemberSummary {
  /** True only when this caller may target the member and a live Team key exists. */
  readonly canReceiveOwnership: boolean
}

/** Deliberately omits API-key summaries; the Browser never manages raw Team credentials. */
export interface TeamManagementOverview {
  readonly team: TeamSummary
  readonly currentMember: TeamMemberSummary
  readonly members: readonly TeamManagementMemberSummary[]
  readonly invites: readonly TeamInviteSummary[]
  readonly contributions: readonly TeamContributionAccountSummary[]
}

export interface TeamManagementConnectionResult {
  readonly team: TeamSummary
  readonly member: TeamMemberSummary
}

/** Minimum Browser projection after the Host has completed a durable Team departure. */
export interface TeamManagementDepartureResult {
  readonly member: TeamMemberSummary
}

/** Minimum Browser projection after an atomic Team ownership transfer. */
export interface TeamManagementOwnershipTransferResult {
  readonly formerOwner: TeamMemberSummary
  readonly owner: TeamMemberSummary
}

export interface TeamManagementInviteResult {
  readonly invite: TeamInviteSummary
  /** One-time value intentionally shown so an administrator can send it to a friend. */
  readonly inviteToken: string
}

export interface TeamManagementInviteRevocationResult {
  readonly invite: TeamInviteSummary
}

export interface TeamManagementOAuthResult {
  readonly account: TeamContributionAccountSummary
  readonly method: 'device_code'
  /** Provider verification URL intentionally returned; credentials remain on the Host. */
  readonly verificationUrl: string
  readonly userCode: string
  readonly expiresAt: number
}

export interface TeamManagementUsageResult {
  readonly events: readonly TeamUsageEventSummary[]
}

export interface TeamManagementTeamStatusResult {
  readonly team: TeamSummary & { readonly status: TeamStatus }
}

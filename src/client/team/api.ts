/** Runtime-validated same-origin client for the Host-owned Team management proxy. */

import {
  TEAM_MANAGEMENT_CAPABILITY_HEADER,
  TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH,
  TEAM_MANAGEMENT_DISCONNECT_PATH,
  TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH,
  TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH,
  TEAM_MANAGEMENT_DISSOLVE_PATH,
  TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_MANAGEMENT_INVITES_PATH,
  TEAM_MANAGEMENT_INVITES_PREVIEW_PATH,
  TEAM_MANAGEMENT_INVITES_REVEAL_PATH,
  TEAM_MANAGEMENT_INVITES_REVOKE_PATH,
  TEAM_MANAGEMENT_JOIN_PATH,
  TEAM_MANAGEMENT_JOIN_DISCARD_PATH,
  TEAM_MANAGEMENT_JOIN_RECOVER_PATH,
  TEAM_MANAGEMENT_LEAVE_PATH,
  TEAM_MANAGEMENT_MEMBERS_REMOVE_PATH,
  TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
  TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
  TEAM_MANAGEMENT_OAUTH_START_PATH,
  TEAM_MANAGEMENT_OVERVIEW_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH,
  TEAM_MANAGEMENT_SESSION_PATH,
  TEAM_MANAGEMENT_STATUS_PATH,
  TEAM_MANAGEMENT_TEAM_STATUS_PATH,
  TEAM_MANAGEMENT_USAGE_PATH,
} from '../../shared/team-management.ts'
import type {
  TeamDissolutionClearResult,
  TeamDissolutionInput,
  TeamDissolutionView,
  TeamConnectionTerminalClearResult,
  TeamConnectionTerminalView,
  TeamManagementConnectionResult,
  TeamManagementContributionPatch,
  TeamManagementContributionResult,
  TeamManagementContributionSummary,
  TeamManagementDepartureResult,
  TeamManagementDisplayNameMigrationAcknowledgement,
  TeamManagementExpectedContext,
  TeamManagementInviteResult,
  TeamManagementInvitePreview,
  TeamManagementInviteRevealResult,
  TeamManagementInviteRevocationResult,
  TeamManagementMemberResult,
  TeamManagementMemberSummary,
  TeamManagementOAuthResult,
  TeamManagementOverview,
  TeamManagementOwnershipTransferAcceptanceResult,
  TeamManagementOwnershipTransferSummary,
  TeamManagementStatus,
  TeamManagementSession,
  TeamManagementSharedAccountDirectoryEntry,
  TeamManagementTeamStatusResult,
  TeamManagementUsageResult,
} from '../../shared/team-management.ts'
import type {
  TeamContributionCapacityBucketSummary,
  TeamContributionCapacitySummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamSummary,
  TeamUsageAggregateSummary,
} from '../../team/types.ts'

type JsonObject = Record<string, unknown>
type Parser<T> = (value: unknown) => T

/** Browser-visible request failure with enough structure for recovery UX. */
export class TeamManagementRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'TeamManagementRequestError'
    this.status = status
  }
}

export function parseTeamManagementStatus(value: unknown): TeamManagementStatus {
  const item = object(value, 'Team management status')
  exactKeys(item, [
    'enabled',
    'keyConfigured',
    'keyWritable',
    'pendingJoinConfigured',
    'keySource',
    'serverOrigin',
    'dissolution',
    'connectionTerminal',
  ], 'Team management status')
  const enabled = booleanField(item, 'enabled')
  const keyConfigured = booleanField(item, 'keyConfigured')
  const keyWritable = booleanField(item, 'keyWritable')
  const pendingJoinConfigured = booleanField(item, 'pendingJoinConfigured')
  const keySource = optionalStringField(item, 'keySource')
  const serverOrigin = optionalStringField(item, 'serverOrigin')
  const dissolution = item.dissolution === undefined
    ? undefined
    : parseTeamDissolutionView(item.dissolution)
  const connectionTerminal = item.connectionTerminal === undefined
    ? undefined
    : parseTeamConnectionTerminalView(item.connectionTerminal)
  if (dissolution !== undefined && connectionTerminal !== undefined) {
    throw new Error('Team management status contains conflicting terminal states')
  }
  if (serverOrigin !== undefined) safeUrl(serverOrigin, 'serverOrigin')
  return {
    enabled,
    keyConfigured,
    keyWritable,
    pendingJoinConfigured,
    ...(keySource === undefined ? {} : { keySource }),
    ...(serverOrigin === undefined ? {} : { serverOrigin }),
    ...(dissolution === undefined ? {} : { dissolution }),
    ...(connectionTerminal === undefined ? {} : { connectionTerminal }),
  }
}

function parseTeamConnectionTerminalView(value: unknown): TeamConnectionTerminalView {
  const item = object(value, 'Team connection terminal')
  exactKeys(item, ['code', 'localCleanup'], 'Team connection terminal')
  return {
    code: unionField(item, 'code', ['member_removed', 'member_left', 'team_dissolved', 'device_revoked'] as const),
    localCleanup: unionField(item, 'localCleanup', ['completed', 'retry_required', 'manual_required'] as const),
  }
}

function parseTeamConnectionTerminalClearResult(value: unknown): TeamConnectionTerminalClearResult {
  const item = object(value, 'Team connection terminal clear result')
  if (item.cleared === true) {
    exactKeys(item, ['cleared'], 'Team connection terminal clear result')
    return { cleared: true }
  }
  return parseTeamConnectionTerminalView(value)
}

function parseTeamDissolutionView(value: unknown): TeamDissolutionView {
  const item = object(value, 'Team dissolution')
  const state = unionField(item, 'state', ['confirming', 'confirmed'] as const)
  if (state === 'confirming') {
    exactKeys(item, ['state', 'teamName', 'requestedAt'], 'Team dissolution')
    return {
      state,
      teamName: stringField(item, 'teamName'),
      requestedAt: boundedIntegerField(item, 'requestedAt', 0, Number.MAX_SAFE_INTEGER),
    }
  }
  const hasTeamName = item.teamName !== undefined
  const hasDissolvedAt = item.dissolvedAt !== undefined
  if (hasTeamName !== hasDissolvedAt) throw new Error('Team dissolution metadata is incomplete')
  exactKeys(
    item,
    hasTeamName ? ['state', 'teamName', 'dissolvedAt', 'localCleanup'] : ['state', 'localCleanup'],
    'Team dissolution',
  )
  return {
    state,
    ...(hasTeamName ? {
      teamName: stringField(item, 'teamName'),
      dissolvedAt: boundedIntegerField(item, 'dissolvedAt', 0, Number.MAX_SAFE_INTEGER),
    } : {}),
    localCleanup: unionField(item, 'localCleanup', ['completed', 'retry_required', 'manual_required'] as const),
  }
}

function parseTeamDissolutionClearResult(value: unknown): TeamDissolutionClearResult {
  const item = object(value, 'Team dissolution clear result')
  if (item.cleared === true) {
    exactKeys(item, ['cleared'], 'Team dissolution clear result')
    return { cleared: true }
  }
  return parseTeamDissolutionView(value)
}

function parseDisplayNameMigrationNotice(value: unknown): { readonly migrationVersion: number } {
  const item = object(value, 'Team display-name migration notice')
  exactKeys(item, ['migrationVersion'], 'Team display-name migration notice')
  return {
    migrationVersion: boundedIntegerField(item, 'migrationVersion', 1, Number.MAX_SAFE_INTEGER),
  }
}

function parseDisplayNameMigrationAcknowledgement(
  value: unknown,
  requestedMigrationVersion: number,
): TeamManagementDisplayNameMigrationAcknowledgement {
  const item = object(value, 'Team display-name migration acknowledgement')
  exactKeys(item, ['migrationVersion', 'acknowledged'], 'Team display-name migration acknowledgement')
  const migrationVersion = boundedIntegerField(item, 'migrationVersion', 1, Number.MAX_SAFE_INTEGER)
  if (migrationVersion !== requestedMigrationVersion || item.acknowledged !== true) {
    throw new Error('Team display-name migration acknowledgement does not match the request')
  }
  return { migrationVersion, acknowledged: true }
}

export function parseTeamManagementOverview(value: unknown): TeamManagementOverview {
  const item = object(value, 'Team overview')
  const team = parseTeam(item.team)
  const currentMember = parseMember(item.currentMember)
  const viewerRole = unionField(item, 'viewerRole', ['owner', 'member'] as const)
  if ((viewerRole === 'owner') !== (currentMember.role === 'owner')) {
    throw new Error('viewerRole is inconsistent with currentMember')
  }
  const contributions = arrayField(
    item,
    'contributions',
    value => parseContribution(value, currentMember.id),
  ).filter(account => account.ownerMemberId === currentMember.id)
  const pendingBrowserAuthorization = item.pendingBrowserAuthorization === undefined
    ? undefined
    : parsePendingBrowserAuthorization(item.pendingBrowserAuthorization, contributions)
  // Hosts released before the shared-account directory projection omitted this
  // additive field. Keep rolling upgrades usable while still validating every
  // entry once the field is present.
  const activeSharedAccounts = item.activeSharedAccounts === undefined
    ? []
    : arrayField(item, 'activeSharedAccounts', parseActiveSharedAccount)
  const ownershipTransfer = item.ownershipTransfer === undefined
    ? undefined
    : parseOwnershipTransferSummary(item.ownershipTransfer)
  const displayNameMigrationNotice = item.displayNameMigrationNotice === undefined
    ? undefined
    : parseDisplayNameMigrationNotice(item.displayNameMigrationNotice)
  if (
    ownershipTransfer !== undefined
    && (
      ownershipTransfer.teamId !== team.id
      || ownershipTransfer.status !== 'pending'
      || (currentMember.id !== ownershipTransfer.requestedByMemberId
        && currentMember.id !== ownershipTransfer.targetMemberId)
    )
  ) {
    throw new Error('Team ownership transfer is not visible to this member')
  }
  const base = {
    team,
    currentMember,
    members: arrayField(item, 'members', parseManagementMember),
    contributions,
    activeSharedAccounts,
    ...(pendingBrowserAuthorization === undefined ? {} : { pendingBrowserAuthorization }),
    ...(displayNameMigrationNotice === undefined ? {} : { displayNameMigrationNotice }),
    ...(ownershipTransfer === undefined ? {} : { ownershipTransfer }),
  }
  return viewerRole === 'owner'
    ? { viewerRole, ...base, invites: arrayField(item, 'invites', parseInvite) }
    : { viewerRole, ...base }
}

function parsePendingBrowserAuthorization(
  value: unknown,
  contributions: readonly TeamManagementContributionSummary[],
) {
  const item = object(value, 'pending browser authorization')
  exactKeys(
    item,
    ['accountId', 'method', 'expiresAt', 'discardInitial'],
    'pending browser authorization',
  )
  const pending = {
    accountId: stringField(item, 'accountId'),
    method: unionField(item, 'method', ['browser'] as const),
    expiresAt: boundedIntegerField(item, 'expiresAt', 0, Number.MAX_SAFE_INTEGER),
    discardInitial: booleanField(item, 'discardInitial'),
  }
  if (!contributions.some(account => (
    account.id === pending.accountId
    && account.status === 'authorizing'
  ))) {
    throw new Error('pending browser authorization has no matching authorizing account')
  }
  return pending
}

function parseActiveSharedAccount(value: unknown): TeamManagementSharedAccountDirectoryEntry {
  const item = object(value, 'active shared account')
  exactKeys(item, ['id', 'label', 'ownerMemberId', 'status'], 'active shared account')
  if (item.status !== 'active') throw new Error('active shared account status is invalid')
  return {
    id: stringField(item, 'id'),
    label: stringField(item, 'label'),
    ownerMemberId: stringField(item, 'ownerMemberId'),
    status: 'active',
  }
}

export function parseTeamManagementOAuthResult(value: unknown): TeamManagementOAuthResult {
  const item = object(value, 'OAuth challenge')
  if (item.method === 'browser') {
    const authorizationUrl = stringField(item, 'authorizationUrl')
    safeUrl(authorizationUrl, 'authorizationUrl')
    return {
      account: parseContribution(item.account),
      method: 'browser',
      authorizationUrl,
      expiresAt: numberField(item, 'expiresAt'),
    }
  }
  if (item.method !== 'device_code') throw new Error('OAuth method is unsupported')
  const verificationUrl = stringField(item, 'verificationUrl')
  safeUrl(verificationUrl, 'verificationUrl')
  const userCode = stringField(item, 'userCode')
  if (!/^[A-Za-z0-9-]{4,32}$/u.test(userCode)) throw new Error('OAuth userCode is invalid')
  return {
    account: parseContribution(item.account),
    method: 'device_code',
    verificationUrl,
    userCode,
    expiresAt: numberField(item, 'expiresAt'),
  }
}

function parseConnection(value: unknown): TeamManagementConnectionResult {
  const item = object(value, 'Team connection')
  return { team: parseTeam(item.team), member: parseMember(item.member) }
}

function parseDeparture(value: unknown): TeamManagementDepartureResult {
  const item = object(value, 'Team departure')
  const member = parseMember(item.member)
  if (member.status !== 'removed' || member.role === 'owner') throw new Error('Team departure member is invalid')
  return { member }
}

function parseOwnershipTransferSummary(value: unknown): TeamManagementOwnershipTransferSummary {
  const item = object(value, 'Team ownership transfer')
  const status = unionField(item, 'status', ['pending', 'accepted', 'rejected', 'revoked', 'expired', 'canceled'] as const)
  exactKeys(
    item,
    status === 'pending'
      ? ['id', 'teamId', 'requestedByMemberId', 'targetMemberId', 'status', 'createdAt', 'expiresAt']
      : ['id', 'teamId', 'requestedByMemberId', 'targetMemberId', 'status', 'createdAt', 'expiresAt', 'resolvedAt'],
    'Team ownership transfer',
  )
  const transfer = {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    requestedByMemberId: stringField(item, 'requestedByMemberId'),
    targetMemberId: stringField(item, 'targetMemberId'),
    status,
    createdAt: numberField(item, 'createdAt'),
    expiresAt: numberField(item, 'expiresAt'),
    ...(status === 'pending' ? {} : { resolvedAt: numberField(item, 'resolvedAt') }),
  } satisfies TeamManagementOwnershipTransferSummary
  if (
    transfer.requestedByMemberId === transfer.targetMemberId
    || transfer.expiresAt !== transfer.createdAt + 24 * 60 * 60 * 1000
    || ('resolvedAt' in transfer && transfer.resolvedAt < transfer.createdAt)
  ) {
    throw new Error('Team ownership transfer is invalid')
  }
  return transfer
}

function parseOwnershipTransferAcceptance(value: unknown): TeamManagementOwnershipTransferAcceptanceResult {
  const item = object(value, 'Team ownership transfer acceptance')
  exactKeys(item, ['transfer', 'formerOwner', 'owner'], 'Team ownership transfer acceptance')
  const transfer = parseOwnershipTransferSummary(item.transfer)
  const formerOwner = parseMember(item.formerOwner)
  const owner = parseMember(item.owner)
  if (
    transfer.status !== 'accepted'
    || formerOwner.role !== 'member'
    || formerOwner.status !== 'active'
    || owner.role !== 'owner'
    || owner.status !== 'active'
    || formerOwner.id === owner.id
    || formerOwner.teamId !== owner.teamId
    || formerOwner.teamId !== transfer.teamId
    || formerOwner.id !== transfer.requestedByMemberId
    || owner.id !== transfer.targetMemberId
  ) {
    throw new Error('Team ownership transfer is invalid')
  }
  return { transfer, formerOwner, owner }
}

function parseInviteResult(value: unknown): TeamManagementInviteResult {
  const item = object(value, 'Team invite')
  const inviteToken = stringField(item, 'inviteToken')
  if (!inviteToken.startsWith('dsh_invite_')) throw new Error('inviteToken is invalid')
  return { invite: parseInvite(item.invite), inviteToken }
}

function parseInviteRevocationResult(value: unknown): TeamManagementInviteRevocationResult {
  const item = object(value, 'Team invite revocation')
  return { invite: parseInvite(item.invite) }
}

function parseInviteRevealResult(value: unknown): TeamManagementInviteRevealResult {
  const item = object(value, 'Team invite reveal')
  const inviteToken = stringField(item, 'inviteToken')
  if (!inviteToken.startsWith('dsh_invite_')) throw new Error('inviteToken is invalid')
  return {
    inviteId: stringField(item, 'inviteId'),
    inviteToken,
    expiresAt: numberField(item, 'expiresAt'),
  }
}

function parseInvitePreview(value: unknown): TeamManagementInvitePreview {
  const item = object(value, 'Team invite preview')
  const joinHandle = stringField(item, 'joinHandle')
  if (!/^dsh_join_[A-Za-z0-9_-]{43}$/u.test(joinHandle)) throw new Error('joinHandle is invalid')
  return {
    teamName: stringField(item, 'teamName'),
    label: stringField(item, 'label'),
    expiresAt: numberField(item, 'expiresAt'),
    teamStatus: unionField(item, 'teamStatus', ['active', 'paused'] as const),
    joinHandle,
  }
}

function parseMemberResult(value: unknown): TeamManagementMemberResult {
  const item = object(value, 'Team member result')
  return { member: parseMember(item.member) }
}

function parseTeamStatusResult(value: unknown): TeamManagementTeamStatusResult {
  const item = object(value, 'Team status result')
  return { team: parseTeam(item.team) }
}

function parseContributionResult(value: unknown): TeamManagementContributionResult {
  const item = object(value, 'Contribution result')
  return { account: parseContribution(item.account) }
}

function parseUsageResult(value: unknown): TeamManagementUsageResult {
  const item = object(value, 'Team usage')
  const role = unionField(item, 'role', ['owner', 'member'] as const)
  if (item.currency !== 'USD') throw new Error('currency is invalid')
  const window = object(item.window, 'usage window')
  const startedAt = boundedIntegerField(window, 'startedAt', 0, Number.MAX_SAFE_INTEGER)
  const endedAt = boundedIntegerField(window, 'endedAt', 0, Number.MAX_SAFE_INTEGER)
  if (startedAt > endedAt) throw new Error('usage window is invalid')
  const base = {
    window: { startedAt, endedAt },
    currency: 'USD' as const,
    mine: parseUsageAggregate(item.mine, 'member usage aggregate'),
    ownedAccounts: item.ownedAccounts === undefined
      ? []
      : arrayField(item, 'ownedAccounts', parseOwnedAccountUsage),
  }
  if (role === 'member') return { role, ...base }
  return { role, ...base, team: parseUsageAggregate(item.team, 'Team usage aggregate') }
}

function parseOwnedAccountUsage(value: unknown) {
  const item = object(value, 'owned account usage')
  const window = parseUsageWindow(item.window, 'owned account usage window')
  const currentUtcWeek = item.currentUtcWeek === undefined
    ? undefined
    : (() => {
        const week = object(item.currentUtcWeek, 'owned account current UTC week')
        const weekWindow = parseUsageWindow(week.window, 'owned account current UTC week window')
        const resetAt = boundedIntegerField(week, 'resetAt', 0, Number.MAX_SAFE_INTEGER)
        if (resetAt < weekWindow.endedAt) throw new Error('owned account current UTC week reset is invalid')
        return {
          window: weekWindow,
          resetAt,
          aggregate: parseUsageAggregate(week.aggregate, 'owned account current UTC week aggregate'),
        }
      })()
  const last24Hours = item.last24Hours === undefined
    ? undefined
    : (() => {
        const day = object(item.last24Hours, 'owned account last 24 hours')
        return {
          window: parseUsageWindow(day.window, 'owned account last 24 hours window'),
          aggregate: parseUsageAggregate(day.aggregate, 'owned account last 24 hours aggregate'),
        }
      })()
  return {
    accountId: stringField(item, 'accountId'),
    window,
    aggregate: parseUsageAggregate(item.aggregate, 'owned account usage aggregate'),
    ...(currentUtcWeek === undefined ? {} : { currentUtcWeek }),
    ...(last24Hours === undefined ? {} : { last24Hours }),
    recentRequests: arrayField(item, 'recentRequests', value => {
      const request = object(value, 'recent request')
      const finishedAt = request.finishedAt === undefined ? undefined : numberField(request, 'finishedAt')
      const totalTokens = request.totalTokens === undefined ? undefined : boundedIntegerField(request, 'totalTokens', 0, Number.MAX_SAFE_INTEGER)
      const estimatedCostUsdMicros = request.estimatedCostUsdMicros === undefined ? undefined : stringField(request, 'estimatedCostUsdMicros')
      return {
        id: stringField(request, 'id'),
        model: stringField(request, 'model'),
        status: unionField(request, 'status', ['in_progress', 'succeeded', 'failed', 'cancelled'] as const),
        startedAt: numberField(request, 'startedAt'),
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(estimatedCostUsdMicros === undefined ? {} : { estimatedCostUsdMicros }),
      }
    }),
  }
}

function parseUsageWindow(value: unknown, label: string) {
  const window = object(value, label)
  const startedAt = boundedIntegerField(window, 'startedAt', 0, Number.MAX_SAFE_INTEGER)
  const endedAt = boundedIntegerField(window, 'endedAt', 0, Number.MAX_SAFE_INTEGER)
  if (startedAt > endedAt) throw new Error(`${label} is invalid`)
  return { startedAt, endedAt }
}

function parseTeam(value: unknown): TeamSummary {
  const item = object(value, 'team')
  return {
    id: stringField(item, 'id'),
    name: stringField(item, 'name'),
    status: unionField(item, 'status', ['active', 'paused'] as const),
    lifecycleRevision: boundedIntegerField(item, 'lifecycleRevision', 1, Number.MAX_SAFE_INTEGER),
    createdAt: numberField(item, 'createdAt'),
  }
}

function parseMember(value: unknown): TeamMemberSummary {
  const item = object(value, 'member')
  const role = unionField(item, 'role', ['owner', 'admin', 'member'] as const)
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    displayName: stringField(item, 'displayName'),
    role: role === 'owner' ? 'owner' : 'member',
    status: unionField(item, 'status', ['active', 'suspended', 'removed'] as const),
    joinedAt: numberField(item, 'joinedAt'),
  }
}

function parseManagementMember(value: unknown): TeamManagementMemberSummary {
  const item = object(value, 'member')
  return {
    ...parseMember(item),
    canReceiveOwnership: booleanField(item, 'canReceiveOwnership'),
  }
}

function parseInvite(value: unknown): TeamInviteSummary {
  const item = object(value, 'invite')
  const acceptedAt = optionalNumberField(item, 'acceptedAt')
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    invitedByMemberId: stringField(item, 'invitedByMemberId'),
    label: stringField(item, 'label'),
    status: unionField(item, 'status', ['pending', 'accepted', 'expired', 'revoked'] as const),
    revealable: booleanField(item, 'revealable'),
    expiresAt: numberField(item, 'expiresAt'),
    createdAt: numberField(item, 'createdAt'),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
  }
}

function parseContribution(value: unknown, capacityOwnerMemberId?: string): TeamManagementContributionSummary {
  const item = object(value, 'contribution')
  const maximum = item.maxSharedRequestsPerWindow
  if (maximum !== null && (typeof maximum !== 'number' || !Number.isInteger(maximum) || maximum <= 0)) {
    throw new Error('contribution.maxSharedRequestsPerWindow is invalid')
  }
  const lastError = optionalStringField(item, 'lastError')
  const weeklyLimit = item.weeklySharedEstimatedApiCostLimitMicros ?? null
  if (weeklyLimit !== null && (typeof weeklyLimit !== 'number' || !Number.isSafeInteger(weeklyLimit) || weeklyLimit < 0)) {
    throw new Error('contribution.weeklySharedEstimatedApiCostLimitMicros is invalid')
  }
  const ownerMemberId = stringField(item, 'ownerMemberId')
  const status = unionField(item, 'status', ['authorizing', 'active', 'paused', 'revoked', 'reauth_required'] as const)
  const capacity = item.capacity === undefined
    || ownerMemberId !== capacityOwnerMemberId
    || status !== 'active'
    ? undefined
    : parseCapacity(item.capacity)
  const sourceLocalProfileId = optionalStringField(item, 'sourceLocalProfileId')
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    ownerMemberId,
    label: stringField(item, 'label'),
    status,
    personalReservePercent: boundedNumberField(item, 'personalReservePercent', 0, 100),
    maxSharedRequestsPerWindow: maximum,
    weeklySharedEstimatedApiCostLimitMicros: weeklyLimit as number | null,
    maxSharedConcurrency: boundedIntegerField(item, 'maxSharedConcurrency', 1, 1_000),
    allowedModels: arrayField(item, 'allowedModels', value => shortString(value, 'allowed model')),
    createdAt: numberField(item, 'createdAt'),
    updatedAt: numberField(item, 'updatedAt'),
    ...(lastError === undefined ? {} : { lastError }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(sourceLocalProfileId === undefined ? {} : { sourceLocalProfileId }),
  }
}

const CAPACITY_REASONS = [
  'ready',
  'provider_unavailable',
  'quota_unavailable',
  'quota_exhausted',
  'reserve_reached',
  'shared_concurrency_reached',
  'request_cap_reset_unavailable',
  'request_cap_reached',
  'weekly_shared_cost_reached',
  'runtime_unavailable',
] as const

function parseCapacity(value: unknown): TeamContributionCapacitySummary {
  const item = object(value, 'contribution capacity')
  const sharedInFlight = item.sharedInFlight === undefined
    ? undefined
    : boundedIntegerField(item, 'sharedInFlight', 0, Number.MAX_SAFE_INTEGER)
  const buckets = arrayField(item, 'buckets', parseCapacityBucket)
  if (buckets.length === 0 || buckets.length > 2 || new Set(buckets.map(bucket => bucket.id)).size !== buckets.length) {
    throw new Error('contribution capacity buckets are invalid')
  }
  return {
    ...(sharedInFlight === undefined ? {} : { sharedInFlight }),
    buckets,
  }
}

function parseCapacityBucket(value: unknown): TeamContributionCapacityBucketSummary {
  const item = object(value, 'capacity bucket')
  const remainingPercent = item.remainingPercent === undefined
    ? undefined
    : boundedNumberField(item, 'remainingPercent', 0, 100)
  const resetAt = item.resetAt === undefined
    ? undefined
    : boundedIntegerField(item, 'resetAt', 0, Number.MAX_SAFE_INTEGER)
  const sharedRequestsUsed = item.sharedRequestsUsed === undefined
    ? undefined
    : boundedIntegerField(item, 'sharedRequestsUsed', 0, Number.MAX_SAFE_INTEGER)
  return {
    id: unionField(item, 'id', ['codex', 'codex_spark'] as const),
    reason: unionField(item, 'reason', CAPACITY_REASONS),
    ...(remainingPercent === undefined ? {} : { remainingPercent }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(sharedRequestsUsed === undefined ? {} : { sharedRequestsUsed }),
  }
}

function parseUsageAggregate(value: unknown, label: string): TeamUsageAggregateSummary {
  const item = object(value, label)
  const requestCount = boundedIntegerField(item, 'requestCount', 0, Number.MAX_SAFE_INTEGER)
  const tokenMeasuredRequestCount = boundedIntegerField(item, 'tokenMeasuredRequestCount', 0, Number.MAX_SAFE_INTEGER)
  const pricedRequestCount = boundedIntegerField(item, 'pricedRequestCount', 0, Number.MAX_SAFE_INTEGER)
  const totalTokens = nullableDecimalString(item.totalTokens, 'totalTokens')
  const estimatedCostUsdMicros = nullableDecimalString(item.estimatedCostUsdMicros, 'estimatedCostUsdMicros')
  if (tokenMeasuredRequestCount > requestCount) throw new Error('tokenMeasuredRequestCount exceeds requestCount')
  if (pricedRequestCount > tokenMeasuredRequestCount) throw new Error('pricedRequestCount exceeds tokenMeasuredRequestCount')
  if (requestCount === 0) {
    if (tokenMeasuredRequestCount !== 0 || pricedRequestCount !== 0 || totalTokens !== '0' || estimatedCostUsdMicros !== '0') {
      throw new Error('empty usage aggregate is invalid')
    }
  } else {
    if ((tokenMeasuredRequestCount === 0) !== (totalTokens === null)) {
      throw new Error('totalTokens is inconsistent with tokenMeasuredRequestCount')
    }
    if ((pricedRequestCount === 0) !== (estimatedCostUsdMicros === null)) {
      throw new Error('estimatedCostUsdMicros is inconsistent with pricedRequestCount')
    }
  }
  return { requestCount, tokenMeasuredRequestCount, pricedRequestCount, totalTokens, estimatedCostUsdMicros }
}

function nullableDecimalString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} is invalid`)
  return value
}

/** Small typed facade; raw remote documents never reach React state. */
export class TeamManagementApi {
  private session: TeamManagementSession | undefined
  private sessionRequest: Promise<TeamManagementSession> | undefined

  constructor(private readonly fetcher: typeof fetch) {}

  status(): Promise<TeamManagementStatus> {
    return this.request(TEAM_MANAGEMENT_STATUS_PATH, {}, parseTeamManagementStatus)
  }

  join(joinHandle: string, displayName: string): Promise<TeamManagementConnectionResult> {
    return this.request(TEAM_MANAGEMENT_JOIN_PATH, { method: 'POST', body: { joinHandle, displayName } }, parseConnection)
  }

  recoverJoin(): Promise<TeamManagementConnectionResult> {
    return this.request(TEAM_MANAGEMENT_JOIN_RECOVER_PATH, { method: 'POST', body: {} }, parseConnection)
  }

  discardPendingJoin(): Promise<{ discarded: true }> {
    return this.request(TEAM_MANAGEMENT_JOIN_DISCARD_PATH, { method: 'POST', body: {} }, value => {
      const item = object(value, 'pending Team join discard')
      if (item.discarded !== true) throw new Error('pending Team join discard is invalid')
      return { discarded: true }
    })
  }

  disconnect(revokeRemote: false): Promise<{ ok: true; remoteRevoked: boolean }>
  disconnect(revokeRemote: true, expectedContext: TeamManagementExpectedContext): Promise<{ ok: true; remoteRevoked: boolean }>
  disconnect(
    revokeRemote: boolean,
    expectedContext?: TeamManagementExpectedContext,
  ): Promise<{ ok: true; remoteRevoked: boolean }> {
    return this.request(TEAM_MANAGEMENT_DISCONNECT_PATH, {
      method: 'POST',
      body: { revokeRemote, ...(expectedContext === undefined ? {} : { expectedContext }) },
    }, value => {
      const item = object(value, 'disconnect result')
      if (item.disconnected !== true) throw new Error('disconnect result is invalid')
      return { ok: true, remoteRevoked: booleanField(item, 'remoteRevoked') }
    })
  }

  leaveTeam(expectedContext: TeamManagementExpectedContext): Promise<TeamManagementDepartureResult> {
    return this.request(TEAM_MANAGEMENT_LEAVE_PATH, { method: 'POST', body: { expectedContext } }, parseDeparture)
  }

  dissolveTeam(input: TeamDissolutionInput, expectedContext: TeamManagementExpectedContext): Promise<TeamDissolutionView> {
    return this.request(
      TEAM_MANAGEMENT_DISSOLVE_PATH,
      {
        method: 'POST',
        body: {
          confirmationName: input.confirmationName,
          expectedLifecycleRevision: input.expectedLifecycleRevision,
          expectedContext,
        },
      },
      parseTeamDissolutionView,
    )
  }

  recoverTeamDissolution(): Promise<TeamDissolutionView> {
    return this.request(
      TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH,
      { method: 'POST', body: {} },
      parseTeamDissolutionView,
    )
  }

  clearTeamDissolution(): Promise<TeamDissolutionClearResult> {
    return this.request(
      TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH,
      { method: 'POST', body: {} },
      parseTeamDissolutionClearResult,
    )
  }

  clearConnectionTerminal(): Promise<TeamConnectionTerminalClearResult> {
    return this.request(
      TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH,
      { method: 'POST', body: {} },
      parseTeamConnectionTerminalClearResult,
    )
  }

  requestOwnershipTransfer(
    targetMemberId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOwnershipTransferSummary> {
    return this.request(
      TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH,
      { method: 'POST', body: { targetMemberId, expectedContext } },
      parseOwnershipTransferSummary,
    )
  }

  acceptOwnershipTransfer(
    transferId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOwnershipTransferAcceptanceResult> {
    return this.request(
      TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH,
      { method: 'POST', body: { transferId, expectedContext } },
      parseOwnershipTransferAcceptance,
    )
  }

  rejectOwnershipTransfer(
    transferId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOwnershipTransferSummary> {
    return this.request(
      TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH,
      { method: 'POST', body: { transferId, expectedContext } },
      parseOwnershipTransferSummary,
    )
  }

  revokeOwnershipTransfer(
    transferId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOwnershipTransferSummary> {
    return this.request(
      TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH,
      { method: 'POST', body: { transferId, expectedContext } },
      parseOwnershipTransferSummary,
    )
  }

  overview(): Promise<TeamManagementOverview> {
    return this.request(TEAM_MANAGEMENT_OVERVIEW_PATH, {}, parseTeamManagementOverview)
  }

  acknowledgeDisplayNameMigration(
    migrationVersion: number,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementDisplayNameMigrationAcknowledgement> {
    if (!Number.isSafeInteger(migrationVersion) || migrationVersion < 1) {
      return Promise.reject(new Error('migrationVersion is invalid'))
    }
    return this.request(
      TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH,
      { method: 'POST', body: { migrationVersion, expectedContext } },
      value => parseDisplayNameMigrationAcknowledgement(value, migrationVersion),
    )
  }

  previewInvite(inviteToken: string): Promise<TeamManagementInvitePreview> {
    return this.request(TEAM_MANAGEMENT_INVITES_PREVIEW_PATH, { method: 'POST', body: { inviteToken } }, parseInvitePreview)
  }

  createInvite(
    label: string,
    expiresInMs: number,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementInviteResult> {
    return this.request(
      TEAM_MANAGEMENT_INVITES_PATH,
      { method: 'POST', body: { label, expiresInMs, expectedContext } },
      parseInviteResult,
    )
  }

  revealInvite(inviteId: string, expectedContext: TeamManagementExpectedContext): Promise<TeamManagementInviteRevealResult> {
    return this.request(
      TEAM_MANAGEMENT_INVITES_REVEAL_PATH,
      { method: 'POST', body: { inviteId, expectedContext } },
      value => {
        const result = parseInviteRevealResult(value)
        if (result.inviteId !== inviteId) throw new Error('inviteId does not match the reveal request')
        return result
      },
    )
  }

  revokeInvite(inviteId: string, expectedContext: TeamManagementExpectedContext): Promise<TeamManagementInviteRevocationResult> {
    return this.request(
      TEAM_MANAGEMENT_INVITES_REVOKE_PATH,
      { method: 'POST', body: { inviteId, expectedContext } },
      parseInviteRevocationResult,
    )
  }

  removeMember(memberId: string, expectedContext: TeamManagementExpectedContext): Promise<TeamManagementMemberResult> {
    return this.request(
      TEAM_MANAGEMENT_MEMBERS_REMOVE_PATH,
      { method: 'POST', body: { memberId, expectedContext } },
      parseMemberResult,
    )
  }

  setTeamStatus(
    status: 'active' | 'paused',
    expectedLifecycleRevision: number,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementTeamStatusResult> {
    return this.request(
      TEAM_MANAGEMENT_TEAM_STATUS_PATH,
      { method: 'POST', body: { status, expectedLifecycleRevision, expectedContext } },
      parseTeamStatusResult,
    )
  }

  startOAuth(
    label: string,
    expectedContext: TeamManagementExpectedContext,
    method: 'browser' | 'device_code' = 'browser',
    sourceLocalProfileId?: string,
  ): Promise<TeamManagementOAuthResult> {
    return this.request(
      TEAM_MANAGEMENT_OAUTH_START_PATH,
      {
        method: 'POST',
        body: {
          label,
          expectedContext,
          method,
          ...(sourceLocalProfileId === undefined ? {} : { sourceLocalProfileId }),
        },
      },
      parseTeamManagementOAuthResult,
    )
  }

  cancelOAuth(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
    discardInitial = false,
  ): Promise<TeamManagementContributionResult> {
    return this.request(
      TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
      { method: 'POST', body: { accountId, expectedContext, discardInitial } },
      parseContributionResult,
    )
  }

  reauthorizeOAuth(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
    method: 'browser' | 'device_code' = 'browser',
  ): Promise<TeamManagementOAuthResult> {
    return this.request(
      TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
      { method: 'POST', body: { accountId, expectedContext, method } },
      parseTeamManagementOAuthResult,
    )
  }

  updateContribution(
    accountId: string,
    patch: TeamManagementContributionPatch,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementContributionResult> {
    const body: JsonObject = {
      accountId,
      expectedContext,
      ...patch.label === undefined ? {} : { label: patch.label },
      ...patch.status === undefined ? {} : { status: patch.status },
      ...patch.personalReservePercent === undefined ? {} : { personalReservePercent: patch.personalReservePercent },
      ...patch.maxSharedRequestsPerWindow === undefined ? {} : { maxSharedRequestsPerWindow: patch.maxSharedRequestsPerWindow },
      ...patch.weeklySharedEstimatedApiCostLimitMicros === undefined ? {} : { weeklySharedEstimatedApiCostLimitMicros: patch.weeklySharedEstimatedApiCostLimitMicros },
      ...patch.maxSharedConcurrency === undefined ? {} : { maxSharedConcurrency: patch.maxSharedConcurrency },
      ...patch.allowedModels === undefined ? {} : { allowedModels: [...patch.allowedModels] },
    }
    return this.request(TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH, { method: 'POST', body }, parseContributionResult)
  }

  revokeContribution(accountId: string, expectedContext: TeamManagementExpectedContext): Promise<TeamManagementContributionResult> {
    return this.request(
      TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH,
      { method: 'POST', body: { accountId, expectedContext } },
      parseContributionResult,
    )
  }

  usage(_limit = 50): Promise<TeamManagementUsageResult> {
    return this.request(TEAM_MANAGEMENT_USAGE_PATH, {}, parseUsageResult)
  }

  private async request<T>(
    path: string,
    options: { method?: 'POST'; body?: JsonObject },
    parse: Parser<T>,
  ): Promise<T> {
    let capability = options.method === 'POST' ? await this.managementCapability() : undefined
    let response = await this.dispatch(path, options, capability)
    if (options.method === 'POST' && await isCapabilityRejected(response)) {
      this.session = undefined
      capability = await this.managementCapability()
      response = await this.dispatch(path, options, capability)
    }
    if (!response.ok) {
      const message = await safeResponseError(response)
      throw new TeamManagementRequestError(response.status, message ?? `Team management request failed (${response.status})`)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.startsWith('application/json')) throw new Error('Team management returned a non-JSON response')
    return parse(await response.json())
  }

  private dispatch(
    path: string,
    options: { method?: 'POST'; body?: JsonObject },
    capability: string | undefined,
  ): Promise<Response> {
    return this.fetcher(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(capability === undefined ? {} : { [TEAM_MANAGEMENT_CAPABILITY_HEADER]: capability }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }

  private async managementCapability(): Promise<string> {
    const active = this.session
    if (active !== undefined && active.expiresAt > Date.now() + 5_000) return active.capability
    if (this.sessionRequest !== undefined) return (await this.sessionRequest).capability

    const request = this.issueManagementSession()
    this.sessionRequest = request
    try {
      const session = await request
      this.session = session
      return session.capability
    } finally {
      if (this.sessionRequest === request) this.sessionRequest = undefined
    }
  }

  private async issueManagementSession(): Promise<TeamManagementSession> {
    const response = await this.fetcher(TEAM_MANAGEMENT_SESSION_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!response.ok) {
      const message = await safeResponseError(response)
      throw new TeamManagementRequestError(response.status, message ?? `Team management session failed (${response.status})`)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.startsWith('application/json')) throw new Error('Team management session returned a non-JSON response')
    const item = object(await response.json(), 'Team management session')
    const capability = stringField(item, 'capability')
    const expiresAt = numberField(item, 'expiresAt')
    if (!/^dsh_tm_[A-Za-z0-9_-]{43}$/u.test(capability) || !Number.isInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Team management session is invalid')
    }
    return { capability, expiresAt }
  }
}

export function createTeamManagementApi(fetcher: typeof fetch = globalThis.fetch): TeamManagementApi {
  return new TeamManagementApi(fetcher.bind(globalThis))
}

async function safeResponseError(response: Response): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return undefined
  try {
    const item = object(await response.json(), 'error response')
    if (typeof item.error === 'string' && item.error.length > 0 && item.error.length <= 400) return item.error
    if (isForbiddenError(item)) return 'Team management request is forbidden'
    return undefined
  } catch {
    return undefined
  }
}

async function isCapabilityRejected(response: Response): Promise<boolean> {
  if (response.status !== 403 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return false
  try {
    return isForbiddenError(object(await response.clone().json(), 'error response'))
  } catch {
    return false
  }
}

function isForbiddenError(item: JsonObject): boolean {
  if (typeof item.error !== 'object' || item.error === null || Array.isArray(item.error)) return false
  return (item.error as JsonObject).code === 'team_management_forbidden'
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function exactKeys(item: JsonObject, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(item).find(key => !allowed.includes(key))
  if (unexpected !== undefined) throw new Error(`${label} has unexpected field ${unexpected}`)
}

function shortString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error(`${label} is invalid`)
  return value
}

function stringField(item: JsonObject, key: string): string {
  return shortString(item[key], key)
}

function optionalStringField(item: JsonObject, key: string): string | undefined {
  return item[key] === undefined ? undefined : stringField(item, key)
}

function numberField(item: JsonObject, key: string): number {
  const value = item[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} is invalid`)
  return value
}

function optionalNumberField(item: JsonObject, key: string): number | undefined {
  return item[key] === undefined ? undefined : numberField(item, key)
}

function booleanField(item: JsonObject, key: string): boolean {
  const value = item[key]
  if (typeof value !== 'boolean') throw new Error(`${key} is invalid`)
  return value
}

function boundedNumberField(item: JsonObject, key: string, minimum: number, maximum: number): number {
  const value = numberField(item, key)
  if (value < minimum || value > maximum) throw new Error(`${key} is invalid`)
  return value
}

function boundedIntegerField(item: JsonObject, key: string, minimum: number, maximum: number): number {
  const value = boundedNumberField(item, key, minimum, maximum)
  if (!Number.isInteger(value)) throw new Error(`${key} is invalid`)
  return value
}

function unionField<const T extends readonly string[]>(item: JsonObject, key: string, values: T): T[number] {
  const value = item[key]
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${key} is invalid`)
  return value
}

function arrayField<T>(item: JsonObject, key: string, parse: Parser<T>): readonly T[] {
  const value = item[key]
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(`${key} is invalid`)
  return value.map(parse)
}

function safeUrl(value: string, label: string): void {
  const parsed = new URL(value)
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error(`${label} is unsafe`)
}

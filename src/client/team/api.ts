/** Runtime-validated same-origin client for the Host-owned Team management proxy. */

import {
  TEAM_MANAGEMENT_CONNECT_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH,
  TEAM_MANAGEMENT_DISCONNECT_PATH,
  TEAM_MANAGEMENT_INVITES_PATH,
  TEAM_MANAGEMENT_INVITES_REVOKE_PATH,
  TEAM_MANAGEMENT_JOIN_PATH,
  TEAM_MANAGEMENT_LEAVE_PATH,
  TEAM_MANAGEMENT_OAUTH_CANCEL_PATH,
  TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
  TEAM_MANAGEMENT_OAUTH_START_PATH,
  TEAM_MANAGEMENT_OVERVIEW_PATH,
  TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH,
  TEAM_MANAGEMENT_STATUS_PATH,
  TEAM_MANAGEMENT_TEAM_STATUS_PATH,
  TEAM_MANAGEMENT_USAGE_PATH,
} from '../../shared/team-management.ts'
import type {
  TeamManagementConnectionResult,
  TeamManagementDepartureResult,
  TeamManagementInviteResult,
  TeamManagementInviteRevocationResult,
  TeamManagementMemberSummary,
  TeamManagementOAuthResult,
  TeamManagementOverview,
  TeamManagementOwnershipTransferResult,
  TeamManagementStatus,
  TeamManagementTeamStatusResult,
  TeamManagementUsageResult,
} from '../../shared/team-management.ts'
import type {
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamContributionCapacityBucketSummary,
  TeamContributionCapacitySummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamSummary,
  TeamUsageEventSummary,
} from '../../team/types.ts'

type JsonObject = Record<string, unknown>
type Parser<T> = (value: unknown) => T

export function parseTeamManagementStatus(value: unknown): TeamManagementStatus {
  const item = object(value, 'Team management status')
  const enabled = booleanField(item, 'enabled')
  const keyConfigured = booleanField(item, 'keyConfigured')
  const keyWritable = booleanField(item, 'keyWritable')
  const keySource = optionalStringField(item, 'keySource')
  const serverOrigin = optionalStringField(item, 'serverOrigin')
  if (serverOrigin !== undefined) safeUrl(serverOrigin, 'serverOrigin')
  return {
    enabled,
    keyConfigured,
    keyWritable,
    ...(keySource === undefined ? {} : { keySource }),
    ...(serverOrigin === undefined ? {} : { serverOrigin }),
  }
}

export function parseTeamManagementOverview(value: unknown): TeamManagementOverview {
  const item = object(value, 'Team overview')
  const currentMember = parseMember(item.currentMember)
  return {
    team: parseTeam(item.team),
    currentMember,
    members: arrayField(item, 'members', parseManagementMember),
    invites: arrayField(item, 'invites', parseInvite),
    contributions: arrayField(item, 'contributions', value => parseContribution(value, currentMember.id)),
  }
}

export function parseTeamManagementOAuthResult(value: unknown): TeamManagementOAuthResult {
  const item = object(value, 'OAuth challenge')
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

function parseOwnershipTransfer(value: unknown): TeamManagementOwnershipTransferResult {
  const item = object(value, 'Team ownership transfer')
  const formerOwner = parseMember(item.formerOwner)
  const owner = parseMember(item.owner)
  if (
    formerOwner.role !== 'admin'
    || formerOwner.status !== 'active'
    || owner.role !== 'owner'
    || owner.status !== 'active'
    || formerOwner.id === owner.id
    || formerOwner.teamId !== owner.teamId
  ) {
    throw new Error('Team ownership transfer is invalid')
  }
  return { formerOwner, owner }
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

function parseTeamStatusResult(value: unknown): TeamManagementTeamStatusResult {
  const item = object(value, 'Team status result')
  return { team: parseTeam(item.team) }
}

function parseContributionResult(value: unknown): { account: TeamContributionAccountSummary } {
  const item = object(value, 'Contribution result')
  return { account: parseContribution(item.account) }
}

function parseUsageResult(value: unknown): TeamManagementUsageResult {
  const item = object(value, 'Team usage')
  return { events: arrayField(item, 'events', parseUsageEvent) }
}

function parseTeam(value: unknown): TeamSummary {
  const item = object(value, 'team')
  return {
    id: stringField(item, 'id'),
    name: stringField(item, 'name'),
    status: unionField(item, 'status', ['active', 'paused'] as const),
    createdAt: numberField(item, 'createdAt'),
  }
}

function parseMember(value: unknown): TeamMemberSummary {
  const item = object(value, 'member')
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    displayName: stringField(item, 'displayName'),
    role: unionField(item, 'role', ['owner', 'admin', 'member'] as const),
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
    status: unionField(item, 'status', ['pending', 'accepted', 'expired', 'revoked'] as const),
    expiresAt: numberField(item, 'expiresAt'),
    createdAt: numberField(item, 'createdAt'),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
  }
}

function parseContribution(value: unknown, capacityOwnerMemberId?: string): TeamContributionAccountSummary {
  const item = object(value, 'contribution')
  const maximum = item.maxSharedRequestsPerWindow
  if (maximum !== null && (typeof maximum !== 'number' || !Number.isInteger(maximum) || maximum <= 0)) {
    throw new Error('contribution.maxSharedRequestsPerWindow is invalid')
  }
  const lastError = optionalStringField(item, 'lastError')
  const ownerMemberId = stringField(item, 'ownerMemberId')
  const status = unionField(item, 'status', ['authorizing', 'active', 'paused', 'revoked', 'reauth_required'] as const)
  const capacity = item.capacity === undefined
    || ownerMemberId !== capacityOwnerMemberId
    || status !== 'active'
    ? undefined
    : parseCapacity(item.capacity)
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    ownerMemberId,
    label: stringField(item, 'label'),
    status,
    personalReservePercent: boundedNumberField(item, 'personalReservePercent', 0, 100),
    maxSharedRequestsPerWindow: maximum,
    maxSharedConcurrency: boundedIntegerField(item, 'maxSharedConcurrency', 1, 1_000),
    allowedModels: arrayField(item, 'allowedModels', value => shortString(value, 'allowed model')),
    createdAt: numberField(item, 'createdAt'),
    updatedAt: numberField(item, 'updatedAt'),
    ...(lastError === undefined ? {} : { lastError }),
    ...(capacity === undefined ? {} : { capacity }),
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

function parseUsageEvent(value: unknown): TeamUsageEventSummary {
  const item = object(value, 'usage event')
  const finishedAt = optionalNumberField(item, 'finishedAt')
  if (item.unit !== 'request') throw new Error('usage event unit is invalid')
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    consumerMemberId: stringField(item, 'consumerMemberId'),
    upstreamOwnerMemberId: stringField(item, 'upstreamOwnerMemberId'),
    upstreamAccountId: stringField(item, 'upstreamAccountId'),
    model: stringField(item, 'model'),
    unit: 'request',
    status: unionField(item, 'status', ['in_progress', 'succeeded', 'failed', 'cancelled'] as const),
    startedAt: numberField(item, 'startedAt'),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  }
}

/** Small typed facade; raw remote documents never reach React state. */
export class TeamManagementApi {
  constructor(private readonly fetcher: typeof fetch) {}

  status(): Promise<TeamManagementStatus> {
    return this.request(TEAM_MANAGEMENT_STATUS_PATH, {}, parseTeamManagementStatus)
  }

  connect(apiKey: string): Promise<TeamManagementConnectionResult> {
    return this.request(TEAM_MANAGEMENT_CONNECT_PATH, { method: 'POST', body: { apiKey } }, parseConnection)
  }

  join(inviteToken: string, displayName: string): Promise<TeamManagementConnectionResult> {
    return this.request(TEAM_MANAGEMENT_JOIN_PATH, { method: 'POST', body: { inviteToken, displayName } }, parseConnection)
  }

  disconnect(revokeRemote: boolean): Promise<{ ok: true; remoteRevoked: boolean }> {
    return this.request(TEAM_MANAGEMENT_DISCONNECT_PATH, { method: 'POST', body: { revokeRemote } }, value => {
      const item = object(value, 'disconnect result')
      if (item.ok !== true) throw new Error('disconnect result is invalid')
      return { ok: true, remoteRevoked: booleanField(item, 'remoteRevoked') }
    })
  }

  leaveTeam(): Promise<TeamManagementDepartureResult> {
    return this.request(TEAM_MANAGEMENT_LEAVE_PATH, { method: 'POST', body: {} }, parseDeparture)
  }

  transferOwnership(targetMemberId: string): Promise<TeamManagementOwnershipTransferResult> {
    return this.request(
      TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH,
      { method: 'POST', body: { targetMemberId } },
      parseOwnershipTransfer,
    )
  }

  overview(): Promise<TeamManagementOverview> {
    return this.request(TEAM_MANAGEMENT_OVERVIEW_PATH, {}, parseTeamManagementOverview)
  }

  createInvite(expiresInMs = 7 * 24 * 60 * 60 * 1000): Promise<TeamManagementInviteResult> {
    return this.request(TEAM_MANAGEMENT_INVITES_PATH, { method: 'POST', body: { expiresInMs } }, parseInviteResult)
  }

  revokeInvite(inviteId: string): Promise<TeamManagementInviteRevocationResult> {
    return this.request(
      TEAM_MANAGEMENT_INVITES_REVOKE_PATH,
      { method: 'POST', body: { inviteId } },
      parseInviteRevocationResult,
    )
  }

  setTeamStatus(status: 'active' | 'paused'): Promise<TeamManagementTeamStatusResult> {
    return this.request(TEAM_MANAGEMENT_TEAM_STATUS_PATH, { method: 'POST', body: { status } }, parseTeamStatusResult)
  }

  startOAuth(label: string): Promise<TeamManagementOAuthResult> {
    return this.request(TEAM_MANAGEMENT_OAUTH_START_PATH, { method: 'POST', body: { label } }, parseTeamManagementOAuthResult)
  }

  cancelOAuth(accountId: string): Promise<{ account: TeamContributionAccountSummary }> {
    return this.request(TEAM_MANAGEMENT_OAUTH_CANCEL_PATH, { method: 'POST', body: { accountId } }, parseContributionResult)
  }

  reauthorizeOAuth(accountId: string): Promise<TeamManagementOAuthResult> {
    return this.request(
      TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH,
      { method: 'POST', body: { accountId } },
      parseTeamManagementOAuthResult,
    )
  }

  updateContribution(accountId: string, patch: TeamContributionAccountPatch): Promise<{ account: TeamContributionAccountSummary }> {
    return this.request(TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH, { method: 'POST', body: { accountId, ...patch } }, parseContributionResult)
  }

  revokeContribution(accountId: string): Promise<{ account: TeamContributionAccountSummary }> {
    return this.request(TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH, { method: 'POST', body: { accountId } }, parseContributionResult)
  }

  usage(_limit = 50): Promise<TeamManagementUsageResult> {
    return this.request(TEAM_MANAGEMENT_USAGE_PATH, {}, parseUsageResult)
  }

  private async request<T>(
    path: string,
    options: { method?: 'POST'; body?: JsonObject },
    parse: Parser<T>,
  ): Promise<T> {
    const response = await this.fetcher(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    if (!response.ok) {
      const message = await safeResponseError(response)
      throw new Error(message ?? `Team management request failed (${response.status})`)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.startsWith('application/json')) throw new Error('Team management returned a non-JSON response')
    return parse(await response.json())
  }
}

export function createTeamManagementApi(fetcher: typeof fetch = globalThis.fetch): TeamManagementApi {
  return new TeamManagementApi(fetcher.bind(globalThis))
}

async function safeResponseError(response: Response): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return undefined
  try {
    const item = object(await response.json(), 'error response')
    return typeof item.error === 'string' && item.error.length > 0 && item.error.length <= 400
      ? item.error
      : undefined
  } catch {
    return undefined
  }
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonObject
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

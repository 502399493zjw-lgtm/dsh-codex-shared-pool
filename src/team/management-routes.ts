/** Local same-origin Team management proxy. Raw Team keys remain Host-only. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  TEAM_MANAGEMENT_CONNECT_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH,
  TEAM_MANAGEMENT_CONTRIBUTIONS_PATH,
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
} from '../shared/team-management.ts'
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
  TeamManagementUsageResult,
} from '../shared/team-management.ts'
import {
  TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH,
  TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH,
  TEAM_CONTRIBUTION_OAUTH_START_PATH,
  TEAM_CONTRIBUTION_REVOKE_PATH,
  TEAM_CONTRIBUTION_UPDATE_PATH,
  TEAM_CONTRIBUTIONS_PATH,
  TEAM_CURRENT_KEY_REVOKE_PATH,
  TEAM_INVITES_PATH,
  TEAM_INVITES_REVOKE_PATH,
  TEAM_JOIN_PATH,
  TEAM_MEMBERS_LEAVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH,
  TEAM_OVERVIEW_PATH,
  TEAM_PATH_PREFIX,
  TEAM_STATUS_PATH,
  TEAM_USAGE_PATH,
} from './types.ts'
import type {
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamContributionCapacityBucketSummary,
  TeamContributionCapacitySummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamSummary,
  TeamUsageEventSummary,
} from './types.ts'
import {
  DEFAULT_TEAM_CLIENT_API_KEY_REF,
  resolveTeamClientBaseUrl,
} from './client.ts'
import type { TeamClientConfig } from './client.ts'
import { safeTeamErrorMessage } from './safe-message.ts'

const MAX_LOCAL_BODY_BYTES = 16 * 1024
const MAX_REMOTE_BODY_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

type Credentials = Pick<CredentialProvider, 'resolve' | 'describe' | 'set' | 'unset'>

export interface TeamManagementRouteOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function safeMessage(error: unknown): string {
  return safeTeamErrorMessage(error, 500)
}

function statusFor(error: unknown): number {
  const message = safeMessage(error)
  if (/not enabled|not configured/iu.test(message)) return 409
  if (/not writable/iu.test(message)) return 409
  if (/unauthorized|API key|required/iu.test(message)) return 401
  if (/forbidden|administrator role|only the/iu.test(message)) return 403
  if (/not found/iu.test(message)) return 404
  if (/timed out|unavailable|remote Team/iu.test(message)) return 502
  return 400
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new Error('content-type must be application/json')
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.byteLength
    if (bytes > MAX_LOCAL_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(data)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
  return record(value, 'request body')
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('request contains an unknown field')
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate.trim().length === 0) throw new Error(`${key} must be a non-empty string`)
  return candidate.trim()
}

function optionalInteger(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (!Number.isSafeInteger(candidate)) throw new Error(`${key} must be an integer`)
  return candidate as number
}

function requiredInteger(value: Record<string, unknown>, key: string): number {
  const candidate = optionalInteger(value, key)
  if (candidate === undefined) throw new Error(`${key} must be an integer`)
  return candidate
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string') throw new Error(`remote Team returned an invalid ${key}`)
  return candidate
}

function numberField(value: Record<string, unknown>, key: string): number {
  const candidate = value[key]
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new Error(`remote Team returned an invalid ${key}`)
  return candidate
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`remote Team returned an invalid ${key}`)
  return [...value] as string[]
}

function objectArray<T>(value: unknown, key: string, project: (candidate: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`remote Team returned an invalid ${key}`)
  return value.map(project)
}

function projectTeam(value: unknown): TeamSummary {
  const item = record(value, 'team')
  const status = stringField(item, 'status')
  if (status !== 'active' && status !== 'paused') throw new Error('remote Team returned an invalid status')
  return { id: stringField(item, 'id'), name: stringField(item, 'name'), status, createdAt: numberField(item, 'createdAt') }
}

function projectMember(value: unknown): TeamMemberSummary {
  const item = record(value, 'member')
  const role = stringField(item, 'role')
  const status = stringField(item, 'status')
  if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new Error('remote Team returned an invalid role')
  if (status !== 'active' && status !== 'suspended' && status !== 'removed') throw new Error('remote Team returned an invalid member status')
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    displayName: stringField(item, 'displayName'),
    role,
    status,
    joinedAt: numberField(item, 'joinedAt'),
  }
}

function projectInvite(value: unknown): TeamInviteSummary {
  const item = record(value, 'invite')
  const status = stringField(item, 'status')
  if (status !== 'pending' && status !== 'accepted' && status !== 'expired' && status !== 'revoked') {
    throw new Error('remote Team returned an invalid invite status')
  }
  const acceptedAt = item.acceptedAt === undefined ? undefined : numberField(item, 'acceptedAt')
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    invitedByMemberId: stringField(item, 'invitedByMemberId'),
    status,
    expiresAt: numberField(item, 'expiresAt'),
    createdAt: numberField(item, 'createdAt'),
    ...acceptedAt === undefined ? {} : { acceptedAt },
  }
}

function projectContribution(value: unknown, capacityOwnerMemberId?: string): TeamContributionAccountSummary {
  const item = record(value, 'contribution')
  const status = stringField(item, 'status')
  if (!['authorizing', 'active', 'paused', 'revoked', 'reauth_required'].includes(status)) {
    throw new Error('remote Team returned an invalid contribution status')
  }
  const cap = item.maxSharedRequestsPerWindow
  if (cap !== null && (typeof cap !== 'number' || !Number.isSafeInteger(cap))) {
    throw new Error('remote Team returned an invalid request cap')
  }
  const lastError = item.lastError === undefined
    ? undefined
    : safeTeamErrorMessage(stringField(item, 'lastError'))
  const ownerMemberId = stringField(item, 'ownerMemberId')
  const capacity = item.capacity === undefined
    || ownerMemberId !== capacityOwnerMemberId
    || status !== 'active'
    ? undefined
    : projectCapacity(item.capacity)
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    ownerMemberId,
    label: stringField(item, 'label'),
    status: status as TeamContributionAccountSummary['status'],
    personalReservePercent: numberField(item, 'personalReservePercent'),
    maxSharedRequestsPerWindow: cap as number | null,
    maxSharedConcurrency: numberField(item, 'maxSharedConcurrency'),
    allowedModels: stringArray(item.allowedModels, 'allowedModels'),
    createdAt: numberField(item, 'createdAt'),
    updatedAt: numberField(item, 'updatedAt'),
    ...lastError === undefined ? {} : { lastError },
    ...capacity === undefined ? {} : { capacity },
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

function projectCapacity(value: unknown): TeamContributionCapacitySummary {
  const item = record(value, 'contribution capacity')
  const sharedInFlight = item.sharedInFlight === undefined
    ? undefined
    : safeNonNegativeInteger(item, 'sharedInFlight')
  const buckets = objectArray(item.buckets, 'capacity buckets', projectCapacityBucket)
  if (buckets.length === 0 || buckets.length > 2 || new Set(buckets.map(bucket => bucket.id)).size !== buckets.length) {
    throw new Error('remote Team returned invalid capacity buckets')
  }
  return {
    ...sharedInFlight === undefined ? {} : { sharedInFlight },
    buckets,
  }
}

function projectCapacityBucket(value: unknown): TeamContributionCapacityBucketSummary {
  const item = record(value, 'capacity bucket')
  const id = stringField(item, 'id')
  if (id !== 'codex' && id !== 'codex_spark') throw new Error('remote Team returned an invalid capacity bucket id')
  const reason = stringField(item, 'reason')
  if (!CAPACITY_REASONS.includes(reason as typeof CAPACITY_REASONS[number])) {
    throw new Error('remote Team returned an invalid capacity reason')
  }
  const remainingPercent = item.remainingPercent === undefined
    ? undefined
    : numberField(item, 'remainingPercent')
  if (remainingPercent !== undefined && (remainingPercent < 0 || remainingPercent > 100)) {
    throw new Error('remote Team returned an invalid remaining percentage')
  }
  const resetAt = item.resetAt === undefined ? undefined : safeNonNegativeInteger(item, 'resetAt')
  const sharedRequestsUsed = item.sharedRequestsUsed === undefined
    ? undefined
    : safeNonNegativeInteger(item, 'sharedRequestsUsed')
  return {
    id,
    reason: reason as TeamContributionCapacityBucketSummary['reason'],
    ...remainingPercent === undefined ? {} : { remainingPercent },
    ...resetAt === undefined ? {} : { resetAt },
    ...sharedRequestsUsed === undefined ? {} : { sharedRequestsUsed },
  }
}

function safeNonNegativeInteger(item: Record<string, unknown>, key: string): number {
  const value = numberField(item, key)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`remote Team returned an invalid ${key}`)
  return value
}

function projectUsage(value: unknown): TeamUsageEventSummary {
  const item = record(value, 'usage event')
  const status = stringField(item, 'status')
  if (!['in_progress', 'succeeded', 'failed', 'cancelled'].includes(status)) throw new Error('remote Team returned an invalid usage status')
  const unit = stringField(item, 'unit')
  if (unit !== 'request') throw new Error('remote Team returned an invalid usage unit')
  const finishedAt = item.finishedAt === undefined ? undefined : numberField(item, 'finishedAt')
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    consumerMemberId: stringField(item, 'consumerMemberId'),
    upstreamOwnerMemberId: stringField(item, 'upstreamOwnerMemberId'),
    upstreamAccountId: stringField(item, 'upstreamAccountId'),
    model: stringField(item, 'model'),
    unit,
    status: status as TeamUsageEventSummary['status'],
    startedAt: numberField(item, 'startedAt'),
    ...finishedAt === undefined ? {} : { finishedAt },
  }
}

function projectOverview(value: unknown): TeamManagementOverview {
  const item = record(value, 'overview')
  const team = projectTeam(item.team)
  const currentMember = projectMember(item.currentMember)
  const members = objectArray(item.members, 'members', projectMember)
  const liveKeyMemberIds = projectLiveKeyMemberIds(item.apiKeys, team.id)
  return {
    team,
    currentMember,
    members: members.map((member): TeamManagementMemberSummary => ({
      ...member,
      canReceiveOwnership: currentMember.role === 'owner'
        && currentMember.status === 'active'
        && member.teamId === currentMember.teamId
        && member.id !== currentMember.id
        && member.role !== 'owner'
        && member.status === 'active'
        && liveKeyMemberIds.has(member.id),
    })),
    invites: objectArray(item.invites, 'invites', projectInvite),
    contributions: objectArray(item.contributions, 'contributions', value => projectContribution(value, currentMember.id)),
  }
}

function projectLiveKeyMemberIds(value: unknown, teamId: string): ReadonlySet<string> {
  if (!Array.isArray(value)) throw new Error('remote Team returned invalid apiKeys')
  const memberIds = new Set<string>()
  for (const candidate of value) {
    const key = record(candidate, 'API key')
    const keyTeamId = stringField(key, 'teamId')
    const memberId = stringField(key, 'memberId')
    if (key.revokedAt !== undefined) numberField(key, 'revokedAt')
    if (keyTeamId === teamId && key.revokedAt === undefined) memberIds.add(memberId)
  }
  return memberIds
}

function projectConnection(value: unknown): TeamManagementConnectionResult {
  const item = record(value, 'connection')
  return { team: projectTeam(item.team), member: projectMember(item.member ?? item.currentMember) }
}

function projectDeparture(value: unknown): TeamManagementDepartureResult {
  const item = record(value, 'Team departure')
  const member = projectMember(item.member)
  if (member.status !== 'removed' || member.role === 'owner') throw new Error('remote Team returned an invalid departure member')
  return { member }
}

function projectOwnershipTransfer(value: unknown): TeamManagementOwnershipTransferResult {
  const item = record(value, 'Team ownership transfer')
  const formerOwner = projectMember(item.formerOwner)
  const owner = projectMember(item.owner)
  if (
    formerOwner.role !== 'admin'
    || formerOwner.status !== 'active'
    || owner.role !== 'owner'
    || owner.status !== 'active'
    || formerOwner.id === owner.id
    || formerOwner.teamId !== owner.teamId
  ) {
    throw new Error('remote Team returned an invalid ownership transfer')
  }
  return { formerOwner, owner }
}

function contributionPatch(value: Record<string, unknown>): { accountId: string; patch: TeamContributionAccountPatch } {
  exactKeys(value, ['accountId', 'label', 'status', 'personalReservePercent', 'maxSharedRequestsPerWindow', 'maxSharedConcurrency', 'allowedModels'])
  const accountId = requiredString(value, 'accountId')
  const patch: TeamContributionAccountPatch = {
    ...value.label === undefined ? {} : { label: requiredString(value, 'label') },
    ...value.status === undefined ? {} : { status: requiredString(value, 'status') as 'active' | 'paused' },
    ...value.personalReservePercent === undefined ? {} : { personalReservePercent: requiredInteger(value, 'personalReservePercent') },
    ...value.maxSharedConcurrency === undefined ? {} : { maxSharedConcurrency: requiredInteger(value, 'maxSharedConcurrency') },
    ...value.maxSharedRequestsPerWindow === undefined
      ? {}
      : value.maxSharedRequestsPerWindow === null
        ? { maxSharedRequestsPerWindow: null }
        : { maxSharedRequestsPerWindow: requiredInteger(value, 'maxSharedRequestsPerWindow') },
    ...value.allowedModels === undefined ? {} : { allowedModels: stringArray(value.allowedModels, 'allowedModels') },
  }
  if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'paused') throw new Error('status must be active or paused')
  return { accountId, patch }
}

class TeamManagementProxy {
  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(
    private readonly config: TeamClientConfig,
    private readonly credentials: Credentials,
    options: TeamManagementRouteOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async status(): Promise<TeamManagementStatus> {
    if (this.config.enabled !== true) return { enabled: false, keyConfigured: false, keyWritable: false }
    const baseUrl = resolveTeamClientBaseUrl(this.config.baseUrl)
    const info = await this.credentials.describe(this.keyRef())
    return {
      enabled: true,
      keyConfigured: info.configured,
      keyWritable: info.writable,
      ...info.source === undefined ? {} : { keySource: info.source },
      serverOrigin: new URL(baseUrl).origin,
    }
  }

  async overview(explicitKey?: string): Promise<TeamManagementOverview> {
    return projectOverview(await this.remote(TEAM_OVERVIEW_PATH, explicitKey === undefined ? {} : { key: explicitKey }))
  }

  async connect(apiKey: string): Promise<TeamManagementConnectionResult> {
    validateTeamKey(apiKey)
    await this.requireWritable()
    const overview = await this.overview(apiKey)
    await this.credentials.set(this.keyRef(), apiKey)
    return { team: overview.team, member: overview.currentMember }
  }

  async join(inviteToken: string, displayName: string): Promise<TeamManagementConnectionResult> {
    await this.requireWritable()
    const raw = record(await this.remote(TEAM_JOIN_PATH, {
      authenticated: false,
      method: 'POST',
      body: { inviteToken, displayName },
    }), 'join result')
    const connection = projectConnection(raw)
    const apiKey = stringField(raw, 'apiKey')
    validateTeamKey(apiKey)
    await this.credentials.set(this.keyRef(), apiKey)
    return connection
  }

  async disconnect(revokeRemote: boolean): Promise<{ disconnected: true; remoteRevoked: boolean }> {
    if (revokeRemote) await this.remote(TEAM_CURRENT_KEY_REVOKE_PATH, { method: 'POST' })
    await this.credentials.unset(this.keyRef())
    return { disconnected: true, remoteRevoked: revokeRemote }
  }

  async leaveTeam(): Promise<TeamManagementDepartureResult> {
    await this.requireWritable()
    const result = projectDeparture(await this.remote(TEAM_MEMBERS_LEAVE_PATH, { method: 'POST', body: {} }))
    await this.credentials.unset(this.keyRef())
    return result
  }

  async transferOwnership(targetMemberId: string): Promise<TeamManagementOwnershipTransferResult> {
    return projectOwnershipTransfer(await this.remote(TEAM_OWNERSHIP_TRANSFER_PATH, {
      method: 'POST',
      body: { targetMemberId },
    }))
  }

  async createInvite(expiresInMs?: number): Promise<TeamManagementInviteResult> {
    const item = record(await this.remote(TEAM_INVITES_PATH, {
      method: 'POST',
      body: expiresInMs === undefined ? {} : { expiresInMs },
    }), 'invite result')
    const inviteToken = stringField(item, 'inviteToken')
    if (!inviteToken.startsWith('dsh_invite_')) throw new Error('remote Team returned an invalid invite token')
    return { invite: projectInvite(item.invite), inviteToken }
  }

  async revokeInvite(inviteId: string): Promise<TeamManagementInviteRevocationResult> {
    const item = record(await this.remote(TEAM_INVITES_REVOKE_PATH, {
      method: 'POST',
      body: { inviteId },
    }), 'invite revocation result')
    return { invite: projectInvite(item.invite) }
  }

  async setTeamStatus(status: 'active' | 'paused'): Promise<{ team: TeamSummary }> {
    const item = record(await this.remote(TEAM_STATUS_PATH, { method: 'POST', body: { status } }), 'team status')
    return { team: projectTeam(item.team) }
  }

  async contributions(): Promise<{ accounts: readonly TeamContributionAccountSummary[] }> {
    const item = record(await this.remote(TEAM_CONTRIBUTIONS_PATH), 'contributions')
    return { accounts: objectArray(item.accounts, 'accounts', projectContribution) }
  }

  async startOAuth(label: string): Promise<TeamManagementOAuthResult> {
    const item = record(await this.remote(TEAM_CONTRIBUTION_OAUTH_START_PATH, { method: 'POST', body: { label } }), 'OAuth result')
    if (item.method !== 'device_code') throw new Error('remote Team returned an unsupported OAuth method')
    const verificationUrl = stringField(item, 'verificationUrl')
    const parsed = new URL(verificationUrl)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
      throw new Error('remote Team returned an unsafe authorization URL')
    }
    const userCode = stringField(item, 'userCode')
    if (!/^[A-Za-z0-9-]{4,32}$/u.test(userCode)) throw new Error('remote Team returned an invalid authorization code')
    const expiresAt = numberField(item, 'expiresAt')
    return { account: projectContribution(item.account), method: 'device_code', verificationUrl, userCode, expiresAt }
  }

  async cancelOAuth(accountId: string): Promise<{ account: TeamContributionAccountSummary }> {
    const item = record(await this.remote(TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH, { method: 'POST', body: { accountId } }), 'OAuth cancellation')
    return { account: projectContribution(item.account) }
  }

  async reauthorizeOAuth(accountId: string): Promise<TeamManagementOAuthResult> {
    const item = record(await this.remote(TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH, { method: 'POST', body: { accountId } }), 'OAuth result')
    if (item.method !== 'device_code') throw new Error('remote Team returned an unsupported OAuth method')
    const verificationUrl = stringField(item, 'verificationUrl')
    const parsed = new URL(verificationUrl)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
      throw new Error('remote Team returned an unsafe authorization URL')
    }
    const userCode = stringField(item, 'userCode')
    if (!/^[A-Za-z0-9-]{4,32}$/u.test(userCode)) throw new Error('remote Team returned an invalid authorization code')
    return {
      account: projectContribution(item.account),
      method: 'device_code',
      verificationUrl,
      userCode,
      expiresAt: numberField(item, 'expiresAt'),
    }
  }

  async updateContribution(accountId: string, patch: TeamContributionAccountPatch): Promise<{ account: TeamContributionAccountSummary }> {
    const item = record(await this.remote(TEAM_CONTRIBUTION_UPDATE_PATH, { method: 'POST', body: { accountId, ...patch } }), 'contribution update')
    return { account: projectContribution(item.account) }
  }

  async revokeContribution(accountId: string): Promise<{ account: TeamContributionAccountSummary }> {
    const item = record(await this.remote(TEAM_CONTRIBUTION_REVOKE_PATH, { method: 'POST', body: { accountId } }), 'contribution revocation')
    return { account: projectContribution(item.account) }
  }

  async usage(): Promise<TeamManagementUsageResult> {
    const item = record(await this.remote(TEAM_USAGE_PATH), 'usage')
    return { events: objectArray(item.events, 'events', projectUsage) }
  }

  private async requireWritable(): Promise<CredentialInfo> {
    this.requireEnabled()
    const info = await this.credentials.describe(this.keyRef())
    if (!info.writable) throw new Error('Team API key credential is not writable')
    return info
  }

  private keyRef(): CredentialRef {
    return credentialRef(this.config.apiKeyRef ?? DEFAULT_TEAM_CLIENT_API_KEY_REF)
  }

  private requireEnabled(): string {
    if (this.config.enabled !== true) throw new Error('Team client mode is not enabled')
    return resolveTeamClientBaseUrl(this.config.baseUrl)
  }

  private async key(): Promise<string> {
    const resolved = await this.credentials.resolve(this.keyRef())
    if (resolved === undefined) throw new Error('Team API key is not configured')
    validateTeamKey(resolved.value)
    return resolved.value
  }

  private async remote(
    path: string,
    options: { authenticated?: boolean; method?: 'GET' | 'POST'; body?: unknown; key?: string } = {},
  ): Promise<unknown> {
    const baseUrl = this.requireEnabled()
    if (!path.startsWith(`${TEAM_PATH_PREFIX}/`) || path.includes('?') || path.includes('#')) throw new Error('invalid fixed Team route')
    const key = options.authenticated === false ? undefined : options.key ?? await this.key()
    const method = options.method ?? 'GET'
    const signal = AbortSignal.timeout(this.timeoutMs)
    let response: Response
    try {
      response = await this.fetch(`${baseUrl}${path.slice(TEAM_PATH_PREFIX.length)}`, {
        method,
        redirect: 'error',
        signal,
        headers: {
          accept: 'application/json',
          ...key === undefined ? {} : { authorization: `Bearer ${key}` },
          ...options.body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
      })
    } catch (error: unknown) {
      throw new Error(`remote Team unavailable: ${safeMessage(error)}`)
    }
    const value = await readRemoteJson(response)
    if (!response.ok) {
      const item = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
      const message = typeof item?.error === 'string' ? item.error : `HTTP ${response.status}`
      throw new Error(`remote Team request failed: ${safeMessage(message)}`)
    }
    return value
  }
}

async function readRemoteJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase()
  if (contentType === undefined || !contentType.startsWith('application/json')) throw new Error('remote Team returned a non-JSON response')
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_BODY_BYTES) throw new Error('remote Team response is too large')
  if (response.body === null) throw new Error('remote Team returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_REMOTE_BODY_BYTES) throw new Error('remote Team response is too large')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('remote Team returned invalid JSON')
  }
}

function validateTeamKey(value: string): void {
  if (!/^dsh_team_[A-Za-z0-9_-]{16,}$/u.test(value)) throw new Error('Team API key is invalid')
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/** Register Browser-safe local routes and dispose them with the plugin context. */
export function registerTeamManagementRoutes(
  ctx: Context,
  config: TeamClientConfig,
  credentials: Credentials,
  options: TeamManagementRouteOptions = {},
): void {
  const proxy = new TeamManagementProxy(config, credentials, options)
  ctx.effect(() => {
    const register = (
      path: string,
      method: 'GET' | 'POST',
      action: (body: Record<string, unknown>) => Promise<{ status?: number; value: unknown }>,
    ) => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== method) { json(res, 405, { error: 'method not allowed' }); return }
        if (!trustedRequest(req)) { json(res, 403, { error: 'forbidden' }); return }
        try {
          const body = method === 'POST' ? await readJson(req) : {}
          const result = await action(body)
          json(res, result.status ?? 200, result.value)
        } catch (error: unknown) {
          json(res, statusFor(error), { error: safeMessage(error) })
        }
      },
    })
    const routes = [
      register(TEAM_MANAGEMENT_STATUS_PATH, 'GET', async () => ({ value: await proxy.status() })),
      register(TEAM_MANAGEMENT_OVERVIEW_PATH, 'GET', async () => ({ value: await proxy.overview() })),
      register(TEAM_MANAGEMENT_CONNECT_PATH, 'POST', async (body) => {
        exactKeys(body, ['apiKey'])
        return { value: await proxy.connect(requiredString(body, 'apiKey')) }
      }),
      register(TEAM_MANAGEMENT_JOIN_PATH, 'POST', async (body) => {
        exactKeys(body, ['inviteToken', 'displayName'])
        return {
          status: 201,
          value: await proxy.join(requiredString(body, 'inviteToken'), requiredString(body, 'displayName')),
        }
      }),
      register(TEAM_MANAGEMENT_DISCONNECT_PATH, 'POST', async (body) => {
        exactKeys(body, ['revokeRemote'])
        if (typeof body.revokeRemote !== 'boolean') throw new Error('revokeRemote must be a boolean')
        return { value: await proxy.disconnect(body.revokeRemote) }
      }),
      register(TEAM_MANAGEMENT_LEAVE_PATH, 'POST', async (body) => {
        exactKeys(body, [])
        return { value: await proxy.leaveTeam() }
      }),
      register(TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH, 'POST', async (body) => {
        exactKeys(body, ['targetMemberId'])
        return { value: await proxy.transferOwnership(requiredString(body, 'targetMemberId')) }
      }),
      register(TEAM_MANAGEMENT_INVITES_PATH, 'POST', async (body) => {
        exactKeys(body, ['expiresInMs'])
        return { status: 201, value: await proxy.createInvite(optionalInteger(body, 'expiresInMs')) }
      }),
      register(TEAM_MANAGEMENT_INVITES_REVOKE_PATH, 'POST', async (body) => {
        exactKeys(body, ['inviteId'])
        return { value: await proxy.revokeInvite(requiredString(body, 'inviteId')) }
      }),
      register(TEAM_MANAGEMENT_TEAM_STATUS_PATH, 'POST', async (body) => {
        exactKeys(body, ['status'])
        const status = requiredString(body, 'status')
        if (status !== 'active' && status !== 'paused') throw new Error('status must be active or paused')
        return { value: await proxy.setTeamStatus(status) }
      }),
      register(TEAM_MANAGEMENT_CONTRIBUTIONS_PATH, 'GET', async () => ({ value: await proxy.contributions() })),
      register(TEAM_MANAGEMENT_OAUTH_START_PATH, 'POST', async (body) => {
        exactKeys(body, ['label'])
        return { status: 201, value: await proxy.startOAuth(requiredString(body, 'label')) }
      }),
      register(TEAM_MANAGEMENT_OAUTH_CANCEL_PATH, 'POST', async (body) => {
        exactKeys(body, ['accountId'])
        return { value: await proxy.cancelOAuth(requiredString(body, 'accountId')) }
      }),
      register(TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH, 'POST', async (body) => {
        exactKeys(body, ['accountId'])
        return { value: await proxy.reauthorizeOAuth(requiredString(body, 'accountId')) }
      }),
      register(TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH, 'POST', async (body) => {
        const { accountId, patch } = contributionPatch(body)
        return { value: await proxy.updateContribution(accountId, patch) }
      }),
      register(TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH, 'POST', async (body) => {
        exactKeys(body, ['accountId'])
        return { value: await proxy.revokeContribution(requiredString(body, 'accountId')) }
      }),
      register(TEAM_MANAGEMENT_USAGE_PATH, 'GET', async () => ({ value: await proxy.usage() })),
    ]
    return async () => {
      for (const dispose of routes) dispose()
    }
  }, 'dsh-codex-shared-pool: local Team management routes')
}

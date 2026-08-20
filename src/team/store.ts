/** Host-only Team control-plane store. Secrets never appear in summaries. */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  TeamApiKeySummary,
  TeamBootstrapResult,
  TeamInviteResult,
  TeamInviteSummary,
  TeamJoinResult,
  TeamMemberDepartureResult,
  TeamMemberSummary,
  TeamOwnershipTransferResult,
  TeamOverview,
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamContributionStatus,
  TeamUsageEventStatus,
  TeamUsageEventSummary,
  TeamRole,
  TeamStatus,
  TeamSummary,
} from './types.ts'
import { safeTeamErrorMessage } from './safe-message.ts'

export interface TeamAuthContext {
  readonly teamId: string
  readonly memberId: string
  readonly role: TeamRole
  readonly keyId: string
}

export interface TeamStore {
  bootstrap(teamName: string, ownerName: string): Promise<TeamBootstrapResult>
  authenticateApiKey(token: string): Promise<TeamAuthContext | undefined>
  overview(auth: TeamAuthContext): Promise<TeamOverview>
  createInvite(auth: TeamAuthContext, expiresInMs: number): Promise<TeamInviteResult>
  revokeInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteSummary>
  acceptInvite(token: string, displayName: string): Promise<TeamJoinResult>
  issueApiKey(auth: TeamAuthContext, label: string): Promise<{ summary: TeamApiKeySummary; token: string }>
  revokeApiKey(auth: TeamAuthContext, keyId: string): Promise<void>
  transferOwnership(auth: TeamAuthContext, targetMemberId: string): Promise<TeamOwnershipTransferResult>
  leaveTeam(auth: TeamAuthContext): Promise<TeamMemberDepartureResult>
  createContributionAccount(auth: TeamAuthContext, label: string): Promise<TeamContributionAccountSummary>
  listContributionAccounts(auth: TeamAuthContext): Promise<readonly TeamContributionAccountSummary[]>
  /** Host-internal cross-Team query used only for lifecycle reconciliation. */
  listContributionAccountsByStatus(status: TeamContributionStatus): Promise<readonly TeamContributionAccountSummary[]>
  /** Owner-only atomic transition that preserves an existing contribution's policy. */
  beginContributionReauthorization(
    auth: TeamAuthContext,
    accountId: string,
  ): Promise<TeamContributionAccountSummary>
  updateContributionAccount(
    auth: TeamAuthContext,
    accountId: string,
    patch: TeamContributionAccountPatch,
  ): Promise<TeamContributionAccountSummary>
  revokeContributionAccount(auth: TeamAuthContext, accountId: string): Promise<TeamContributionAccountSummary>
  setContributionAccountStatus(
    teamId: string,
    accountId: string,
    status: TeamContributionStatus,
    lastError?: string,
    expectedStatus?: TeamContributionStatus,
  ): Promise<TeamContributionAccountSummary>
  beginUsageEvent(
    auth: TeamAuthContext,
    eventId: string,
    accountId: string,
    model: string,
  ): Promise<TeamUsageEventSummary>
  settleUsageEvent(
    teamId: string,
    eventId: string,
    status: Exclude<TeamUsageEventStatus, 'in_progress'>,
  ): Promise<TeamUsageEventSummary>
  listUsageEvents(auth: TeamAuthContext, limit: number): Promise<readonly TeamUsageEventSummary[]>
  setTeamStatus(auth: TeamAuthContext, status: TeamStatus): Promise<TeamSummary>
  dispose(): Promise<void>
}

interface TeamRecord {
  id: string
  name: string
  status: TeamStatus
  createdAt: number
  memberIds: string[]
}

interface MemberRecord {
  id: string
  teamId: string
  displayName: string
  role: TeamRole
  status: TeamMemberSummary['status']
  joinedAt: number
}

interface InviteRecord {
  id: string
  teamId: string
  invitedByMemberId: string
  status: TeamInviteSummary['status']
  expiresAt: number
  createdAt: number
  acceptedAt?: number
  tokenHash: string
}

interface ApiKeyRecord {
  id: string
  teamId: string
  memberId: string
  label: string
  prefix: string
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
  tokenHash: string
}

interface ContributionRecord {
  id: string
  teamId: string
  ownerMemberId: string
  label: string
  status: TeamContributionStatus
  personalReservePercent: number
  maxSharedRequestsPerWindow: number | null
  maxSharedConcurrency: number
  allowedModels: string[]
  createdAt: number
  updatedAt: number
  lastError?: string
}

interface UsageEventRecord {
  id: string
  teamId: string
  consumerMemberId: string
  upstreamOwnerMemberId: string
  upstreamAccountId: string
  model: string
  unit: 'request'
  status: TeamUsageEventStatus
  startedAt: number
  finishedAt?: number
}

export interface MemoryTeamStoreOptions {
  now?: () => number
  id?: () => string
  token?: () => string
}

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TEAM_NAME_LENGTH = 120
const MAX_MEMBER_NAME_LENGTH = 120
const MAX_KEY_LABEL_LENGTH = 80
const MAX_MODEL_NAME_LENGTH = 120
const DEFAULT_PERSONAL_RESERVE_PERCENT = 20
const DEFAULT_MAX_SHARED_CONCURRENCY = 1

function nonEmpty(value: string, field: string, maxLength: number): string {
  const result = value.trim().replace(/\s+/gu, ' ')
  if (result.length === 0) throw new Error(`${field} must be a non-empty string`)
  if (result.length > maxLength) throw new Error(`${field} is too long`)
  return result
}

function normalizeModels(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 32) throw new Error('allowedModels must contain at most 32 model names')
  const normalized = values.map(value => nonEmpty(value, 'allowedModels', MAX_MODEL_NAME_LENGTH))
  return [...new Set(normalized)]
}

function manualContributionStatus(
  current: TeamContributionStatus,
  requested: TeamContributionAccountPatch['status'],
): TeamContributionStatus {
  if (requested === undefined) return current
  if (current !== 'active' && current !== 'paused') {
    throw new Error('contribution authorization status cannot be changed manually')
  }
  return requested
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function createSecret(prefix: string, tokenFactory: () => string): string {
  return `${prefix}_${tokenFactory()}`
}

function summaryTeam(team: TeamRecord): TeamSummary {
  return {
    id: team.id,
    name: team.name,
    status: team.status,
    createdAt: team.createdAt,
  }
}

function summaryMember(member: MemberRecord): TeamMemberSummary {
  return { ...member }
}

function summaryInvite(invite: InviteRecord, now: number): TeamInviteSummary {
  const status = invite.status === 'pending' && invite.expiresAt <= now ? 'expired' : invite.status
  return {
    id: invite.id,
    teamId: invite.teamId,
    invitedByMemberId: invite.invitedByMemberId,
    status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
    ...(invite.acceptedAt === undefined ? {} : { acceptedAt: invite.acceptedAt }),
  }
}

function summaryKey(key: ApiKeyRecord): TeamApiKeySummary {
  return {
    id: key.id,
    teamId: key.teamId,
    memberId: key.memberId,
    label: key.label,
    prefix: key.prefix,
    createdAt: key.createdAt,
    ...(key.lastUsedAt === undefined ? {} : { lastUsedAt: key.lastUsedAt }),
    ...(key.revokedAt === undefined ? {} : { revokedAt: key.revokedAt }),
  }
}

function summaryContribution(account: ContributionRecord): TeamContributionAccountSummary {
  return {
    id: account.id,
    teamId: account.teamId,
    ownerMemberId: account.ownerMemberId,
    label: account.label,
    status: account.status,
    personalReservePercent: account.personalReservePercent,
    maxSharedRequestsPerWindow: account.maxSharedRequestsPerWindow,
    maxSharedConcurrency: account.maxSharedConcurrency,
    allowedModels: [...account.allowedModels],
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    ...(account.lastError === undefined ? {} : { lastError: safeTeamErrorMessage(account.lastError) }),
  }
}

function summaryUsageEvent(event: UsageEventRecord): TeamUsageEventSummary {
  return { ...event }
}

/**
 * Deterministic in-memory implementation used by unit tests and development.
 * A durable database adapter will implement the same interface before hosted
 * Team deployment; no production claim is made for this store yet.
 */
export class MemoryTeamStore implements TeamStore {
  private readonly teams = new Map<string, TeamRecord>()
  private readonly members = new Map<string, MemberRecord>()
  private readonly invites = new Map<string, InviteRecord>()
  private readonly inviteHashes = new Map<string, string>()
  private readonly keys = new Map<string, ApiKeyRecord>()
  private readonly keyHashes = new Map<string, string>()
  private readonly contributions = new Map<string, ContributionRecord>()
  private readonly usageEvents = new Map<string, UsageEventRecord>()
  private readonly now: () => number
  private readonly id: () => string
  private readonly token: () => string

  constructor(options: MemoryTeamStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
    this.token = options.token ?? (() => randomBytes(32).toString('base64url'))
  }

  async bootstrap(teamName: string, ownerName: string): Promise<TeamBootstrapResult> {
    const now = this.now()
    const team: TeamRecord = {
      id: this.id(),
      name: nonEmpty(teamName, 'teamName', MAX_TEAM_NAME_LENGTH),
      status: 'active',
      createdAt: now,
      memberIds: [],
    }
    const member: MemberRecord = {
      id: this.id(),
      teamId: team.id,
      displayName: nonEmpty(ownerName, 'ownerName', MAX_MEMBER_NAME_LENGTH),
      role: 'owner',
      status: 'active',
      joinedAt: now,
    }
    this.teams.set(team.id, team)
    this.members.set(member.id, member)
    team.memberIds.push(member.id)
    const key = this.createKey(team.id, member.id, 'bootstrap', now)
    return { team: summaryTeam(team), member: summaryMember(member), apiKey: key.token }
  }

  async authenticateApiKey(token: string): Promise<TeamAuthContext | undefined> {
    if (token.trim().length < 16) return undefined
    const keyId = this.keyHashes.get(hashToken(token))
    if (keyId === undefined) return undefined
    const key = this.keys.get(keyId)
    if (key === undefined || key.revokedAt !== undefined) return undefined
    const member = this.members.get(key.memberId)
    const team = this.teams.get(key.teamId)
    if (member === undefined || member.status !== 'active' || team === undefined) {
      return undefined
    }
    // Re-check the stored hash using a timing-safe comparison before accepting it.
    if (!sameHash(key.tokenHash, hashToken(token))) return undefined
    key.lastUsedAt = this.now()
    return { teamId: key.teamId, memberId: key.memberId, role: member.role, keyId: key.id }
  }

  async overview(auth: TeamAuthContext): Promise<TeamOverview> {
    this.requireAuthContext(auth)
    const team = this.requireTeam(auth.teamId)
    const currentMember = this.requireMember(auth.memberId, auth.teamId)
    return {
      team: summaryTeam(team),
      currentMember: summaryMember(currentMember),
      members: team.memberIds.map(id => this.requireStoredMember(id, team.id)).map(summaryMember),
      invites: [...this.invites.values()]
        .filter(invite => invite.teamId === team.id && invite.status !== 'revoked')
        .map(invite => summaryInvite(invite, this.now())),
      apiKeys: [...this.keys.values()]
        .filter(key => key.teamId === team.id)
        .map(summaryKey),
      contributions: [...this.contributions.values()]
        .filter(account => account.teamId === team.id)
        .map(summaryContribution),
    }
  }

  async createInvite(auth: TeamAuthContext, expiresInMs = DEFAULT_INVITE_TTL_MS): Promise<TeamInviteResult> {
    this.requireOperator(auth)
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error('expiresInMs is outside the allowed range')
    }
    const now = this.now()
    const invite: InviteRecord = {
      id: this.id(),
      teamId: auth.teamId,
      invitedByMemberId: auth.memberId,
      status: 'pending',
      expiresAt: now + expiresInMs,
      createdAt: now,
      tokenHash: '',
    }
    const token = createSecret('dsh_invite', this.token)
    invite.tokenHash = hashToken(token)
    this.invites.set(invite.id, invite)
    this.inviteHashes.set(invite.tokenHash, invite.id)
    return { invite: summaryInvite(invite, now), inviteToken: token }
  }

  async revokeInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteSummary> {
    this.requireOperator(auth)
    const invite = this.invites.get(inviteId)
    if (invite === undefined || invite.teamId !== auth.teamId) throw new Error('invite not found')
    if (invite.status === 'accepted') throw new Error('accepted invite cannot be revoked')
    if (invite.status === 'revoked') return summaryInvite(invite, this.now())
    invite.status = 'revoked'
    this.inviteHashes.delete(invite.tokenHash)
    invite.tokenHash = hashToken(`revoked:${invite.id}`)
    return summaryInvite(invite, this.now())
  }

  async acceptInvite(token: string, displayName: string): Promise<TeamJoinResult> {
    const inviteId = this.inviteHashes.get(hashToken(token))
    if (inviteId === undefined) throw new Error('invite is invalid or expired')
    const invite = this.invites.get(inviteId)
    if (invite === undefined || invite.status !== 'pending' || invite.expiresAt <= this.now()) {
      throw new Error('invite is invalid or expired')
    }
    const team = this.requireTeam(invite.teamId)
    if (team.status !== 'active') throw new Error('team is paused')
    const now = this.now()
    const member: MemberRecord = {
      id: this.id(),
      teamId: team.id,
      displayName: nonEmpty(displayName, 'displayName', MAX_MEMBER_NAME_LENGTH),
      role: 'member',
      status: 'active',
      joinedAt: now,
    }
    this.members.set(member.id, member)
    team.memberIds.push(member.id)
    invite.status = 'accepted'
    invite.acceptedAt = now
    this.inviteHashes.delete(invite.tokenHash)
    const key = this.createKey(team.id, member.id, 'member', now)
    return { team: summaryTeam(team), member: summaryMember(member), apiKey: key.token }
  }

  async issueApiKey(auth: TeamAuthContext, label: string): Promise<{ summary: TeamApiKeySummary; token: string }> {
    this.requireAuthContext(auth)
    const key = this.createKey(auth.teamId, auth.memberId, nonEmpty(label, 'label', MAX_KEY_LABEL_LENGTH), this.now())
    return { summary: summaryKey(key), token: key.token }
  }

  async revokeApiKey(auth: TeamAuthContext, keyId: string): Promise<void> {
    this.requireAuthContext(auth)
    const key = this.keys.get(keyId)
    if (key === undefined || key.teamId !== auth.teamId) throw new Error('api key not found')
    if (key.memberId !== auth.memberId && auth.role !== 'owner' && auth.role !== 'admin') {
      throw new Error('only the key owner or a Team administrator can revoke this key')
    }
    if (key.revokedAt === undefined) key.revokedAt = this.now()
  }

  async transferOwnership(auth: TeamAuthContext, targetMemberId: string): Promise<TeamOwnershipTransferResult> {
    const formerOwner = this.requireAuthContext(auth)
    if (formerOwner.role !== 'owner') throw new Error('only the owner can transfer Team ownership')
    if (targetMemberId === formerOwner.id) throw new Error('ownership target must be a different Team member')
    const owner = this.requireMember(targetMemberId, formerOwner.teamId)
    const hasActiveKey = [...this.keys.values()].some(key => (
      key.teamId === formerOwner.teamId
      && key.memberId === owner.id
      && key.revokedAt === undefined
    ))
    if (!hasActiveKey) throw new Error('ownership target must have an active Team API key')
    formerOwner.role = 'admin'
    owner.role = 'owner'
    return { formerOwner: summaryMember(formerOwner), owner: summaryMember(owner) }
  }

  async leaveTeam(auth: TeamAuthContext): Promise<TeamMemberDepartureResult> {
    const member = this.requireAuthContext(auth)
    if (member.role === 'owner') throw new Error('Team owner cannot leave before transferring ownership')
    const now = this.now()
    member.status = 'removed'
    for (const key of this.keys.values()) {
      if (key.teamId === member.teamId && key.memberId === member.id && key.revokedAt === undefined) key.revokedAt = now
    }
    const contributions = [...this.contributions.values()]
      .filter(account => account.teamId === member.teamId && account.ownerMemberId === member.id)
    for (const account of contributions) {
      account.status = 'revoked'
      account.updatedAt = now
    }
    return {
      member: summaryMember(member),
      contributions: contributions.map(summaryContribution),
    }
  }

  async createContributionAccount(auth: TeamAuthContext, label: string): Promise<TeamContributionAccountSummary> {
    const member = this.requireAuthContext(auth)
    const now = this.now()
    const account: ContributionRecord = {
      id: this.id(),
      teamId: member.teamId,
      ownerMemberId: member.id,
      label: nonEmpty(label, 'label', MAX_KEY_LABEL_LENGTH),
      status: 'authorizing',
      personalReservePercent: DEFAULT_PERSONAL_RESERVE_PERCENT,
      maxSharedRequestsPerWindow: null,
      maxSharedConcurrency: DEFAULT_MAX_SHARED_CONCURRENCY,
      allowedModels: [],
      createdAt: now,
      updatedAt: now,
    }
    this.contributions.set(account.id, account)
    return summaryContribution(account)
  }

  async listContributionAccounts(auth: TeamAuthContext): Promise<readonly TeamContributionAccountSummary[]> {
    this.requireAuthContext(auth)
    return [...this.contributions.values()]
      .filter(account => account.teamId === auth.teamId)
      .map(summaryContribution)
  }

  async listContributionAccountsByStatus(
    status: TeamContributionStatus,
  ): Promise<readonly TeamContributionAccountSummary[]> {
    return [...this.contributions.values()]
      .filter(account => account.status === status)
      .map(summaryContribution)
  }

  async beginContributionReauthorization(
    auth: TeamAuthContext,
    accountId: string,
  ): Promise<TeamContributionAccountSummary> {
    const member = this.requireAuthContext(auth)
    const account = this.requireContribution(accountId, member.teamId)
    if (account.ownerMemberId !== member.id) throw new Error('only the owner of the contribution account can reauthorize it')
    if (account.status !== 'reauth_required') throw new Error('contribution account is not waiting for reauthorization')
    account.status = 'authorizing'
    delete account.lastError
    account.updatedAt = this.now()
    return summaryContribution(account)
  }

  async updateContributionAccount(
    auth: TeamAuthContext,
    accountId: string,
    patch: TeamContributionAccountPatch,
  ): Promise<TeamContributionAccountSummary> {
    const member = this.requireAuthContext(auth)
    const account = this.requireContribution(accountId, auth.teamId)
    if (account.ownerMemberId !== member.id) throw new Error('only the owner of the contribution account can update it')
    if (account.status === 'revoked') throw new Error('contribution account is revoked')
    const nextStatus = manualContributionStatus(account.status, patch.status)
    if (patch.label !== undefined) account.label = nonEmpty(patch.label, 'label', MAX_KEY_LABEL_LENGTH)
    account.status = nextStatus
    if (patch.personalReservePercent !== undefined) {
      if (!Number.isSafeInteger(patch.personalReservePercent) || patch.personalReservePercent < 0 || patch.personalReservePercent > 99) {
        throw new Error('personalReservePercent must be an integer from 0 to 99')
      }
      account.personalReservePercent = patch.personalReservePercent
    }
    if (patch.maxSharedRequestsPerWindow !== undefined) {
      const value = patch.maxSharedRequestsPerWindow
      if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000)) {
        throw new Error('maxSharedRequestsPerWindow must be null or an integer from 1 to 1000000')
      }
      account.maxSharedRequestsPerWindow = value
    }
    if (patch.maxSharedConcurrency !== undefined) {
      if (!Number.isSafeInteger(patch.maxSharedConcurrency) || patch.maxSharedConcurrency < 1 || patch.maxSharedConcurrency > 16) {
        throw new Error('maxSharedConcurrency must be an integer from 1 to 16')
      }
      account.maxSharedConcurrency = patch.maxSharedConcurrency
    }
    if (patch.allowedModels !== undefined) account.allowedModels = normalizeModels(patch.allowedModels)
    account.updatedAt = this.now()
    return summaryContribution(account)
  }

  async revokeContributionAccount(auth: TeamAuthContext, accountId: string): Promise<TeamContributionAccountSummary> {
    const member = this.requireAuthContext(auth)
    const account = this.requireContribution(accountId, auth.teamId)
    if (account.ownerMemberId !== member.id && member.role !== 'owner' && member.role !== 'admin') {
      throw new Error('only the owner or a Team administrator can revoke this contribution account')
    }
    account.status = 'revoked'
    account.updatedAt = this.now()
    return summaryContribution(account)
  }

  async setContributionAccountStatus(
    teamId: string,
    accountId: string,
    status: TeamContributionStatus,
    lastError?: string,
    expectedStatus?: TeamContributionStatus,
  ): Promise<TeamContributionAccountSummary> {
    const account = this.requireContribution(accountId, teamId)
    if (account.status === 'revoked' && status !== 'revoked') return summaryContribution(account)
    if (expectedStatus !== undefined && account.status !== expectedStatus) return summaryContribution(account)
    account.status = status
    if (lastError === undefined) delete account.lastError
    else account.lastError = nonEmpty(safeTeamErrorMessage(lastError), 'lastError', 240)
    account.updatedAt = this.now()
    return summaryContribution(account)
  }

  async beginUsageEvent(
    auth: TeamAuthContext,
    eventId: string,
    accountId: string,
    model: string,
  ): Promise<TeamUsageEventSummary> {
    const member = this.requireAuthContext(auth)
    if (this.requireTeam(member.teamId).status !== 'active') throw new Error('team is paused')
    if (this.usageEvents.has(eventId)) throw new Error('usage event already exists')
    const account = this.requireContribution(accountId, member.teamId)
    if (account.status !== 'active') throw new Error('contribution account is not active')
    const event: UsageEventRecord = {
      id: nonEmpty(eventId, 'eventId', 128),
      teamId: member.teamId,
      consumerMemberId: member.id,
      upstreamOwnerMemberId: account.ownerMemberId,
      upstreamAccountId: account.id,
      model: nonEmpty(model, 'model', MAX_MODEL_NAME_LENGTH),
      unit: 'request',
      status: 'in_progress',
      startedAt: this.now(),
    }
    this.usageEvents.set(event.id, event)
    return summaryUsageEvent(event)
  }

  async settleUsageEvent(
    teamId: string,
    eventId: string,
    status: Exclude<TeamUsageEventStatus, 'in_progress'>,
  ): Promise<TeamUsageEventSummary> {
    const event = this.usageEvents.get(eventId)
    if (event === undefined || event.teamId !== teamId) throw new Error('usage event not found')
    if (event.status !== 'in_progress') {
      if (event.status === status) return summaryUsageEvent(event)
      throw new Error('usage event is already settled')
    }
    event.status = status
    event.finishedAt = this.now()
    return summaryUsageEvent(event)
  }

  async listUsageEvents(auth: TeamAuthContext, limit: number): Promise<readonly TeamUsageEventSummary[]> {
    this.requireAuthContext(auth)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('usage event limit must be an integer from 1 to 1000')
    }
    return [...this.usageEvents.values()]
      .filter(event => event.teamId === auth.teamId)
      .slice(-limit)
      .reverse()
      .map(summaryUsageEvent)
  }

  async setTeamStatus(auth: TeamAuthContext, status: TeamStatus): Promise<TeamSummary> {
    this.requireOperator(auth)
    const team = this.requireTeam(auth.teamId)
    team.status = status
    return summaryTeam(team)
  }

  async dispose(): Promise<void> {
    // The memory store owns no timers or subprocesses. This explicit method
    // keeps the same lifecycle contract as the future durable adapter.
  }

  private createKey(teamId: string, memberId: string, label: string, now: number): ApiKeyRecord & { token: string } {
    const token = createSecret('dsh_team', this.token)
    const record: ApiKeyRecord & { token: string } = {
      id: this.id(),
      teamId,
      memberId,
      label,
      prefix: token.slice(0, 18),
      createdAt: now,
      tokenHash: hashToken(token),
      token,
    }
    this.keys.set(record.id, record)
    this.keyHashes.set(record.tokenHash, record.id)
    return record
  }

  private requireTeam(teamId: string): TeamRecord {
    const team = this.teams.get(teamId)
    if (team === undefined) throw new Error('team not found')
    return team
  }

  private requireContribution(accountId: string, teamId: string): ContributionRecord {
    const account = this.contributions.get(accountId)
    if (account === undefined || account.teamId !== teamId) throw new Error('contribution account not found')
    return account
  }

  private requireMember(memberId: string, teamId: string): MemberRecord {
    const member = this.requireStoredMember(memberId, teamId)
    if (member.status !== 'active') throw new Error('member is not active in this Team')
    return member
  }

  private requireStoredMember(memberId: string, teamId: string): MemberRecord {
    const member = this.members.get(memberId)
    if (member === undefined || member.teamId !== teamId) throw new Error('member not found in this Team')
    return member
  }

  private requireOperator(auth: TeamAuthContext): MemberRecord {
    const member = this.requireAuthContext(auth)
    if (member.role !== 'owner' && member.role !== 'admin') throw new Error('Team administrator role required')
    return member
  }

  private requireAuthContext(auth: TeamAuthContext): MemberRecord {
    const key = this.keys.get(auth.keyId)
    if (key === undefined || key.revokedAt !== undefined || key.teamId !== auth.teamId || key.memberId !== auth.memberId) {
      throw new Error('Team API key is revoked or invalid')
    }
    const member = this.requireMember(auth.memberId, auth.teamId)
    if (member.role !== auth.role) throw new Error('Team API key role is stale')
    return member
  }
}

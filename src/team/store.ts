/** Host-only Team control-plane store. Secrets never appear in summaries. */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  TeamApiKeySummary,
  TeamAccountUsage24HourSummary,
  TeamBootstrapResult,
  TeamInviteResult,
  TeamInvitePreview,
  TeamInviteRevealAuditEventSummary,
  TeamInviteRevealResult,
  TeamInviteSummary,
  TeamJoinAcceptedResult,
  TeamJoinResult,
  TeamMemberDepartureResult,
  TeamMembershipAuditAction,
  TeamMembershipAuditEventSummary,
  TeamMemberSummary,
  TeamOwnershipTransferAcceptanceResult,
  TeamOwnershipTransferStatus,
  TeamOwnershipTransferSummary,
  TeamOverview,
  TeamContributionAccountPatch,
  TeamContributionAccountSummary,
  TeamContributionStatus,
  TeamConnectionTerminal,
  TeamDissolutionInput,
  TeamDissolutionRecoveryResult,
  TeamDissolutionResult,
  TeamDisplayNameMigrationAcknowledgement,
  TeamLifecycleTransitionInput,
  TeamUsageEventStatus,
  TeamUsageEventSummary,
  TeamUsageAggregates,
  TeamUsageAggregateSummary,
  TeamUsageProjection,
  TeamMemberDailyUsageSummary,
  TeamRole,
  TeamStatus,
  TeamSummary,
} from './types.ts'
import { safeTeamErrorMessage } from './safe-message.ts'
import { calculateTeamCredits } from './credits.ts'
import type { TeamProviderTokenUsage } from './credits.ts'
import { TeamInviteCipher } from './invite-cipher.ts'
import type { TeamInviteTokenEnvelope } from './invite-cipher.ts'
import { Aes256GcmTeamInviteKeyEncryptionProvider } from './invite-key-encryption.ts'
import { normalizeTeamMemberDisplayName } from './member-display-name.ts'

export interface TeamAuthContext {
  readonly teamId: string
  readonly memberId: string
  readonly role: TeamRole
  readonly keyId: string
}

/** Host-only result from a future verified pricing catalog. Never accepted from Browser input. */
export interface TeamUsageCostEstimate {
  readonly estimatedCostUsdMicros: bigint
  readonly pricingCatalogVersion: string
}

/** Expected admission rejection when a contributor's UTC-day sharing cap is full. */
export class TeamDailyCreditsLimitError extends Error {
  constructor() {
    super('contribution daily shared Credits limit reached')
    this.name = 'TeamDailyCreditsLimitError'
  }
}

export class TeamWeeklyEstimatedCostLimitError extends Error {
  constructor() {
    super('contribution weekly shared estimated API cost limit reached')
    this.name = 'TeamWeeklyEstimatedCostLimitError'
  }
}

/** Expected Owner reveal rejection after the fixed-window allowance is exhausted. */
export class TeamInviteRevealRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Team invitation reveal rate limit exceeded')
    this.name = 'TeamInviteRevealRateLimitError'
  }
}

/** Expected anonymous dissolution-recovery rejection after one source exhausts its fixed window. */
export class TeamDissolutionRecoveryRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Team dissolution recovery rate limit exceeded')
    this.name = 'TeamDissolutionRecoveryRateLimitError'
  }
}

export type TeamDissolutionRecoveryAction = 'result' | 'ack'

/** Optimistic lifecycle write failed or an operation ID was reused for another binding. */
export class TeamLifecycleConflictError extends Error {
  readonly status = 409
  readonly code = 'team_lifecycle_conflict'

  constructor() {
    super('Team lifecycle changed; refresh and try again')
    this.name = 'TeamLifecycleConflictError'
  }
}

/** Terminal error returned only after a previously valid Team key is diagnosed. */
export class TeamDissolvedError extends Error {
  readonly status = 410
  readonly code = 'team_dissolved'

  constructor() {
    super('this Team has been permanently dissolved')
    this.name = 'TeamDissolvedError'
  }
}

/** Uniform recovery miss: operation existence and secret correctness are intentionally indistinguishable. */
export class TeamDissolutionUnavailableError extends Error {
  readonly status = 404
  readonly code = 'team_dissolution_unavailable'

  constructor() {
    super('Team dissolution result is unavailable')
    this.name = 'TeamDissolutionUnavailableError'
  }
}

/** Uniform miss for a version that is not acknowledgeable by this authenticated member. */
export class TeamDisplayNameMigrationUnavailableError extends Error {
  readonly status = 404
  readonly code = 'team_display_name_migration_unavailable'

  constructor() {
    super('Team display-name migration notice is unavailable')
    this.name = 'TeamDisplayNameMigrationUnavailableError'
  }
}

export interface TeamStore {
  bootstrap(teamName: string, ownerName: string): Promise<TeamBootstrapResult>
  authenticateApiKey(token: string): Promise<TeamAuthContext | undefined>
  overview(auth: TeamAuthContext): Promise<TeamOverview>
  acknowledgeDisplayNameMigration(
    auth: TeamAuthContext,
    migrationVersion: number,
  ): Promise<TeamDisplayNameMigrationAcknowledgement>
  createInvite(auth: TeamAuthContext, expiresInMs: number, label?: string): Promise<TeamInviteResult>
  revealInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteRevealResult>
  previewInvite(token: string): Promise<TeamInvitePreview>
  revokeInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteSummary>
  acceptInvite(token: string, displayName: string): Promise<TeamJoinResult>
  acceptInviteWithApiKey(token: string, displayName: string, apiKey: string): Promise<TeamJoinAcceptedResult>
  issueApiKey(auth: TeamAuthContext, label: string): Promise<{ summary: TeamApiKeySummary; token: string }>
  revokeApiKey(auth: TeamAuthContext, keyId: string): Promise<void>
  requestOwnershipTransfer(auth: TeamAuthContext, targetMemberId: string): Promise<TeamOwnershipTransferSummary>
  acceptOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferAcceptanceResult>
  rejectOwnershipTransfer(auth: TeamAuthContext, transferId: string): Promise<TeamOwnershipTransferSummary>
  revokeOwnershipTransfer(auth: TeamAuthContext, transferId: string): Promise<TeamOwnershipTransferSummary>
  removeMember(auth: TeamAuthContext, targetMemberId: string): Promise<TeamMemberDepartureResult>
  leaveTeam(auth: TeamAuthContext): Promise<TeamMemberDepartureResult>
  listMembershipAuditEvents(auth: TeamAuthContext, limit: number): Promise<readonly TeamMembershipAuditEventSummary[]>
  /** Owner-only Host inspection; never exposed through a Browser route. */
  listInviteRevealAuditEvents(auth: TeamAuthContext, limit: number): Promise<readonly TeamInviteRevealAuditEventSummary[]>
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
    providerAuthenticatedLabel?: string,
  ): Promise<TeamContributionAccountSummary>
  beginUsageEvent(
    auth: TeamAuthContext,
    eventId: string,
    accountId: string,
    model: string,
    reservedCredits?: number,
  ): Promise<TeamUsageEventSummary>
  settleUsageEvent(
    teamId: string,
    eventId: string,
    status: Exclude<TeamUsageEventStatus, 'in_progress'>,
    usage?: TeamProviderTokenUsage,
    costEstimate?: TeamUsageCostEstimate,
  ): Promise<TeamUsageEventSummary>
  listUsageEvents(auth: TeamAuthContext, limit: number): Promise<readonly TeamUsageEventSummary[]>
  listUsageAggregates(auth: TeamAuthContext): Promise<TeamUsageAggregates>
  readUsageProjection(auth: TeamAuthContext): Promise<TeamUsageProjection>
  setTeamStatus(auth: TeamAuthContext, input: TeamLifecycleTransitionInput): Promise<TeamSummary>
  dissolveTeam(auth: TeamAuthContext, input: TeamDissolutionInput): Promise<TeamDissolutionResult>
  consumeDissolutionRecoveryAttempt(
    sourceDigest: string,
    action: TeamDissolutionRecoveryAction,
  ): Promise<void>
  recoverTeamDissolution(operationId: string, recoverySecret: string): Promise<TeamDissolutionRecoveryResult>
  ackTeamDissolution(operationId: string, recoverySecret: string): Promise<void>
  diagnoseApiKey(token: string): Promise<TeamConnectionTerminal | undefined>
  /** Host-internal retention sweep; clears only expired invitation ciphertext. */
  sweepExpiredInviteEnvelopes(): Promise<number>
  dispose(): Promise<void>
}

interface TeamRecord {
  id: string
  name: string
  status: TeamStatus
  lifecycleRevision: number
  dissolvedAt?: number
  createdAt: number
  memberIds: string[]
}

interface MemberRecord {
  id: string
  teamId: string
  displayName: string
  displayNameKey: string
  role: TeamRole
  status: TeamMemberSummary['status']
  joinedAt: number
}

interface InviteRecord {
  id: string
  teamId: string
  invitedByMemberId: string
  label: string
  status: TeamInviteSummary['status']
  expiresAt: number
  createdAt: number
  acceptedAt?: number
  tokenHash: string
  envelope?: TeamInviteTokenEnvelope
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
  revokedReason?: 'member_removed' | 'member_left' | 'device_revoked' | 'team_dissolved'
  tokenHash: string
}

interface LifecycleOperationRecord {
  operationId: string
  teamId: string
  actorMemberId: string
  kind: 'status' | 'dissolution'
  bindingHash: string
  summary?: TeamSummary
  result?: TeamDissolutionResult
  recoverySecretHash?: string
  acknowledgedAt?: number
}

interface OwnershipTransferRecord {
  id: string
  teamId: string
  requestedByMemberId: string
  targetMemberId: string
  status: TeamOwnershipTransferStatus
  createdAt: number
  expiresAt: number
  resolvedAt?: number
  acceptanceResult?: TeamOwnershipTransferAcceptanceResult
}

type OwnershipTransferAuditAction =
  | 'requested'
  | 'accepted'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'canceled'

interface OwnershipTransferAuditRecord {
  id: string
  teamId: string
  transferId: string
  actorMemberId?: string
  action: OwnershipTransferAuditAction
  createdAt: number
}

interface ContributionRecord {
  id: string
  teamId: string
  ownerMemberId: string
  label: string
  status: TeamContributionStatus
  personalReservePercent: number
  maxSharedRequestsPerWindow: number | null
  dailySharedCreditLimit: number | null
  weeklySharedEstimatedApiCostLimitMicros: number | null
  maxSharedConcurrency: number
  allowedModels: string[]
  createdAt: number
  updatedAt: number
  lastError?: string
}

interface MembershipAuditRecord {
  id: string
  teamId: string
  actorMemberId: string
  targetMemberId: string
  action: TeamMembershipAuditAction
  previousRole: TeamRole
  nextRole?: TeamRole
  result: 'succeeded'
  createdAt: number
}

interface InviteRevealAuditRecord {
  id: string
  teamId: string
  actorMemberId: string
  inviteId: string
  createdAt: number
}

interface InviteRevealRateLimitRecord {
  windowStartedAt: number
  attemptCount: number
}

interface DissolutionRecoveryRateLimitRecord {
  windowStartedAt: number
  attemptCount: number
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
  reservedCredits: number
  reservedEstimatedCostUsdMicros: bigint
  credits?: number
  creditsFormulaVersion?: 'credits-v1'
  totalTokens?: number
  estimatedCostUsdMicros?: bigint
  pricingCatalogVersion?: string
  startedAt: number
  finishedAt?: number
}

export interface MemoryTeamStoreOptions {
  now?: () => number
  id?: () => string
  token?: () => string
  inviteCipher?: TeamInviteCipher
}

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TEAM_OWNERSHIP_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000
export const TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS = 5
export const TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS = 60_000
export const TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS = 5
export const TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS = 60_000
const MAX_TEAM_NAME_LENGTH = 120
const MAX_INVITE_LABEL_LENGTH = 120
const MAX_KEY_LABEL_LENGTH = 80
const MAX_MODEL_NAME_LENGTH = 120
const DEFAULT_PERSONAL_RESERVE_PERCENT = 20
const DEFAULT_MAX_SHARED_CONCURRENCY = 1
const MAX_DAILY_SHARED_CREDIT_LIMIT = 1_000_000_000_000
const MIN_WEEKLY_SHARED_ESTIMATED_API_COST_LIMIT_MICROS = 10_000
const MAX_WEEKLY_SHARED_ESTIMATED_API_COST_LIMIT_MICROS = 10_000_000_000

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

function lifecycleBindingHash(parts: readonly unknown[]): string {
  return hashToken(JSON.stringify(parts))
}

function lifecycleOperationId(value: string): string {
  const operationId = nonEmpty(value, 'operationId', 128)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) {
    throw new Error('operationId must be a UUID')
  }
  return operationId
}

function lifecycleRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('expectedLifecycleRevision must be a positive safe integer')
  }
  return value
}

function recoverySecretHash(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('recoverySecretHash must be a SHA-256 hex digest')
  return value
}

function dissolutionRecoverySourceDigest(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('sourceDigest must be a SHA-256 hex digest')
  return value
}

function dissolutionRecoveryAction(value: TeamDissolutionRecoveryAction): TeamDissolutionRecoveryAction {
  if (value !== 'result' && value !== 'ack') throw new Error('dissolution recovery action is invalid')
  return value
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
    lifecycleRevision: team.lifecycleRevision,
    ...(team.dissolvedAt === undefined ? {} : { dissolvedAt: team.dissolvedAt }),
    createdAt: team.createdAt,
  }
}

function summaryMember(member: MemberRecord): TeamMemberSummary {
  return {
    id: member.id,
    teamId: member.teamId,
    displayName: member.displayName,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt,
  }
}

function summaryMembershipAudit(event: MembershipAuditRecord): TeamMembershipAuditEventSummary {
  return {
    id: event.id,
    teamId: event.teamId,
    actorMemberId: event.actorMemberId,
    targetMemberId: event.targetMemberId,
    action: event.action,
    previousRole: event.previousRole,
    ...(event.nextRole === undefined ? {} : { nextRole: event.nextRole }),
    result: event.result,
    createdAt: event.createdAt,
  }
}

function summaryOwnershipTransfer(transfer: OwnershipTransferRecord): TeamOwnershipTransferSummary {
  return {
    id: transfer.id,
    teamId: transfer.teamId,
    requestedByMemberId: transfer.requestedByMemberId,
    targetMemberId: transfer.targetMemberId,
    status: transfer.status,
    createdAt: transfer.createdAt,
    expiresAt: transfer.expiresAt,
    ...(transfer.resolvedAt === undefined ? {} : { resolvedAt: transfer.resolvedAt }),
  }
}

function cloneOwnershipTransferAcceptanceResult(
  result: TeamOwnershipTransferAcceptanceResult,
): TeamOwnershipTransferAcceptanceResult {
  return {
    transfer: { ...result.transfer },
    formerOwner: { ...result.formerOwner },
    owner: { ...result.owner },
  }
}

function summaryInviteRevealAudit(event: InviteRevealAuditRecord): TeamInviteRevealAuditEventSummary {
  return {
    id: event.id,
    teamId: event.teamId,
    actorMemberId: event.actorMemberId,
    inviteId: event.inviteId,
    createdAt: event.createdAt,
  }
}

function summaryInvite(invite: InviteRecord, now: number): TeamInviteSummary {
  const status = invite.status === 'pending' && invite.expiresAt <= now ? 'expired' : invite.status
  return {
    id: invite.id,
    teamId: invite.teamId,
    invitedByMemberId: invite.invitedByMemberId,
    label: invite.label,
    status,
    revealable: status === 'pending' && invite.envelope !== undefined,
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
    dailySharedCreditLimit: account.dailySharedCreditLimit,
    weeklySharedEstimatedApiCostLimitMicros: account.weeklySharedEstimatedApiCostLimitMicros,
    maxSharedConcurrency: account.maxSharedConcurrency,
    allowedModels: [...account.allowedModels],
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    ...(account.lastError === undefined ? {} : { lastError: safeTeamErrorMessage(account.lastError) }),
  }
}

function summaryUsageEvent(event: UsageEventRecord): TeamUsageEventSummary {
  return {
    id: event.id,
    teamId: event.teamId,
    consumerMemberId: event.consumerMemberId,
    upstreamOwnerMemberId: event.upstreamOwnerMemberId,
    upstreamAccountId: event.upstreamAccountId,
    model: event.model,
    unit: event.unit,
    status: event.status,
    ...(event.credits === undefined ? {} : { credits: event.credits }),
    ...(event.creditsFormulaVersion === undefined ? {} : { creditsFormulaVersion: event.creditsFormulaVersion }),
    ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
    ...(event.estimatedCostUsdMicros === undefined ? {} : { estimatedCostUsdMicros: event.estimatedCostUsdMicros.toString() }),
    ...(event.pricingCatalogVersion === undefined ? {} : { pricingCatalogVersion: event.pricingCatalogVersion }),
    startedAt: event.startedAt,
    ...(event.finishedAt === undefined ? {} : { finishedAt: event.finishedAt }),
  }
}

function aggregateUsage(events: readonly UsageEventRecord[]): TeamUsageAggregateSummary {
  let tokenMeasuredRequestCount = 0
  let pricedRequestCount = 0
  let totalTokens = 0n
  let estimatedCostUsdMicros = 0n
  for (const event of events) {
    if (event.totalTokens !== undefined) {
      tokenMeasuredRequestCount += 1
      totalTokens += BigInt(event.totalTokens)
    }
    if (event.estimatedCostUsdMicros !== undefined) {
      pricedRequestCount += 1
      estimatedCostUsdMicros += event.estimatedCostUsdMicros
    }
  }
  const requestCount = events.length
  return {
    requestCount,
    tokenMeasuredRequestCount,
    pricedRequestCount,
    totalTokens: requestCount === 0 ? '0' : tokenMeasuredRequestCount === 0 ? null : totalTokens.toString(),
    estimatedCostUsdMicros: requestCount === 0 ? '0' : pricedRequestCount === 0 ? null : estimatedCostUsdMicros.toString(),
  }
}

function ownedAccountUsage(
  events: readonly UsageEventRecord[],
  accounts: readonly ContributionRecord[],
  memberId: string,
  endedAt: number,
): TeamUsageProjection['ownedAccounts'] {
  const startedAt = endedAt - 7 * 86_400_000
  const last24HoursStartedAt = endedAt - 86_400_000
  const currentUtcWeekStartedAt = utcIsoWeekStart(endedAt)
  const currentUtcWeekResetAt = currentUtcWeekStartedAt + 7 * 86_400_000
  return accounts
    .filter(account => account.ownerMemberId === memberId && account.status !== 'revoked')
    .map(account => {
      const matching = events
        .filter(event => event.upstreamAccountId === account.id
          && event.consumerMemberId !== event.upstreamOwnerMemberId
          && event.startedAt >= startedAt && event.startedAt <= endedAt)
        .sort((left, right) => right.startedAt - left.startedAt)
      return {
        accountId: account.id,
        window: { startedAt, endedAt },
        aggregate: aggregateUsage(matching),
        currentUtcWeek: {
          window: { startedAt: currentUtcWeekStartedAt, endedAt },
          resetAt: currentUtcWeekResetAt,
          aggregate: aggregateUsage(matching.filter(event => event.startedAt >= currentUtcWeekStartedAt)),
        },
        last24Hours: {
          window: { startedAt: last24HoursStartedAt, endedAt },
          aggregate: aggregateUsage(matching.filter(event => event.startedAt >= last24HoursStartedAt)),
        },
        recentRequests: matching.slice(0, 10).map(event => ({
          id: event.id,
          model: event.model,
          status: event.status,
          startedAt: event.startedAt,
          ...(event.finishedAt === undefined ? {} : { finishedAt: event.finishedAt }),
          ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
          ...(event.estimatedCostUsdMicros === undefined ? {} : { estimatedCostUsdMicros: event.estimatedCostUsdMicros.toString() }),
        })),
      }
    })
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
  private readonly lifecycleOperations = new Map<string, LifecycleOperationRecord>()
  private readonly ownershipTransfers = new Map<string, OwnershipTransferRecord>()
  private readonly ownershipTransferAuditEvents: OwnershipTransferAuditRecord[] = []
  private readonly membershipAuditEvents: MembershipAuditRecord[] = []
  private readonly inviteRevealAuditEvents: InviteRevealAuditRecord[] = []
  private readonly inviteRevealRateLimits = new Map<string, InviteRevealRateLimitRecord>()
  private readonly dissolutionRecoveryRateLimits = new Map<string, DissolutionRecoveryRateLimitRecord>()
  private readonly now: () => number
  private readonly id: () => string
  private readonly token: () => string
  private readonly inviteCipher: TeamInviteCipher
  private readonly ownedInviteKeyProvider?: Aes256GcmTeamInviteKeyEncryptionProvider

  constructor(options: MemoryTeamStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
    this.token = options.token ?? (() => randomBytes(32).toString('base64url'))
    if (options.inviteCipher !== undefined) {
      this.inviteCipher = options.inviteCipher
    } else {
      const key = randomBytes(32)
      try {
        this.ownedInviteKeyProvider = new Aes256GcmTeamInviteKeyEncryptionProvider(key)
        this.inviteCipher = new TeamInviteCipher({ keyEncryptionProvider: this.ownedInviteKeyProvider })
      } finally {
        key.fill(0)
      }
    }
  }

  async bootstrap(teamName: string, ownerName: string): Promise<TeamBootstrapResult> {
    const normalizedTeamName = nonEmpty(teamName, 'teamName', MAX_TEAM_NAME_LENGTH)
    const normalizedOwnerName = normalizeTeamMemberDisplayName(ownerName, 'ownerName')
    const now = this.now()
    const team: TeamRecord = {
      id: this.id(),
      name: normalizedTeamName,
      status: 'active',
      lifecycleRevision: 1,
      createdAt: now,
      memberIds: [],
    }
    const member: MemberRecord = {
      id: this.id(),
      teamId: team.id,
      displayName: normalizedOwnerName.displayName,
      displayNameKey: normalizedOwnerName.displayNameKey,
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
    const now = this.now()
    const ownershipTransfer = this.findPendingOwnershipTransfer(team.id, now)
    if (currentMember.role === 'owner') {
      for (const invite of this.invites.values()) {
        if (invite.teamId === team.id) this.expireInvite(invite, now)
      }
    }
    return {
      team: summaryTeam(team),
      currentMember: summaryMember(currentMember),
      members: team.memberIds.map(id => this.requireStoredMember(id, team.id)).map(summaryMember),
      invites: currentMember.role === 'owner'
        ? [...this.invites.values()]
          .filter(invite => invite.teamId === team.id && invite.status === 'pending' && invite.expiresAt > now)
          .map(invite => summaryInvite(invite, now))
        : [],
      apiKeys: [...this.keys.values()]
        .filter(key => key.teamId === team.id)
        .map(summaryKey),
      contributions: [...this.contributions.values()]
        .filter(account => account.teamId === team.id)
        .map(summaryContribution),
      ...(
        ownershipTransfer !== undefined
        && (currentMember.id === ownershipTransfer.requestedByMemberId
          || currentMember.id === ownershipTransfer.targetMemberId)
          ? { ownershipTransfer: summaryOwnershipTransfer(ownershipTransfer) }
          : {}
      ),
    }
  }

  async acknowledgeDisplayNameMigration(
    auth: TeamAuthContext,
    _migrationVersion: number,
  ): Promise<TeamDisplayNameMigrationAcknowledgement> {
    this.requireAuthContext(auth)
    throw new TeamDisplayNameMigrationUnavailableError()
  }

  async createInvite(
    auth: TeamAuthContext,
    expiresInMs = DEFAULT_INVITE_TTL_MS,
    label = 'Team invitation',
  ): Promise<TeamInviteResult> {
    this.requireOwner(auth)
    const team = this.requireTeam(auth.teamId)
    if (team.status !== 'active') throw new Error('team is paused')
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error('expiresInMs is outside the allowed range')
    }
    const now = this.now()
    const inviteId = this.id()
    const invite: InviteRecord = {
      id: inviteId,
      teamId: auth.teamId,
      invitedByMemberId: auth.memberId,
      label: nonEmpty(label, 'label', MAX_INVITE_LABEL_LENGTH),
      status: 'pending',
      expiresAt: now + expiresInMs,
      createdAt: now,
      tokenHash: '',
    }
    const token = createSecret('dsh_invite', this.token)
    invite.tokenHash = hashToken(token)
    invite.envelope = await this.inviteCipher.encrypt({
      teamId: auth.teamId,
      inviteId,
      createdAt: now,
      tokenDigest: invite.tokenHash,
    }, token)
    // Envelope encryption is asynchronous. Re-establish the Owner/state
    // preconditions immediately before the synchronous in-memory commit so a
    // concurrent ownership transfer cannot insert an invite for the old Owner.
    this.requireOwner(auth)
    const currentTeam = this.requireTeam(auth.teamId)
    if (currentTeam.status !== 'active') throw new Error('team is paused')
    this.invites.set(invite.id, invite)
    this.inviteHashes.set(invite.tokenHash, invite.id)
    return { invite: summaryInvite(invite, now), inviteToken: token }
  }

  async revealInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteRevealResult> {
    this.requireOwner(auth)
    const now = this.now()
    this.consumeInviteRevealRateLimit(auth, inviteId, now)
    const invite = this.invites.get(inviteId)
    if (invite !== undefined && invite.teamId === auth.teamId) this.expireInvite(invite, now)
    if (
      invite === undefined
      || invite.teamId !== auth.teamId
      || invite.status !== 'pending'
      || invite.expiresAt <= now
      || invite.envelope === undefined
    ) {
      throw new Error('invite is no longer available')
    }
    const envelope = invite.envelope
    let inviteToken: string
    try {
      inviteToken = await this.inviteCipher.decrypt({
        teamId: invite.teamId,
        inviteId: invite.id,
        createdAt: invite.createdAt,
        tokenDigest: invite.tokenHash,
      }, envelope)
    } catch {
      throw new Error('invite is no longer available')
    }
    const current = this.invites.get(inviteId)
    const afterDecryptNow = this.now()
    const currentOwner = this.requireTeamOwner(auth)
    if (current !== undefined) this.expireInvite(current, afterDecryptNow)
    if (
      current !== invite
      || current.status !== 'pending'
      || current.expiresAt <= afterDecryptNow
      || current.envelope !== envelope
    ) {
      throw new Error('invite is no longer available')
    }
    this.inviteRevealAuditEvents.push({
      id: this.id(),
      teamId: current.teamId,
      actorMemberId: currentOwner.id,
      inviteId: current.id,
      createdAt: afterDecryptNow,
    })
    return { inviteId: invite.id, inviteToken, expiresAt: invite.expiresAt }
  }

  private consumeInviteRevealRateLimit(auth: TeamAuthContext, inviteId: string, now: number): void {
    const windowStartedAt = Math.floor(now / TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS)
      * TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS
    for (const [key, record] of this.inviteRevealRateLimits) {
      if (record.windowStartedAt !== windowStartedAt) this.inviteRevealRateLimits.delete(key)
    }
    const key = JSON.stringify([auth.teamId, auth.memberId, inviteId])
    const current = this.inviteRevealRateLimits.get(key)
    if (
      current?.windowStartedAt === windowStartedAt
      && current.attemptCount >= TEAM_INVITE_REVEAL_RATE_LIMIT_MAX_ATTEMPTS
    ) {
      throw new TeamInviteRevealRateLimitError(Math.max(
        1,
        Math.ceil((windowStartedAt + TEAM_INVITE_REVEAL_RATE_LIMIT_WINDOW_MS - now) / 1_000),
      ))
    }
    this.inviteRevealRateLimits.set(key, {
      windowStartedAt,
      attemptCount: current?.windowStartedAt === windowStartedAt ? current.attemptCount + 1 : 1,
    })
  }

  async previewInvite(token: string): Promise<TeamInvitePreview> {
    const inviteId = this.inviteHashes.get(hashToken(token))
    if (inviteId === undefined) throw new Error('invite is invalid or expired')
    const invite = this.invites.get(inviteId)
    if (invite !== undefined) this.expireInvite(invite, this.now())
    if (invite === undefined || invite.status !== 'pending' || invite.expiresAt <= this.now()) {
      throw new Error('invite is invalid or expired')
    }
    const team = this.requireTeam(invite.teamId)
    return {
      teamName: team.name,
      label: invite.label,
      expiresAt: invite.expiresAt,
      teamStatus: team.status,
    }
  }

  async revokeInvite(auth: TeamAuthContext, inviteId: string): Promise<TeamInviteSummary> {
    this.requireOwner(auth)
    const invite = this.invites.get(inviteId)
    if (invite === undefined || invite.teamId !== auth.teamId) throw new Error('invite not found')
    this.expireInvite(invite, this.now())
    if (invite.status === 'accepted') throw new Error('accepted invite cannot be revoked')
    if (invite.status === 'expired') return summaryInvite(invite, this.now())
    if (invite.status === 'revoked') return summaryInvite(invite, this.now())
    invite.status = 'revoked'
    this.inviteHashes.delete(invite.tokenHash)
    invite.tokenHash = hashToken(`revoked:${invite.id}`)
    delete invite.envelope
    return summaryInvite(invite, this.now())
  }

  async acceptInvite(token: string, displayName: string): Promise<TeamJoinResult> {
    const result = this.acceptInviteRecord(token, displayName)
    return { team: result.team, member: result.member, apiKey: result.apiKey }
  }

  async acceptInviteWithApiKey(token: string, displayName: string, apiKey: string): Promise<TeamJoinAcceptedResult> {
    const result = this.acceptInviteRecord(token, displayName, apiKey)
    return { team: result.team, member: result.member }
  }

  private acceptInviteRecord(token: string, displayName: string, suppliedApiKey?: string): TeamJoinResult {
    const inviteId = this.inviteHashes.get(hashToken(token))
    if (inviteId === undefined) throw new Error('invite is invalid or expired')
    const invite = this.invites.get(inviteId)
    if (invite !== undefined) this.expireInvite(invite, this.now())
    if (invite === undefined || invite.status !== 'pending' || invite.expiresAt <= this.now()) {
      throw new Error('invite is invalid or expired')
    }
    const team = this.requireTeam(invite.teamId)
    if (team.status !== 'active') throw new Error('team is paused')
    const normalizedName = normalizeTeamMemberDisplayName(displayName, 'displayName')
    const duplicate = team.memberIds.some((memberId) => {
      const existing = this.members.get(memberId)
      return existing?.status === 'active'
        && existing.displayNameKey === normalizedName.displayNameKey
    })
    if (duplicate) {
      throw new Error('Team display name is already in use by an active member')
    }
    const now = this.now()
    const member: MemberRecord = {
      id: this.id(),
      teamId: team.id,
      displayName: normalizedName.displayName,
      displayNameKey: normalizedName.displayNameKey,
      role: 'member',
      status: 'active',
      joinedAt: now,
    }
    const key = this.prepareKey(team.id, member.id, 'member', now, suppliedApiKey)
    this.members.set(member.id, member)
    team.memberIds.push(member.id)
    this.commitKey(key)
    invite.status = 'accepted'
    invite.acceptedAt = now
    this.inviteHashes.delete(invite.tokenHash)
    invite.tokenHash = hashToken(`accepted:${invite.id}`)
    delete invite.envelope
    return { team: summaryTeam(team), member: summaryMember(member), apiKey: key.token }
  }

  async issueApiKey(auth: TeamAuthContext, label: string): Promise<{ summary: TeamApiKeySummary; token: string }> {
    this.requireAuthContext(auth)
    const key = this.createKey(auth.teamId, auth.memberId, nonEmpty(label, 'label', MAX_KEY_LABEL_LENGTH), this.now())
    return { summary: summaryKey(key), token: key.token }
  }

  async revokeApiKey(auth: TeamAuthContext, keyId: string): Promise<void> {
    const actor = this.requireAuthContext(auth)
    const key = this.keys.get(keyId)
    if (key === undefined || key.teamId !== auth.teamId) throw new Error('api key not found')
    if (key.memberId !== auth.memberId && auth.role !== 'owner') {
      throw new Error('only the key owner or the Team owner can revoke this key')
    }
    if (actor.role === 'owner' && key.id === auth.keyId && key.revokedAt === undefined) {
      throw new Error('the current Owner API key cannot be revoked; authenticate with another Owner key')
    }
    if (key.revokedAt === undefined) {
      key.revokedAt = this.now()
      key.revokedReason = 'device_revoked'
    }
  }

  async requestOwnershipTransfer(
    auth: TeamAuthContext,
    targetMemberId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    const formerOwner = this.requireAuthContext(auth)
    if (formerOwner.role !== 'owner') throw new Error('only the owner can transfer Team ownership')
    if (targetMemberId === formerOwner.id) throw new Error('ownership target must be a different Team member')
    const target = this.requireMember(targetMemberId, formerOwner.teamId)
    if (target.role !== 'member') throw new Error('ownership target must be an ordinary Team member')
    const hasActiveKey = [...this.keys.values()].some(key => (
      key.teamId === formerOwner.teamId
      && key.memberId === target.id
      && key.revokedAt === undefined
    ))
    if (!hasActiveKey) throw new Error('ownership target must have an active Team API key')

    const now = this.now()
    const pending = this.findPendingOwnershipTransfer(formerOwner.teamId, now)
    if (pending !== undefined) throw new Error('this Team already has a pending ownership transfer')
    const transfer: OwnershipTransferRecord = {
      id: this.id(),
      teamId: formerOwner.teamId,
      requestedByMemberId: formerOwner.id,
      targetMemberId: target.id,
      status: 'pending',
      createdAt: now,
      expiresAt: now + TEAM_OWNERSHIP_TRANSFER_TTL_MS,
    }
    this.ownershipTransfers.set(transfer.id, transfer)
    this.recordOwnershipTransferAudit(transfer, 'requested', now, formerOwner.id)
    return summaryOwnershipTransfer(transfer)
  }

  async acceptOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferAcceptanceResult> {
    const target = this.requireAuthContext(auth)
    const transfer = this.requireOwnershipTransferParticipant(transferId, target.teamId, target.id, 'target')
    const now = this.now()
    this.expireOwnershipTransfer(transfer, now)
    if (transfer.status === 'accepted' && transfer.acceptanceResult !== undefined) {
      return cloneOwnershipTransferAcceptanceResult(transfer.acceptanceResult)
    }
    this.requirePendingOwnershipTransfer(transfer)
    if (target.role !== 'member') throw new Error('ownership target must be an ordinary Team member')
    const formerOwner = this.requireMember(transfer.requestedByMemberId, target.teamId)
    if (formerOwner.role !== 'owner') throw new Error('ownership transfer requester is no longer the Team owner')

    const audit = this.prepareMembershipAudit(
      target.teamId,
      target.id,
      target.id,
      'ownership_transferred',
      target.role,
      'owner',
      now,
    )
    formerOwner.role = 'member'
    target.role = 'owner'
    for (const invite of this.invites.values()) {
      if (invite.teamId !== target.teamId || invite.status !== 'pending') continue
      invite.status = 'revoked'
      this.inviteHashes.delete(invite.tokenHash)
      invite.tokenHash = hashToken(`ownership-transfer:${invite.id}`)
      delete invite.envelope
    }
    transfer.status = 'accepted'
    transfer.resolvedAt = now
    this.membershipAuditEvents.push(audit)
    const result: TeamOwnershipTransferAcceptanceResult = {
      transfer: summaryOwnershipTransfer(transfer),
      formerOwner: summaryMember(formerOwner),
      owner: summaryMember(target),
    }
    transfer.acceptanceResult = cloneOwnershipTransferAcceptanceResult(result)
    this.recordOwnershipTransferAudit(transfer, 'accepted', now, target.id)
    return result
  }

  async rejectOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    const target = this.requireAuthContext(auth)
    const transfer = this.requireOwnershipTransferParticipant(transferId, target.teamId, target.id, 'target')
    const now = this.now()
    this.expireOwnershipTransfer(transfer, now)
    if (transfer.status !== 'pending') return summaryOwnershipTransfer(transfer)
    this.requirePendingOwnershipTransfer(transfer)
    transfer.status = 'rejected'
    transfer.resolvedAt = now
    this.recordOwnershipTransferAudit(transfer, 'rejected', now, target.id)
    return summaryOwnershipTransfer(transfer)
  }

  async revokeOwnershipTransfer(
    auth: TeamAuthContext,
    transferId: string,
  ): Promise<TeamOwnershipTransferSummary> {
    const owner = this.requireAuthContext(auth)
    const transfer = this.requireOwnershipTransferParticipant(transferId, owner.teamId, owner.id, 'requester')
    const now = this.now()
    this.expireOwnershipTransfer(transfer, now)
    if (transfer.status !== 'pending') return summaryOwnershipTransfer(transfer)
    if (owner.role !== 'owner') {
      throw new Error('only the current Team owner can revoke this ownership transfer')
    }
    this.requirePendingOwnershipTransfer(transfer)
    transfer.status = 'revoked'
    transfer.resolvedAt = now
    this.recordOwnershipTransferAudit(transfer, 'revoked', now, owner.id)
    return summaryOwnershipTransfer(transfer)
  }

  async removeMember(auth: TeamAuthContext, targetMemberId: string): Promise<TeamMemberDepartureResult> {
    const owner = this.requireTeamOwner(auth)
    if (owner.id === targetMemberId) throw new Error('Team owner cannot remove themselves')
    const target = this.requireMember(targetMemberId, owner.teamId)
    if (target.role === 'owner') throw new Error('Team owner cannot be removed')
    return this.departMember(target, owner.id, 'member_removed')
  }

  async leaveTeam(auth: TeamAuthContext): Promise<TeamMemberDepartureResult> {
    const member = this.requireAuthContext(auth)
    if (member.role === 'owner') throw new Error('Team owner cannot leave before transferring ownership')
    return this.departMember(member, member.id, 'member_left')
  }

  async listMembershipAuditEvents(
    auth: TeamAuthContext,
    limit: number,
  ): Promise<readonly TeamMembershipAuditEventSummary[]> {
    this.requireTeamOwner(auth)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('membership audit limit must be an integer from 1 to 1000')
    }
    return this.membershipAuditEvents
      .filter(event => event.teamId === auth.teamId)
      .slice(-limit)
      .reverse()
      .map(summaryMembershipAudit)
  }

  async listInviteRevealAuditEvents(
    auth: TeamAuthContext,
    limit: number,
  ): Promise<readonly TeamInviteRevealAuditEventSummary[]> {
    this.requireTeamOwner(auth)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('invite reveal audit limit must be an integer from 1 to 1000')
    }
    return this.inviteRevealAuditEvents
      .filter(event => event.teamId === auth.teamId)
      .slice(-limit)
      .reverse()
      .map(summaryInviteRevealAudit)
  }

  private departMember(
    member: MemberRecord,
    actorMemberId: string,
    action: Extract<TeamMembershipAuditAction, 'member_removed' | 'member_left'>,
  ): TeamMemberDepartureResult {
    const now = this.now()
    this.cancelPendingOwnershipTransferForTarget(member.teamId, member.id, now, actorMemberId)
    const audit = this.prepareMembershipAudit(
      member.teamId,
      actorMemberId,
      member.id,
      action,
      member.role,
      undefined,
      now,
    )
    member.status = 'removed'
    for (const key of this.keys.values()) {
      if (key.teamId !== member.teamId || key.memberId !== member.id || key.revokedAt !== undefined) continue
      key.revokedAt = now
      key.revokedReason = action
    }
    const contributions = [...this.contributions.values()]
      .filter(account => account.teamId === member.teamId && account.ownerMemberId === member.id)
    for (const account of contributions) {
      account.status = 'revoked'
      account.updatedAt = now
    }
    this.membershipAuditEvents.push(audit)
    return {
      member: summaryMember(member),
      contributions: contributions.map(summaryContribution),
    }
  }

  private prepareMembershipAudit(
    teamId: string,
    actorMemberId: string,
    targetMemberId: string,
    action: Extract<
      TeamMembershipAuditAction,
      'ownership_transferred' | 'member_removed' | 'member_left'
    >,
    previousRole: TeamRole,
    nextRole?: TeamRole,
    createdAt = this.now(),
  ): MembershipAuditRecord {
    return {
      id: this.id(),
      teamId,
      actorMemberId,
      targetMemberId,
      action,
      previousRole,
      ...(nextRole === undefined ? {} : { nextRole }),
      result: 'succeeded',
      createdAt,
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
      dailySharedCreditLimit: null,
      weeklySharedEstimatedApiCostLimitMicros: null,
      maxSharedConcurrency: DEFAULT_MAX_SHARED_CONCURRENCY,
      allowedModels: [],
      createdAt: now,
      updatedAt: now,
    }
    this.contributions.set(account.id, account)
    return summaryContribution(account)
  }

  async listContributionAccounts(auth: TeamAuthContext): Promise<readonly TeamContributionAccountSummary[]> {
    const member = this.requireAuthContext(auth)
    return [...this.contributions.values()]
      .filter(account => account.teamId === member.teamId && account.ownerMemberId === member.id)
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
    if (patch.dailySharedCreditLimit !== undefined) {
      const value = patch.dailySharedCreditLimit
      if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > MAX_DAILY_SHARED_CREDIT_LIMIT)) {
        throw new Error(`dailySharedCreditLimit must be null or an integer from 1 to ${MAX_DAILY_SHARED_CREDIT_LIMIT}`)
      }
      account.dailySharedCreditLimit = value
    }
    if (patch.weeklySharedEstimatedApiCostLimitMicros !== undefined) {
      const value = patch.weeklySharedEstimatedApiCostLimitMicros
      if (value !== null && (!Number.isSafeInteger(value)
        || value < MIN_WEEKLY_SHARED_ESTIMATED_API_COST_LIMIT_MICROS
        || value > MAX_WEEKLY_SHARED_ESTIMATED_API_COST_LIMIT_MICROS)) {
        throw new Error('weeklySharedEstimatedApiCostLimitMicros must be null or an integer from 10000 to 10000000000')
      }
      account.weeklySharedEstimatedApiCostLimitMicros = value
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
    if (account.ownerMemberId !== member.id) throw new Error('only the owner of the contribution account can revoke it')
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
    providerAuthenticatedLabel?: string,
  ): Promise<TeamContributionAccountSummary> {
    const account = this.requireContribution(accountId, teamId)
    if (this.requireTeam(teamId).status === 'dissolved' && status !== 'revoked') return summaryContribution(account)
    if (account.status === 'revoked' && status !== 'revoked') return summaryContribution(account)
    if (expectedStatus !== undefined && account.status !== expectedStatus) return summaryContribution(account)
    if (providerAuthenticatedLabel !== undefined) {
      if (status !== 'active') throw new Error('providerAuthenticatedLabel requires active status')
      account.label = nonEmpty(providerAuthenticatedLabel, 'providerAuthenticatedLabel', MAX_KEY_LABEL_LENGTH)
    }
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
    reservedCredits = 0,
  ): Promise<TeamUsageEventSummary> {
    const member = this.requireAuthContext(auth)
    if (this.requireTeam(member.teamId).status !== 'active') throw new Error('team is paused')
    if (this.usageEvents.has(eventId)) throw new Error('usage event already exists')
    const account = this.requireContribution(accountId, member.teamId)
    if (account.status !== 'active') throw new Error('contribution account is not active')
    if (!Number.isSafeInteger(reservedCredits) || reservedCredits < 0 || reservedCredits > MAX_DAILY_SHARED_CREDIT_LIMIT) {
      throw new Error(`reservedCredits must be an integer from 0 to ${MAX_DAILY_SHARED_CREDIT_LIMIT}`)
    }
    const shared = account.ownerMemberId !== member.id
    const effectiveReservation = shared ? reservedCredits : 0
    const startedAt = this.now()
    if (shared && account.dailySharedCreditLimit !== null) {
      const dayStart = utcDayStart(startedAt)
      const usedCredits = [...this.usageEvents.values()]
        .filter(event => event.teamId === member.teamId
          && event.upstreamAccountId === account.id
          && event.consumerMemberId !== event.upstreamOwnerMemberId
          && event.startedAt >= dayStart
          && event.startedAt < dayStart + 86_400_000)
        .reduce((total, event) => total + (event.status === 'in_progress' ? event.reservedCredits : (event.credits ?? 0)), 0)
      if (usedCredits + effectiveReservation > account.dailySharedCreditLimit) {
        throw new TeamDailyCreditsLimitError()
      }
    }
    const weeklyLimit = account.weeklySharedEstimatedApiCostLimitMicros
    const estimatedCostReservation = shared && weeklyLimit !== null
      ? BigInt(Math.min(weeklyLimit, 250_000))
      : 0n
    if (shared && weeklyLimit !== null) {
      const weekStart = utcIsoWeekStart(startedAt)
      const used = [...this.usageEvents.values()]
        .filter(event => event.teamId === member.teamId
          && event.upstreamAccountId === account.id
          && event.consumerMemberId !== event.upstreamOwnerMemberId
          && event.startedAt >= weekStart
          && event.startedAt < weekStart + 7 * 86_400_000)
        .reduce((total, event) => total + (event.status === 'in_progress'
          ? event.reservedEstimatedCostUsdMicros
          : (event.estimatedCostUsdMicros ?? 0n)), 0n)
      if (used + estimatedCostReservation > BigInt(weeklyLimit)) throw new TeamWeeklyEstimatedCostLimitError()
    }
    const event: UsageEventRecord = {
      id: nonEmpty(eventId, 'eventId', 128),
      teamId: member.teamId,
      consumerMemberId: member.id,
      upstreamOwnerMemberId: account.ownerMemberId,
      upstreamAccountId: account.id,
      model: nonEmpty(model, 'model', MAX_MODEL_NAME_LENGTH),
      unit: 'request',
      status: 'in_progress',
      reservedCredits: effectiveReservation,
      reservedEstimatedCostUsdMicros: estimatedCostReservation,
      startedAt,
    }
    this.usageEvents.set(event.id, event)
    return summaryUsageEvent(event)
  }

  async settleUsageEvent(
    teamId: string,
    eventId: string,
    status: Exclude<TeamUsageEventStatus, 'in_progress'>,
    usage?: TeamProviderTokenUsage,
    costEstimate?: TeamUsageCostEstimate,
  ): Promise<TeamUsageEventSummary> {
    const event = this.usageEvents.get(eventId)
    if (event === undefined || event.teamId !== teamId) throw new Error('usage event not found')
    if (event.status !== 'in_progress') {
      if (event.status === status) return summaryUsageEvent(event)
      throw new Error('usage event is already settled')
    }
    const calculation = usage === undefined ? undefined : calculateTeamCredits(usage)
    if (costEstimate !== undefined && calculation === undefined) {
      throw new Error('a Team cost estimate requires measured provider Token usage')
    }
    event.status = status
    event.reservedCredits = 0
    if (calculation !== undefined && usage !== undefined) {
      event.credits = calculation.credits
      event.creditsFormulaVersion = calculation.formulaVersion
      event.totalTokens = usage.inputTokens + usage.outputTokens
    }
    if (costEstimate !== undefined) {
      if (
        typeof costEstimate.estimatedCostUsdMicros !== 'bigint'
        || costEstimate.estimatedCostUsdMicros < 0n
        || costEstimate.estimatedCostUsdMicros > 9_223_372_036_854_775_807n
      ) {
        throw new Error('estimatedCostUsdMicros must be a non-negative signed bigint')
      }
      event.estimatedCostUsdMicros = costEstimate.estimatedCostUsdMicros
      event.pricingCatalogVersion = nonEmpty(costEstimate.pricingCatalogVersion, 'pricingCatalogVersion', 128)
    } else if (status !== 'cancelled' && event.reservedEstimatedCostUsdMicros > 0n) {
      event.estimatedCostUsdMicros = event.reservedEstimatedCostUsdMicros
      event.pricingCatalogVersion = 'admission-reservation-v1'
    }
    event.reservedEstimatedCostUsdMicros = 0n
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

  async listUsageAggregates(auth: TeamAuthContext): Promise<TeamUsageAggregates> {
    const member = this.requireAuthContext(auth)
    const generatedAt = this.now()
    const last24HoursStartedAt = generatedAt - 86_400_000
    const last7DaysStartedAt = utcDayStart(generatedAt) - 6 * 86_400_000
    const accountTotals = new Map<string, TeamAccountUsage24HourSummary>()
    const memberDaily = new Map<string, TeamMemberDailyUsageSummary>()

    for (const event of this.usageEvents.values()) {
      if (
        event.teamId !== member.teamId
        || event.consumerMemberId === event.upstreamOwnerMemberId
        || event.startedAt < last7DaysStartedAt
      ) continue
      const measured = event.credits === undefined ? 0 : 1
      const credits = event.credits ?? 0
      const dayStartedAt = utcDayStart(event.startedAt)
      const dailyKey = `${event.upstreamAccountId}\u0000${event.consumerMemberId}\u0000${dayStartedAt}`
      const existingDaily = memberDaily.get(dailyKey)
      memberDaily.set(dailyKey, {
        upstreamAccountId: event.upstreamAccountId,
        consumerMemberId: event.consumerMemberId,
        dayStartedAt,
        requestCount: (existingDaily?.requestCount ?? 0) + 1,
        measuredRequestCount: (existingDaily?.measuredRequestCount ?? 0) + measured,
        credits: (existingDaily?.credits ?? 0) + credits,
      })

      if (event.startedAt < last24HoursStartedAt) continue
      const existingAccount = accountTotals.get(event.upstreamAccountId)
      accountTotals.set(event.upstreamAccountId, {
        upstreamAccountId: event.upstreamAccountId,
        requestCount: (existingAccount?.requestCount ?? 0) + 1,
        measuredRequestCount: (existingAccount?.measuredRequestCount ?? 0) + measured,
        credits: (existingAccount?.credits ?? 0) + credits,
      })
    }

    return {
      generatedAt,
      last24HoursStartedAt,
      last7DaysStartedAt,
      accountTotals24Hours: [...accountTotals.values()].sort((left, right) => left.upstreamAccountId.localeCompare(right.upstreamAccountId)),
      memberDaily7Days: [...memberDaily.values()].sort((left, right) =>
        left.dayStartedAt - right.dayStartedAt
        || left.consumerMemberId.localeCompare(right.consumerMemberId)
        || left.upstreamAccountId.localeCompare(right.upstreamAccountId)),
    }
  }

  async readUsageProjection(auth: TeamAuthContext): Promise<TeamUsageProjection> {
    const member = this.requireAuthContext(auth)
    const endedAt = this.now()
    const startedAt = endedAt - 86_400_000
    const sharedInWindow = [...this.usageEvents.values()].filter(event =>
      event.teamId === member.teamId
      && event.consumerMemberId !== event.upstreamOwnerMemberId
      && event.startedAt >= startedAt
      && event.startedAt <= endedAt)
    const mine = aggregateUsage(sharedInWindow.filter(event => event.consumerMemberId === member.id))
    const ownedAccounts = ownedAccountUsage(
      [...this.usageEvents.values()].filter(event => event.teamId === member.teamId),
      [...this.contributions.values()].filter(account => account.teamId === member.teamId),
      member.id,
      endedAt,
    )
    if (member.role !== 'owner') {
      return { role: 'member', window: { startedAt, endedAt }, currency: 'USD', mine, ownedAccounts }
    }
    return {
      role: 'owner',
      window: { startedAt, endedAt },
      currency: 'USD',
      team: aggregateUsage(sharedInWindow),
      mine,
      ownedAccounts,
    }
  }

  async setTeamStatus(auth: TeamAuthContext, input: TeamLifecycleTransitionInput): Promise<TeamSummary> {
    const operationId = lifecycleOperationId(input.operationId)
    const expectedLifecycleRevision = lifecycleRevision(input.expectedLifecycleRevision)
    if (input.status !== 'active' && input.status !== 'paused') {
      throw new Error('Team status transition must target active or paused')
    }
    const bindingHash = lifecycleBindingHash([
      'status', auth.teamId, auth.memberId, expectedLifecycleRevision, input.status,
    ])
    const previous = this.lifecycleOperations.get(operationId)
    if (previous !== undefined) {
      if (previous.kind === 'status' && previous.bindingHash === bindingHash && previous.summary !== undefined) {
        return previous.summary
      }
      throw new TeamLifecycleConflictError()
    }

    this.requireOwner(auth)
    const team = this.requireTeam(auth.teamId)
    if (team.status === 'dissolved') throw new TeamDissolvedError()
    if (team.lifecycleRevision !== expectedLifecycleRevision) throw new TeamLifecycleConflictError()
    if (team.status !== input.status) {
      team.status = input.status
      team.lifecycleRevision += 1
    }
    const summary = summaryTeam(team)
    this.lifecycleOperations.set(operationId, {
      operationId,
      teamId: auth.teamId,
      actorMemberId: auth.memberId,
      kind: 'status',
      bindingHash,
      summary,
    })
    return summary
  }

  async dissolveTeam(auth: TeamAuthContext, input: TeamDissolutionInput): Promise<TeamDissolutionResult> {
    const operationId = lifecycleOperationId(input.operationId)
    const expectedLifecycleRevision = lifecycleRevision(input.expectedLifecycleRevision)
    const storedRecoverySecretHash = recoverySecretHash(input.recoverySecretHash)
    const bindingHash = lifecycleBindingHash([
      'dissolution', auth.teamId, auth.memberId, expectedLifecycleRevision,
      input.confirmationName, storedRecoverySecretHash,
    ])
    const previous = this.lifecycleOperations.get(operationId)
    if (previous !== undefined) {
      if (previous.kind === 'dissolution' && previous.bindingHash === bindingHash && previous.result !== undefined) {
        return previous.result
      }
      throw new TeamLifecycleConflictError()
    }

    this.requireOwner(auth)
    const team = this.requireTeam(auth.teamId)
    if (team.status === 'dissolved') throw new TeamDissolvedError()
    if (team.lifecycleRevision !== expectedLifecycleRevision) throw new TeamLifecycleConflictError()
    if (input.confirmationName !== team.name) throw new Error('Team name confirmation does not match')

    const dissolvedAt = this.now()
    let terminatedMemberCount = 0
    let revokedInviteCount = 0
    let revokedKeyCount = 0
    let revokedContributionCount = 0

    this.cancelPendingOwnershipTransfers(team.id, dissolvedAt, auth.memberId)
    team.status = 'dissolved'
    team.lifecycleRevision += 1
    team.dissolvedAt = dissolvedAt
    for (const memberId of team.memberIds) {
      const member = this.members.get(memberId)
      if (member === undefined || member.teamId !== team.id || member.status !== 'active') continue
      member.status = 'removed'
      terminatedMemberCount += 1
    }
    for (const invite of this.invites.values()) {
      if (invite.teamId !== team.id || invite.status !== 'pending') continue
      invite.status = 'revoked'
      this.inviteHashes.delete(invite.tokenHash)
      invite.tokenHash = hashToken(`team-dissolved:${invite.id}`)
      delete invite.envelope
      revokedInviteCount += 1
    }
    for (const key of this.keys.values()) {
      if (key.teamId !== team.id || key.revokedAt !== undefined) continue
      key.revokedAt = dissolvedAt
      key.revokedReason = 'team_dissolved'
      revokedKeyCount += 1
    }
    for (const account of this.contributions.values()) {
      if (account.teamId !== team.id || account.status === 'revoked') continue
      account.status = 'revoked'
      account.updatedAt = dissolvedAt
      delete account.lastError
      revokedContributionCount += 1
    }

    const result: TeamDissolutionResult = {
      operationId,
      teamId: team.id,
      teamName: team.name,
      status: 'dissolved',
      lifecycleRevision: team.lifecycleRevision,
      dissolvedAt,
      terminatedMemberCount,
      revokedInviteCount,
      revokedKeyCount,
      revokedContributionCount,
    }
    this.lifecycleOperations.set(operationId, {
      operationId,
      teamId: team.id,
      actorMemberId: auth.memberId,
      kind: 'dissolution',
      bindingHash,
      result,
      recoverySecretHash: storedRecoverySecretHash,
    })
    return result
  }

  async recoverTeamDissolution(operationId: string, recoverySecret: string): Promise<TeamDissolutionRecoveryResult> {
    this.requireRecoverableDissolution(operationId, recoverySecret)
    return { operationType: 'team_dissolution', status: 'dissolved' }
  }

  async consumeDissolutionRecoveryAttempt(
    sourceDigest: string,
    action: TeamDissolutionRecoveryAction,
  ): Promise<void> {
    const normalizedSourceDigest = dissolutionRecoverySourceDigest(sourceDigest)
    const normalizedAction = dissolutionRecoveryAction(action)
    const now = this.now()
    const windowStartedAt = Math.floor(now / TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS)
      * TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS
    for (const [key, record] of this.dissolutionRecoveryRateLimits) {
      if (record.windowStartedAt !== windowStartedAt) this.dissolutionRecoveryRateLimits.delete(key)
    }
    const key = JSON.stringify([normalizedSourceDigest, normalizedAction])
    const current = this.dissolutionRecoveryRateLimits.get(key)
    const attemptCount = current?.windowStartedAt === windowStartedAt ? current.attemptCount + 1 : 1
    this.dissolutionRecoveryRateLimits.set(key, {
      windowStartedAt,
      attemptCount: Math.min(attemptCount, TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS + 1),
    })
    if (attemptCount > TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_MAX_ATTEMPTS) {
      throw new TeamDissolutionRecoveryRateLimitError(Math.max(
        1,
        Math.ceil((windowStartedAt + TEAM_DISSOLUTION_RECOVERY_RATE_LIMIT_WINDOW_MS - now) / 1_000),
      ))
    }
  }

  async ackTeamDissolution(operationId: string, recoverySecret: string): Promise<void> {
    const operation = this.requireRecoverableDissolution(operationId, recoverySecret)
    operation.acknowledgedAt ??= this.now()
  }

  async diagnoseApiKey(token: string): Promise<TeamConnectionTerminal | undefined> {
    if (token.length < 16) return undefined
    const tokenHash = hashToken(token)
    const keyId = this.keyHashes.get(tokenHash)
    if (keyId === undefined) return undefined
    const key = this.keys.get(keyId)
    if (
      key === undefined
      || key.revokedReason === undefined
      || !sameHash(key.tokenHash, tokenHash)
    ) return undefined
    return { code: key.revokedReason }
  }

  async sweepExpiredInviteEnvelopes(): Promise<number> {
    const now = this.now()
    let cleared = 0
    for (const invite of this.invites.values()) {
      if (invite.expiresAt > now || invite.envelope === undefined) continue
      delete invite.envelope
      cleared += 1
    }
    return cleared
  }

  async dispose(): Promise<void> {
    this.ownedInviteKeyProvider?.dispose()
  }

  private createKey(teamId: string, memberId: string, label: string, now: number, suppliedToken?: string): ApiKeyRecord & { token: string } {
    const record = this.prepareKey(teamId, memberId, label, now, suppliedToken)
    this.commitKey(record)
    return record
  }

  private expireInvite(invite: InviteRecord, now: number): boolean {
    if (invite.status !== 'pending' || invite.expiresAt > now) return false
    invite.status = 'expired'
    this.inviteHashes.delete(invite.tokenHash)
    invite.tokenHash = hashToken(`expired:${invite.id}`)
    delete invite.envelope
    return true
  }

  private expireOwnershipTransfer(transfer: OwnershipTransferRecord, now: number): boolean {
    if (transfer.status !== 'pending' || transfer.expiresAt > now) return false
    transfer.status = 'expired'
    transfer.resolvedAt = now
    this.recordOwnershipTransferAudit(transfer, 'expired', now)
    return true
  }

  private findPendingOwnershipTransfer(teamId: string, now: number): OwnershipTransferRecord | undefined {
    for (const transfer of this.ownershipTransfers.values()) {
      if (transfer.teamId !== teamId || transfer.status !== 'pending') continue
      this.expireOwnershipTransfer(transfer, now)
      if (transfer.status === 'pending') return transfer
    }
    return undefined
  }

  private requireOwnershipTransferParticipant(
    transferId: string,
    teamId: string,
    memberId: string,
    participant: 'requester' | 'target',
  ): OwnershipTransferRecord {
    const id = nonEmpty(transferId, 'transferId', 128)
    const transfer = this.ownershipTransfers.get(id)
    const participantId = participant === 'requester' ? transfer?.requestedByMemberId : transfer?.targetMemberId
    if (transfer === undefined || transfer.teamId !== teamId || participantId !== memberId) {
      throw new Error('ownership transfer is unavailable to this member')
    }
    return transfer
  }

  private requirePendingOwnershipTransfer(transfer: OwnershipTransferRecord): void {
    if (transfer.status !== 'pending') {
      throw new Error(`ownership transfer is ${transfer.status} and no longer pending`)
    }
  }

  private cancelPendingOwnershipTransferForTarget(
    teamId: string,
    targetMemberId: string,
    now: number,
    actorMemberId: string,
  ): void {
    for (const transfer of this.ownershipTransfers.values()) {
      if (transfer.teamId !== teamId || transfer.targetMemberId !== targetMemberId) continue
      this.expireOwnershipTransfer(transfer, now)
      if (transfer.status !== 'pending') continue
      transfer.status = 'canceled'
      transfer.resolvedAt = now
      this.recordOwnershipTransferAudit(transfer, 'canceled', now, actorMemberId)
    }
  }

  private cancelPendingOwnershipTransfers(teamId: string, now: number, actorMemberId: string): void {
    for (const transfer of this.ownershipTransfers.values()) {
      if (transfer.teamId !== teamId) continue
      this.expireOwnershipTransfer(transfer, now)
      if (transfer.status !== 'pending') continue
      transfer.status = 'canceled'
      transfer.resolvedAt = now
      this.recordOwnershipTransferAudit(transfer, 'canceled', now, actorMemberId)
    }
  }

  private recordOwnershipTransferAudit(
    transfer: OwnershipTransferRecord,
    action: OwnershipTransferAuditAction,
    createdAt: number,
    actorMemberId?: string,
  ): void {
    if (this.ownershipTransferAuditEvents.some(event => (
      event.transferId === transfer.id && event.action === action
    ))) return
    this.ownershipTransferAuditEvents.push({
      id: this.id(),
      teamId: transfer.teamId,
      transferId: transfer.id,
      ...(actorMemberId === undefined ? {} : { actorMemberId }),
      action,
      createdAt,
    })
  }

  private prepareKey(teamId: string, memberId: string, label: string, now: number, suppliedToken?: string): ApiKeyRecord & { token: string } {
    const token = suppliedToken ?? createSecret('dsh_team', this.token)
    if (!/^dsh_team_[A-Za-z0-9_-]{16,}$/u.test(token)) throw new Error('Team API key is invalid')
    const tokenHash = hashToken(token)
    if (this.keyHashes.has(tokenHash)) throw new Error('Team API key already exists')
    const record: ApiKeyRecord & { token: string } = {
      id: this.id(),
      teamId,
      memberId,
      label,
      prefix: token.slice(0, 18),
      createdAt: now,
      tokenHash,
      token,
    }
    return record
  }

  private commitKey(record: ApiKeyRecord & { token: string }): void {
    this.keys.set(record.id, record)
    this.keyHashes.set(record.tokenHash, record.id)
  }

  private requireTeam(teamId: string): TeamRecord {
    const team = this.teams.get(teamId)
    if (team === undefined) throw new Error('team not found')
    return team
  }

  private requireRecoverableDissolution(operationId: string, recoverySecret: string): LifecycleOperationRecord {
    const normalizedOperationId = lifecycleOperationId(operationId)
    const operation = this.lifecycleOperations.get(normalizedOperationId)
    const expectedHash = operation?.kind === 'dissolution' && operation.recoverySecretHash !== undefined
      ? operation.recoverySecretHash
      : '0'.repeat(64)
    const matches = sameHash(expectedHash, hashToken(recoverySecret))
    if (!matches || operation?.kind !== 'dissolution' || operation.result === undefined) {
      throw new TeamDissolutionUnavailableError()
    }
    return operation
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

  private requireTeamOwner(auth: TeamAuthContext): MemberRecord {
    const member = this.requireAuthContext(auth)
    if (member.role !== 'owner') throw new Error('only the owner can manage Team members')
    return member
  }

  private requireOwner(auth: TeamAuthContext): MemberRecord {
    const member = this.requireAuthContext(auth)
    if (member.role !== 'owner') throw new Error('only the owner can manage Team invitations and status')
    return member
  }

  private requireAuthContext(auth: TeamAuthContext): MemberRecord {
    const key = this.keys.get(auth.keyId)
    if (key === undefined || key.revokedAt !== undefined || key.teamId !== auth.teamId || key.memberId !== auth.memberId) {
      throw new Error('Team API key is revoked or invalid')
    }
    if (this.requireTeam(auth.teamId).status === 'dissolved') throw new TeamDissolvedError()
    const member = this.requireMember(auth.memberId, auth.teamId)
    if (member.role !== auth.role) throw new Error('Team API key role is stale')
    return member
  }
}

function utcDayStart(timestamp: number): number {
  const value = new Date(timestamp)
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
}

function utcIsoWeekStart(timestamp: number): number {
  const dayStart = utcDayStart(timestamp)
  const day = new Date(dayStart).getUTCDay()
  return dayStart - ((day + 6) % 7) * 86_400_000
}

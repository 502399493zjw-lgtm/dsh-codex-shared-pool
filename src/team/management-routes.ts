/** Local same-origin Team management proxy. Raw Team keys remain Host-only. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  TEAM_MANAGEMENT_CAPABILITY_HEADER,
  TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH,
  TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH,
  TEAM_MANAGEMENT_CONTRIBUTIONS_PATH,
  TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_MANAGEMENT_DISCONNECT_PATH,
  TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH,
  TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH,
  TEAM_MANAGEMENT_DISSOLVE_PATH,
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
} from '../shared/team-management.ts'
import type {
  TeamManagementConnectionResult,
  TeamConnectionTerminalClearResult,
  TeamConnectionTerminalView,
  TeamManagementDepartureResult,
  TeamDissolutionClearResult,
  TeamDissolutionInput,
  TeamDissolutionView,
  TeamManagementContributionPatch,
  TeamManagementContributionResult,
  TeamManagementContributionSummary,
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
  TeamManagementUsageResult,
} from '../shared/team-management.ts'
import {
  TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH,
  TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH,
  TEAM_CONTRIBUTION_OAUTH_START_PATH,
  TEAM_CONTRIBUTION_REVOKE_PATH,
  TEAM_CONTRIBUTION_UPDATE_PATH,
  TEAM_CONTRIBUTIONS_PATH,
  TEAM_CONNECTION_TERMINAL_PATH,
  TEAM_CURRENT_KEY_REVOKE_PATH,
  TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH,
  TEAM_DISSOLVE_ACK_PATH,
  TEAM_DISSOLVE_PATH,
  TEAM_DISSOLVE_RESULT_PATH,
  TEAM_INVITES_PATH,
  TEAM_INVITES_PREVIEW_PATH,
  TEAM_INVITES_REVEAL_PATH,
  TEAM_INVITES_REVOKE_PATH,
  TEAM_JOIN_PATH,
  TEAM_MEMBERS_LEAVE_PATH,
  TEAM_MEMBERS_REMOVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_ACCEPT_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH,
  TEAM_OWNERSHIP_TRANSFER_REJECT_PATH,
  TEAM_OWNERSHIP_TRANSFER_REVOKE_PATH,
  TEAM_OVERVIEW_PATH,
  TEAM_PATH_PREFIX,
  TEAM_STATUS_PATH,
  TEAM_USAGE_PATH,
} from './types.ts'
import type {
  TeamContributionCapacityBucketSummary,
  TeamContributionCapacitySummary,
  TeamConnectionTerminal,
  TeamDissolutionRecoveryResult,
  TeamDissolutionResult,
  TeamInvitePreview,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamSummary,
  TeamUsageAggregateSummary,
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
const PENDING_JOIN_REF_SUFFIX = '_PENDING_JOIN'
const DISSOLUTION_PENDING_REF_SUFFIX = '_DISSOLUTION_PENDING'
const DISSOLUTION_TERMINAL_REF_SUFFIX = '_DISSOLUTION_TERMINAL'
const DISSOLUTION_KEY_DIGEST_REF_SUFFIX = '_DISSOLUTION_KEY_DIGEST'
const CONNECTION_TERMINAL_REF_SUFFIX = '_CONNECTION_TERMINAL'
const CONNECTION_TERMINAL_KEY_DIGEST_REF_SUFFIX = '_CONNECTION_TERMINAL_KEY_DIGEST'
const INVITE_PREVIEW_SESSION_TTL_MS = 15 * 60 * 1000
const MAX_INVITE_PREVIEW_SESSIONS = 64
const MANAGEMENT_SESSION_TTL_MS = 15 * 60 * 1000
const MAX_MANAGEMENT_SESSIONS = 64
const MANAGEMENT_CAPABILITY_PATTERN = /^dsh_tm_[A-Za-z0-9_-]{43}$/u

interface InvitePreviewSession {
  readonly inviteToken: string
  readonly createdAt: number
  readonly expiresAt: number
}

interface PendingJoinRecord {
  readonly version: 1
  readonly apiKey: string
  readonly inviteToken: string
  readonly displayName: string
}

/** Host-only journal. The raw recovery secret must never cross a Browser route. */
interface PendingDissolutionRecord {
  readonly version: 1
  readonly operationId: string
  readonly recoverySecret: string
  readonly teamName: string
  readonly expectedLifecycleRevision: number
  readonly requestedAt: number
}

/** Browser-safe terminal marker. It deliberately contains no operation or recovery secret. */
interface SubmittedDissolutionRecord {
  readonly version: 1
  readonly state: 'confirmed'
  readonly teamName: string
  readonly dissolvedAt: number
  readonly localCleanup: 'completed' | 'retry_required' | 'manual_required'
}

/** A second Host can learn only the coarse tombstone, never Team metadata. */
interface DiagnosedDissolutionRecord {
  readonly version: 2
  readonly state: 'confirmed'
  readonly localCleanup: 'completed' | 'retry_required' | 'manual_required'
}

type TerminalDissolutionRecord = SubmittedDissolutionRecord | DiagnosedDissolutionRecord

interface ConnectionTerminalRecord {
  readonly version: 1
  readonly code: Exclude<TeamConnectionTerminal['code'], 'team_dissolved'>
  readonly localCleanup: 'completed' | 'retry_required' | 'manual_required'
}

class RemoteTeamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly responseBody?: unknown,
    readonly diagnosedTerminal?: TeamConnectionTerminal,
  ) {
    super(message)
    this.name = 'RemoteTeamError'
  }
}

class TeamManagementContextMismatchError extends Error {
  constructor() {
    super('Team connection changed; refresh before trying again')
    this.name = 'TeamManagementContextMismatchError'
  }
}

type Credentials = Pick<CredentialProvider, 'resolve' | 'describe' | 'set' | 'unset'>

export interface TeamManagementRouteOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  security?: TeamManagementRouteSecurity
  now?: () => number
}

export interface TeamManagementRouteSecurity {
  readonly allowedOrigins: readonly string[]
  issue(origin: string): TeamManagementSession
  verify(capability: string, origin: string): boolean
  dispose?(): void
}

interface ManagementSessionRecord {
  readonly origin: string
  readonly createdAt: number
  readonly expiresAt: number
}

class LocalTeamManagementRouteSecurity implements TeamManagementRouteSecurity {
  readonly allowedOrigins: readonly string[]
  private readonly sessions = new Map<string, ManagementSessionRecord>()

  constructor(
    allowedOrigins: readonly string[],
    private readonly now: () => number,
  ) {
    this.allowedOrigins = Object.freeze([...new Set(allowedOrigins.map(requireCanonicalOrigin))])
  }

  issue(origin: string): TeamManagementSession {
    if (!this.allowedOrigins.includes(origin)) throw new Error('Team management origin is forbidden')
    const now = this.now()
    this.prune(now)
    while (this.sessions.size >= MAX_MANAGEMENT_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    let capability: string
    do capability = `dsh_tm_${randomBytes(32).toString('base64url')}`
    while (this.sessions.has(capability))
    const expiresAt = now + MANAGEMENT_SESSION_TTL_MS
    this.sessions.set(capability, { origin, createdAt: now, expiresAt })
    return { capability, expiresAt }
  }

  verify(capability: string, origin: string): boolean {
    if (!MANAGEMENT_CAPABILITY_PATTERN.test(capability)) return false
    const now = this.now()
    this.prune(now)
    const session = this.sessions.get(capability)
    return session !== undefined && session.origin === origin && session.expiresAt > now
  }

  dispose(): void {
    this.sessions.clear()
  }

  private prune(now: number): void {
    for (const [capability, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(capability)
    }
  }
}

function header(req: IncomingMessage, name: string): string | null | undefined {
  const value = req.headers[name]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function requireCanonicalOrigin(value: string): string {
  try {
    const parsed = new URL(value)
    if (
      value !== parsed.origin
      || parsed.origin === 'null'
      || parsed.username !== ''
      || parsed.password !== ''
      || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    ) throw new Error('Team management origin must be canonical')
    return parsed.origin
  } catch {
    throw new Error('Team management origin must be canonical')
  }
}

function exactLoopbackPeer(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function requestOrigin(
  req: IncomingMessage,
  allowedOrigins: readonly string[],
  requireOrigin: boolean,
): string | undefined {
  if (!exactLoopbackPeer(req.socket.remoteAddress)) return undefined
  if (req.url?.includes('?') === true) return undefined
  const host = header(req, 'host')
  if (host === undefined || host === null || host.trim() !== host) return undefined
  const allowedOrigin = allowedOrigins.find(origin => new URL(origin).host === host)
  if (allowedOrigin === undefined) return undefined

  const fetchSite = header(req, 'sec-fetch-site')
  if (fetchSite !== 'same-origin') return undefined

  const origin = header(req, 'origin')
  if (origin === null) return undefined
  if (origin !== undefined) return origin === allowedOrigin ? allowedOrigin : undefined
  if (requireOrigin) return undefined

  if (req.method !== 'GET') return undefined
  const referer = header(req, 'referer')
  if (typeof referer !== 'string') return undefined
  try {
    const parsed = new URL(referer)
    return parsed.origin === allowedOrigin && parsed.username === '' && parsed.password === ''
      ? allowedOrigin
      : undefined
  } catch {
    return undefined
  }
}

function configuredManagementOrigins(ctx: Context): readonly string[] {
  const port = ctx.webServer.port
  if (ctx.webServer.host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65_535) return []
  return [new URL(`http://127.0.0.1:${port}`).origin]
}

function forbidden(res: ServerResponse): void {
  json(res, 403, { error: { code: 'team_management_forbidden' } })
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
  if (error instanceof TeamManagementContextMismatchError) return 409
  if (error instanceof RemoteTeamError) {
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) return error.status
    return 502
  }
  const message = safeMessage(error)
  if (/not enabled|not configured|already configured|pending Team join/iu.test(message)) return 409
  if (/not writable/iu.test(message)) return 409
  if (/unauthorized|API key|required/iu.test(message)) return 401
  if (/forbidden|administrator role|only the/iu.test(message)) return 403
  if (/not found/iu.test(message)) return 404
  if (/timed out|unavailable|remote Team/iu.test(message)) return 502
  return 400
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type']
  if (
    typeof contentType !== 'string'
    || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(contentType.trim())
  ) {
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

function requiredPositiveInteger(value: Record<string, unknown>, key: string): number {
  const candidate = requiredInteger(value, key)
  if (candidate < 1) throw new Error(`${key} must be a positive integer`)
  return candidate
}

/** Preserve the exact bytes used for irreversible Team-name confirmation. */
function requiredUnmodifiedString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error(`${key} must be a non-empty string`)
  return candidate
}

function requiredExpectedContext(value: Record<string, unknown>): TeamManagementExpectedContext {
  const context = record(value.expectedContext, 'expectedContext')
  exactKeys(context, ['serverOrigin', 'teamId', 'currentMemberId'])
  return {
    serverOrigin: requireCanonicalOrigin(requiredUnmodifiedString(context, 'serverOrigin')),
    teamId: requiredUnmodifiedString(context, 'teamId'),
    currentMemberId: requiredUnmodifiedString(context, 'currentMemberId'),
  }
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
  const lifecycleRevision = safeNonNegativeInteger(item, 'lifecycleRevision')
  if (lifecycleRevision < 1) throw new Error('remote Team returned an invalid lifecycleRevision')
  return {
    id: stringField(item, 'id'),
    name: stringField(item, 'name'),
    status,
    lifecycleRevision,
    createdAt: numberField(item, 'createdAt'),
  }
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
    role: role === 'owner' ? 'owner' : 'member',
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
  if (item.revealable !== undefined && typeof item.revealable !== 'boolean') {
    throw new Error('remote Team returned an invalid revealable flag')
  }
  return {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    invitedByMemberId: stringField(item, 'invitedByMemberId'),
    label: item.label === undefined ? 'Team invitation' : stringField(item, 'label'),
    status,
    revealable: item.revealable === true,
    expiresAt: numberField(item, 'expiresAt'),
    createdAt: numberField(item, 'createdAt'),
    ...acceptedAt === undefined ? {} : { acceptedAt },
  }
}

function projectInvitePreview(value: unknown): TeamInvitePreview {
  const item = record(value, 'invite preview')
  const teamStatus = stringField(item, 'teamStatus')
  if (teamStatus !== 'active' && teamStatus !== 'paused') throw new Error('remote Team returned an invalid teamStatus')
  return {
    teamName: stringField(item, 'teamName'),
    label: stringField(item, 'label'),
    expiresAt: numberField(item, 'expiresAt'),
    teamStatus,
  }
}

function projectContribution(value: unknown, capacityOwnerMemberId?: string): TeamManagementContributionSummary {
  const item = record(value, 'contribution')
  const status = stringField(item, 'status')
  if (!['authorizing', 'active', 'paused', 'revoked', 'reauth_required'].includes(status)) {
    throw new Error('remote Team returned an invalid contribution status')
  }
  const cap = item.maxSharedRequestsPerWindow
  if (cap !== null && (typeof cap !== 'number' || !Number.isSafeInteger(cap))) {
    throw new Error('remote Team returned an invalid request cap')
  }
  const dailySharedCreditLimit = item.dailySharedCreditLimit
  if (dailySharedCreditLimit !== null && (
    typeof dailySharedCreditLimit !== 'number'
    || !Number.isSafeInteger(dailySharedCreditLimit)
    || dailySharedCreditLimit < 1
    || dailySharedCreditLimit > 1_000_000_000_000
  )) {
    throw new Error('remote Team returned an invalid contribution policy')
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
    status: status as TeamManagementContributionSummary['status'],
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

function exactRemoteKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`remote Team returned an invalid ${label}`)
  }
}

function projectDissolutionResult(
  value: unknown,
  pending: PendingDissolutionRecord,
): TeamDissolutionResult {
  const item = record(value, 'Team dissolution result')
  exactRemoteKeys(item, [
    'operationId',
    'teamId',
    'teamName',
    'status',
    'lifecycleRevision',
    'dissolvedAt',
    'terminatedMemberCount',
    'revokedInviteCount',
    'revokedKeyCount',
    'revokedContributionCount',
  ], 'Team dissolution result')
  const operationId = stringField(item, 'operationId')
  const teamId = stringField(item, 'teamId')
  const teamName = stringField(item, 'teamName')
  const lifecycleRevision = safeNonNegativeInteger(item, 'lifecycleRevision')
  if (
    operationId !== pending.operationId
    || teamId.length === 0
    || teamName !== pending.teamName
    || item.status !== 'dissolved'
    || lifecycleRevision !== pending.expectedLifecycleRevision + 1
  ) throw new Error('remote Team returned an invalid Team dissolution result')
  return {
    operationId,
    teamId,
    teamName,
    status: 'dissolved',
    lifecycleRevision,
    dissolvedAt: safeNonNegativeInteger(item, 'dissolvedAt'),
    terminatedMemberCount: safeNonNegativeInteger(item, 'terminatedMemberCount'),
    revokedInviteCount: safeNonNegativeInteger(item, 'revokedInviteCount'),
    revokedKeyCount: safeNonNegativeInteger(item, 'revokedKeyCount'),
    revokedContributionCount: safeNonNegativeInteger(item, 'revokedContributionCount'),
  }
}

function projectDissolutionRecoveryResult(value: unknown): TeamDissolutionRecoveryResult {
  const item = record(value, 'Team dissolution recovery result')
  exactRemoteKeys(item, ['operationType', 'status'], 'Team dissolution recovery result')
  if (item.operationType !== 'team_dissolution' || item.status !== 'dissolved') {
    throw new Error('remote Team returned an invalid Team dissolution recovery result')
  }
  return { operationType: 'team_dissolution', status: 'dissolved' }
}

function projectDissolutionAck(value: unknown): void {
  const item = record(value, 'Team dissolution acknowledgement')
  exactRemoteKeys(item, ['ok'], 'Team dissolution acknowledgement')
  if (item.ok !== true) throw new Error('remote Team returned an invalid Team dissolution acknowledgement')
}

function projectConnectionTerminal(value: unknown): TeamConnectionTerminal {
  const item = record(value, 'Team connection terminal')
  exactRemoteKeys(item, ['code'], 'Team connection terminal')
  if (
    item.code !== 'member_removed'
    && item.code !== 'member_left'
    && item.code !== 'team_dissolved'
    && item.code !== 'device_revoked'
  ) throw new Error('remote Team returned an invalid connection terminal')
  return { code: item.code }
}

function dissolutionView(value: TerminalDissolutionRecord): TeamDissolutionView {
  return {
    state: 'confirmed',
    ...value.version === 1 ? { teamName: value.teamName, dissolvedAt: value.dissolvedAt } : {},
    localCleanup: value.localCleanup,
  }
}

function connectionTerminalView(value: ConnectionTerminalRecord): TeamConnectionTerminalView {
  return { code: value.code, localCleanup: value.localCleanup }
}

function projectUsageAggregate(value: unknown, label: string): TeamUsageAggregateSummary {
  const item = record(value, label)
  const requestCount = safeNonNegativeInteger(item, 'requestCount')
  const tokenMeasuredRequestCount = safeNonNegativeInteger(item, 'tokenMeasuredRequestCount')
  const pricedRequestCount = safeNonNegativeInteger(item, 'pricedRequestCount')
  const totalTokens = nullableDecimalString(item.totalTokens, 'totalTokens')
  const estimatedCostUsdMicros = nullableDecimalString(item.estimatedCostUsdMicros, 'estimatedCostUsdMicros')
  validateUsageAggregate(
    requestCount,
    tokenMeasuredRequestCount,
    pricedRequestCount,
    totalTokens,
    estimatedCostUsdMicros,
  )
  return { requestCount, tokenMeasuredRequestCount, pricedRequestCount, totalTokens, estimatedCostUsdMicros }
}

function nullableDecimalString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`remote Team returned an invalid ${label}`)
  }
  return value
}

function validateUsageAggregate(
  requestCount: number,
  tokenMeasuredRequestCount: number,
  pricedRequestCount: number,
  totalTokens: string | null,
  estimatedCostUsdMicros: string | null,
): void {
  if (tokenMeasuredRequestCount > requestCount) {
    throw new Error('remote Team returned invalid tokenMeasuredRequestCount')
  }
  if (pricedRequestCount > tokenMeasuredRequestCount) {
    throw new Error('remote Team returned invalid pricedRequestCount')
  }
  if (requestCount === 0) {
    if (tokenMeasuredRequestCount !== 0 || pricedRequestCount !== 0 || totalTokens !== '0' || estimatedCostUsdMicros !== '0') {
      throw new Error('remote Team returned invalid empty usage totals')
    }
    return
  }
  if ((tokenMeasuredRequestCount === 0) !== (totalTokens === null)) {
    throw new Error('remote Team returned inconsistent totalTokens')
  }
  if ((pricedRequestCount === 0) !== (estimatedCostUsdMicros === null)) {
    throw new Error('remote Team returned inconsistent estimatedCostUsdMicros')
  }
}

function projectOverview(value: unknown): TeamManagementOverview {
  const item = record(value, 'overview')
  const team = projectTeam(item.team)
  const currentMember = projectMember(item.currentMember)
  const viewerRole = item.viewerRole === undefined
    ? currentMember.role === 'owner' ? 'owner' : 'member'
    : stringField(item, 'viewerRole')
  if (viewerRole !== 'owner' && viewerRole !== 'member') {
    throw new Error('remote Team returned an invalid viewerRole')
  }
  if ((viewerRole === 'owner') !== (currentMember.role === 'owner')) {
    throw new Error('remote Team returned an inconsistent viewerRole')
  }
  const liveKeyMemberIds = item.apiKeys === undefined
    ? undefined
    : projectLiveKeyMemberIds(item.apiKeys, team.id)
  const members = objectArray(item.members, 'members', candidate => {
    const rawMember = record(candidate, 'member')
    const member = projectMember(rawMember)
    const projectedEligibility = rawMember.canReceiveOwnership
    if (projectedEligibility !== undefined && typeof projectedEligibility !== 'boolean') {
      throw new Error('remote Team returned invalid canReceiveOwnership')
    }
    const legacyEligibility = liveKeyMemberIds?.has(member.id) ?? false
    return {
      ...member,
      canReceiveOwnership: viewerRole === 'owner'
        && currentMember.status === 'active'
        && member.teamId === currentMember.teamId
        && member.id !== currentMember.id
        && member.role !== 'owner'
        && member.status === 'active'
        && (projectedEligibility ?? legacyEligibility),
    } satisfies TeamManagementMemberSummary
  })
  const contributions = objectArray(
    item.contributions,
    'contributions',
    value => projectContribution(value, currentMember.id),
  ).filter(account => account.ownerMemberId === currentMember.id)
  const ownershipTransfer = item.ownershipTransfer === undefined
    ? undefined
    : projectOwnershipTransferSummary(item.ownershipTransfer)
  const displayNameMigrationNotice = item.displayNameMigrationNotice === undefined
    ? undefined
    : projectDisplayNameMigrationNotice(item.displayNameMigrationNotice)
  if (
    ownershipTransfer !== undefined
    && (
      ownershipTransfer.status !== 'pending'
      || ownershipTransfer.teamId !== team.id
      || (ownershipTransfer.requestedByMemberId !== currentMember.id
        && ownershipTransfer.targetMemberId !== currentMember.id)
    )
  ) {
    throw new Error('remote Team returned an ownership transfer that is not visible to this member')
  }
  const base = {
    team,
    currentMember,
    members,
    contributions,
    ...(displayNameMigrationNotice === undefined ? {} : { displayNameMigrationNotice }),
    ...(ownershipTransfer === undefined ? {} : { ownershipTransfer }),
  }
  return viewerRole === 'owner'
    ? { viewerRole, ...base, invites: objectArray(item.invites, 'invites', projectInvite) }
    : { viewerRole, ...base }
}

function projectDisplayNameMigrationNotice(value: unknown): { migrationVersion: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('remote Team returned an invalid display-name migration notice')
  }
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 1 || !Object.hasOwn(item, 'migrationVersion')) {
    throw new Error('remote Team returned an invalid display-name migration notice')
  }
  const migrationVersion = item.migrationVersion
  if (!Number.isSafeInteger(migrationVersion) || (migrationVersion as number) < 1) {
    throw new Error('remote Team returned an invalid display-name migration notice')
  }
  return { migrationVersion: migrationVersion as number }
}

function projectDisplayNameMigrationAcknowledgement(
  value: unknown,
  expectedMigrationVersion: number,
): TeamManagementDisplayNameMigrationAcknowledgement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('remote Team returned an invalid display-name migration acknowledgement')
  }
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).length !== 2
    || !Object.hasOwn(item, 'migrationVersion')
    || !Object.hasOwn(item, 'acknowledged')
    || item.acknowledged !== true
    || item.migrationVersion !== expectedMigrationVersion
  ) {
    throw new Error('remote Team returned an invalid display-name migration acknowledgement')
  }
  return { migrationVersion: expectedMigrationVersion, acknowledged: true }
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

function projectMemberResult(value: unknown, removed = false): TeamManagementMemberResult {
  const item = record(value, 'member result')
  const member = projectMember(item.member)
  if (removed && (member.status !== 'removed' || member.role === 'owner')) {
    throw new Error('remote Team returned an invalid removed member')
  }
  return { member }
}

function projectOwnershipTransferSummary(value: unknown): TeamManagementOwnershipTransferSummary {
  const item = record(value, 'Team ownership transfer')
  const status = stringField(item, 'status')
  if (
    status !== 'pending'
    && status !== 'accepted'
    && status !== 'rejected'
    && status !== 'revoked'
    && status !== 'expired'
    && status !== 'canceled'
  ) {
    throw new Error('remote Team returned an invalid ownership transfer status')
  }
  exactRemoteKeys(
    item,
    status === 'pending'
      ? ['id', 'teamId', 'requestedByMemberId', 'targetMemberId', 'status', 'createdAt', 'expiresAt']
      : ['id', 'teamId', 'requestedByMemberId', 'targetMemberId', 'status', 'createdAt', 'expiresAt', 'resolvedAt'],
    'ownership transfer',
  )
  const createdAt = numberField(item, 'createdAt')
  const expiresAt = numberField(item, 'expiresAt')
  const transfer = {
    id: stringField(item, 'id'),
    teamId: stringField(item, 'teamId'),
    requestedByMemberId: stringField(item, 'requestedByMemberId'),
    targetMemberId: stringField(item, 'targetMemberId'),
    status,
    createdAt,
    expiresAt,
    ...(status === 'pending' ? {} : { resolvedAt: numberField(item, 'resolvedAt') }),
  } satisfies TeamManagementOwnershipTransferSummary
  if (
    transfer.requestedByMemberId === transfer.targetMemberId
    || expiresAt !== createdAt + 24 * 60 * 60 * 1000
    || ('resolvedAt' in transfer && transfer.resolvedAt < createdAt)
  ) {
    throw new Error('remote Team returned an invalid ownership transfer')
  }
  return transfer
}

function projectOwnershipTransferAcceptance(value: unknown): TeamManagementOwnershipTransferAcceptanceResult {
  const item = record(value, 'Team ownership transfer acceptance')
  exactRemoteKeys(item, ['transfer', 'formerOwner', 'owner'], 'ownership transfer acceptance')
  const transfer = projectOwnershipTransferSummary(item.transfer)
  const formerOwner = projectMember(item.formerOwner)
  const owner = projectMember(item.owner)
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
    throw new Error('remote Team returned an invalid ownership transfer')
  }
  return { transfer, formerOwner, owner }
}

function contributionPatch(value: Record<string, unknown>): {
  accountId: string
  patch: TeamManagementContributionPatch
  expectedContext: TeamManagementExpectedContext
} {
  exactKeys(value, [
    'accountId',
    'label',
    'status',
    'personalReservePercent',
    'maxSharedRequestsPerWindow',
    'maxSharedConcurrency',
    'allowedModels',
    'expectedContext',
  ])
  const accountId = requiredString(value, 'accountId')
  const patch: TeamManagementContributionPatch = {
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
  return { accountId, patch, expectedContext: requiredExpectedContext(value) }
}

class TeamManagementProxy {
  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly invitePreviewSessions = new Map<string, InvitePreviewSession>()
  private credentialTransition: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: TeamClientConfig,
    private readonly credentials: Credentials,
    options: TeamManagementRouteOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  async status(): Promise<TeamManagementStatus> {
    if (this.config.enabled !== true) {
      return { enabled: false, keyConfigured: false, keyWritable: false, pendingJoinConfigured: false }
    }
    const baseUrl = resolveTeamClientBaseUrl(this.config.baseUrl)
    const [info, pending, pendingDissolution, terminalDissolution, connectionTerminal] = await Promise.all([
      this.credentials.describe(this.keyRef()),
      this.credentials.describe(this.pendingJoinRef()),
      this.credentials.describe(this.pendingDissolutionRef()),
      this.credentials.describe(this.terminalDissolutionRef()),
      this.credentials.describe(this.connectionTerminalRef()),
    ])
    const dissolution = terminalDissolution.configured
      ? dissolutionView(await this.terminalDissolution())
      : pendingDissolution.configured
        ? this.confirmingDissolution(await this.pendingDissolution())
        : undefined
    return {
      enabled: true,
      keyConfigured: info.configured,
      keyWritable: info.writable,
      pendingJoinConfigured: pending.configured,
      ...info.source === undefined ? {} : { keySource: info.source },
      serverOrigin: new URL(baseUrl).origin,
      ...dissolution === undefined ? {} : { dissolution },
      ...dissolution !== undefined || !connectionTerminal.configured
        ? {}
        : { connectionTerminal: connectionTerminalView(await this.connectionTerminal()) },
    }
  }

  async overview(explicitKey?: string): Promise<TeamManagementOverview> {
    return projectOverview(await this.remote(TEAM_OVERVIEW_PATH, explicitKey === undefined ? {} : { key: explicitKey }))
  }

  async acknowledgeDisplayNameMigration(
    migrationVersion: number,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementDisplayNameMigrationAcknowledgement> {
    const key = await this.expectedMutationKey(expectedContext)
    return projectDisplayNameMigrationAcknowledgement(
      await this.remote(TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH, {
        method: 'POST',
        body: { migrationVersion },
        key,
      }),
      migrationVersion,
    )
  }

  async join(joinHandle: string, displayName: string): Promise<TeamManagementConnectionResult> {
    return this.withCredentialTransition(async () => {
      const active = await this.requireWritable()
      if (active.configured) throw new Error('Team API key is already configured')
      if (
        (await this.credentials.describe(this.connectionTerminalRef())).configured
        || (await this.credentials.describe(this.terminalDissolutionRef())).configured
        || (await this.credentials.describe(this.pendingDissolutionRef())).configured
      ) throw new Error('the previous Team terminal must be cleared before joining another Team')
      if ((await this.credentials.describe(this.pendingJoinRef())).configured) {
        throw new Error('pending Team join must be recovered or discarded first')
      }
      const session = this.invitePreviewSession(joinHandle)
      const pending: PendingJoinRecord = {
        version: 1,
        apiKey: `dsh_team_${randomBytes(32).toString('base64url')}`,
        inviteToken: session.inviteToken,
        displayName,
      }
      await this.credentials.set(this.pendingJoinRef(), JSON.stringify(pending))
      this.invitePreviewSessions.delete(joinHandle)
      try {
        const connection = projectConnection(await this.acceptPendingJoin(pending))
        await this.promotePendingJoin(pending)
        return connection
      } catch (error: unknown) {
        if (this.isDefiniteJoinRejection(error)) await this.credentials.unset(this.pendingJoinRef())
        throw error
      }
    })
  }

  async recoverJoin(): Promise<TeamManagementConnectionResult> {
    return this.withCredentialTransition(async () => {
      const active = await this.requireWritable()
      const pending = await this.pendingJoin()
      const activeKey = active.configured ? (await this.credentials.resolve(this.keyRef()))?.value : undefined
      if (active.configured && activeKey !== pending.apiKey) {
        throw new Error('pending Team join belongs to a different active Team connection')
      }
      try {
        const overview = await this.overview(pending.apiKey)
        await this.promotePendingJoin(pending)
        return { team: overview.team, member: overview.currentMember }
      } catch (error: unknown) {
        if (!this.isMissingRemoteIdentity(error)) throw error
      }
      try {
        const connection = projectConnection(await this.acceptPendingJoin(pending))
        await this.promotePendingJoin(pending)
        return connection
      } catch (error: unknown) {
        if (this.isDefiniteJoinRejection(error)) {
          await this.credentials.unset(this.pendingJoinRef())
          if (activeKey === pending.apiKey) await this.credentials.unset(this.keyRef())
        }
        throw error
      }
    })
  }

  async discardPendingJoin(): Promise<{ discarded: true }> {
    return this.withCredentialTransition(async () => {
      const active = await this.requireWritable()
      if (!(await this.credentials.describe(this.pendingJoinRef())).configured) {
        throw new Error('pending Team join is not configured')
      }
      let pending: PendingJoinRecord
      try {
        pending = await this.pendingJoin()
      } catch {
        // A malformed local record cannot be used to authenticate or recover.
        // Discard remains the explicit escape hatch for this local-only state.
        await this.credentials.unset(this.pendingJoinRef())
        return { discarded: true }
      }
      if (active.configured) {
        const activeKey = (await this.credentials.resolve(this.keyRef()))?.value
        if (activeKey !== pending.apiKey) {
          throw new Error('pending Team join belongs to a different active Team connection')
        }
        await this.credentials.unset(this.pendingJoinRef())
        return { discarded: true }
      }
      try {
        await this.overview(pending.apiKey)
      } catch (error: unknown) {
        if (!this.isMissingRemoteIdentity(error)) throw error
        await this.credentials.unset(this.pendingJoinRef())
        return { discarded: true }
      }
      projectDeparture(await this.remote(TEAM_MEMBERS_LEAVE_PATH, {
        method: 'POST',
        body: {},
        key: pending.apiKey,
      }))
      await this.credentials.unset(this.pendingJoinRef())
      return { discarded: true }
    })
  }

  async disconnect(
    revokeRemote: boolean,
    expectedContext?: TeamManagementExpectedContext,
  ): Promise<{ disconnected: true; remoteRevoked: boolean }> {
    return this.withCredentialTransition(async () => {
      if (revokeRemote) {
        if (expectedContext === undefined) throw new Error('expectedContext is required when revoking the remote key')
        const key = await this.expectedMutationKey(expectedContext)
        await this.remote(TEAM_CURRENT_KEY_REVOKE_PATH, { method: 'POST', key })
        await this.unsetKeyIfCurrent(key)
        return { disconnected: true, remoteRevoked: true }
      } else {
        const key = await this.key()
        try {
          await this.overview(key)
        } catch (error: unknown) {
          // A bare 401 is the only proof that permits local-only cleanup. A
          // diagnosed 410 has already created its durable terminal marker;
          // network failures, 404s and valid identities must retain the key.
          if (!(error instanceof RemoteTeamError) || error.status !== 401) throw error
          await this.unsetKeyIfCurrent(key)
          return { disconnected: true, remoteRevoked: false }
        }
        throw new Error('an active Team connection cannot be cleared without revoking the remote key')
      }
      return { disconnected: true, remoteRevoked: false }
    })
  }

  async leaveTeam(expectedContext: TeamManagementExpectedContext): Promise<TeamManagementDepartureResult> {
    return this.withCredentialTransition(async () => {
      await this.requireWritable()
      const key = await this.expectedMutationKey(expectedContext)
      const result = projectDeparture(await this.remote(TEAM_MEMBERS_LEAVE_PATH, { method: 'POST', body: {}, key }))
      await this.unsetKeyIfCurrent(key)
      return result
    })
  }

  async dissolveTeam(
    input: TeamDissolutionInput,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamDissolutionView> {
    return this.withCredentialTransition(async () => {
      this.requireEnabled()
      const existingTerminal = await this.credentials.describe(this.terminalDissolutionRef())
      if (existingTerminal.configured) return dissolutionView(await this.terminalDissolution())
      if ((await this.credentials.describe(this.pendingDissolutionRef())).configured) {
        throw new Error('pending Team dissolution must be recovered first')
      }
      const key = await this.expectedMutationKey(expectedContext, 'owner')
      const pending: PendingDissolutionRecord = {
        version: 1,
        operationId: randomUUID(),
        recoverySecret: randomBytes(32).toString('base64url'),
        teamName: input.confirmationName,
        expectedLifecycleRevision: input.expectedLifecycleRevision,
        requestedAt: this.now(),
      }

      // This write is the point of no return for starting the remote operation.
      // If it cannot be made durable, no destructive request is sent.
      await this.credentials.set(this.pendingDissolutionRef(), JSON.stringify(pending))
      try {
        // Bind cleanup to the exact credential that authorized this operation.
        // CredentialProvider has no CAS primitive, so this prevents deleting a
        // replacement that already exists when cleanup starts, but cannot close
        // a cross-process resolve-to-unset race.
        await this.rememberDissolutionKeyDigest(key)
      } catch (error: unknown) {
        await Promise.allSettled([
          this.credentials.unset(this.pendingDissolutionRef()),
          this.credentials.unset(this.dissolutionKeyDigestRef()),
        ])
        throw error
      }
      try {
        const result = projectDissolutionResult(await this.submitDissolution(pending, key), pending)
        return await this.finalizeDissolution(pending, result)
      } catch (error: unknown) {
        if (this.isDefiniteRemoteRejection(error)) {
          await this.credentials.unset(this.pendingDissolutionRef())
          await this.credentials.unset(this.dissolutionKeyDigestRef())
          throw error
        }
        return this.confirmingDissolution(pending)
      }
    })
  }

  async recoverTeamDissolution(): Promise<TeamDissolutionView> {
    return this.withCredentialTransition(async () => {
      this.requireEnabled()
      const [pendingInfo, terminalInfo] = await Promise.all([
        this.credentials.describe(this.pendingDissolutionRef()),
        this.credentials.describe(this.terminalDissolutionRef()),
      ])
      const terminal = terminalInfo.configured ? await this.terminalDissolution() : undefined
      if (!pendingInfo.configured) {
        if (terminal === undefined) throw new Error('pending Team dissolution is not configured')
        return dissolutionView(await this.refreshTerminalCleanup(terminal, true))
      }
      const pending = await this.pendingDissolution()

      // A durable terminal marker proves the remote commit. Only the repeatable
      // acknowledgement and local credential cleanup remain.
      if (terminal !== undefined) {
        const acknowledged = await this.acknowledgeDissolution(pending)
        return dissolutionView(await this.refreshTerminalCleanup(terminal, acknowledged))
      }

      try {
        projectDissolutionRecoveryResult(await this.remote(TEAM_DISSOLVE_RESULT_PATH, {
          authenticated: false,
          method: 'POST',
          body: { operationId: pending.operationId, recoverySecret: pending.recoverySecret },
        }))
        return await this.finalizeRecoveredDissolution(pending)
      } catch (error: unknown) {
        if (!(error instanceof RemoteTeamError) || error.status !== 404) {
          if (this.isDefiniteRemoteRejection(error)) {
            await this.credentials.unset(this.pendingDissolutionRef())
            await this.credentials.unset(this.dissolutionKeyDigestRef())
            throw error
          }
          return this.confirmingDissolution(pending)
        }
      }

      // The result lookup can race the original request before its commit. Reuse
      // the exact operation id, revision, name, secret hash and authorizing key to
      // make the replay safe. A replacement credential must never authorize it.
      try {
        const key = await this.verifiedDissolutionReplayKey()
        const replayed = projectDissolutionResult(await this.submitDissolution(pending, key), pending)
        return await this.finalizeDissolution(pending, replayed)
      } catch (error: unknown) {
        if (
          error instanceof RemoteTeamError
          && error.diagnosedTerminal?.code === 'team_dissolved'
        ) return await this.finalizeRecoveredDissolution(pending)
        if (this.isDefiniteRemoteRejection(error)) {
          await this.credentials.unset(this.pendingDissolutionRef())
          await this.credentials.unset(this.dissolutionKeyDigestRef())
          throw error
        }
        return this.confirmingDissolution(pending)
      }
    })
  }

  async clearTeamDissolution(): Promise<TeamDissolutionClearResult> {
    return this.withCredentialTransition(async () => {
      this.requireEnabled()
      const terminal = await this.terminalDissolution()
      const pendingConfigured = (await this.credentials.describe(this.pendingDissolutionRef())).configured
      if (terminal.localCleanup === 'completed' && !pendingConfigured) {
        // Delete the non-blocking digest first. If terminal deletion then fails,
        // the completed marker still prevents a misleading fresh connection.
        await this.credentials.unset(this.dissolutionKeyDigestRef())
        await this.credentials.unset(this.terminalDissolutionRef())
        return { cleared: true }
      }
      return dissolutionView(await this.refreshTerminalCleanup(terminal, !pendingConfigured))
    })
  }

  async clearConnectionTerminal(): Promise<TeamConnectionTerminalClearResult> {
    return this.withCredentialTransition(async () => {
      this.requireEnabled()
      const terminal = await this.connectionTerminal()
      if (terminal.localCleanup === 'completed') {
        await this.credentials.unset(this.connectionTerminalRef())
        await this.credentials.unset(this.connectionTerminalKeyDigestRef())
        return { cleared: true }
      }
      return connectionTerminalView(await this.refreshConnectionTerminalCleanup(terminal))
    })
  }

  async requestOwnershipTransfer(
    targetMemberId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOwnershipTransferSummary> {
    const key = await this.expectedMutationKey(expectedContext, 'owner')
    return projectOwnershipTransferSummary(await this.remote(TEAM_OWNERSHIP_TRANSFER_PATH, {
      method: 'POST',
      body: { targetMemberId },
      key,
    }))
  }

  async acceptOwnershipTransfer(
    transferId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOwnershipTransferAcceptanceResult> {
    const key = await this.expectedMutationKey(expectedContext)
    return projectOwnershipTransferAcceptance(await this.remote(TEAM_OWNERSHIP_TRANSFER_ACCEPT_PATH, {
      method: 'POST',
      body: { transferId },
      key,
    }))
  }

  async rejectOwnershipTransfer(
    transferId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOwnershipTransferSummary> {
    const key = await this.expectedMutationKey(expectedContext)
    return projectOwnershipTransferSummary(await this.remote(TEAM_OWNERSHIP_TRANSFER_REJECT_PATH, {
      method: 'POST',
      body: { transferId },
      key,
    }))
  }

  async revokeOwnershipTransfer(
    transferId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOwnershipTransferSummary> {
    const key = await this.expectedMutationKey(expectedContext, 'owner')
    return projectOwnershipTransferSummary(await this.remote(TEAM_OWNERSHIP_TRANSFER_REVOKE_PATH, {
      method: 'POST',
      body: { transferId },
      key,
    }))
  }

  async previewInvite(inviteToken: string): Promise<TeamManagementInvitePreview> {
    const preview = projectInvitePreview(await this.remote(TEAM_INVITES_PREVIEW_PATH, {
      authenticated: false,
      method: 'POST',
      body: { inviteToken },
    }))
    const now = Date.now()
    this.pruneInvitePreviewSessions(now)
    while (this.invitePreviewSessions.size >= MAX_INVITE_PREVIEW_SESSIONS) {
      const oldest = this.invitePreviewSessions.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.invitePreviewSessions.delete(oldest)
    }
    let joinHandle: string
    do {
      joinHandle = `dsh_join_${randomBytes(32).toString('base64url')}`
    } while (this.invitePreviewSessions.has(joinHandle))
    this.invitePreviewSessions.set(joinHandle, {
      inviteToken,
      createdAt: now,
      expiresAt: Math.min(preview.expiresAt, now + INVITE_PREVIEW_SESSION_TTL_MS),
    })
    return { ...preview, joinHandle }
  }

  async createInvite(
    label: string,
    expiresInMs: number | undefined,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementInviteResult> {
    const key = await this.expectedMutationKey(expectedContext, 'owner')
    const item = record(await this.remote(TEAM_INVITES_PATH, {
      method: 'POST',
      body: { label, ...expiresInMs === undefined ? {} : { expiresInMs } },
      key,
    }), 'invite result')
    const inviteToken = stringField(item, 'inviteToken')
    if (!inviteToken.startsWith('dsh_invite_')) throw new Error('remote Team returned an invalid invite token')
    return { invite: projectInvite(item.invite), inviteToken }
  }

  async revealInvite(
    inviteId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementInviteRevealResult> {
    const key = await this.expectedMutationKey(expectedContext, 'owner')
    const item = record(await this.remote(TEAM_INVITES_REVEAL_PATH, {
      method: 'POST',
      body: { inviteId },
      key,
    }), 'invite reveal result')
    const returnedInviteId = stringField(item, 'inviteId')
    const inviteToken = stringField(item, 'inviteToken')
    if (returnedInviteId !== inviteId || !inviteToken.startsWith('dsh_invite_')) {
      throw new Error('remote Team returned an invalid invite reveal result')
    }
    return {
      inviteId: returnedInviteId,
      inviteToken,
      expiresAt: numberField(item, 'expiresAt'),
    }
  }

  async revokeInvite(
    inviteId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementInviteRevocationResult> {
    const key = await this.expectedMutationKey(expectedContext, 'owner')
    const item = record(await this.remote(TEAM_INVITES_REVOKE_PATH, {
      method: 'POST',
      body: { inviteId },
      key,
    }), 'invite revocation result')
    return { invite: projectInvite(item.invite) }
  }

  async removeMember(
    memberId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementMemberResult> {
    const key = await this.expectedMutationKey(expectedContext, 'owner')
    return projectMemberResult(await this.remote(TEAM_MEMBERS_REMOVE_PATH, {
      method: 'POST', body: { memberId }, key,
    }), true)
  }

  async setTeamStatus(
    status: 'active' | 'paused',
    expectedLifecycleRevision: number,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<{ team: TeamSummary }> {
    const key = await this.expectedMutationKey(expectedContext, 'owner')
    const item = record(await this.remote(TEAM_STATUS_PATH, {
      method: 'POST',
      body: { status, operationId: randomUUID(), expectedLifecycleRevision },
      key,
    }), 'team status')
    return { team: projectTeam(item.team) }
  }

  async contributions(): Promise<{ accounts: readonly TeamManagementContributionSummary[] }> {
    const item = record(await this.remote(TEAM_CONTRIBUTIONS_PATH), 'contributions')
    const currentMemberId = stringField(item, 'currentMemberId')
    return {
      accounts: objectArray(item.accounts, 'accounts', projectContribution)
        .filter(account => account.ownerMemberId === currentMemberId),
    }
  }

  async startOAuth(
    label: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOAuthResult> {
    const key = await this.expectedMutationKey(expectedContext)
    const item = record(await this.remote(TEAM_CONTRIBUTION_OAUTH_START_PATH, {
      method: 'POST', body: { label }, key,
    }), 'OAuth result')
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

  async cancelOAuth(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementContributionResult> {
    const key = await this.expectedMutationKey(expectedContext)
    const item = record(await this.remote(TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH, {
      method: 'POST', body: { accountId }, key,
    }), 'OAuth cancellation')
    return { account: projectContribution(item.account) }
  }

  async reauthorizeOAuth(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementOAuthResult> {
    const key = await this.expectedMutationKey(expectedContext)
    const item = record(await this.remote(TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH, {
      method: 'POST', body: { accountId }, key,
    }), 'OAuth result')
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

  async updateContribution(
    accountId: string,
    patch: TeamManagementContributionPatch,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementContributionResult> {
    const key = await this.expectedMutationKey(expectedContext)
    const item = record(await this.remote(TEAM_CONTRIBUTION_UPDATE_PATH, {
      method: 'POST', body: { accountId, ...patch }, key,
    }), 'contribution update')
    return { account: projectContribution(item.account) }
  }

  async revokeContribution(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<TeamManagementContributionResult> {
    const key = await this.expectedMutationKey(expectedContext)
    const item = record(await this.remote(TEAM_CONTRIBUTION_REVOKE_PATH, {
      method: 'POST', body: { accountId }, key,
    }), 'contribution revocation')
    return { account: projectContribution(item.account) }
  }

  async usage(): Promise<TeamManagementUsageResult> {
    const item = record(await this.remote(TEAM_USAGE_PATH), 'usage')
    const role = stringField(item, 'role')
    if (role !== 'owner' && role !== 'member') throw new Error('remote Team returned an invalid usage role')
    if (item.currency !== 'USD') throw new Error('remote Team returned an invalid usage currency')
    const window = record(item.window, 'usage window')
    const startedAt = safeNonNegativeInteger(window, 'startedAt')
    const endedAt = safeNonNegativeInteger(window, 'endedAt')
    if (startedAt > endedAt) throw new Error('remote Team returned an invalid usage window')
    const base = {
      window: { startedAt, endedAt },
      currency: 'USD' as const,
      mine: projectUsageAggregate(item.mine, 'member usage aggregate'),
    }
    if (role === 'member') return { role, ...base }
    return { role, ...base, team: projectUsageAggregate(item.team, 'Team usage aggregate') }
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

  private pendingJoinRef(): CredentialRef {
    return credentialRef(`${String(this.keyRef())}${PENDING_JOIN_REF_SUFFIX}`)
  }

  private pendingDissolutionRef(): CredentialRef {
    return credentialRef(`${String(this.keyRef())}${DISSOLUTION_PENDING_REF_SUFFIX}`)
  }

  private terminalDissolutionRef(): CredentialRef {
    return credentialRef(`${String(this.keyRef())}${DISSOLUTION_TERMINAL_REF_SUFFIX}`)
  }

  private dissolutionKeyDigestRef(): CredentialRef {
    return credentialRef(`${String(this.keyRef())}${DISSOLUTION_KEY_DIGEST_REF_SUFFIX}`)
  }

  private connectionTerminalRef(): CredentialRef {
    return credentialRef(`${String(this.keyRef())}${CONNECTION_TERMINAL_REF_SUFFIX}`)
  }

  private connectionTerminalKeyDigestRef(): CredentialRef {
    return credentialRef(`${String(this.keyRef())}${CONNECTION_TERMINAL_KEY_DIGEST_REF_SUFFIX}`)
  }

  private confirmingDissolution(pending: PendingDissolutionRecord): TeamDissolutionView {
    return {
      state: 'confirming',
      teamName: pending.teamName,
      requestedAt: pending.requestedAt,
    }
  }

  private async pendingDissolution(): Promise<PendingDissolutionRecord> {
    const value = (await this.credentials.resolve(this.pendingDissolutionRef()))?.value
    if (value === undefined) throw new Error('pending Team dissolution is not configured')
    let candidate: unknown
    try {
      candidate = JSON.parse(value)
    } catch {
      throw new Error('pending Team dissolution is invalid')
    }
    const item = record(candidate, 'pending Team dissolution')
    exactKeys(item, [
      'version',
      'operationId',
      'recoverySecret',
      'teamName',
      'expectedLifecycleRevision',
      'requestedAt',
    ])
    const operationId = requiredUnmodifiedString(item, 'operationId')
    const recoverySecret = requiredUnmodifiedString(item, 'recoverySecret')
    const requestedAt = requiredInteger(item, 'requestedAt')
    if (
      item.version !== 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)
      || !/^[A-Za-z0-9_-]+$/u.test(recoverySecret)
      || Buffer.from(recoverySecret, 'base64url').byteLength < 32
      || requestedAt < 0
    ) throw new Error('pending Team dissolution is invalid')
    return {
      version: 1,
      operationId,
      recoverySecret,
      teamName: requiredUnmodifiedString(item, 'teamName'),
      expectedLifecycleRevision: requiredPositiveInteger(item, 'expectedLifecycleRevision'),
      requestedAt,
    }
  }

  private async terminalDissolution(): Promise<TerminalDissolutionRecord> {
    const value = (await this.credentials.resolve(this.terminalDissolutionRef()))?.value
    if (value === undefined) throw new Error('confirmed Team dissolution is not configured')
    let candidate: unknown
    try {
      candidate = JSON.parse(value)
    } catch {
      throw new Error('confirmed Team dissolution is invalid')
    }
    const item = record(candidate, 'confirmed Team dissolution')
    if (
      item.state !== 'confirmed'
      || (item.localCleanup !== 'completed'
        && item.localCleanup !== 'retry_required'
        && item.localCleanup !== 'manual_required')
    ) throw new Error('confirmed Team dissolution is invalid')
    if (item.version === 2) {
      exactKeys(item, ['version', 'state', 'localCleanup'])
      return { version: 2, state: 'confirmed', localCleanup: item.localCleanup }
    }
    exactKeys(item, ['version', 'state', 'teamName', 'dissolvedAt', 'localCleanup'])
    const dissolvedAt = requiredInteger(item, 'dissolvedAt')
    if (item.version !== 1 || dissolvedAt < 0) throw new Error('confirmed Team dissolution is invalid')
    return {
      version: 1,
      state: 'confirmed',
      teamName: requiredUnmodifiedString(item, 'teamName'),
      dissolvedAt,
      localCleanup: item.localCleanup,
    }
  }

  private async rememberDiagnosedDissolution(key: string): Promise<void> {
    const configured = await this.credentials.describe(this.terminalDissolutionRef())
    const terminal: TerminalDissolutionRecord = configured.configured
      ? await this.terminalDissolution()
      : { version: 2, state: 'confirmed', localCleanup: 'retry_required' }
    if (!configured.configured) {
      // Bind cleanup before publishing the terminal. Both writes precede removal
      // of the old Team key, and neither record contains the credential itself.
      await this.rememberDissolutionKeyDigest(key)
      await this.credentials.set(this.terminalDissolutionRef(), JSON.stringify(terminal))
    }
    try {
      await this.refreshTerminalCleanup(terminal, true)
    } catch {
      // The durable marker keeps the Browser terminal; cleanup can be retried locally.
    }
  }

  private async connectionTerminal(): Promise<ConnectionTerminalRecord> {
    const value = (await this.credentials.resolve(this.connectionTerminalRef()))?.value
    if (value === undefined) throw new Error('Team connection terminal is not configured')
    let candidate: unknown
    try {
      candidate = JSON.parse(value)
    } catch {
      throw new Error('Team connection terminal is invalid')
    }
    const item = record(candidate, 'Team connection terminal')
    exactKeys(item, ['version', 'code', 'localCleanup'])
    if (
      item.version !== 1
      || (item.code !== 'member_removed' && item.code !== 'member_left' && item.code !== 'device_revoked')
      || (item.localCleanup !== 'completed'
        && item.localCleanup !== 'retry_required'
        && item.localCleanup !== 'manual_required')
    ) throw new Error('Team connection terminal is invalid')
    return { version: 1, code: item.code, localCleanup: item.localCleanup }
  }

  private async rememberDiagnosedConnectionTerminal(terminal: TeamConnectionTerminal, key: string): Promise<void> {
    if (terminal.code === 'team_dissolved') {
      await this.rememberDiagnosedDissolution(key)
      return
    }
    const configured = await this.credentials.describe(this.connectionTerminalRef())
    const record: ConnectionTerminalRecord = configured.configured
      ? await this.connectionTerminal()
      : { version: 1, code: terminal.code, localCleanup: 'retry_required' }
    if (!configured.configured) {
      // Persist the reason before deleting the credential so a crash cannot
      // regress the Browser to an ambiguous disconnected state.
      await this.credentials.set(this.connectionTerminalKeyDigestRef(), JSON.stringify({
        version: 1,
        keySha256: createHash('sha256').update(key).digest('hex'),
      }))
      await this.credentials.set(this.connectionTerminalRef(), JSON.stringify(record))
    }
    try {
      await this.refreshConnectionTerminalCleanup(record)
    } catch {
      // The durable marker keeps the terminal reason visible for a later retry.
    }
  }

  private async refreshConnectionTerminalCleanup(
    terminal: ConnectionTerminalRecord,
  ): Promise<ConnectionTerminalRecord> {
    const localCleanup = await this.cleanupConnectionTerminalKey()
    const next: ConnectionTerminalRecord = {
      version: 1,
      code: terminal.code,
      localCleanup,
    }
    await this.credentials.set(this.connectionTerminalRef(), JSON.stringify(next))
    return next
  }

  private async connectionTerminalKeyDigest(): Promise<string | undefined> {
    const value = (await this.credentials.resolve(this.connectionTerminalKeyDigestRef()))?.value
    if (value === undefined) return undefined
    let candidate: unknown
    try {
      candidate = JSON.parse(value)
    } catch {
      throw new Error('Team connection terminal key digest is invalid')
    }
    const item = record(candidate, 'Team connection terminal key digest')
    exactKeys(item, ['version', 'keySha256'])
    if (item.version !== 1 || typeof item.keySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.keySha256)) {
      throw new Error('Team connection terminal key digest is invalid')
    }
    return item.keySha256
  }

  private async cleanupConnectionTerminalKey(): Promise<ConnectionTerminalRecord['localCleanup']> {
    let expectedKeySha256: string | undefined
    try {
      expectedKeySha256 = await this.connectionTerminalKeyDigest()
    } catch {
      return 'manual_required'
    }
    // A legacy, removed or malformed binding is not permission to delete the
    // credential currently occupying the fixed ref.
    if (expectedKeySha256 === undefined) return 'manual_required'
    return this.cleanupLocalTeamKey(expectedKeySha256)
  }

  private async rememberDissolutionKeyDigest(key: string): Promise<void> {
    await this.credentials.set(this.dissolutionKeyDigestRef(), JSON.stringify({
      version: 1,
      keySha256: createHash('sha256').update(key).digest('hex'),
    }))
  }

  private async dissolutionKeyDigest(): Promise<string | undefined> {
    const value = (await this.credentials.resolve(this.dissolutionKeyDigestRef()))?.value
    if (value === undefined) return undefined
    let candidate: unknown
    try {
      candidate = JSON.parse(value)
    } catch {
      throw new Error('Team dissolution key digest is invalid')
    }
    const item = record(candidate, 'Team dissolution key digest')
    exactKeys(item, ['version', 'keySha256'])
    if (item.version !== 1 || typeof item.keySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.keySha256)) {
      throw new Error('Team dissolution key digest is invalid')
    }
    return item.keySha256
  }

  private async verifiedDissolutionReplayKey(): Promise<string> {
    const expectedKeySha256 = await this.dissolutionKeyDigest()
    if (expectedKeySha256 === undefined) throw new Error('Team dissolution key binding is not configured')
    const key = await this.key()
    const actualKeySha256 = createHash('sha256').update(key).digest()
    const expectedKeySha256Bytes = Buffer.from(expectedKeySha256, 'hex')
    if (!timingSafeEqual(actualKeySha256, expectedKeySha256Bytes)) {
      throw new Error('pending Team dissolution belongs to a different active Team connection')
    }
    return key
  }

  private async cleanupDissolvedTeamKey(): Promise<TerminalDissolutionRecord['localCleanup']> {
    let expectedKeySha256: string | undefined
    try {
      expectedKeySha256 = await this.dissolutionKeyDigest()
    } catch {
      return 'manual_required'
    }
    // A legacy, removed or malformed binding is not permission to delete the
    // credential currently occupying the fixed ref.
    if (expectedKeySha256 === undefined) return 'manual_required'
    return this.cleanupLocalTeamKey(expectedKeySha256)
  }

  private async diagnoseConnectionTerminal(key: string): Promise<TeamConnectionTerminal | undefined> {
    try {
      await this.remote(TEAM_CONNECTION_TERMINAL_PATH, {
        method: 'POST',
        key,
        diagnoseTerminal: false,
      })
      return undefined
    } catch (error: unknown) {
      if (!(error instanceof RemoteTeamError) || error.status !== 410) return undefined
      try {
        return projectConnectionTerminal(error.responseBody)
      } catch {
        return undefined
      }
    }
  }

  private async submitDissolution(pending: PendingDissolutionRecord, key: string): Promise<unknown> {
    return this.remote(TEAM_DISSOLVE_PATH, {
      method: 'POST',
      key,
      body: {
        operationId: pending.operationId,
        expectedLifecycleRevision: pending.expectedLifecycleRevision,
        confirmationName: pending.teamName,
        recoverySecretHash: createHash('sha256').update(pending.recoverySecret).digest('hex'),
      },
    })
  }

  private async acknowledgeDissolution(pending: PendingDissolutionRecord): Promise<boolean> {
    try {
      projectDissolutionAck(await this.remote(TEAM_DISSOLVE_ACK_PATH, {
        authenticated: false,
        method: 'POST',
        body: { operationId: pending.operationId, recoverySecret: pending.recoverySecret },
      }))
      await this.credentials.unset(this.pendingDissolutionRef())
      return true
    } catch {
      return false
    }
  }

  private async finalizeDissolution(
    pending: PendingDissolutionRecord,
    result: TeamDissolutionResult,
  ): Promise<TeamDissolutionView> {
    const terminal: TerminalDissolutionRecord = {
      version: 1,
      state: 'confirmed',
      teamName: result.teamName,
      dissolvedAt: result.dissolvedAt,
      localCleanup: 'retry_required',
    }
    // Once this marker is durable, the Browser can never regress to an
    // ambiguous pre-dissolution screen, even if ACK or key deletion fails.
    await this.credentials.set(this.terminalDissolutionRef(), JSON.stringify(terminal))
    const acknowledged = await this.acknowledgeDissolution(pending)
    try {
      return dissolutionView(await this.refreshTerminalCleanup(terminal, acknowledged))
    } catch {
      return dissolutionView(terminal)
    }
  }

  private async finalizeRecoveredDissolution(
    pending: PendingDissolutionRecord,
  ): Promise<TeamDissolutionView> {
    const terminal: TerminalDissolutionRecord = {
      version: 2,
      state: 'confirmed',
      localCleanup: 'retry_required',
    }
    // Recovery is intentionally coarse. Persist that coarse terminal before
    // ACK or local key cleanup so a crash cannot regress to an ambiguous state.
    await this.credentials.set(this.terminalDissolutionRef(), JSON.stringify(terminal))
    const acknowledged = await this.acknowledgeDissolution(pending)
    try {
      return dissolutionView(await this.refreshTerminalCleanup(terminal, acknowledged))
    } catch {
      return dissolutionView(terminal)
    }
  }

  private async refreshTerminalCleanup(
    terminal: TerminalDissolutionRecord,
    pendingResolved: boolean,
  ): Promise<TerminalDissolutionRecord> {
    const keyCleanup = await this.cleanupDissolvedTeamKey()
    const localCleanup = keyCleanup === 'manual_required'
      ? 'manual_required'
      : pendingResolved && keyCleanup === 'completed'
        ? 'completed'
        : 'retry_required'
    const next: TerminalDissolutionRecord = { ...terminal, localCleanup }
    await this.credentials.set(this.terminalDissolutionRef(), JSON.stringify(next))
    return next
  }

  private async cleanupLocalTeamKey(expectedKeySha256?: string): Promise<TerminalDissolutionRecord['localCleanup']> {
    try {
      const resolved = await this.credentials.resolve(this.keyRef())
      if (resolved === undefined) return 'completed'
      if (
        expectedKeySha256 !== undefined
        && createHash('sha256').update(resolved.value).digest('hex') !== expectedKeySha256
      ) return 'completed'
      const info = await this.credentials.describe(this.keyRef())
      if (!info.writable) return 'manual_required'
      await this.credentials.unset(this.keyRef())
      return 'completed'
    } catch {
      try {
        const info = await this.credentials.describe(this.keyRef())
        return info.configured && !info.writable ? 'manual_required' : 'retry_required'
      } catch {
        return 'retry_required'
      }
    }
  }

  private async pendingJoin(): Promise<PendingJoinRecord> {
    const value = (await this.credentials.resolve(this.pendingJoinRef()))?.value
    if (value === undefined) throw new Error('pending Team join is not configured')
    let candidate: unknown
    try {
      candidate = JSON.parse(value)
    } catch {
      throw new Error('pending Team join is invalid')
    }
    const item = record(candidate, 'pending Team join')
    exactKeys(item, ['version', 'apiKey', 'inviteToken', 'displayName'])
    if (item.version !== 1) throw new Error('pending Team join is invalid')
    const pending: PendingJoinRecord = {
      version: 1,
      apiKey: requiredString(item, 'apiKey'),
      inviteToken: requiredString(item, 'inviteToken'),
      displayName: requiredUnmodifiedString(item, 'displayName'),
    }
    validateTeamKey(pending.apiKey)
    if (!pending.inviteToken.startsWith('dsh_invite_')) throw new Error('pending Team join is invalid')
    return pending
  }

  private invitePreviewSession(joinHandle: string): InvitePreviewSession {
    if (!/^dsh_join_[A-Za-z0-9_-]{43}$/u.test(joinHandle)) throw new Error('join handle is invalid or expired')
    const now = Date.now()
    this.pruneInvitePreviewSessions(now)
    const session = this.invitePreviewSessions.get(joinHandle)
    if (session === undefined || session.expiresAt <= now) {
      this.invitePreviewSessions.delete(joinHandle)
      throw new Error('join handle is invalid or expired')
    }
    return session
  }

  private pruneInvitePreviewSessions(now: number): void {
    for (const [joinHandle, session] of this.invitePreviewSessions) {
      if (session.expiresAt <= now) this.invitePreviewSessions.delete(joinHandle)
    }
  }

  private async acceptPendingJoin(pending: PendingJoinRecord): Promise<unknown> {
    return this.remote(TEAM_JOIN_PATH, {
      authenticated: false,
      method: 'POST',
      body: {
        inviteToken: pending.inviteToken,
        displayName: pending.displayName,
        apiKey: pending.apiKey,
      },
    })
  }

  private async promotePendingJoin(pending: PendingJoinRecord): Promise<void> {
    const active = await this.credentials.resolve(this.keyRef())
    if (active !== undefined && active.value !== pending.apiKey) {
      throw new Error('pending Team join belongs to a different active Team connection')
    }
    if (active === undefined) await this.credentials.set(this.keyRef(), pending.apiKey)
    await this.credentials.unset(this.pendingJoinRef())
  }

  private isDefiniteJoinRejection(error: unknown): boolean {
    return this.isDefiniteRemoteRejection(error)
  }

  private isDefiniteRemoteRejection(error: unknown): boolean {
    return error instanceof RemoteTeamError
      && error.status >= 400
      && error.status < 500
      && error.status !== 408
      && error.status !== 429
  }

  private isMissingRemoteIdentity(error: unknown): boolean {
    return error instanceof RemoteTeamError && (error.status === 401 || error.status === 404)
  }

  private async withCredentialTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.credentialTransition
    let release!: () => void
    this.credentialTransition = new Promise(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
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

  /**
   * Capture one credential, prove that it still represents the Browser's
   * complete Team identity, and return that exact credential for the write.
   */
  private async expectedMutationKey(
    expectedContext: TeamManagementExpectedContext,
    requiredRole?: TeamManagementOverview['viewerRole'],
  ): Promise<string> {
    const serverOrigin = new URL(this.requireEnabled()).origin
    if (expectedContext.serverOrigin !== serverOrigin) throw new TeamManagementContextMismatchError()

    const key = await this.key()
    const overview = await this.overview(key)
    if (
      overview.team.id !== expectedContext.teamId
      || overview.currentMember.id !== expectedContext.currentMemberId
      || (requiredRole !== undefined && overview.viewerRole !== requiredRole)
    ) throw new TeamManagementContextMismatchError()
    return key
  }

  /** Do not delete a credential another process or tab has already replaced. */
  private async unsetKeyIfCurrent(expectedKey: string): Promise<void> {
    const current = await this.credentials.resolve(this.keyRef())
    if (current?.value === expectedKey) await this.credentials.unset(this.keyRef())
  }

  private async remote(
    path: string,
    options: {
      authenticated?: boolean
      method?: 'GET' | 'POST'
      body?: unknown
      key?: string
      diagnoseTerminal?: boolean
    } = {},
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
      if (
        response.status === 401
        && key !== undefined
        && path !== TEAM_CONNECTION_TERMINAL_PATH
        && options.diagnoseTerminal !== false
      ) {
        const terminal = await this.diagnoseConnectionTerminal(key)
        if (terminal !== undefined) {
          await this.rememberDiagnosedConnectionTerminal(terminal, key)
          throw new RemoteTeamError(410, 'remote Team connection is terminal', terminal, terminal)
        }
      }
      const item = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
      const message = typeof item?.error === 'string' ? item.error : `HTTP ${response.status}`
      throw new RemoteTeamError(response.status, `remote Team request failed: ${safeMessage(message)}`, value)
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
  const ownsSecurity = options.security === undefined
  const security = options.security ?? new LocalTeamManagementRouteSecurity(
    configuredManagementOrigins(ctx),
    options.now ?? Date.now,
  )
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
        const origin = requestOrigin(req, security.allowedOrigins, method === 'POST')
        if (origin === undefined) { forbidden(res); return }
        if (method === 'POST') {
          const capability = header(req, TEAM_MANAGEMENT_CAPABILITY_HEADER)
          if (typeof capability !== 'string' || !security.verify(capability, origin)) { forbidden(res); return }
        }
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
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_MANAGEMENT_SESSION_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          const origin = requestOrigin(req, security.allowedOrigins, true)
          if (origin === undefined) { forbidden(res); return }
          try {
            const body = await readJson(req)
            exactKeys(body, [])
            json(res, 200, security.issue(origin))
          } catch (error: unknown) {
            json(res, statusFor(error), { error: safeMessage(error) })
          }
        },
      }),
      register(TEAM_MANAGEMENT_STATUS_PATH, 'GET', async () => ({ value: await proxy.status() })),
      register(TEAM_MANAGEMENT_OVERVIEW_PATH, 'GET', async () => ({ value: await proxy.overview() })),
      register(TEAM_MANAGEMENT_DISPLAY_NAME_MIGRATION_ACK_PATH, 'POST', async (body) => {
        exactKeys(body, ['migrationVersion', 'expectedContext'])
        return {
          value: await proxy.acknowledgeDisplayNameMigration(
            requiredPositiveInteger(body, 'migrationVersion'),
            requiredExpectedContext(body),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_JOIN_PATH, 'POST', async (body) => {
        exactKeys(body, ['joinHandle', 'displayName'])
        return {
          status: 201,
          value: await proxy.join(requiredString(body, 'joinHandle'), requiredUnmodifiedString(body, 'displayName')),
        }
      }),
      register(TEAM_MANAGEMENT_JOIN_RECOVER_PATH, 'POST', async (body) => {
        exactKeys(body, [])
        return { value: await proxy.recoverJoin() }
      }),
      register(TEAM_MANAGEMENT_JOIN_DISCARD_PATH, 'POST', async (body) => {
        exactKeys(body, [])
        return { value: await proxy.discardPendingJoin() }
      }),
      register(TEAM_MANAGEMENT_DISCONNECT_PATH, 'POST', async (body) => {
        exactKeys(body, ['revokeRemote', 'expectedContext'])
        if (typeof body.revokeRemote !== 'boolean') throw new Error('revokeRemote must be a boolean')
        if (!body.revokeRemote && body.expectedContext !== undefined) {
          throw new Error('expectedContext is only valid when revoking the remote key')
        }
        return {
          value: await proxy.disconnect(
            body.revokeRemote,
            body.revokeRemote ? requiredExpectedContext(body) : undefined,
          ),
        }
      }),
      register(TEAM_MANAGEMENT_LEAVE_PATH, 'POST', async (body) => {
        exactKeys(body, ['expectedContext'])
        return { value: await proxy.leaveTeam(requiredExpectedContext(body)) }
      }),
      register(TEAM_MANAGEMENT_DISSOLVE_PATH, 'POST', async (body) => {
        exactKeys(body, ['confirmationName', 'expectedLifecycleRevision', 'expectedContext'])
        const value = await proxy.dissolveTeam({
          confirmationName: requiredUnmodifiedString(body, 'confirmationName'),
          expectedLifecycleRevision: requiredPositiveInteger(body, 'expectedLifecycleRevision'),
        }, requiredExpectedContext(body))
        return { status: value.state === 'confirming' ? 202 : 200, value }
      }),
      register(TEAM_MANAGEMENT_DISSOLUTION_RECOVER_PATH, 'POST', async (body) => {
        exactKeys(body, [])
        const value = await proxy.recoverTeamDissolution()
        return { status: value.state === 'confirming' ? 202 : 200, value }
      }),
      register(TEAM_MANAGEMENT_DISSOLUTION_CLEAR_PATH, 'POST', async (body) => {
        exactKeys(body, [])
        return { value: await proxy.clearTeamDissolution() }
      }),
      register(TEAM_MANAGEMENT_CONNECTION_TERMINAL_CLEAR_PATH, 'POST', async (body) => {
        exactKeys(body, [])
        return { value: await proxy.clearConnectionTerminal() }
      }),
      register(TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_PATH, 'POST', async (body) => {
        exactKeys(body, ['targetMemberId', 'expectedContext'])
        return {
          value: await proxy.requestOwnershipTransfer(
            requiredString(body, 'targetMemberId'),
            requiredExpectedContext(body),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_ACCEPT_PATH, 'POST', async (body) => {
        exactKeys(body, ['transferId', 'expectedContext'])
        return {
          value: await proxy.acceptOwnershipTransfer(
            requiredString(body, 'transferId'),
            requiredExpectedContext(body),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REJECT_PATH, 'POST', async (body) => {
        exactKeys(body, ['transferId', 'expectedContext'])
        return {
          value: await proxy.rejectOwnershipTransfer(
            requiredString(body, 'transferId'),
            requiredExpectedContext(body),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_OWNERSHIP_TRANSFER_REVOKE_PATH, 'POST', async (body) => {
        exactKeys(body, ['transferId', 'expectedContext'])
        return {
          value: await proxy.revokeOwnershipTransfer(
            requiredString(body, 'transferId'),
            requiredExpectedContext(body),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_INVITES_PATH, 'POST', async (body) => {
        exactKeys(body, ['label', 'expiresInMs', 'expectedContext'])
        return {
          status: 201,
          value: await proxy.createInvite(
            requiredString(body, 'label'),
            optionalInteger(body, 'expiresInMs'),
            requiredExpectedContext(body),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_INVITES_PREVIEW_PATH, 'POST', async (body) => {
        exactKeys(body, ['inviteToken'])
        return { value: await proxy.previewInvite(requiredString(body, 'inviteToken')) }
      }),
      register(TEAM_MANAGEMENT_INVITES_REVEAL_PATH, 'POST', async (body) => {
        exactKeys(body, ['inviteId', 'expectedContext'])
        return {
          value: await proxy.revealInvite(requiredString(body, 'inviteId'), requiredExpectedContext(body)),
        }
      }),
      register(TEAM_MANAGEMENT_INVITES_REVOKE_PATH, 'POST', async (body) => {
        exactKeys(body, ['inviteId', 'expectedContext'])
        return {
          value: await proxy.revokeInvite(requiredString(body, 'inviteId'), requiredExpectedContext(body)),
        }
      }),
      register(TEAM_MANAGEMENT_MEMBERS_REMOVE_PATH, 'POST', async (body) => {
        exactKeys(body, ['memberId', 'expectedContext'])
        return {
          value: await proxy.removeMember(requiredString(body, 'memberId'), requiredExpectedContext(body)),
        }
      }),
      register(TEAM_MANAGEMENT_TEAM_STATUS_PATH, 'POST', async (body) => {
        exactKeys(body, ['status', 'expectedLifecycleRevision', 'expectedContext'])
        const status = requiredString(body, 'status')
        if (status !== 'active' && status !== 'paused') throw new Error('status must be active or paused')
        return {
          value: await proxy.setTeamStatus(
            status,
            requiredPositiveInteger(body, 'expectedLifecycleRevision'),
            requiredExpectedContext(body),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_CONTRIBUTIONS_PATH, 'GET', async () => ({ value: await proxy.contributions() })),
      register(TEAM_MANAGEMENT_OAUTH_START_PATH, 'POST', async (body) => {
        exactKeys(body, ['label', 'expectedContext'])
        return {
          status: 201,
          value: await proxy.startOAuth(requiredString(body, 'label'), requiredExpectedContext(body)),
        }
      }),
      register(TEAM_MANAGEMENT_OAUTH_CANCEL_PATH, 'POST', async (body) => {
        exactKeys(body, ['accountId', 'expectedContext'])
        return {
          value: await proxy.cancelOAuth(requiredString(body, 'accountId'), requiredExpectedContext(body)),
        }
      }),
      register(TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH, 'POST', async (body) => {
        exactKeys(body, ['accountId', 'expectedContext'])
        return {
          value: await proxy.reauthorizeOAuth(requiredString(body, 'accountId'), requiredExpectedContext(body)),
        }
      }),
      register(TEAM_MANAGEMENT_CONTRIBUTION_UPDATE_PATH, 'POST', async (body) => {
        const { accountId, patch, expectedContext } = contributionPatch(body)
        return { value: await proxy.updateContribution(accountId, patch, expectedContext) }
      }),
      register(TEAM_MANAGEMENT_CONTRIBUTION_REVOKE_PATH, 'POST', async (body) => {
        exactKeys(body, ['accountId', 'expectedContext'])
        return {
          value: await proxy.revokeContribution(requiredString(body, 'accountId'), requiredExpectedContext(body)),
        }
      }),
      register(TEAM_MANAGEMENT_USAGE_PATH, 'GET', async () => ({ value: await proxy.usage() })),
    ]
    return async () => {
      for (const dispose of routes) dispose()
      if (ownsSecurity) security.dispose?.()
    }
  }, 'dsh-codex-shared-pool: local Team management routes')
}

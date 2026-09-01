/** Local same-origin Team management proxy. Raw Team keys remain Host-only. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import { loginOpenAICodexProfile } from '../auth.ts'
import { OpenAICodexCredentialStore } from '../store.ts'
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
  TEAM_MANAGEMENT_CONTEXT_CHANGED_MESSAGE,
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
  TeamManagementPendingBrowserAuthorization,
  TeamManagementStatus,
  TeamManagementSession,
  TeamManagementSharedAccountDirectoryEntry,
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
  TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH,
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
import type { TeamCredentialHandoffOffer } from './oauth-handoff.ts'
import { sealTeamCredentialHandoff } from './oauth-handoff.ts'
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
  TeamUsageEventStatus,
  TeamUsageProjection,
} from './types.ts'
import {
  DEFAULT_TEAM_CLIENT_API_KEY_REF,
  resolveTeamClientBaseUrl,
} from './client.ts'
import type { TeamClientConfig } from './client.ts'
import { safeTeamErrorMessage, safeTeamOAuthErrorMessage } from './safe-message.ts'

const MAX_LOCAL_BODY_BYTES = 16 * 1024
const MAX_REMOTE_BODY_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const PENDING_JOIN_REF_SUFFIX = '_PENDING_JOIN'
const BROWSER_OAUTH_PENDING_REF_SUFFIX = '_BROWSER_OAUTH_PENDING'
const LOCAL_CONTRIBUTION_BINDINGS_REF_SUFFIX = '_LOCAL_CONTRIBUTION_BINDINGS'
const DISSOLUTION_PENDING_REF_SUFFIX = '_DISSOLUTION_PENDING'
const DISSOLUTION_TERMINAL_REF_SUFFIX = '_DISSOLUTION_TERMINAL'
const DISSOLUTION_KEY_DIGEST_REF_SUFFIX = '_DISSOLUTION_KEY_DIGEST'
const CONNECTION_TERMINAL_REF_SUFFIX = '_CONNECTION_TERMINAL'
const CONNECTION_TERMINAL_KEY_DIGEST_REF_SUFFIX = '_CONNECTION_TERMINAL_KEY_DIGEST'
const INVITE_PREVIEW_SESSION_TTL_MS = 15 * 60 * 1000
const MAX_INVITE_PREVIEW_SESSIONS = 64
const MANAGEMENT_SESSION_TTL_MS = 15 * 60 * 1000
const MAX_MANAGEMENT_SESSIONS = 64
const MAX_PENDING_BROWSER_OAUTH_OPERATIONS = 8
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

/** Browser-safe Host journal used to restore cancellation after an abrupt restart. */
interface PendingBrowserOAuthRecord {
  readonly expectedContext: TeamManagementExpectedContext
  readonly pending: TeamManagementPendingBrowserAuthorization
}

interface PendingBrowserOAuthJournal {
  readonly version: 1
  readonly operations: readonly PendingBrowserOAuthRecord[]
}

interface LocalContributionBinding {
  readonly expectedContext: TeamManagementExpectedContext
  readonly accountId: string
  readonly sourceLocalProfileId: string
}

interface LocalContributionBindingJournal {
  readonly version: 1
  readonly bindings: readonly LocalContributionBinding[]
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
    super(TEAM_MANAGEMENT_CONTEXT_CHANGED_MESSAGE)
    this.name = 'TeamManagementContextMismatchError'
  }
}

function projectedOAuthRemoteError(error: unknown): Error {
  if (error instanceof TeamManagementContextMismatchError) return error
  const message = safeTeamOAuthErrorMessage(error)
  return error instanceof RemoteTeamError
    ? new RemoteTeamError(error.status, message)
    : new Error(message)
}

function sameTeamManagementContext(
  left: Readonly<TeamManagementExpectedContext>,
  right: Readonly<TeamManagementExpectedContext>,
): boolean {
  return left.serverOrigin === right.serverOrigin
    && left.teamId === right.teamId
    && left.currentMemberId === right.currentMemberId
}

type Credentials = Pick<CredentialProvider, 'resolve' | 'describe' | 'set' | 'unset'>
type LocalProfiles = Pick<OpenAICodexCredentialStore, 'listProfiles' | 'readProfileCredential'>

type LocalOAuthMethod = 'browser' | 'device_code'

interface LocalBrowserOAuthOperation {
  /** Abort locally; callers that perform their own remote mutation suppress duplicate cleanup. */
  readonly abort: (reason: Error, suppressAutomaticCleanup?: boolean) => void
  readonly completion: Promise<void>
  /** Immutable identity verified immediately before the remote OAuth mutation. */
  readonly expectedContext: Readonly<TeamManagementExpectedContext>
  /** Safe metadata projected only while the same contribution is authorizing. */
  readonly pending: TeamManagementPendingBrowserAuthorization
}

interface LocalAccountValidationIntent {
  readonly expectedProviderAccountId: string
  readonly sourceLocalProfileId: string
}

export interface TeamManagementRouteOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  security?: TeamManagementRouteSecurity
  now?: () => number
  /** Test seam for provider OAuth; production always uses the local Host implementation. */
  loginProfile?: typeof loginOpenAICodexProfile
  /** Parent for owner-only, short-lived OAuth capture directories. */
  temporaryRootDir?: string
  /** Receives failures that happen after the authorization URL was returned to the Browser. */
  onBackgroundError?: (error: unknown) => void
  /** Host-only local profile lookup used solely for exact provider-account verification. */
  localProfiles?: LocalProfiles
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

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  return value[key] === undefined ? undefined : requiredString(value, key)
}

function optionalBoolean(value: Record<string, unknown>, key: string, fallback = false): boolean {
  const candidate = value[key]
  if (candidate === undefined) return fallback
  if (typeof candidate !== 'boolean') throw new Error(`${key} must be a boolean`)
  return candidate
}

function optionalOAuthMethod(value: Record<string, unknown>, fallback: LocalOAuthMethod = 'browser'): LocalOAuthMethod {
  const method = value.method
  if (method === undefined) return fallback
  if (method !== 'browser' && method !== 'device_code') throw new Error('method must be browser or device_code')
  return method
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('OpenAI Codex sign-in aborted')
}

function waitForPromptAbort(prompt: AuthPrompt, operationSignal: AbortSignal): Promise<string> {
  const signal = prompt.signal === undefined
    ? operationSignal
    : AbortSignal.any([prompt.signal, operationSignal])
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
  })
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

function parsePendingBrowserOAuthJournal(value: string): PendingBrowserOAuthJournal {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('pending browser OAuth journal is invalid')
  }
  const journal = record(parsed, 'pending browser OAuth journal')
  exactKeys(journal, ['version', 'operations'])
  if (journal.version !== 1 || !Array.isArray(journal.operations)) {
    throw new Error('pending browser OAuth journal is invalid')
  }
  if (journal.operations.length > MAX_PENDING_BROWSER_OAUTH_OPERATIONS) {
    throw new Error('pending browser OAuth journal is invalid')
  }
  const identities = new Set<string>()
  const operations = journal.operations.map((candidate): PendingBrowserOAuthRecord => {
    const operation = record(candidate, 'pending browser OAuth operation')
    exactKeys(operation, ['expectedContext', 'pending'])
    const expectedContext = requiredExpectedContext({ expectedContext: operation.expectedContext })
    const rawPending = record(operation.pending, 'pending browser OAuth metadata')
    exactKeys(rawPending, ['accountId', 'method', 'expiresAt', 'discardInitial'])
    const accountId = requiredUnmodifiedString(rawPending, 'accountId')
    if (rawPending.method !== 'browser') throw new Error('pending browser OAuth journal is invalid')
    const expiresAt = requiredInteger(rawPending, 'expiresAt')
    if (expiresAt < 0 || typeof rawPending.discardInitial !== 'boolean') {
      throw new Error('pending browser OAuth journal is invalid')
    }
    const identity = `${expectedContext.serverOrigin}\u0000${expectedContext.teamId}\u0000${expectedContext.currentMemberId}\u0000${accountId}`
    if (identities.has(identity)) throw new Error('pending browser OAuth journal is invalid')
    identities.add(identity)
    return {
      expectedContext,
      pending: { accountId, method: 'browser', expiresAt, discardInitial: rawPending.discardInitial },
    }
  })
  return { version: 1, operations }
}

function parseLocalContributionBindingJournal(value: string): LocalContributionBindingJournal {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('local contribution binding journal is invalid')
  }
  const journal = record(parsed, 'local contribution binding journal')
  exactKeys(journal, ['version', 'bindings'])
  if (journal.version !== 1 || !Array.isArray(journal.bindings) || journal.bindings.length > 256) {
    throw new Error('local contribution binding journal is invalid')
  }
  const accountIds = new Set<string>()
  const profileIds = new Set<string>()
  const bindings = journal.bindings.map((candidate): LocalContributionBinding => {
    const binding = record(candidate, 'local contribution binding')
    exactKeys(binding, ['expectedContext', 'accountId', 'sourceLocalProfileId'])
    const expectedContext = requiredExpectedContext({ expectedContext: binding.expectedContext })
    const accountId = requiredUnmodifiedString(binding, 'accountId')
    const sourceLocalProfileId = requiredUnmodifiedString(binding, 'sourceLocalProfileId')
    const scope = `${expectedContext.serverOrigin}\u0000${expectedContext.teamId}\u0000${expectedContext.currentMemberId}\u0000`
    if (accountIds.has(`${scope}${accountId}`) || profileIds.has(`${scope}${sourceLocalProfileId}`)) {
      throw new Error('local contribution binding journal is invalid')
    }
    accountIds.add(`${scope}${accountId}`)
    profileIds.add(`${scope}${sourceLocalProfileId}`)
    return { expectedContext, accountId, sourceLocalProfileId }
  })
  return { version: 1, bindings }
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
  const weeklyLimit = item.weeklySharedEstimatedApiCostLimitMicros ?? null
  if (weeklyLimit !== null && (
    typeof weeklyLimit !== 'number' || !Number.isSafeInteger(weeklyLimit) || weeklyLimit < 0
  )) throw new Error('remote Team returned an invalid weekly contribution limit')
  const lastError = item.lastError === undefined
    ? undefined
    : safeTeamOAuthErrorMessage(stringField(item, 'lastError'))
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
    weeklySharedEstimatedApiCostLimitMicros: weeklyLimit as number | null,
    maxSharedConcurrency: numberField(item, 'maxSharedConcurrency'),
    allowedModels: stringArray(item.allowedModels, 'allowedModels'),
    createdAt: numberField(item, 'createdAt'),
    updatedAt: numberField(item, 'updatedAt'),
    ...lastError === undefined ? {} : { lastError },
    ...capacity === undefined ? {} : { capacity },
  }
}

function projectActiveSharedAccount(value: unknown): TeamManagementSharedAccountDirectoryEntry {
  const item = record(value, 'active shared account')
  exactRemoteKeys(item, ['id', 'label', 'ownerMemberId', 'status'], 'active shared account')
  if (item.status !== 'active') throw new Error('remote Team returned an invalid active shared account')
  return {
    id: stringField(item, 'id'),
    label: stringField(item, 'label'),
    ownerMemberId: stringField(item, 'ownerMemberId'),
    status: 'active',
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

function projectOwnedAccountUsage(value: unknown): TeamUsageProjection['ownedAccounts'] {
  if (!Array.isArray(value)) throw new Error('remote Team returned invalid owned account usage')
  return value.map(raw => {
    const account = record(raw, 'owned account usage')
    const window = projectUsageWindow(account.window, 'owned account usage window')
    const currentUtcWeek = account.currentUtcWeek === undefined
      ? undefined
      : (() => {
          const week = record(account.currentUtcWeek, 'owned account current UTC week')
          const weekWindow = projectUsageWindow(week.window, 'owned account current UTC week window')
          const resetAt = safeNonNegativeInteger(week, 'resetAt')
          if (resetAt < weekWindow.endedAt) throw new Error('remote Team returned invalid current UTC week reset')
          return {
            window: weekWindow,
            resetAt,
            aggregate: projectUsageAggregate(week.aggregate, 'owned account current UTC week aggregate'),
          }
        })()
    const last24Hours = account.last24Hours === undefined
      ? undefined
      : (() => {
          const day = record(account.last24Hours, 'owned account last 24 hours')
          return {
            window: projectUsageWindow(day.window, 'owned account last 24 hours window'),
            aggregate: projectUsageAggregate(day.aggregate, 'owned account last 24 hours aggregate'),
          }
        })()
    const requests = account.recentRequests
    if (!Array.isArray(requests)) throw new Error('remote Team returned invalid recent requests')
    return {
      accountId: stringField(account, 'accountId'),
      window,
      aggregate: projectUsageAggregate(account.aggregate, 'owned account usage aggregate'),
      ...(currentUtcWeek === undefined ? {} : { currentUtcWeek }),
      ...(last24Hours === undefined ? {} : { last24Hours }),
      recentRequests: requests.map(rawRequest => {
        const request = record(rawRequest, 'recent request')
        const status = stringField(request, 'status')
        if (!['in_progress', 'succeeded', 'failed', 'cancelled'].includes(status)) throw new Error('remote Team returned invalid request status')
        return {
          id: stringField(request, 'id'),
          model: stringField(request, 'model'),
          status: status as TeamUsageEventStatus,
          startedAt: safeNonNegativeInteger(request, 'startedAt'),
          ...(request.finishedAt === undefined ? {} : { finishedAt: safeNonNegativeInteger(request, 'finishedAt') }),
          ...(request.totalTokens === undefined ? {} : { totalTokens: safeNonNegativeInteger(request, 'totalTokens') }),
          ...(request.estimatedCostUsdMicros === undefined ? {} : { estimatedCostUsdMicros: stringField(request, 'estimatedCostUsdMicros') }),
        }
      }),
    }
  })
}

function projectUsageWindow(value: unknown, label: string) {
  const window = record(value, label)
  const startedAt = safeNonNegativeInteger(window, 'startedAt')
  const endedAt = safeNonNegativeInteger(window, 'endedAt')
  if (startedAt > endedAt) throw new Error(`remote Team returned invalid ${label}`)
  return { startedAt, endedAt }
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
  // The directory was added as a browser-safe projection after the initial
  // Team overview contract. An omitted field means an empty legacy directory;
  // present entries still pass the strict allowlist below.
  const activeSharedAccounts = item.activeSharedAccounts === undefined
    ? []
    : objectArray(
        item.activeSharedAccounts,
        'activeSharedAccounts',
        projectActiveSharedAccount,
      )
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
    activeSharedAccounts,
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
    'weeklySharedEstimatedApiCostLimitMicros',
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
    ...value.weeklySharedEstimatedApiCostLimitMicros === undefined
      ? {}
      : value.weeklySharedEstimatedApiCostLimitMicros === null
        ? { weeklySharedEstimatedApiCostLimitMicros: null }
        : { weeklySharedEstimatedApiCostLimitMicros: requiredInteger(value, 'weeklySharedEstimatedApiCostLimitMicros') },
    ...value.allowedModels === undefined ? {} : { allowedModels: stringArray(value.allowedModels, 'allowedModels') },
  }
  if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'paused') throw new Error('status must be active or paused')
  return { accountId, patch, expectedContext: requiredExpectedContext(value) }
}

class TeamManagementProxy {
  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly loginProfile: typeof loginOpenAICodexProfile
  private readonly temporaryRootDir: string
  private readonly onBackgroundError: (error: unknown) => void
  private readonly localProfiles: LocalProfiles | undefined
  private readonly browserOAuth = new Map<string, LocalBrowserOAuthOperation>()
  private readonly invitePreviewSessions = new Map<string, InvitePreviewSession>()
  private browserOAuthJournalTransition: Promise<void> = Promise.resolve()
  private localContributionBindingTransition: Promise<void> = Promise.resolve()
  private credentialTransition: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: TeamClientConfig,
    private readonly credentials: Credentials,
    options: TeamManagementRouteOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.loginProfile = options.loginProfile ?? loginOpenAICodexProfile
    this.temporaryRootDir = options.temporaryRootDir ?? tmpdir()
    this.onBackgroundError = options.onBackgroundError ?? (() => {})
    this.localProfiles = options.localProfiles
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
    let overview = projectOverview(
      await this.remote(TEAM_OVERVIEW_PATH, explicitKey === undefined ? {} : { key: explicitKey }),
    )
    const actualContext: TeamManagementExpectedContext = {
      serverOrigin: new URL(this.requireEnabled()).origin,
      teamId: overview.team.id,
      currentMemberId: overview.currentMember.id,
    }
    const bindings = await this.localContributionBindings()
    const retainedBindings = bindings.filter((binding) => {
      if (!sameTeamManagementContext(binding.expectedContext, actualContext)) return false
      const account = overview.contributions.find(candidate => candidate.id === binding.accountId)
      return account !== undefined && account.status !== 'revoked'
    })
    if (retainedBindings.length !== bindings.length) {
      await this.replaceLocalContributionBindings(retainedBindings).catch((error: unknown) => {
        this.onBackgroundError(new Error('failed to prune stale local contribution bindings', { cause: error }))
      })
    }
    const bindingByAccountId = new Map(retainedBindings.map(binding => [binding.accountId, binding]))
    overview = {
      ...overview,
      contributions: overview.contributions.map((account) => {
        const binding = bindingByAccountId.get(account.id)
        return binding === undefined ? account : { ...account, sourceLocalProfileId: binding.sourceLocalProfileId }
      }),
    }
    let livePending: TeamManagementPendingBrowserAuthorization | undefined
    for (const operation of this.browserOAuth.values()) {
      if (!sameTeamManagementContext(operation.expectedContext, actualContext)) {
        operation.abort(new TeamManagementContextMismatchError(), false)
        continue
      }
      const account = overview.contributions.find(candidate => candidate.id === operation.pending.accountId)
      if (account?.status !== 'authorizing') continue
      livePending ??= operation.pending
    }
    const journal = await this.pendingBrowserOAuthJournal()
    const retained = journal.filter((operation) => {
      if (!sameTeamManagementContext(operation.expectedContext, actualContext)) return false
      const account = overview.contributions.find(candidate => candidate.id === operation.pending.accountId)
      return account === undefined || account.status === 'authorizing'
    })
    if (retained.length !== journal.length) {
      await this.replacePendingBrowserOAuthJournal(retained).catch((error: unknown) => {
        this.onBackgroundError(new Error('failed to prune stale browser OAuth recovery metadata', { cause: error }))
      })
    }
    const recoveredPending = retained.find((operation) => {
      const account = overview.contributions.find(candidate => candidate.id === operation.pending.accountId)
      return account?.status === 'authorizing'
    })?.pending
    const pendingBrowserAuthorization = livePending ?? recoveredPending
    return pendingBrowserAuthorization === undefined
      ? overview
      : { ...overview, pendingBrowserAuthorization }
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
    method: LocalOAuthMethod = 'browser',
    sourceLocalProfileId?: string,
  ): Promise<TeamManagementOAuthResult> {
    try {
      const key = await this.expectedMutationKey(expectedContext)
      const validationIntent = await this.resolveLocalAccountValidationIntent(method, sourceLocalProfileId)
      const remote = await this.remote(TEAM_CONTRIBUTION_OAUTH_START_PATH, {
        method: 'POST', body: { label, method }, key,
      })
      const item = record(remote, 'OAuth result')
      return method === 'browser'
        ? await this.beginBrowserOAuth(item, true, key, expectedContext, validationIntent)
        : this.projectDeviceOAuth(item)
    } catch (error: unknown) {
      throw projectedOAuthRemoteError(error)
    }
  }

  private async resolveLocalAccountValidationIntent(
    method: LocalOAuthMethod,
    sourceLocalProfileId: string | undefined,
  ): Promise<LocalAccountValidationIntent | undefined> {
    if (sourceLocalProfileId === undefined) return undefined
    if (method !== 'browser') throw new Error('sourceLocalProfileId requires browser OAuth')
    if (this.localProfiles === undefined) throw new Error('local account verification is not available')
    const profiles = await this.localProfiles.listProfiles()
    if (!profiles.some(profile => profile.id === sourceLocalProfileId)) {
      throw new Error('selected local Codex account was not found')
    }
    const credential = await this.localProfiles.readProfileCredential(sourceLocalProfileId)
    if (credential?.type !== 'oauth') throw new Error('selected local Codex account was not found')
    const accountId = (credential as typeof credential & { accountId?: unknown }).accountId
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      throw new Error('selected local Codex account has no provider account identity')
    }
    return { expectedProviderAccountId: accountId, sourceLocalProfileId }
  }

  private projectDeviceOAuth(item: Record<string, unknown>): TeamManagementOAuthResult {
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

  async cancelOAuth(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
    discardInitial = false,
  ): Promise<TeamManagementContributionResult> {
    try {
      const key = await this.expectedMutationKey(expectedContext)
      const operation = this.browserOAuth.get(accountId)
      const ownedOperation = operation !== undefined
        && sameTeamManagementContext(operation.expectedContext, expectedContext)
        ? operation
        : undefined
      const persistedOperation = (await this.pendingBrowserOAuthJournal()).find(candidate => (
        candidate.pending.accountId === accountId
        && sameTeamManagementContext(candidate.expectedContext, expectedContext)
      ))
      const effectiveDiscardInitial = ownedOperation?.pending.discardInitial
        ?? persistedOperation?.pending.discardInitial
        ?? discardInitial
      if (ownedOperation !== undefined) {
        ownedOperation.abort(new Error('OpenAI Codex sign-in cancelled'))
        await ownedOperation.completion.catch(() => {})
      }
      const item = record(await this.remote(TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH, {
        method: 'POST', body: { accountId, discardInitial: effectiveDiscardInitial }, key,
      }), 'OAuth cancellation')
      const account = projectContribution(item.account)
      if (account.id !== accountId) throw new Error('remote Team returned a mismatched OAuth contribution')
      await this.removeLocalContributionBinding(accountId, expectedContext).catch((error: unknown) => {
        this.onBackgroundError(new Error('failed to clear local contribution binding', { cause: error }))
      })
      await this.removePendingBrowserOAuth(accountId, expectedContext).catch((error: unknown) => {
        this.onBackgroundError(new Error('failed to clear browser OAuth recovery metadata', { cause: error }))
      })
      return { account }
    } catch (error: unknown) {
      throw projectedOAuthRemoteError(error)
    }
  }

  async reauthorizeOAuth(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
    method: LocalOAuthMethod = 'browser',
  ): Promise<TeamManagementOAuthResult> {
    try {
      const key = await this.expectedMutationKey(expectedContext)
      const current = this.browserOAuth.get(accountId)
      if (current !== undefined && sameTeamManagementContext(current.expectedContext, expectedContext)) {
        current.abort(new Error('OpenAI Codex sign-in restarted'))
        await current.completion.catch(() => {})
      }
      const remote = await this.remote(TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH, {
        method: 'POST', body: { accountId, method }, key,
      })
      const item = record(remote, 'OAuth result')
      return method === 'browser'
        ? await this.beginBrowserOAuth(item, false, key, expectedContext)
        : this.projectDeviceOAuth(item)
    } catch (error: unknown) {
      throw projectedOAuthRemoteError(error)
    }
  }

  private async beginBrowserOAuth(
    item: Record<string, unknown>,
    discardInitialOnFailure: boolean,
    key: string,
    expectedContext: TeamManagementExpectedContext,
    validationIntent?: LocalAccountValidationIntent,
  ): Promise<TeamManagementOAuthResult> {
    const account = projectContribution(item.account)
    let offer: TeamCredentialHandoffOffer
    try {
      if (item.method !== 'browser_handoff') throw new Error('remote Team returned an unsupported OAuth method')
      const rawOffer = record(item.handoff, 'OAuth handoff offer')
      exactKeys(rawOffer, ['version', 'sessionId', 'serverPublicKey', 'expiresAt'])
      offer = {
        version: numberField(rawOffer, 'version') as 1,
        sessionId: stringField(rawOffer, 'sessionId'),
        serverPublicKey: stringField(rawOffer, 'serverPublicKey'),
        expiresAt: numberField(rawOffer, 'expiresAt'),
      }
      if (offer.version !== 1) throw new Error('remote Team returned an unsupported OAuth handoff version')
    } catch (error: unknown) {
      if (discardInitialOnFailure) {
        await this.cancelRemoteOAuthBestEffort(account.id, true, key, expectedContext)
      }
      throw error
    }

    const frozenExpectedContext = Object.freeze({ ...expectedContext })
    const pending = Object.freeze({
      accountId: account.id,
      method: 'browser',
      expiresAt: offer.expiresAt,
      discardInitial: discardInitialOnFailure,
    } satisfies TeamManagementPendingBrowserAuthorization)
    try {
      await this.persistPendingBrowserOAuth({ expectedContext: frozenExpectedContext, pending })
    } catch (error: unknown) {
      await this.cancelRemoteOAuthBestEffort(
        account.id,
        discardInitialOnFailure,
        key,
        frozenExpectedContext,
      )
      throw error
    }

    const cancellation = new AbortController()
    let suppressAutomaticCleanup = false
    const abort = (reason: Error, suppressCleanup = true): void => {
      if (suppressCleanup) suppressAutomaticCleanup = true
      cancellation.abort(reason)
    }
    const expirationTimer = setTimeout(() => {
      abort(new Error('OpenAI Codex sign-in timed out'), false)
    }, Math.max(0, offer.expiresAt - this.now()))
    let resolveAuthorization!: (url: string) => void
    let rejectAuthorization!: (error: unknown) => void
    let authorizationSettled = false
    const authorization = new Promise<string>((resolve, reject) => {
      resolveAuthorization = (url) => { authorizationSettled = true; resolve(url) }
      rejectAuthorization = (error) => { authorizationSettled = true; reject(error) }
    })
    const interaction: AuthInteraction = {
      signal: cancellation.signal,
      prompt: prompt => prompt.type === 'select'
        ? Promise.resolve('browser')
        : waitForPromptAbort(prompt, cancellation.signal),
      notify: (event) => {
        if (event.type !== 'auth_url' || authorizationSettled) return
        try {
          const url = new URL(event.url)
          if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
            throw new Error('OpenAI returned an unsafe authorization URL')
          }
          resolveAuthorization(event.url)
        } catch (error: unknown) {
          cancellation.abort(error)
          rejectAuthorization(error)
        }
      },
    }

    let completion!: Promise<void>
    completion = this.captureAndTransferOAuth(
      account,
      offer,
      interaction,
      cancellation.signal,
      frozenExpectedContext,
      validationIntent,
    )
      .catch(async (error: unknown) => {
        if (!authorizationSettled) rejectAuthorization(error)
        if (!suppressAutomaticCleanup) {
          await this.cancelRemoteOAuthBestEffort(
            account.id,
            discardInitialOnFailure,
            key,
            frozenExpectedContext,
          )
          this.onBackgroundError(projectedOAuthRemoteError(error))
        }
        throw error
      })
      .finally(() => {
        clearTimeout(expirationTimer)
        if (this.browserOAuth.get(account.id)?.completion === completion) this.browserOAuth.delete(account.id)
      })
    this.browserOAuth.set(account.id, { abort, completion, expectedContext: frozenExpectedContext, pending })
    // Completion stays Host-side after the Browser receives and opens this URL.
    completion.catch(() => {})
    return { account, method: 'browser', authorizationUrl: await authorization, expiresAt: offer.expiresAt }
  }

  /** Automatic cleanup is idempotent; retry one transport failure before giving up. */
  private async cancelRemoteOAuthBestEffort(
    accountId: string,
    discardInitial: boolean,
    key: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.remote(TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH, {
          method: 'POST', body: { accountId, discardInitial }, key,
        })
        await this.removePendingBrowserOAuth(accountId, expectedContext).catch((error: unknown) => {
          this.onBackgroundError(new Error('failed to clear browser OAuth recovery metadata', { cause: error }))
        })
        await this.removeLocalContributionBinding(accountId, expectedContext).catch((error: unknown) => {
          this.onBackgroundError(new Error('failed to clear local contribution binding', { cause: error }))
        })
        return true
      } catch (error: unknown) {
        if (
          error instanceof RemoteTeamError
          && error.status >= 400
          && error.status < 500
          && error.status !== 408
          && error.status !== 429
        ) return false
      }
    }
    return false
  }

  private async captureAndTransferOAuth(
    account: TeamManagementContributionSummary,
    offer: TeamCredentialHandoffOffer,
    interaction: AuthInteraction,
    signal: AbortSignal,
    expectedContext: TeamManagementExpectedContext,
    validationIntent?: LocalAccountValidationIntent,
  ): Promise<void> {
    const directory = await mkdtemp(join(this.temporaryRootDir, 'dsh-team-oauth-'))
    const store = new OpenAICodexCredentialStore(join(directory, 'credentials.json'))
    try {
      const profile = await this.loginProfile(interaction, store, {
        beforeCommit: () => { if (signal.aborted) throw abortReason(signal) },
      })
      if (signal.aborted) throw abortReason(signal)
      const credential = await store.readProfileCredential(profile.id)
      if (credential?.type !== 'oauth') throw new Error('OpenAI Codex sign-in completed without an OAuth credential')
      const providerAccountId = (credential as typeof credential & { accountId?: unknown }).accountId
      if (typeof providerAccountId !== 'string' || providerAccountId.trim() === '') {
        throw new Error('OpenAI Codex sign-in completed without an account credential')
      }
      if (validationIntent !== undefined && providerAccountId !== validationIntent.expectedProviderAccountId) {
        throw new Error('independently authorized OpenAI account does not match the selected local account')
      }
      const currentKey = await this.expectedMutationKey(expectedContext)
      if (signal.aborted) throw abortReason(signal)
      if (validationIntent !== undefined) {
        await this.persistLocalContributionBinding({
          expectedContext,
          accountId: account.id,
          sourceLocalProfileId: validationIntent.sourceLocalProfileId,
        })
      }
      const envelope = sealTeamCredentialHandoff(
        offer,
        { teamId: account.teamId, accountId: account.id },
        { label: profile.label, credential: { ...credential, accountId: providerAccountId } },
      )
      const completed = record(await this.remote(TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH, {
        method: 'POST', body: { accountId: account.id, envelope }, key: currentKey,
      }), 'OAuth handoff completion')
      const completedAccount = projectContribution(completed.account)
      if (
        completedAccount.id !== account.id
        || completedAccount.teamId !== account.teamId
        || completedAccount.status !== 'active'
      ) throw new Error('remote Team returned a mismatched OAuth contribution')
      await this.removePendingBrowserOAuth(account.id, expectedContext).catch((error: unknown) => {
        this.onBackgroundError(new Error('failed to clear browser OAuth recovery metadata', { cause: error }))
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async dispose(): Promise<void> {
    const operations = [...this.browserOAuth.values()]
    for (const operation of operations) operation.abort(new Error('Team management routes disposed'), false)
    await Promise.allSettled(operations.map(operation => operation.completion))
    this.browserOAuth.clear()
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
    const account = projectContribution(item.account)
    await this.removeLocalContributionBinding(accountId, expectedContext)
    return { account }
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
      ownedAccounts: item.ownedAccounts === undefined ? [] : projectOwnedAccountUsage(item.ownedAccounts),
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

  private pendingBrowserOAuthRef(): CredentialRef {
    return credentialRef(`${String(this.keyRef())}${BROWSER_OAUTH_PENDING_REF_SUFFIX}`)
  }

  private localContributionBindingsRef(): CredentialRef {
    return credentialRef(`${String(this.keyRef())}${LOCAL_CONTRIBUTION_BINDINGS_REF_SUFFIX}`)
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

  private async pendingBrowserOAuthJournal(): Promise<readonly PendingBrowserOAuthRecord[]> {
    const resolved = await this.credentials.resolve(this.pendingBrowserOAuthRef())
    if (resolved === undefined) return []
    try {
      return parsePendingBrowserOAuthJournal(resolved.value).operations
    } catch (error: unknown) {
      this.onBackgroundError(new Error('discarded invalid browser OAuth recovery metadata', { cause: error }))
      await this.credentials.unset(this.pendingBrowserOAuthRef()).catch((unsetError: unknown) => {
        this.onBackgroundError(new Error('failed to discard invalid browser OAuth recovery metadata', { cause: unsetError }))
      })
      return []
    }
  }

  private async localContributionBindings(): Promise<readonly LocalContributionBinding[]> {
    const resolved = await this.credentials.resolve(this.localContributionBindingsRef())
    if (resolved === undefined) return []
    try {
      return parseLocalContributionBindingJournal(resolved.value).bindings
    } catch (error: unknown) {
      this.onBackgroundError(new Error('discarded invalid local contribution bindings', { cause: error }))
      await this.credentials.unset(this.localContributionBindingsRef()).catch((unsetError: unknown) => {
        this.onBackgroundError(new Error('failed to discard invalid local contribution bindings', { cause: unsetError }))
      })
      return []
    }
  }

  private async replaceLocalContributionBindings(bindings: readonly LocalContributionBinding[]): Promise<void> {
    await this.withLocalContributionBindingTransition(async () => {
      if (bindings.length === 0) {
        if (await this.credentials.resolve(this.localContributionBindingsRef()) !== undefined) {
          await this.credentials.unset(this.localContributionBindingsRef())
        }
        return
      }
      await this.credentials.set(this.localContributionBindingsRef(), JSON.stringify({ version: 1, bindings }))
    })
  }

  private async persistLocalContributionBinding(binding: LocalContributionBinding): Promise<void> {
    await this.withLocalContributionBindingTransition(async () => {
      const current = await this.localContributionBindings()
      const bindings = current.filter(candidate => !(
        sameTeamManagementContext(candidate.expectedContext, binding.expectedContext)
        && (candidate.accountId === binding.accountId
          || candidate.sourceLocalProfileId === binding.sourceLocalProfileId)
      ))
      await this.credentials.set(this.localContributionBindingsRef(), JSON.stringify({
        version: 1,
        bindings: [...bindings, binding],
      } satisfies LocalContributionBindingJournal))
    })
  }

  private async removeLocalContributionBinding(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<void> {
    await this.withLocalContributionBindingTransition(async () => {
      const current = await this.localContributionBindings()
      const bindings = current.filter(candidate => !(
        candidate.accountId === accountId
        && sameTeamManagementContext(candidate.expectedContext, expectedContext)
      ))
      if (bindings.length === current.length) return
      if (bindings.length === 0) await this.credentials.unset(this.localContributionBindingsRef())
      else await this.credentials.set(this.localContributionBindingsRef(), JSON.stringify({ version: 1, bindings }))
    })
  }

  private async replacePendingBrowserOAuthJournal(
    operations: readonly PendingBrowserOAuthRecord[],
  ): Promise<void> {
    await this.withBrowserOAuthJournalTransition(async () => {
      if (operations.length === 0) {
        if (await this.credentials.resolve(this.pendingBrowserOAuthRef()) !== undefined) {
          await this.credentials.unset(this.pendingBrowserOAuthRef())
        }
        return
      }
      await this.credentials.set(this.pendingBrowserOAuthRef(), JSON.stringify({
        version: 1,
        operations,
      } satisfies PendingBrowserOAuthJournal))
    })
  }

  private async persistPendingBrowserOAuth(operation: PendingBrowserOAuthRecord): Promise<void> {
    await this.withBrowserOAuthJournalTransition(async () => {
      const current = await this.pendingBrowserOAuthJournal()
      const operations = current.filter(candidate => !(
        candidate.pending.accountId === operation.pending.accountId
        && sameTeamManagementContext(candidate.expectedContext, operation.expectedContext)
      ))
      if (operations.length >= MAX_PENDING_BROWSER_OAUTH_OPERATIONS) {
        throw new Error('too many pending browser OAuth operations')
      }
      await this.credentials.set(this.pendingBrowserOAuthRef(), JSON.stringify({
        version: 1,
        operations: [...operations, operation],
      } satisfies PendingBrowserOAuthJournal))
    })
  }

  private async removePendingBrowserOAuth(
    accountId: string,
    expectedContext: TeamManagementExpectedContext,
  ): Promise<void> {
    await this.withBrowserOAuthJournalTransition(async () => {
      const current = await this.pendingBrowserOAuthJournal()
      const operations = current.filter(candidate => !(
        candidate.pending.accountId === accountId
        && sameTeamManagementContext(candidate.expectedContext, expectedContext)
      ))
      if (operations.length === current.length) return
      if (operations.length === 0) await this.credentials.unset(this.pendingBrowserOAuthRef())
      else {
        await this.credentials.set(this.pendingBrowserOAuthRef(), JSON.stringify({
          version: 1,
          operations,
        } satisfies PendingBrowserOAuthJournal))
      }
    })
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

  private async withBrowserOAuthJournalTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.browserOAuthJournalTransition
    let release!: () => void
    this.browserOAuthJournalTransition = new Promise(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async withLocalContributionBindingTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.localContributionBindingTransition
    let release!: () => void
    this.localContributionBindingTransition = new Promise(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
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
        exactKeys(body, ['label', 'method', 'sourceLocalProfileId', 'expectedContext'])
        return {
          status: 201,
          value: await proxy.startOAuth(
            requiredString(body, 'label'),
            requiredExpectedContext(body),
            optionalOAuthMethod(body),
            optionalString(body, 'sourceLocalProfileId'),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_OAUTH_CANCEL_PATH, 'POST', async (body) => {
        exactKeys(body, ['accountId', 'discardInitial', 'expectedContext'])
        return {
          value: await proxy.cancelOAuth(
            requiredString(body, 'accountId'),
            requiredExpectedContext(body),
            optionalBoolean(body, 'discardInitial'),
          ),
        }
      }),
      register(TEAM_MANAGEMENT_OAUTH_REAUTHORIZE_PATH, 'POST', async (body) => {
        exactKeys(body, ['accountId', 'method', 'expectedContext'])
        return {
          value: await proxy.reauthorizeOAuth(
            requiredString(body, 'accountId'),
            requiredExpectedContext(body),
            optionalOAuthMethod(body),
          ),
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
      await proxy.dispose()
      if (ownsSecurity) security.dispose?.()
    }
  }, 'dsh-codex-shared-pool: local Team management routes')
}

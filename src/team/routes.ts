/** Team control-plane HTTP routes. OAuth credentials never cross this boundary. */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamService } from './service.ts'
import {
  TEAM_AUTHORIZATION_FAILED_CODE,
  TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE,
  type TeamAuthorizationFailureCode,
} from '../shared/team-management.ts'
import {
  TEAM_BOOTSTRAP_PATH,
  TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH,
  TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH,
  TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH,
  TEAM_CONTRIBUTION_OAUTH_START_PATH,
  TEAM_CONTRIBUTION_PROVIDER_ACCOUNT_MATCHES_PATH,
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
  TEAM_KEYS_PATH,
  TEAM_KEYS_REVOKE_PATH,
  TEAM_MEMBERS_LEAVE_PATH,
  TEAM_MEMBERS_REMOVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_ACCEPT_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH,
  TEAM_OWNERSHIP_TRANSFER_REJECT_PATH,
  TEAM_OWNERSHIP_TRANSFER_REVOKE_PATH,
  TEAM_OVERVIEW_PATH,
  TEAM_STATUS_PATH,
  TEAM_USAGE_PATH,
} from './types.ts'
import type {
  TeamContributionAccountPatch,
  TeamDissolutionInput,
  TeamLifecycleTransitionInput,
  TeamOAuthMethod,
} from './types.ts'
import type { TeamCredentialHandoffEnvelope } from './oauth-handoff.ts'
import { TeamDissolutionRecoveryRateLimitError, TeamInviteRevealRateLimitError } from './store.ts'
import type { TeamAuthContext } from './store.ts'
import { safeTeamErrorMessage as safeMessage } from './safe-message.ts'

export interface TeamRouteConfig {
  /** Resolve the Host-only bootstrap secret for each bootstrap operation. */
  resolveBootstrapToken(): Promise<string | undefined>
  maxInviteTtlMs?: number | undefined
}

const MAX_BODY_BYTES = 16 * 1024

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    ...extraHeaders,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function localRequest(req: IncomingMessage): boolean {
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

function contentTypeIsJson(req: IncomingMessage): boolean {
  const value = req.headers['content-type']
  return typeof value === 'string' && value.toLowerCase().startsWith('application/json')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!contentTypeIsJson(req)) throw new Error('content-type must be application/json')
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(data)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value as Record<string, unknown>
}

function exactStrings<const Key extends string>(value: Record<string, unknown>, keys: readonly Key[]): Record<Key, string> {
  if (Object.keys(value).some(key => !keys.includes(key as Key))) throw new Error('request contains an unknown field')
  const result = {} as Record<Key, string>
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate !== 'string' || candidate.trim().length === 0) throw new Error(`${key} must be a non-empty string`)
    result[key] = candidate.trim()
  }
  return result
}

function oauthMethod(value: unknown): TeamOAuthMethod {
  if (value !== 'browser' && value !== 'device_code') throw new Error('method must be browser or device_code')
  return value
}

function oauthStartInput(value: Record<string, unknown>): { label: string; method: TeamOAuthMethod } {
  exactFields(value, ['label', 'method'])
  const label = exactStrings({ label: value.label }, ['label']).label
  return { label, method: value.method === undefined ? 'device_code' : oauthMethod(value.method) }
}

function oauthReauthorizeInput(value: Record<string, unknown>): { accountId: string; method: TeamOAuthMethod } {
  exactFields(value, ['accountId', 'method'])
  const accountId = exactStrings({ accountId: value.accountId }, ['accountId']).accountId
  return { accountId, method: value.method === undefined ? 'device_code' : oauthMethod(value.method) }
}

function oauthCancelInput(value: Record<string, unknown>): {
  accountId: string
  discardInitial: boolean
  failureCode?: TeamAuthorizationFailureCode
} {
  exactFields(value, ['accountId', 'discardInitial', 'failureCode'])
  const accountId = exactStrings({ accountId: value.accountId }, ['accountId']).accountId
  if (value.discardInitial !== undefined && typeof value.discardInitial !== 'boolean') {
    throw new Error('discardInitial must be a boolean')
  }
  const failureCode = value.failureCode
  if (
    failureCode !== undefined
    && failureCode !== TEAM_AUTHORIZATION_FAILED_CODE
    && failureCode !== TEAM_AUTHORIZATION_NETWORK_UNAVAILABLE_CODE
  ) throw new Error('failureCode is invalid')
  return {
    accountId,
    discardInitial: value.discardInitial === true,
    ...(failureCode === undefined ? {} : { failureCode }),
  }
}

function providerAccountMatchInput(value: Record<string, unknown>): { providerAccountId: string } {
  exactFields(value, ['providerAccountId'])
  const providerAccountId = nonEmptyUnmodifiedString(value, 'providerAccountId')
  if (providerAccountId.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(providerAccountId)) {
    throw new Error('providerAccountId is invalid')
  }
  return { providerAccountId }
}

function oauthHandoffInput(value: Record<string, unknown>): {
  accountId: string
  envelope: TeamCredentialHandoffEnvelope
} {
  exactFields(value, ['accountId', 'envelope'])
  const accountId = exactStrings({ accountId: value.accountId }, ['accountId']).accountId
  const envelope = value.envelope
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('envelope must be an object')
  }
  const item = envelope as Record<string, unknown>
  const keys = ['version', 'sessionId', 'clientPublicKey', 'iv', 'ciphertext', 'tag']
  if (Object.keys(item).some(key => !keys.includes(key)) || item.version !== 1) {
    throw new Error('OAuth handoff envelope is invalid')
  }
  for (const key of keys.slice(1)) {
    if (typeof item[key] !== 'string' || (item[key] as string).length === 0) {
      throw new Error('OAuth handoff envelope is invalid')
    }
  }
  return { accountId, envelope: item as unknown as TeamCredentialHandoffEnvelope }
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some(field => !fields.includes(field))) throw new Error('request contains an unknown field')
}

function nonEmptyUnmodifiedString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field]
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return candidate
}

/** Leave display-name trimming and Unicode validation to the fixed-profile store boundary. */
function rawNonEmptyString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field]
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return candidate
}

function expectedLifecycleRevision(value: Record<string, unknown>): number {
  const candidate = value.expectedLifecycleRevision
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw new Error('expectedLifecycleRevision must be a positive integer')
  }
  return candidate as number
}

function displayNameMigrationVersion(value: Record<string, unknown>): number {
  const candidate = value.migrationVersion
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw new Error('migrationVersion must be a positive integer')
  }
  return candidate as number
}

function lifecycleTransitionInput(value: Record<string, unknown>): TeamLifecycleTransitionInput {
  exactFields(value, ['operationId', 'expectedLifecycleRevision', 'status'])
  const status = value.status
  if (status !== 'active' && status !== 'paused') throw new Error('status must be active or paused')
  return {
    operationId: nonEmptyUnmodifiedString(value, 'operationId'),
    expectedLifecycleRevision: expectedLifecycleRevision(value),
    status,
  }
}

function dissolutionInput(value: Record<string, unknown>): TeamDissolutionInput {
  exactFields(value, ['operationId', 'expectedLifecycleRevision', 'confirmationName', 'recoverySecretHash'])
  return {
    operationId: nonEmptyUnmodifiedString(value, 'operationId'),
    expectedLifecycleRevision: expectedLifecycleRevision(value),
    // The store compares this byte-for-byte with the persisted Team name.
    confirmationName: nonEmptyUnmodifiedString(value, 'confirmationName'),
    recoverySecretHash: nonEmptyUnmodifiedString(value, 'recoverySecretHash'),
  }
}

function dissolutionRecoveryInput(value: Record<string, unknown>): {
  operationId: string
  recoverySecret: string
} {
  exactFields(value, ['operationId', 'recoverySecret'])
  return {
    operationId: nonEmptyUnmodifiedString(value, 'operationId'),
    recoverySecret: nonEmptyUnmodifiedString(value, 'recoverySecret'),
  }
}

function dissolutionRecoverySourceDigest(req: IncomingMessage): string {
  const remoteAddress = req.socket.remoteAddress ?? 'unknown'
  return createHash('sha256')
    .update('dsh-team-dissolution-recovery-source\0')
    .update(remoteAddress)
    .digest('hex')
}

function dissolutionRecoveryError(res: ServerResponse, error: unknown): void {
  if (error instanceof TeamDissolutionRecoveryRateLimitError) {
    json(res, 429, { error: safeMessage(error) }, {
      'retry-after': String(error.retryAfterSeconds),
    })
    return
  }
  json(res, statusFor(error), lifecycleErrorBody(error))
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header === 'string' && /^Bearer\s+\S+$/u.test(header)) return header.slice(7).trim()
  const direct = req.headers['x-dsh-team-key']
  return typeof direct === 'string' && direct.trim().length > 0 ? direct.trim() : undefined
}

function statusFor(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { readonly status?: unknown }).status
    if (status === 404 || status === 409 || status === 410) return status
  }
  const message = safeMessage(error)
  if (/administrator role|only the key owner|only the owner|only the current Team owner|only the ownership transfer target|ownership transfer is unavailable to this member|cannot remove|current Owner API key/iu.test(message)) return 403
  if (/not found|no longer available|invalid or expired|not active/iu.test(message)) return 404
  if (/already|paused|outside the allowed|waiting for reauthorization|cannot leave|ownership target|no longer pending|expired|rejected|revoked|canceled/iu.test(message)) return 409
  return 400
}

type LifecycleErrorCode =
  | 'team_lifecycle_conflict'
  | 'team_dissolved'
  | 'team_dissolution_unavailable'

function lifecycleErrorBody(error: unknown): { error: string; code?: LifecycleErrorCode } {
  const body: { error: string; code?: LifecycleErrorCode } = { error: safeMessage(error) }
  if (typeof error !== 'object' || error === null || !('code' in error)) return body
  const code = (error as { readonly code?: unknown }).code
  if (
    code === 'team_lifecycle_conflict'
    || code === 'team_dissolved'
    || code === 'team_dissolution_unavailable'
  ) body.code = code
  return body
}

function contributionPatch(value: Record<string, unknown>): { accountId: string; patch: TeamContributionAccountPatch } {
  const accountIdValue = value.accountId
  if (typeof accountIdValue !== 'string' || accountIdValue.trim().length === 0) throw new Error('accountId must be a non-empty string')
  const accountId = accountIdValue.trim()
  const patch: Record<string, unknown> = { ...value }
  delete patch.accountId
  const allowed = new Set(['label', 'status', 'personalReservePercent', 'maxSharedRequestsPerWindow', 'dailySharedCreditLimit', 'weeklySharedEstimatedApiCostLimitMicros', 'maxSharedConcurrency', 'allowedModels'])
  if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error('request contains an unknown contribution field')
  if (patch.label !== undefined && (typeof patch.label !== 'string' || patch.label.trim().length === 0)) throw new Error('label must be a non-empty string')
  if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'paused') throw new Error('status must be active or paused')
  for (const key of ['personalReservePercent', 'maxSharedConcurrency'] as const) {
    if (patch[key] !== undefined && (!Number.isSafeInteger(patch[key]) || (patch[key] as number) < 0)) {
      throw new Error(`${key} must be an integer`)
    }
  }
  if (patch.maxSharedRequestsPerWindow !== undefined && patch.maxSharedRequestsPerWindow !== null && !Number.isSafeInteger(patch.maxSharedRequestsPerWindow)) {
    throw new Error('maxSharedRequestsPerWindow must be null or an integer')
  }
  if (patch.dailySharedCreditLimit !== undefined && patch.dailySharedCreditLimit !== null && !Number.isSafeInteger(patch.dailySharedCreditLimit)) {
    throw new Error('dailySharedCreditLimit must be null or an integer')
  }
  if (patch.weeklySharedEstimatedApiCostLimitMicros !== undefined && patch.weeklySharedEstimatedApiCostLimitMicros !== null && !Number.isSafeInteger(patch.weeklySharedEstimatedApiCostLimitMicros)) {
    throw new Error('weeklySharedEstimatedApiCostLimitMicros must be null or an integer')
  }
  if (patch.allowedModels !== undefined && (!Array.isArray(patch.allowedModels) || patch.allowedModels.some(model => typeof model !== 'string'))) {
    throw new Error('allowedModels must be an array of strings')
  }
  return { accountId, patch: patch as TeamContributionAccountPatch }
}

async function authenticate(req: IncomingMessage, service: TeamService): Promise<TeamAuthContext | undefined> {
  const token = bearer(req)
  return token === undefined ? undefined : service.store.authenticateApiKey(token)
}

function requireAuth(auth: TeamAuthContext | undefined): TeamAuthContext {
  if (auth === undefined) throw new Error('Team API key required')
  return auth
}

/** Register the Team control-plane routes and dispose them with the Host plugin. */
export function registerTeamRoutes(ctx: Context, service: TeamService, config: TeamRouteConfig): void {
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_BOOTSTRAP_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          if (!localRequest(req)) { json(res, 403, { error: 'forbidden' }); return }
          let bootstrapToken: string | undefined
          try {
            bootstrapToken = await config.resolveBootstrapToken()
          } catch {
            json(res, 503, { error: 'bootstrap credential unavailable' }); return
          }
          if (bootstrapToken === undefined || bootstrapToken.length < 16) {
            json(res, 404, { error: 'not found' }); return
          }
          if (req.headers['x-dsh-bootstrap-token'] !== bootstrapToken) {
            json(res, 403, { error: 'forbidden' }); return
          }
          try {
            const body = await readJson(req)
            exactFields(body, ['teamName', 'ownerName'])
            const { teamName } = exactStrings({ teamName: body.teamName }, ['teamName'])
            const ownerName = rawNonEmptyString(body, 'ownerName')
            json(res, 201, await service.store.bootstrap(teamName, ownerName))
          } catch (error: unknown) {
            json(res, statusFor(error), { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_OVERVIEW_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            json(res, 200, await service.overviewProjection(requireAuth(await authenticate(req, service))))
          } catch (error: unknown) {
            json(res, /API key required/iu.test(safeMessage(error)) ? 401 : statusFor(error), { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_DISPLAY_NAME_MIGRATION_ACK_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            // Authenticate before parsing so unauthenticated callers cannot use this route as a body oracle.
            const auth = requireAuth(await authenticate(req, service))
            const body = await readJson(req)
            exactFields(body, ['migrationVersion'])
            json(res, 200, await service.store.acknowledgeDisplayNameMigration(
              auth,
              displayNameMigrationVersion(body),
            ))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const input = lifecycleTransitionInput(await readJson(req))
            const team = await service.store.setTeamStatus(requireAuth(await authenticate(req, service)), input)
            json(res, 200, { team })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), lifecycleErrorBody(error))
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_DISSOLVE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const result = await service.dissolveTeam(
              requireAuth(await authenticate(req, service)),
              dissolutionInput(await readJson(req)),
            )
            json(res, 200, result)
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), lifecycleErrorBody(error))
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_DISSOLVE_RESULT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const input = dissolutionRecoveryInput(await readJson(req))
            await service.store.consumeDissolutionRecoveryAttempt(
              dissolutionRecoverySourceDigest(req),
              'result',
            )
            json(res, 200, await service.store.recoverTeamDissolution(input.operationId, input.recoverySecret))
          } catch (error: unknown) {
            dissolutionRecoveryError(res, error)
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_DISSOLVE_ACK_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const input = dissolutionRecoveryInput(await readJson(req))
            await service.store.consumeDissolutionRecoveryAttempt(
              dissolutionRecoverySourceDigest(req),
              'ack',
            )
            await service.store.ackTeamDissolution(input.operationId, input.recoverySecret)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            dissolutionRecoveryError(res, error)
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONNECTION_TERMINAL_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          const token = bearer(req)
          if (token === undefined) { json(res, 401, { error: 'unauthorized' }); return }
          try {
            const terminal = await service.store.diagnoseApiKey(token)
            if (terminal === undefined) { json(res, 401, { error: 'unauthorized' }); return }
            json(res, 410, terminal)
          } catch (error: unknown) {
            json(res, statusFor(error), { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTIONS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const auth = requireAuth(await authenticate(req, service))
            json(res, 200, {
              currentMemberId: auth.memberId,
              accounts: await service.listContributionAccounts(auth),
            })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTION_PROVIDER_ACCOUNT_MATCHES_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            // Authenticate before parsing so unauthenticated callers cannot use this as an identity oracle.
            const auth = requireAuth(await authenticate(req, service))
            const { providerAccountId } = providerAccountMatchInput(await readJson(req))
            try {
              const accountIds = await service.findOwnedProviderAccountMatches(auth, providerAccountId)
              json(res, 200, { accountIds })
            } catch {
              json(res, 502, { error: 'provider-account match unavailable' })
            }
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_USAGE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const auth = requireAuth(await authenticate(req, service))
            json(res, 200, await service.readUsageProjection(auth))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTION_OAUTH_START_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { label, method } = oauthStartInput(await readJson(req))
            json(res, 201, await service.startContributionOAuth(requireAuth(await authenticate(req, service)), label, method))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTION_OAUTH_CANCEL_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { accountId, discardInitial, failureCode } = oauthCancelInput(await readJson(req))
            json(res, 200, {
              account: await service.cancelContributionOAuth(
                requireAuth(await authenticate(req, service)),
                accountId,
                { discardInitial, ...(failureCode === undefined ? {} : { failureCode }) },
              ),
            })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTION_OAUTH_REAUTHORIZE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { accountId, method } = oauthReauthorizeInput(await readJson(req))
            json(res, 200, await service.reauthorizeContributionOAuth(
              requireAuth(await authenticate(req, service)),
              accountId,
              method,
            ))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTION_OAUTH_HANDOFF_COMPLETE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { accountId, envelope } = oauthHandoffInput(await readJson(req))
            const account = await service.completeContributionOAuthHandoff(
              requireAuth(await authenticate(req, service)),
              accountId,
              envelope,
            )
            json(res, 200, { account })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTION_UPDATE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { accountId, patch } = contributionPatch(await readJson(req))
            json(res, 200, { account: await service.updateContributionAccount(requireAuth(await authenticate(req, service)), accountId, patch) })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTION_REVOKE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { accountId } = exactStrings(await readJson(req), ['accountId'])
            json(res, 200, { account: await service.revokeContributionAccount(requireAuth(await authenticate(req, service)), accountId) })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_INVITES_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const body = await readJson(req)
            if (Object.keys(body).some(key => key !== 'expiresInMs' && key !== 'label')) throw new Error('request contains an unknown field')
            const value = body.expiresInMs === undefined ? undefined : Number(body.expiresInMs)
            if (value !== undefined && !Number.isSafeInteger(value)) throw new Error('expiresInMs must be an integer')
            const label = body.label === undefined
              ? 'Team invitation'
              : exactStrings({ label: body.label }, ['label']).label
            const expires = value ?? config.maxInviteTtlMs ?? 7 * 24 * 60 * 60 * 1000
            json(res, 201, await service.store.createInvite(requireAuth(await authenticate(req, service)), expires, label))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_INVITES_PREVIEW_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { inviteToken } = exactStrings(await readJson(req), ['inviteToken'])
            json(res, 200, await service.store.previewInvite(inviteToken))
          } catch (error: unknown) {
            json(res, statusFor(error), { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_INVITES_REVEAL_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const auth = await authenticate(req, service)
            if (auth === undefined || auth.role !== 'owner') {
              json(res, 403, { error: 'forbidden' })
              return
            }
            const { inviteId } = exactStrings(await readJson(req), ['inviteId'])
            json(res, 200, await service.store.revealInvite(auth, inviteId))
          } catch (error: unknown) {
            if (error instanceof TeamInviteRevealRateLimitError) {
              json(res, 429, { error: error.message }, { 'retry-after': String(error.retryAfterSeconds) })
              return
            }
            const message = safeMessage(error)
            json(res, statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_INVITES_REVOKE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { inviteId } = exactStrings(await readJson(req), ['inviteId'])
            const invite = await service.store.revokeInvite(requireAuth(await authenticate(req, service)), inviteId)
            json(res, 200, { invite })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_JOIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const body = await readJson(req)
            if (Object.keys(body).some(key => key !== 'inviteToken' && key !== 'displayName' && key !== 'apiKey')) {
              throw new Error('request contains an unknown field')
            }
            const { inviteToken } = exactStrings({ inviteToken: body.inviteToken }, ['inviteToken'])
            const displayName = rawNonEmptyString(body, 'displayName')
            if (body.apiKey === undefined) {
              json(res, 201, await service.store.acceptInvite(inviteToken, displayName))
            } else {
              const { apiKey } = exactStrings({ apiKey: body.apiKey }, ['apiKey'])
              json(res, 201, await service.store.acceptInviteWithApiKey(inviteToken, displayName, apiKey))
            }
          } catch (error: unknown) {
            json(res, statusFor(error), { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_MEMBERS_REMOVE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { memberId } = exactStrings(await readJson(req), ['memberId'])
            json(res, 200, await service.removeMember(requireAuth(await authenticate(req, service)), memberId))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_KEYS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { label } = exactStrings(await readJson(req), ['label'])
            json(res, 201, await service.store.issueApiKey(requireAuth(await authenticate(req, service)), label))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CURRENT_KEY_REVOKE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const auth = requireAuth(await authenticate(req, service))
            await service.store.revokeApiKey(auth, auth.keyId)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_MEMBERS_LEAVE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            exactStrings(await readJson(req), [])
            json(res, 200, await service.leaveTeam(requireAuth(await authenticate(req, service))))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_OWNERSHIP_TRANSFER_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { targetMemberId } = exactStrings(await readJson(req), ['targetMemberId'])
            json(res, 200, await service.requestOwnershipTransfer(
              requireAuth(await authenticate(req, service)),
              targetMemberId,
            ))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_OWNERSHIP_TRANSFER_ACCEPT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { transferId } = exactStrings(await readJson(req), ['transferId'])
            json(res, 200, await service.acceptOwnershipTransfer(
              requireAuth(await authenticate(req, service)),
              transferId,
            ))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_OWNERSHIP_TRANSFER_REJECT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { transferId } = exactStrings(await readJson(req), ['transferId'])
            json(res, 200, await service.rejectOwnershipTransfer(
              requireAuth(await authenticate(req, service)),
              transferId,
            ))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_OWNERSHIP_TRANSFER_REVOKE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { transferId } = exactStrings(await readJson(req), ['transferId'])
            json(res, 200, await service.revokeOwnershipTransfer(
              requireAuth(await authenticate(req, service)),
              transferId,
            ))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_KEYS_REVOKE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { keyId } = exactStrings(await readJson(req), ['keyId'])
            await service.store.revokeApiKey(requireAuth(await authenticate(req, service)), keyId)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
    ]
    return async () => {
      for (const dispose of routes) dispose()
    }
  }, 'dsh-codex-shared-pool: Team routes')
}

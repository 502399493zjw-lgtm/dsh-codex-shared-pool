/** Team control-plane HTTP routes. OAuth credentials never cross this boundary. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamService } from './service.ts'
import {
  TEAM_BOOTSTRAP_PATH,
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
  TEAM_KEYS_PATH,
  TEAM_KEYS_REVOKE_PATH,
  TEAM_MEMBERS_LEAVE_PATH,
  TEAM_OWNERSHIP_TRANSFER_PATH,
  TEAM_OVERVIEW_PATH,
  TEAM_STATUS_PATH,
  TEAM_USAGE_PATH,
} from './types.ts'
import type { TeamContributionAccountPatch } from './types.ts'
import type { TeamAuthContext } from './store.ts'
import { safeTeamErrorMessage as safeMessage } from './safe-message.ts'

export interface TeamRouteConfig {
  /** Resolve the Host-only bootstrap secret for each bootstrap operation. */
  resolveBootstrapToken(): Promise<string | undefined>
  maxInviteTtlMs?: number | undefined
}

const MAX_BODY_BYTES = 16 * 1024

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
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

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header === 'string' && /^Bearer\s+\S+$/u.test(header)) return header.slice(7).trim()
  const direct = req.headers['x-dsh-team-key']
  return typeof direct === 'string' && direct.trim().length > 0 ? direct.trim() : undefined
}

function statusFor(error: unknown): number {
  const message = safeMessage(error)
  if (/administrator role|only the key owner|only the owner/iu.test(message)) return 403
  if (/not found|invalid or expired|not active/iu.test(message)) return 404
  if (/already|paused|outside the allowed|waiting for reauthorization|cannot leave|ownership target/iu.test(message)) return 409
  return 400
}

function contributionPatch(value: Record<string, unknown>): { accountId: string; patch: TeamContributionAccountPatch } {
  const accountIdValue = value.accountId
  if (typeof accountIdValue !== 'string' || accountIdValue.trim().length === 0) throw new Error('accountId must be a non-empty string')
  const accountId = accountIdValue.trim()
  const patch: Record<string, unknown> = { ...value }
  delete patch.accountId
  const allowed = new Set(['label', 'status', 'personalReservePercent', 'maxSharedRequestsPerWindow', 'maxSharedConcurrency', 'allowedModels'])
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
            const { teamName, ownerName } = exactStrings(body, ['teamName', 'ownerName'])
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
            json(res, 200, await service.overview(requireAuth(await authenticate(req, service))))
          } catch (error: unknown) {
            json(res, /API key required/iu.test(safeMessage(error)) ? 401 : statusFor(error), { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const { status } = exactStrings(await readJson(req), ['status'])
            if (status !== 'active' && status !== 'paused') throw new Error('status must be active or paused')
            const team = await service.store.setTeamStatus(requireAuth(await authenticate(req, service)), status)
            json(res, 200, { team })
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: TEAM_CONTRIBUTIONS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            json(res, 200, { accounts: await service.listContributionAccounts(requireAuth(await authenticate(req, service))) })
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
            json(res, 200, { events: await service.listUsageEvents(requireAuth(await authenticate(req, service))) })
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
            const { label } = exactStrings(await readJson(req), ['label'])
            json(res, 201, await service.startContributionOAuth(requireAuth(await authenticate(req, service)), label))
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
            const { accountId } = exactStrings(await readJson(req), ['accountId'])
            json(res, 200, { account: await service.cancelContributionOAuth(requireAuth(await authenticate(req, service)), accountId) })
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
            const { accountId } = exactStrings(await readJson(req), ['accountId'])
            json(res, 200, await service.reauthorizeContributionOAuth(requireAuth(await authenticate(req, service)), accountId))
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
            if (Object.keys(body).some(key => key !== 'expiresInMs')) throw new Error('request contains an unknown field')
            const value = body.expiresInMs === undefined ? undefined : Number(body.expiresInMs)
            if (value !== undefined && !Number.isSafeInteger(value)) throw new Error('expiresInMs must be an integer')
            const expires = value ?? config.maxInviteTtlMs ?? 7 * 24 * 60 * 60 * 1000
            json(res, 201, await service.store.createInvite(requireAuth(await authenticate(req, service)), expires))
          } catch (error: unknown) {
            const message = safeMessage(error)
            json(res, /API key required/iu.test(message) ? 401 : statusFor(error), { error: message })
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
            const { inviteToken, displayName } = exactStrings(await readJson(req), ['inviteToken', 'displayName'])
            json(res, 201, await service.store.acceptInvite(inviteToken, displayName))
          } catch (error: unknown) {
            json(res, statusFor(error), { error: safeMessage(error) })
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
            json(res, 200, await service.store.transferOwnership(
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

/** HTTP capability boundary for an out-of-process Team credential broker. */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OpenAICodexUsage } from '../shared/types.ts'
import { normalizeCodexPlan } from '../shared/subscription.ts'
import type {
  TeamCredentialActiveState,
  TeamCredentialAuthorizationState,
  TeamCredentialBroker,
  TeamCredentialRef,
  TeamResponsesForwardRequest,
} from './credentials.ts'
import { safeTeamErrorMessage, safeTeamOAuthErrorMessage } from './safe-message.ts'
import type { TeamCredentialHandoffEnvelope, TeamCredentialHandoffOffer } from './oauth-handoff.ts'
import type {
  TeamContributionStatus,
  TeamOAuthBrokerChallenge,
  TeamOAuthDeviceChallenge,
  TeamOAuthMethod,
} from './types.ts'

export const TEAM_CREDENTIAL_BROKER_PATH_PREFIX = '/v1/dsh-team-credential-broker'
export const TEAM_CREDENTIAL_BROKER_OAUTH_START_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/oauth/start`
export const TEAM_CREDENTIAL_BROKER_OAUTH_RESTART_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/oauth/restart`
export const TEAM_CREDENTIAL_BROKER_OAUTH_CANCEL_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/oauth/cancel`
export const TEAM_CREDENTIAL_BROKER_OAUTH_HANDOFF_COMPLETE_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/oauth/handoff/complete`
export const TEAM_CREDENTIAL_BROKER_AUTHORIZATION_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/authorization`
export const TEAM_CREDENTIAL_BROKER_PROVIDER_ACCOUNT_MATCH_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/provider-account/match`
export const TEAM_CREDENTIAL_BROKER_USAGE_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/usage`
export const TEAM_CREDENTIAL_BROKER_RESPONSES_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/responses`
export const TEAM_CREDENTIAL_BROKER_REVOKE_PATH = `${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}/revoke`

const FORWARD_METADATA_HEADER = 'x-dsh-team-broker-forward'
const UPSTREAM_RESPONSE_HEADER = 'x-dsh-team-broker-upstream'
const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024
const DEFAULT_MAX_FORWARD_BODY_BYTES = 32 * 1024 * 1024
const DEFAULT_JSON_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024
const MAX_INTERNAL_KEY_LENGTH = 4_096
const MAX_FORWARD_METADATA_BYTES = 8 * 1024
const FORWARDED_REQUEST_HEADERS = new Set(['accept', 'openai-beta', 'user-agent'])
const FORWARDED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-type',
  'openai-processing-ms',
  'retry-after',
  'x-request-id',
])

interface ForwardMetadata {
  readonly ref: TeamCredentialRef
  readonly model: string
  readonly sessionId: string
  readonly headers: Readonly<Record<string, string>>
}

interface Monitor {
  readonly cancellation: AbortController
  readonly completion: Promise<void>
}

export interface RemoteTeamCredentialBrokerOptions {
  /** Complete broker URL ending in the fixed protocol path. */
  readonly baseUrl: string
  /** Resolve the current internal key per operation so rotations take effect immediately. */
  readonly resolveApiKey: () => Promise<string | undefined>
  readonly fetch?: typeof fetch
  readonly jsonTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly onStatusChange?: (
    teamId: string,
    accountId: string,
    status: 'active' | 'reauth_required',
    lastError?: string,
    expectedStatus?: TeamContributionStatus,
  ) => Promise<void> | void
  readonly onBackgroundError?: (message: string) => Promise<void> | void
}

export interface TeamCredentialBrokerHttpHandlerOptions {
  readonly broker: TeamCredentialBroker
  /** Resolve the current expected internal key for every request. */
  readonly resolveApiKey: () => Promise<string | undefined>
  readonly maxJsonBodyBytes?: number
  readonly maxForwardBodyBytes?: number
  /** Fixed process-safety guard for the internal service boundary. */
  readonly requestsPerMinute?: number
  /** Fixed process-safety guard shared by OAuth, usage, and streaming calls. */
  readonly maxConcurrency?: number
  readonly now?: () => number
}

type TeamCredentialBrokerHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Validate the one fixed broker protocol origin before an internal key can be sent. */
export function resolveTeamCredentialBrokerBaseUrl(value: string): string {
  if (value.trim().length === 0) throw new Error('Team credential broker base URL is required')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Team credential broker base URL must be an absolute URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Team credential broker base URL must not contain credentials')
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('Team credential broker base URL must not contain a query or fragment')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('Team credential broker base URL must use HTTPS except for loopback development')
  }
  const pathname = url.pathname.replace(/\/+$/u, '')
  if (pathname !== TEAM_CREDENTIAL_BROKER_PATH_PREFIX) {
    throw new Error(`Team credential broker base URL must use the fixed ${TEAM_CREDENTIAL_BROKER_PATH_PREFIX} path`)
  }
  return `${url.origin}${TEAM_CREDENTIAL_BROKER_PATH_PREFIX}`
}

/** Control-plane client that exposes broker capabilities but has no credential export method. */
export class RemoteTeamCredentialBroker implements TeamCredentialBroker {
  private readonly baseUrl: string
  private readonly resolveApiKey: RemoteTeamCredentialBrokerOptions['resolveApiKey']
  private readonly fetch: typeof fetch
  private readonly jsonTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly onStatusChange: NonNullable<RemoteTeamCredentialBrokerOptions['onStatusChange']>
  private readonly onBackgroundError: NonNullable<RemoteTeamCredentialBrokerOptions['onBackgroundError']>
  private readonly monitors = new Map<string, Monitor>()
  private disposed = false

  constructor(options: RemoteTeamCredentialBrokerOptions) {
    this.baseUrl = resolveTeamCredentialBrokerBaseUrl(options.baseUrl)
    this.resolveApiKey = options.resolveApiKey
    this.fetch = options.fetch ?? globalThis.fetch
    this.jsonTimeoutMs = boundedInteger(options.jsonTimeoutMs ?? DEFAULT_JSON_TIMEOUT_MS, 'jsonTimeoutMs', 100, 60_000)
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs', 10, 60_000)
    this.onStatusChange = options.onStatusChange ?? (() => undefined)
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined)
  }

  async startOAuth(
    ref: TeamCredentialRef,
    method: TeamOAuthMethod = 'device_code',
  ): Promise<TeamOAuthBrokerChallenge> {
    const challenge = parseBrokerChallenge(await this.postJson(
      TEAM_CREDENTIAL_BROKER_OAUTH_START_PATH,
      { ...ref, method },
    ), method)
    if (challenge.method === 'device_code') this.ensureMonitor(ref)
    return challenge
  }

  async restartOAuth(
    ref: TeamCredentialRef,
    method: TeamOAuthMethod = 'device_code',
  ): Promise<TeamOAuthBrokerChallenge> {
    await this.stopMonitor(ref)
    const challenge = parseBrokerChallenge(await this.postJson(
      TEAM_CREDENTIAL_BROKER_OAUTH_RESTART_PATH,
      { ...ref, method },
    ), method)
    if (challenge.method === 'device_code') this.ensureMonitor(ref)
    return challenge
  }

  async completeOAuthHandoff(
    ref: TeamCredentialRef,
    envelope: TeamCredentialHandoffEnvelope,
  ): Promise<TeamCredentialActiveState> {
    return parseCredentialActiveState(await this.postJson(
      TEAM_CREDENTIAL_BROKER_OAUTH_HANDOFF_COMPLETE_PATH,
      { ...ref, envelope },
    ))
  }

  async cancelOAuth(ref: TeamCredentialRef): Promise<void> {
    await this.stopMonitor(ref)
    parseOk(await this.postJson(TEAM_CREDENTIAL_BROKER_OAUTH_CANCEL_PATH, ref))
  }

  async inspectAuthorization(ref: TeamCredentialRef): Promise<TeamCredentialAuthorizationState> {
    const state = parseAuthorizationState(await this.postJson(TEAM_CREDENTIAL_BROKER_AUTHORIZATION_PATH, ref))
    if (state.status === 'authorizing') this.ensureMonitor(ref)
    return state
  }

  async matchesProviderAccount(ref: TeamCredentialRef, providerAccountId: string): Promise<boolean> {
    return parseProviderAccountMatch(await this.postJson(
      TEAM_CREDENTIAL_BROKER_PROVIDER_ACCOUNT_MATCH_PATH,
      { ...ref, providerAccountId },
    ))
  }

  async readUsage(ref: TeamCredentialRef, signal?: AbortSignal): Promise<OpenAICodexUsage> {
    return parseUsage(await this.postJson(TEAM_CREDENTIAL_BROKER_USAGE_PATH, ref, signal))
  }

  async forwardResponses(ref: TeamCredentialRef, request: TeamResponsesForwardRequest): Promise<Response> {
    this.assertActive()
    const key = await this.currentApiKey()
    const metadata = encodeForwardMetadata({
      ref: parseCredentialRef(ref),
      model: boundedString(request.model, 'model', 128),
      sessionId: boundedString(request.sessionId, 'session id', 240),
      headers: reduceForwardHeaders(request.headers),
    })
    const response = await this.fetch(TEAM_CREDENTIAL_BROKER_RESPONSES_PATH.replace(TEAM_CREDENTIAL_BROKER_PATH_PREFIX, this.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        [FORWARD_METADATA_HEADER]: metadata,
      },
      body: request.body,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
    if (response.headers.get(UPSTREAM_RESPONSE_HEADER) !== '1') {
      const message = await readRemoteError(response)
      throw new Error(`remote credential broker ${message}`)
    }
    const headers = new Headers(response.headers)
    headers.delete(UPSTREAM_RESPONSE_HEADER)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  async revoke(ref: TeamCredentialRef): Promise<void> {
    await this.stopMonitor(ref)
    parseOk(await this.postJson(TEAM_CREDENTIAL_BROKER_REVOKE_PATH, ref))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const monitors = [...this.monitors.values()]
    for (const monitor of monitors) monitor.cancellation.abort(new Error('remote credential broker disposed'))
    await Promise.allSettled(monitors.map(monitor => monitor.completion))
    this.monitors.clear()
  }

  private async postJson(path: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    this.assertActive()
    const key = await this.currentApiKey()
    const timeout = AbortSignal.timeout(this.jsonTimeoutMs)
    const response = await this.fetch(path.replace(TEAM_CREDENTIAL_BROKER_PATH_PREFIX, this.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    const body = await readBoundedJsonResponse(response)
    if (!response.ok) {
      const message = isRecord(body) && typeof body['error'] === 'string'
        ? safeTeamErrorMessage(body['error'])
        : `request failed with HTTP ${response.status}`
      throw new Error(`remote credential broker ${message}`)
    }
    return body
  }

  private async currentApiKey(): Promise<string> {
    const value = await this.resolveApiKey()
    if (value === undefined || !validInternalApiKey(value)) {
      throw new Error('remote credential broker authentication credential is not configured or invalid')
    }
    return value
  }

  private ensureMonitor(ref: TeamCredentialRef): void {
    if (this.disposed) return
    const key = operationKey(ref)
    if (this.monitors.has(key)) return
    const cancellation = new AbortController()
    const completion = this.monitorAuthorization(ref, cancellation.signal).finally(() => {
      if (this.monitors.get(key)?.cancellation === cancellation) this.monitors.delete(key)
    })
    this.monitors.set(key, { cancellation, completion })
  }

  private async monitorAuthorization(ref: TeamCredentialRef, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await delay(this.pollIntervalMs, signal)
        const state = parseAuthorizationState(await this.postJson(TEAM_CREDENTIAL_BROKER_AUTHORIZATION_PATH, ref, signal))
        if (state.status === 'authorizing') continue
        await this.onStatusChange(
          ref.teamId,
          ref.accountId,
          state.status,
          state.status === 'reauth_required' ? state.lastError : undefined,
          'authorizing',
        )
        return
      } catch (error: unknown) {
        if (signal.aborted) return
        await Promise.resolve(this.onBackgroundError(safeTeamErrorMessage(error))).catch(() => undefined)
      }
    }
  }

  private async stopMonitor(ref: TeamCredentialRef): Promise<void> {
    const monitor = this.monitors.get(operationKey(ref))
    if (monitor === undefined) return
    monitor.cancellation.abort(new Error('remote credential broker monitor stopped'))
    await monitor.completion
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('remote credential broker is disposed')
  }
}

/** Build an authenticated Node HTTP handler around one Host-only broker. */
export function createTeamCredentialBrokerHttpHandler(
  options: TeamCredentialBrokerHttpHandlerOptions,
): TeamCredentialBrokerHttpHandler {
  const maxJsonBodyBytes = boundedInteger(
    options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES,
    'maxJsonBodyBytes',
    1,
    1024 * 1024,
  )
  const maxForwardBodyBytes = boundedInteger(
    options.maxForwardBodyBytes ?? DEFAULT_MAX_FORWARD_BODY_BYTES,
    'maxForwardBodyBytes',
    1,
    64 * 1024 * 1024,
  )
  const guard = new BrokerTrafficGuard(
    boundedInteger(options.requestsPerMinute ?? 600, 'requestsPerMinute', 1, 100_000),
    boundedInteger(options.maxConcurrency ?? 64, 'maxConcurrency', 1, 10_000),
    options.now ?? Date.now,
  )
  return async (req, res) => {
    let release: (() => void) | undefined
    try {
      const path = requestPath(req)
      if (!BROKER_PATHS.has(path)) { writeJson(res, 404, { error: 'not found' }); return }
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
      if (!await authorized(req, options.resolveApiKey)) {
        writeJson(res, 401, { error: 'authentication failed' })
        return
      }
      release = guard.acquire()
      if (release === undefined) {
        writeJson(res, 429, { error: 'internal credential broker rate limit exceeded' })
        return
      }

      if (path === TEAM_CREDENTIAL_BROKER_RESPONSES_PATH) {
        const metadata = parseForwardMetadata(singleHeader(req, FORWARD_METADATA_HEADER))
        const body = await readBody(req, maxForwardBodyBytes)
        assertJsonObject(body)
        const cancellation = new AbortController()
        const onAborted = () => cancellation.abort(new Error('credential broker client disconnected'))
        const onResponseClose = () => {
          if (!res.writableEnded) cancellation.abort(new Error('credential broker client disconnected'))
        }
        req.once('aborted', onAborted)
        res.once('close', onResponseClose)
        try {
          const upstream = await options.broker.forwardResponses(metadata.ref, {
            model: metadata.model,
            sessionId: metadata.sessionId,
            body,
            headers: metadata.headers,
            signal: cancellation.signal,
          })
          res.writeHead(upstream.status, {
            ...forwardResponseHeaders(upstream.headers),
            [UPSTREAM_RESPONSE_HEADER]: '1',
          })
          await pipeResponse(upstream, res, cancellation.signal)
        } finally {
          req.removeListener('aborted', onAborted)
          res.removeListener('close', onResponseClose)
        }
        return
      }

      const cancellation = new AbortController()
      const onDisconnected = () => cancellation.abort(new Error('credential broker client disconnected'))
      const onResponseClose = () => { if (!res.writableEnded) onDisconnected() }
      req.once('aborted', onDisconnected)
      res.once('close', onResponseClose)
      try {
        const body = await readJson(req, maxJsonBodyBytes)
        if (path === TEAM_CREDENTIAL_BROKER_OAUTH_START_PATH) {
          const { ref, method } = parseOAuthRequest(body)
          writeJson(res, 200, parseBrokerChallenge(await options.broker.startOAuth(ref, method), method))
        } else if (path === TEAM_CREDENTIAL_BROKER_OAUTH_RESTART_PATH) {
          const { ref, method } = parseOAuthRequest(body)
          writeJson(res, 200, parseBrokerChallenge(await options.broker.restartOAuth(ref, method), method))
        } else if (path === TEAM_CREDENTIAL_BROKER_OAUTH_HANDOFF_COMPLETE_PATH) {
          const { ref, envelope } = parseHandoffRequest(body)
          writeJson(res, 200, parseCredentialActiveState(await options.broker.completeOAuthHandoff(ref, envelope)))
        } else if (path === TEAM_CREDENTIAL_BROKER_OAUTH_CANCEL_PATH) {
          const ref = parseCredentialRef(body)
          await options.broker.cancelOAuth(ref); writeJson(res, 200, { ok: true })
        } else if (path === TEAM_CREDENTIAL_BROKER_AUTHORIZATION_PATH) {
          const ref = parseCredentialRef(body)
          writeJson(res, 200, parseAuthorizationState(await options.broker.inspectAuthorization(ref)))
        } else if (path === TEAM_CREDENTIAL_BROKER_PROVIDER_ACCOUNT_MATCH_PATH) {
          const { ref, providerAccountId } = parseProviderAccountMatchRequest(body)
          writeJson(res, 200, { matches: parseProviderAccountMatch({
            matches: await options.broker.matchesProviderAccount(ref, providerAccountId),
          }) })
        } else if (path === TEAM_CREDENTIAL_BROKER_USAGE_PATH) {
          const ref = parseCredentialRef(body)
          writeJson(res, 200, parseUsage(await options.broker.readUsage(ref, cancellation.signal)))
        } else if (path === TEAM_CREDENTIAL_BROKER_REVOKE_PATH) {
          const ref = parseCredentialRef(body)
          await options.broker.revoke(ref); writeJson(res, 200, { ok: true })
        }
      } finally {
        req.removeListener('aborted', onDisconnected)
        res.removeListener('close', onResponseClose)
      }
    } catch (error: unknown) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      const status = error instanceof BrokerInputError ? error.status : 502
      writeJson(res, status, {
        error: error instanceof BrokerInputError ? error.message : safeTeamErrorMessage(error),
      })
    } finally {
      release?.()
    }
  }
}

const BROKER_PATHS = new Set([
  TEAM_CREDENTIAL_BROKER_OAUTH_START_PATH,
  TEAM_CREDENTIAL_BROKER_OAUTH_RESTART_PATH,
  TEAM_CREDENTIAL_BROKER_OAUTH_CANCEL_PATH,
  TEAM_CREDENTIAL_BROKER_OAUTH_HANDOFF_COMPLETE_PATH,
  TEAM_CREDENTIAL_BROKER_AUTHORIZATION_PATH,
  TEAM_CREDENTIAL_BROKER_PROVIDER_ACCOUNT_MATCH_PATH,
  TEAM_CREDENTIAL_BROKER_USAGE_PATH,
  TEAM_CREDENTIAL_BROKER_RESPONSES_PATH,
  TEAM_CREDENTIAL_BROKER_REVOKE_PATH,
])

class BrokerInputError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

class BrokerTrafficGuard {
  private windowStartedAt = 0
  private requests = 0
  private concurrent = 0

  constructor(
    private readonly requestsPerMinute: number,
    private readonly maxConcurrency: number,
    private readonly now: () => number,
  ) {}

  acquire(): (() => void) | undefined {
    const observedAt = this.now()
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) return undefined
    if (observedAt - this.windowStartedAt >= 60_000 || observedAt < this.windowStartedAt) {
      this.windowStartedAt = observedAt
      this.requests = 0
    }
    if (this.requests >= this.requestsPerMinute || this.concurrent >= this.maxConcurrency) return undefined
    this.requests += 1
    this.concurrent += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      this.concurrent = Math.max(0, this.concurrent - 1)
    }
  }
}

async function authorized(
  req: IncomingMessage,
  resolveApiKey: () => Promise<string | undefined>,
): Promise<boolean> {
  const header = singleHeader(req, 'authorization', false)
  const presented = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : undefined
  const expected = await resolveApiKey()
  if (presented === undefined || expected === undefined
    || !validInternalApiKey(presented) || !validInternalApiKey(expected)) return false
  const actualDigest = createHash('sha256').update(presented).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualDigest, expectedDigest)
}

function validInternalApiKey(value: string): boolean {
  return value.length >= 16 && value.length <= MAX_INTERNAL_KEY_LENGTH && !/\s/u.test(value)
}

function requestPath(req: IncomingMessage): string {
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://credential-broker.invalid')
  } catch {
    throw new BrokerInputError(400, 'request URL is invalid')
  }
  if (url.search.length > 0 || url.hash.length > 0) throw new BrokerInputError(404, 'not found')
  return url.pathname
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const body = await readBody(req, maxBytes)
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new BrokerInputError(400, 'request body must be valid JSON')
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    throw new BrokerInputError(413, 'request body is too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += bytes.byteLength
    if (total > maxBytes) throw new BrokerInputError(413, 'request body is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseCredentialRef(value: unknown): TeamCredentialRef {
  if (!isRecord(value) || !exactKeys(value, ['teamId', 'accountId'])) {
    throw new BrokerInputError(400, 'credential reference is invalid')
  }
  return {
    teamId: identifier(value['teamId'], 'team id'),
    accountId: identifier(value['accountId'], 'account id'),
  }
}

function parseProviderAccountMatchRequest(value: unknown): {
  ref: TeamCredentialRef
  providerAccountId: string
} {
  if (!isRecord(value) || !exactKeys(value, ['teamId', 'accountId', 'providerAccountId'])) {
    throw new BrokerInputError(400, 'provider-account match request is invalid')
  }
  return {
    ref: parseCredentialRef({ teamId: value['teamId'], accountId: value['accountId'] }),
    providerAccountId: providerAccountId(value['providerAccountId']),
  }
}

function providerAccountId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BrokerInputError(400, 'provider account id is invalid')
  }
  return value
}

function parseProviderAccountMatch(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ['matches']) || typeof value['matches'] !== 'boolean') {
    throw new BrokerInputError(502, 'credential broker returned an invalid provider-account match')
  }
  return value['matches']
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new BrokerInputError(400, `${label} is invalid`)
  }
  return value
}

function parseDeviceChallenge(value: unknown): TeamOAuthDeviceChallenge {
  if (!isRecord(value)
    || !exactKeys(value, ['method', 'verificationUrl', 'userCode', 'expiresAt'])
    || value['method'] !== 'device_code'
    || typeof value['verificationUrl'] !== 'string'
    || typeof value['userCode'] !== 'string'
    || !Number.isSafeInteger(value['expiresAt'])) {
    throw new BrokerInputError(502, 'credential broker returned an invalid OAuth challenge')
  }
  let verificationUrl: URL
  try { verificationUrl = new URL(value['verificationUrl']) } catch {
    throw new BrokerInputError(502, 'credential broker returned an invalid OAuth challenge')
  }
  if (verificationUrl.protocol !== 'https:' || !/^[A-Za-z0-9-]{4,32}$/u.test(value['userCode'])
    || (value['expiresAt'] as number) <= 0) {
    throw new BrokerInputError(502, 'credential broker returned an invalid OAuth challenge')
  }
  return {
    method: 'device_code',
    verificationUrl: verificationUrl.toString(),
    userCode: value['userCode'],
    expiresAt: value['expiresAt'] as number,
  }
}

function parseBrokerChallenge(value: unknown, expectedMethod: TeamOAuthMethod): TeamOAuthBrokerChallenge {
  let challenge: TeamOAuthBrokerChallenge
  if (isRecord(value) && value['method'] === 'browser_handoff') {
    if (!exactKeys(value, ['method', 'handoff'])) {
      throw new BrokerInputError(502, 'credential broker returned an invalid OAuth handoff')
    }
    challenge = { method: 'browser_handoff', handoff: parseHandoffOffer(value['handoff']) }
  } else {
    challenge = parseDeviceChallenge(value)
  }
  if ((expectedMethod === 'browser' && challenge.method !== 'browser_handoff')
    || (expectedMethod === 'device_code' && challenge.method !== 'device_code')) {
    throw new BrokerInputError(502, 'credential broker returned an OAuth challenge for the wrong method')
  }
  return challenge
}

function parseHandoffOffer(value: unknown): TeamCredentialHandoffOffer {
  if (!isRecord(value) || !exactKeys(value, ['version', 'sessionId', 'serverPublicKey', 'expiresAt'])
    || value['version'] !== 1 || !Number.isSafeInteger(value['expiresAt'])
    || (value['expiresAt'] as number) <= 0) {
    throw new BrokerInputError(502, 'credential broker returned an invalid OAuth handoff')
  }
  return {
    version: 1,
    sessionId: handoffSessionId(value['sessionId'], 502),
    serverPublicKey: canonicalBase64Url(value['serverPublicKey'], 'handoff server public key', 44, 44, 502),
    expiresAt: value['expiresAt'] as number,
  }
}

function parseOAuthRequest(value: unknown): { ref: TeamCredentialRef, method: TeamOAuthMethod } {
  if (!isRecord(value) || !exactKeys(value, ['teamId', 'accountId', 'method'])) {
    throw new BrokerInputError(400, 'OAuth request is invalid')
  }
  const method = value['method']
  if (method !== 'browser' && method !== 'device_code') {
    throw new BrokerInputError(400, 'OAuth method is invalid')
  }
  return {
    ref: parseCredentialRef({ teamId: value['teamId'], accountId: value['accountId'] }),
    method,
  }
}

function parseHandoffRequest(value: unknown): { ref: TeamCredentialRef, envelope: TeamCredentialHandoffEnvelope } {
  if (!isRecord(value) || !exactKeys(value, ['teamId', 'accountId', 'envelope'])) {
    throw new BrokerInputError(400, 'OAuth handoff request is invalid')
  }
  const envelope = value['envelope']
  if (!isRecord(envelope)
    || !exactKeys(envelope, ['version', 'sessionId', 'clientPublicKey', 'iv', 'ciphertext', 'tag'])
    || envelope['version'] !== 1) {
    throw new BrokerInputError(400, 'OAuth handoff envelope is invalid')
  }
  return {
    ref: parseCredentialRef({ teamId: value['teamId'], accountId: value['accountId'] }),
    envelope: {
      version: 1,
      sessionId: handoffSessionId(envelope['sessionId'], 400),
      clientPublicKey: canonicalBase64Url(envelope['clientPublicKey'], 'handoff client public key', 44, 44, 400),
      iv: canonicalBase64Url(envelope['iv'], 'handoff iv', 12, 12, 400),
      ciphertext: canonicalBase64Url(envelope['ciphertext'], 'handoff ciphertext', 1, 128 * 1024, 400),
      tag: canonicalBase64Url(envelope['tag'], 'handoff tag', 16, 16, 400),
    },
  }
}

function parseAuthorizationState(value: unknown): TeamCredentialAuthorizationState {
  if (!isRecord(value)) {
    throw new BrokerInputError(502, 'credential broker returned an invalid authorization state')
  }
  if (value['status'] === 'authorizing' && exactKeys(value, ['status'])) return { status: 'authorizing' }
  if (value['status'] === 'active') {
    const accountLabel = value['accountLabel']
    const keys = accountLabel === undefined ? ['status'] : ['status', 'accountLabel']
    if (!exactKeys(value, keys)
      || (accountLabel !== undefined && !validAccountLabel(accountLabel))) {
      throw new BrokerInputError(502, 'credential broker returned an invalid authorization state')
    }
    return accountLabel === undefined
      ? { status: 'active' }
      : { status: 'active', accountLabel: accountLabel.trim() }
  }
  const lastError = value['lastError']
  if (value['status'] !== 'reauth_required'
    || !exactKeys(value, lastError === undefined ? ['status'] : ['status', 'lastError'])
    || (lastError !== undefined && (typeof lastError !== 'string' || lastError.length > 500))) {
    throw new BrokerInputError(502, 'credential broker returned an invalid authorization state')
  }
  return typeof lastError === 'string'
    ? { status: 'reauth_required', lastError: safeTeamOAuthErrorMessage(lastError) }
    : { status: 'reauth_required' }
}

function parseCredentialActiveState(value: unknown): TeamCredentialActiveState {
  const state = parseAuthorizationState(value)
  if (state.status !== 'active' || state.accountLabel === undefined) {
    throw new BrokerInputError(502, 'credential broker returned a non-active handoff result')
  }
  return { status: 'active', accountLabel: state.accountLabel }
}

function parseUsage(value: unknown): OpenAICodexUsage {
  if (!isRecord(value) || !Array.isArray(value['rateLimits']) || value['rateLimits'].length > 32) {
    throw new BrokerInputError(502, 'credential broker returned invalid usage metadata')
  }
  const rateLimits = value['rateLimits'].map((limit): OpenAICodexUsage['rateLimits'][number] => {
    if (!isRecord(limit) || typeof limit['id'] !== 'string' || limit['id'].length === 0 || limit['id'].length > 128
      || !Array.isArray(limit['windows']) || limit['windows'].length > 8) {
      throw new BrokerInputError(502, 'credential broker returned invalid usage metadata')
    }
    const name = limit['name']
    if (name !== undefined && (typeof name !== 'string' || name.length > 128)) {
      throw new BrokerInputError(502, 'credential broker returned invalid usage metadata')
    }
    const windows = limit['windows'].map((window): OpenAICodexUsage['rateLimits'][number]['windows'][number] => {
      if (!isRecord(window) || typeof window['remainingPercent'] !== 'number'
        || !Number.isFinite(window['remainingPercent']) || window['remainingPercent'] < 0 || window['remainingPercent'] > 100
        || !Number.isSafeInteger(window['windowSeconds']) || (window['windowSeconds'] as number) <= 0) {
        throw new BrokerInputError(502, 'credential broker returned invalid usage metadata')
      }
      const resetsAt = window['resetsAt']
      if (resetsAt !== undefined && (!Number.isSafeInteger(resetsAt) || (resetsAt as number) <= 0)) {
        throw new BrokerInputError(502, 'credential broker returned invalid usage metadata')
      }
      return {
        remainingPercent: window['remainingPercent'],
        windowSeconds: window['windowSeconds'] as number,
        ...typeof resetsAt === 'number' ? { resetsAt } : {},
      }
    })
    return { id: limit['id'], ...typeof name === 'string' ? { name } : {}, windows }
  })
  const credits = parseCredits(value['credits'])
  const individualLimit = parseIndividualLimit(value['individualLimit'])
  const planType = normalizeCodexPlan(value['planType'])
  return {
    ...planType === undefined ? {} : { planType },
    rateLimits,
    ...credits === undefined ? {} : { credits },
    ...individualLimit === undefined ? {} : { individualLimit },
  }
}

function parseCredits(value: unknown): OpenAICodexUsage['credits'] {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value['unlimited'] !== 'boolean') {
    throw new BrokerInputError(502, 'credential broker returned invalid credit metadata')
  }
  const balance = value['balance']
  if (balance !== undefined && !validAmount(balance)) {
    throw new BrokerInputError(502, 'credential broker returned invalid credit metadata')
  }
  return { unlimited: value['unlimited'], ...typeof balance === 'string' ? { balance } : {} }
}

function parseIndividualLimit(value: unknown): OpenAICodexUsage['individualLimit'] {
  if (value === undefined) return undefined
  if (!isRecord(value) || !validAmount(value['limit']) || !validAmount(value['used'])
    || !validAmount(value['remaining']) || typeof value['remainingPercent'] !== 'number'
    || !Number.isFinite(value['remainingPercent']) || value['remainingPercent'] < 0 || value['remainingPercent'] > 100) {
    throw new BrokerInputError(502, 'credential broker returned invalid individual-limit metadata')
  }
  return {
    limit: value['limit'],
    used: value['used'],
    remaining: value['remaining'],
    remainingPercent: value['remainingPercent'],
  }
}

function validAmount(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^-?\d+(?:\.\d+)?$/u.test(value)
}

function encodeForwardMetadata(value: ForwardMetadata): string {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.byteLength > MAX_FORWARD_METADATA_BYTES) throw new Error('remote credential broker metadata is too large')
  return bytes.toString('base64url')
}

function parseForwardMetadata(value: string | undefined): ForwardMetadata {
  if (value === undefined || value.length === 0 || value.length > Math.ceil(MAX_FORWARD_METADATA_BYTES * 4 / 3)) {
    throw new BrokerInputError(400, 'Responses forwarding metadata is invalid')
  }
  let parsed: unknown
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value || bytes.byteLength > MAX_FORWARD_METADATA_BYTES) throw new Error('invalid encoding')
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new BrokerInputError(400, 'Responses forwarding metadata is invalid')
  }
  if (!isRecord(parsed)) throw new BrokerInputError(400, 'Responses forwarding metadata is invalid')
  return {
    ref: parseCredentialRef(parsed['ref']),
    model: boundedString(parsed['model'], 'model', 128),
    sessionId: boundedString(parsed['sessionId'], 'session id', 240),
    headers: reduceForwardHeaders(parsed['headers']),
  }
}

function reduceForwardHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [name, header] of Object.entries(value)) {
    const normalized = name.toLowerCase()
    if (FORWARDED_REQUEST_HEADERS.has(normalized) && typeof header === 'string'
      && header.length <= 1024 && !/[\r\n]/u.test(header)) result[normalized] = header
  }
  return result
}

function forwardResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  for (const [name, value] of headers) {
    if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase()) && !/[\r\n]/u.test(value)) result[name] = value
  }
  return result
}

async function pipeResponse(response: Response, res: ServerResponse, signal: AbortSignal): Promise<void> {
  if (response.body === null) { res.end(); return }
  const reader = response.body.getReader()
  let completed = false
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (signal.aborted) throw signal.reason
      if (done) { completed = true; break }
      if (!res.write(value)) await waitForDrain(res, signal)
    }
    res.end()
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!completed) await reader.cancel(signal.reason).catch(() => undefined)
    reader.releaseLock()
  }
}

function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.removeListener('drain', onDrain); signal.removeEventListener('abort', onAbort) }
    const onDrain = () => { cleanup(); resolve() }
    const onAbort = () => { cleanup(); reject(signal.reason) }
    res.once('drain', onDrain)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const text = await readBoundedResponseText(response, MAX_JSON_RESPONSE_BYTES)
  try { return JSON.parse(text) as unknown } catch {
    throw new Error('remote credential broker returned unreadable JSON')
  }
}

async function readRemoteError(response: Response): Promise<string> {
  let body: unknown
  try { body = await readBoundedJsonResponse(response) } catch { body = undefined }
  if (isRecord(body) && typeof body['error'] === 'string') return safeTeamErrorMessage(body['error'])
  return `request failed with HTTP ${response.status}`
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('remote credential broker response is too large')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('remote credential broker response is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseOk(value: unknown): void {
  if (!isRecord(value) || value['ok'] !== true) throw new Error('remote credential broker returned an invalid acknowledgement')
}

function assertJsonObject(value: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown } catch {
    throw new BrokerInputError(400, 'Responses body must be valid JSON')
  }
  if (!isRecord(parsed)) throw new BrokerInputError(400, 'Responses body must be a JSON object')
}

function singleHeader(req: IncomingMessage, name: string, required = true): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) throw new BrokerInputError(400, `${name} header is invalid`)
  if (value === undefined && required) throw new BrokerInputError(400, `${name} header is required`)
  return value
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || /[\r\n]/u.test(value)) {
    throw new BrokerInputError(400, `${label} is invalid`)
  }
  return value
}

function handoffSessionId(value: unknown, status: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value)) {
    throw new BrokerInputError(status, 'handoff session id is invalid')
  }
  return value
}

function canonicalBase64Url(
  value: unknown,
  label: string,
  minBytes: number,
  maxBytes: number,
  status: number,
): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new BrokerInputError(status, `${label} is invalid`)
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength < minBytes || decoded.byteLength > maxBytes || decoded.toString('base64url') !== value) {
    throw new BrokerInputError(status, `${label} is invalid`)
  }
  return value
}

function validAccountLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\r\n]/u.test(value)
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function operationKey(ref: TeamCredentialRef): string {
  return `${ref.teamId}:${ref.accountId}`
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    const onAbort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
}

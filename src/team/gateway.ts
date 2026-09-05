import { TEAM_LIMIT_REASONS_HEADER, teamLimitReasonsHeader } from './gateway-errors.ts'
/** Authenticated Codex Responses gateway backed by Team contribution accounts. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { zstdDecompressSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamResponsesForwardRequest } from './credentials.ts'
import { parseTeamProviderTokenUsage } from './credits.ts'
import type { TeamProviderTokenUsage } from './credits.ts'
import { TeamRouteCapacityError } from './routing.ts'
import type { TeamRouteLease, TeamRouteSettleResult } from './routing.ts'
import type { TeamService } from './service.ts'
import { PostgresTeamStore } from './postgres-store.ts'
import {
  MemoryTeamTrafficGuard,
  PostgresTeamTrafficGuard,
  TeamTrafficGuardError,
} from './traffic-guard.ts'
import type {
  TeamTrafficGuard,
  TeamTrafficLease,
  TeamTrafficResult,
} from './traffic-guard.ts'
import { unwrapTeamCodexBearer } from './client.ts'
import { TEAM_CODEX_RESPONSES_PATH, TEAM_RESPONSES_PATH } from './types.ts'

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024
const DEFAULT_HEARTBEAT_MS = 60_000
const DEFAULT_MAX_UPSTREAM_ATTEMPTS = 8
const MAX_MODEL_LENGTH = 128
const MAX_SESSION_ID_LENGTH = 240
const MAX_USAGE_JSON_BYTES = 256 * 1024
const MAX_USAGE_SSE_LINE_CHARS = 64 * 1024
const MAX_USAGE_SSE_EVENT_CHARS = 128 * 1024

export interface TeamGatewayOptions {
  readonly maxBodyBytes?: number
  readonly heartbeatMs?: number
  /** Fixed safety guard, intentionally not configurable per member. */
  readonly requestsPerMinutePerKey?: number
  /** Fixed safety guard, intentionally not configurable per member. */
  readonly maxConcurrencyPerKey?: number
  readonly failureThreshold?: number
  readonly circuitOpenMs?: number
  readonly trafficLeaseTtlMs?: number
  /** Fixed anti-amplification guard for one external request's hard-limit failover chain. */
  readonly maxUpstreamAttemptsPerRequest?: number
  /** Host-only test/adapter seam; never sourced from browser configuration. */
  readonly trafficGuard?: TeamTrafficGuard
  readonly now?: () => number
  readonly id?: () => string
}

type TeamGatewayHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Build the route handler independently so streaming behavior is testable. */
export function createTeamGatewayHandler(
  service: TeamService,
  options: TeamGatewayOptions = {},
): TeamGatewayHandler {
  const maxBodyBytes = boundedInteger(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 'maxBodyBytes', 1024, 64 * 1024 * 1024)
  const heartbeatMs = boundedInteger(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, 'heartbeatMs', 1_000, 5 * 60_000)
  const id = options.id ?? randomUUID
  const maxUpstreamAttempts = boundedInteger(
    options.maxUpstreamAttemptsPerRequest ?? DEFAULT_MAX_UPSTREAM_ATTEMPTS,
    'maxUpstreamAttemptsPerRequest',
    1,
    32,
  )
  const trafficOptions = {
    requestsPerMinute: boundedInteger(options.requestsPerMinutePerKey ?? 60, 'requestsPerMinutePerKey', 1, 10_000),
    maxConcurrency: boundedInteger(options.maxConcurrencyPerKey ?? 4, 'maxConcurrencyPerKey', 1, 1_000),
    failureThreshold: boundedInteger(options.failureThreshold ?? 8, 'failureThreshold', 1, 100),
    circuitOpenMs: boundedInteger(options.circuitOpenMs ?? 60_000, 'circuitOpenMs', 1_000, 60 * 60_000),
    leaseTtlMs: boundedInteger(
      options.trafficLeaseTtlMs ?? Math.max(heartbeatMs * 3, 60_000),
      'trafficLeaseTtlMs',
      10_000,
      30 * 60_000,
    ),
    now: options.now ?? Date.now,
    id,
  }
  const traffic = options.trafficGuard ?? (service.store instanceof PostgresTeamStore
    ? new PostgresTeamTrafficGuard({ pool: service.store.pool, ...trafficOptions })
    : new MemoryTeamTrafficGuard(trafficOptions))

  return async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
    const token = teamToken(req)
    if (token === undefined) { writeJson(res, 401, { error: 'Team API key required' }); return }
    const auth = await service.store.authenticateApiKey(token)
    if (auth === undefined) { writeJson(res, 401, { error: 'invalid Team API key' }); return }

    let trafficLease: TeamTrafficLease
    try {
      trafficLease = await traffic.acquire(auth.keyId)
    } catch (error: unknown) {
      if (error instanceof TeamTrafficGuardError) {
        const headers = {
          [TEAM_LIMIT_REASONS_HEADER]: teamLimitReasonsHeader([error.reason]),
          ...(error.retryAfterSeconds === undefined ? {} : { 'retry-after': String(error.retryAfterSeconds) }),
        }
        writeJson(res, error.status, { error: error.message, code: error.code }, headers)
        return
      }
      writeJson(res, 503, { error: 'Team traffic guard is unavailable' })
      return
    }

    let admitted: Awaited<ReturnType<TeamService['admitLiveRequest']>> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let responseStarted = false
    const abort = new AbortController()
    let trafficResult: TeamTrafficResult = 'neutral'
    let providerAttempted = false
    const onAborted = () => { abort.abort(new Error('client aborted')) }
    const onResponseClose = () => {
      if (!res.writableEnded) abort.abort(new Error('client disconnected'))
    }
    req.once('aborted', onAborted)
    res.once('close', onResponseClose)
    try {
      heartbeat = setInterval(() => {
        const renewals: Array<Promise<void>> = [trafficLease.renew()]
        if (admitted !== undefined) renewals.push(service.renewRequest(admitted.lease))
        void Promise.all(renewals).catch((error: unknown) => { abort.abort(error) })
      }, heartbeatMs)
      heartbeat.unref?.()
      const { text, body } = await readRequest(req, maxBodyBytes)
      abort.signal.throwIfAborted()
      const model = boundedString(body['model'], 'model', MAX_MODEL_LENGTH)
      const sessionId = resolveSessionId(req, body, id)
      const excludedAccountIds = new Set<string>()
      let upstreamAttempts = 0
      while (true) {
        admitted = await service.admitLiveRequest(auth, {
          sessionId,
          model,
          excludedAccountIds: [...excludedAccountIds],
        })

        const forward: TeamResponsesForwardRequest = {
          model,
          sessionId,
          body: text,
          headers: compatibilityHeaders(req),
          signal: abort.signal,
        }
        providerAttempted = true
        upstreamAttempts += 1
        const upstream = await service.broker.forwardResponses({
          teamId: admitted.account.teamId,
          accountId: admitted.account.id,
        }, forward)
        if (isHardCapacityStatus(upstream.status)) {
          const failed = admitted
          excludedAccountIds.add(failed.account.id)
          service.invalidateCapacity(failed.account.teamId, failed.account.id)
          await discardResponse(upstream)
          await settle(service, failed.lease, 'error')
          admitted = undefined
          await service.router.unbindSession(
            failed.account.teamId,
            auth.memberId,
            sessionId,
            failed.account.id,
          )
          if (upstreamAttempts >= maxUpstreamAttempts) {
            throw new TeamRouteCapacityError('Team failover attempt limit reached', [
              'upstream_hard_limit',
              'failover_attempt_limit',
            ])
          }
          continue
        }
        trafficResult = upstream.status >= 500 ? 'failure' : 'success'
        responseStarted = true
        res.writeHead(upstream.status, responseHeaders(upstream.headers))
        const usage = await pipeResponse(upstream, res, abort.signal)
        await settle(service, admitted.lease, upstream.ok ? 'success' : 'error', usage)
        admitted = undefined
        break
      }
    } catch (error: unknown) {
      if (providerAttempted && !abort.signal.aborted) trafficResult = 'failure'
      if (admitted !== undefined) {
        const result: TeamRouteSettleResult = abort.signal.aborted ? 'cancelled' : 'error'
        await settle(service, admitted.lease, result).catch(() => undefined)
        admitted = undefined
      }
      if (responseStarted || abort.signal.aborted) {
        if (!res.writableEnded) res.end()
        return
      }
      if (error instanceof TeamRouteCapacityError) {
        writeJson(res, 429, { error: 'no Team capacity is available', code: error.code, reasons: error.reasons }, {
          [TEAM_LIMIT_REASONS_HEADER]: teamLimitReasonsHeader([...(providerAttempted ? ['upstream_hard_limit'] : []), ...error.reasons]),
        })
        return
      }
      if (error instanceof ClientInputError) {
        writeJson(res, error.status, { error: error.message })
        return
      }
      writeJson(res, 502, { error: 'Team upstream request failed' })
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      req.removeListener('aborted', onAborted)
      res.removeListener('close', onResponseClose)
      await trafficLease.finish(trafficResult).catch(() => undefined)
    }
  }
}

/** Register generic and Codex-native aliases through the public Host web service. */
export function registerTeamGatewayRoute(
  ctx: Context,
  service: TeamService,
  options: TeamGatewayOptions = {},
): void {
  const handler = createTeamGatewayHandler(service, options)
  ctx.effect(() => {
    const disposeResponses = ctx.webServer.register({ kind: 'exact', path: TEAM_RESPONSES_PATH, handler })
    const disposeCodexResponses = ctx.webServer.register({ kind: 'exact', path: TEAM_CODEX_RESPONSES_PATH, handler })
    return () => {
      disposeCodexResponses()
      disposeResponses()
    }
  })
}

class ClientInputError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function readRequest(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<{ text: string; body: Record<string, unknown> }> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new ClientInputError(415, 'content-type must be application/json')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += data.byteLength
    if (total > maxBodyBytes) throw new ClientInputError(413, 'request body is too large')
    chunks.push(data)
  }
  const encoded = Buffer.concat(chunks)
  const contentEncoding = req.headers['content-encoding']
  if (contentEncoding !== undefined && contentEncoding !== 'identity' && contentEncoding !== 'zstd') {
    throw new ClientInputError(415, 'content-encoding must be identity or zstd')
  }
  let bytes: Buffer
  try {
    bytes = contentEncoding === 'zstd' ? zstdDecompressSync(encoded) : encoded
  } catch {
    throw new ClientInputError(400, 'request body has invalid zstd encoding')
  }
  if (bytes.byteLength > maxBodyBytes) throw new ClientInputError(413, 'decompressed request body is too large')
  const text = bytes.toString('utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ClientInputError(400, 'request body must be valid JSON')
  }
  if (!isRecord(value)) throw new ClientInputError(400, 'request body must be an object')
  return { text, body: value }
}

function resolveSessionId(
  req: IncomingMessage,
  body: Record<string, unknown>,
  id: () => string,
): string {
  for (const candidate of [
    req.headers['session-id'],
    req.headers['thread-id'],
    req.headers['x-client-request-id'],
    body['prompt_cache_key'],
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return boundedString(candidate, 'session id', MAX_SESSION_ID_LENGTH)
    }
  }
  return boundedString(id(), 'session id', MAX_SESSION_ID_LENGTH)
}

function compatibilityHeaders(req: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of ['accept', 'openai-beta', 'user-agent']) {
    const value = req.headers[name]
    if (typeof value === 'string' && value.length <= 1024 && !/[\r\n]/u.test(value)) result[name] = value
  }
  return result
}

function responseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  for (const name of ['content-type', 'content-length', 'x-request-id', 'openai-processing-ms']) {
    const value = headers.get(name)
    if (value !== null) result[name] = value
  }
  return result
}

async function pipeResponse(
  response: Response,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<TeamProviderTokenUsage | undefined> {
  const observer = new ProviderUsageObserver(response.headers.get('content-type'))
  if (response.body === null) { res.end(); return observer.finish() }
  const reader = response.body.getReader()
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      observer.observe(value)
      if (!res.write(value)) await waitForDrain(res, signal)
    }
    res.end()
    return observer.finish()
  } finally {
    reader.releaseLock()
  }
}

/**
 * Bounded, Host-only observer for the numeric `usage` subset of Responses
 * payloads. It never changes forwarded bytes and never retains provider content
 * after the request settles.
 */
class ProviderUsageObserver {
  private readonly mode: 'sse' | 'json' | 'none'
  private readonly decoder = new TextDecoder()
  private readonly jsonChunks: Uint8Array[] = []
  private jsonBytes = 0
  private jsonOverflow = false
  private sseLine = ''
  private sseDiscardLine = false
  private readonly sseEventData: string[] = []
  private sseEventChars = 0
  private sseDiscardEvent = false
  private latest: TeamProviderTokenUsage | undefined

  constructor(contentType: string | null) {
    const normalized = contentType?.toLowerCase() ?? ''
    this.mode = normalized.includes('text/event-stream')
      ? 'sse'
      : normalized.includes('application/json')
        ? 'json'
        : 'none'
  }

  observe(value: Uint8Array): void {
    if (this.mode === 'sse') {
      this.consumeSseText(this.decoder.decode(value, { stream: true }))
      return
    }
    if (this.mode !== 'json' || this.jsonOverflow) return
    if (this.jsonBytes + value.byteLength > MAX_USAGE_JSON_BYTES) {
      this.jsonChunks.length = 0
      this.jsonOverflow = true
      return
    }
    this.jsonBytes += value.byteLength
    this.jsonChunks.push(value.slice())
  }

  finish(): TeamProviderTokenUsage | undefined {
    if (this.mode === 'sse') {
      this.consumeSseText(this.decoder.decode(), true)
      this.flushSseEvent()
      return this.latest
    }
    if (this.mode !== 'json' || this.jsonOverflow) return undefined
    try {
      const payload = JSON.parse(Buffer.concat(this.jsonChunks.map(chunk => Buffer.from(chunk))).toString('utf8')) as unknown
      return usageFromPayload(payload)
    } catch {
      return undefined
    }
  }

  private consumeSseText(text: string, final = false): void {
    let cursor = 0
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor)
      const end = newline === -1 ? text.length : newline
      const piece = text.slice(cursor, end)
      if (!this.sseDiscardLine) {
        if (this.sseLine.length + piece.length <= MAX_USAGE_SSE_LINE_CHARS) {
          this.sseLine += piece
        } else {
          this.sseLine = ''
          this.sseDiscardLine = true
        }
      }
      if (newline === -1) break
      if (!this.sseDiscardLine) this.consumeSseLine(this.sseLine.endsWith('\r') ? this.sseLine.slice(0, -1) : this.sseLine)
      this.sseLine = ''
      this.sseDiscardLine = false
      cursor = newline + 1
    }
    if (final) {
      if (!this.sseDiscardLine && this.sseLine.length > 0) {
        this.consumeSseLine(this.sseLine.endsWith('\r') ? this.sseLine.slice(0, -1) : this.sseLine)
      }
      this.sseLine = ''
      this.sseDiscardLine = false
    }
  }

  private consumeSseLine(line: string): void {
    if (line.length === 0) {
      this.flushSseEvent()
      return
    }
    if (!line.startsWith('data:') || this.sseDiscardEvent) return
    const data = line.slice(5).replace(/^ /u, '')
    if (this.sseEventChars + data.length > MAX_USAGE_SSE_EVENT_CHARS) {
      this.sseEventData.length = 0
      this.sseEventChars = 0
      this.sseDiscardEvent = true
      return
    }
    this.sseEventData.push(data)
    this.sseEventChars += data.length
  }

  private flushSseEvent(): void {
    if (!this.sseDiscardEvent && this.sseEventData.length > 0) {
      const data = this.sseEventData.join('\n')
      if (data !== '[DONE]') {
        try {
          this.latest = usageFromPayload(JSON.parse(data) as unknown) ?? this.latest
        } catch {
          // Provider content and malformed metadata are deliberately ignored.
        }
      }
    }
    this.sseEventData.length = 0
    this.sseEventChars = 0
    this.sseDiscardEvent = false
  }
}

function usageFromPayload(value: unknown): TeamProviderTokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const direct = parseTeamProviderTokenUsage(value['usage'])
  if (direct !== undefined) return direct
  const response = value['response']
  return isRecord(response) ? parseTeamProviderTokenUsage(response['usage']) : undefined
}

function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = () => { cleanup(); resolve() }
    const onAbort = () => { cleanup(); reject(signal.reason) }
    res.once('drain', onDrain)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function settle(
  service: TeamService,
  lease: TeamRouteLease,
  result: TeamRouteSettleResult,
  usage?: TeamProviderTokenUsage,
): Promise<void> {
  await service.settleRequest(lease, result, usage)
}

function isHardCapacityStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

function teamToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && /^Bearer\s+\S+$/u.test(authorization)) {
    const bearer = authorization.slice(7).trim()
    return unwrapTeamCodexBearer(bearer) ?? bearer
  }
  const direct = req.headers['x-dsh-team-key']
  return typeof direct === 'string' && direct.trim().length > 0 ? direct.trim() : undefined
}

function writeJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(JSON.stringify(value))
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ClientInputError(400, `${field} must be a string`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength || /[\r\n]/u.test(normalized)) {
    throw new ClientInputError(400, `${field} is invalid`)
  }
  return normalized
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} is outside the allowed range`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

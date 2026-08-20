/** Narrow Codex app-server adapter for account identity and rate limits. */

import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { CodexAccountQuota } from './types.ts'

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`codex-quota: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`codex-quota: app-server returned invalid ${label}`)
  }
  return value
}

function accountName(account: JsonObject, displayName: string | undefined): string {
  if (account.type === 'chatgpt') {
    if (displayName !== undefined) return displayName
    const email = account.email
    if (typeof email === 'string' && email.trim().length > 0) return email.trim()
    return 'ChatGPT'
  }
  if (account.type === 'apiKey') return 'API Key'
  if (account.type === 'amazonBedrock') return 'Amazon Bedrock'
  throw new Error('codex-quota: app-server returned an unknown account type')
}

function codexRateLimits(response: JsonObject): JsonObject {
  const byId = response.rateLimitsByLimitId
  if (byId !== null && typeof byId === 'object' && !Array.isArray(byId)) {
    const codex = (byId as JsonObject).codex
    if (codex !== undefined) return object(codex, 'Codex rate-limit bucket')
  }
  return object(response.rateLimits, 'rate limits')
}

/**
 * Validate and reduce app-server account responses to display-safe fields.
 * @param accountResponse - Unknown JSON-RPC result from `account/read`.
 * @param rateLimitsResponse - Unknown JSON-RPC result from `account/rateLimits/read`.
 * @param displayName - Optional Host-only OAuth display name using the Settings precedence.
 * @returns Validated account label, remaining percentage, and reset instant.
 */
export function projectCodexAccountQuota(
  accountResponse: unknown,
  rateLimitsResponse: unknown,
  displayName?: string,
): CodexAccountQuota {
  const account = object(object(accountResponse, 'account/read response').account, 'account')
  const limits = codexRateLimits(object(rateLimitsResponse, 'account/rateLimits/read response'))
  const primary = object(limits.primary, 'primary rate-limit window')
  const usedPercent = finiteNumber(primary.usedPercent, 'primary usedPercent')
  const resetsAt = primary.resetsAt
  if (resetsAt !== null && resetsAt !== undefined
    && (!Number.isSafeInteger(resetsAt) || (resetsAt as number) < 0)) {
    throw new Error('codex-quota: app-server returned invalid primary resetsAt')
  }
  return Object.freeze({
    accountName: accountName(account, displayName),
    remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - usedPercent))),
    resetsAt: typeof resetsAt === 'number' ? resetsAt * 1_000 : null,
  })
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** One initialized app-server connection with only quota-related operations. */
export class CodexQuotaAppServerWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private readonly input: Readable
  private readonly output: Writable
  private closed = false

  constructor(input: Readable, output: Writable) {
    this.input = input
    this.output = output
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method) => {
      const error = new Error(`codex-quota: unsupported app-server request ${JSON.stringify(method)}`)
      this.fatal.reject(error)
      return Promise.reject(error)
    })
    this.transport.onNotification(() => {})
    input.on('error', this.onInputError)
    input.on('end', this.onInputEnd)
    output.on('error', this.onOutputError)
  }

  /** Start decoding newline-delimited JSON-RPC frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Perform the Codex app-server initialize handshake.
   * @param signal - Abort signal bounding the protocol request.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: {
        name: 'dsh-codex-shared-pool',
        title: 'DSH Codex Shared Pool',
        version: '0.1.0-alpha.0',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }, signal)), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush())
  }

  /**
   * Read the active account and its current Codex primary-window quota.
   * @param signal - Abort signal bounding both protocol requests.
   * @param displayName - Optional Host-only OAuth display name using the Settings precedence.
   * @returns Display-safe account quota fields.
   */
  async read(signal: AbortSignal, displayName?: string): Promise<CodexAccountQuota> {
    const account = await this.guarded(this.transport.request(
      'account/read',
      { refreshToken: false },
      signal,
    ))
    const rateLimits = await this.guarded(this.transport.request(
      'account/rateLimits/read',
      {},
      signal,
    ))
    return projectCodexAccountQuota(account, rateLimits, displayName)
  }

  /** Detach protocol listeners and reject outstanding operations. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.output.off('error', this.onOutputError)
  }

  private guarded<T>(pending: Promise<T>): Promise<T> {
    return Promise.race([pending, this.fatal.promise])
  }

  private readonly onInputError = (error: Error): void => {
    this.fatal.reject(error)
  }

  private readonly onInputEnd = (): void => {
    this.fatal.reject(new Error('codex-quota: app-server protocol stream closed'))
  }

  private readonly onOutputError = (error: Error): void => {
    this.fatal.reject(thrown(error))
  }
}

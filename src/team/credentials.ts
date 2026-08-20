/** Host-only credential broker boundary for Team contribution accounts. */

import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { loginOpenAICodexProfile } from '../auth.ts'
import { OPENAI_CODEX_RESPONSES_URL } from '../responses.ts'
import { OPENAI_CODEX_PROVIDER, OpenAICodexCredentialStore, openAICodexAuthPath } from '../store.ts'
import type { OpenAICodexProfileStore } from '../store.ts'
import { readOpenAICodexRateLimits } from '../usage.ts'
import type { OpenAICodexUsage } from '../usage.ts'
import { safeTeamErrorMessage } from './safe-message.ts'
import type { TeamContributionStatus, TeamOAuthDeviceChallenge } from './types.ts'

export interface TeamCredentialRef {
  readonly teamId: string
  readonly accountId: string
}

export interface TeamResponsesForwardRequest {
  readonly model: string
  readonly sessionId: string
  readonly body: string
  /** Already-reduced compatibility headers; authorization is always discarded. */
  readonly headers: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** Secret-free result used to reconcile persisted control-plane state. */
export interface TeamCredentialAuthorizationState {
  /** Remote brokers may still own an OAuth operation after the Team Host restarts. */
  readonly status: 'authorizing' | 'active' | 'reauth_required'
  readonly lastError?: string
}

export interface TeamCredentialBroker {
  /** Start an isolated device-code login and return no provider credential. */
  startOAuth(ref: TeamCredentialRef): Promise<TeamOAuthDeviceChallenge>
  /** Replace this contribution's isolated stale credential and start device login again. */
  restartOAuth(ref: TeamCredentialRef): Promise<TeamOAuthDeviceChallenge>
  /** Cancel an in-flight OAuth operation without returning credentials. */
  cancelOAuth(ref: TeamCredentialRef): Promise<void>
  /** Inspect Host-owned credential state without returning provider identity or tokens. */
  inspectAuthorization(ref: TeamCredentialRef): Promise<TeamCredentialAuthorizationState>
  /** Return only provider quota metadata after refreshing OAuth internally. */
  readUsage(ref: TeamCredentialRef, signal?: AbortSignal): Promise<OpenAICodexUsage>
  /** Forward one fixed-endpoint Responses request without exposing OAuth material. */
  forwardResponses(ref: TeamCredentialRef, request: TeamResponsesForwardRequest): Promise<Response>
  /** Delete isolated credential material for an account after scheduling has stopped. */
  revoke(ref: TeamCredentialRef): Promise<void>
  /** Stop callback listeners and in-flight broker work. */
  dispose(): Promise<void>
}

/** Host-only persistence seam; implementations must never expose raw records to Browser code. */
export interface TeamCredentialStoreBackend {
  open(ref: TeamCredentialRef): OpenAICodexProfileStore
  delete(ref: TeamCredentialRef): Promise<void>
  /** Release Host-only storage resources such as in-memory encryption keys. */
  dispose?(): Promise<void> | void
}

export interface LocalTeamCredentialBrokerOptions {
  /** Host-only directory containing one credential document per contribution. */
  rootDir?: string
  /** Optional shared encrypted storage backend; defaults to owner-only local files. */
  storage?: TeamCredentialStoreBackend
  /** Called when an isolated login reaches active/reauth_required state. */
  onStatusChange?: (
    teamId: string,
    accountId: string,
    status: 'active' | 'reauth_required',
    lastError?: string,
    expectedStatus?: TeamContributionStatus,
  ) => Promise<void> | void
  /** Receives only sanitized diagnostics from detached OAuth completion work. */
  onBackgroundError?: (message: string) => Promise<void> | void
  /** Test seam; production always uses the Host fetch implementation. */
  fetch?: typeof fetch
  /** Test seam; production uses the provider-native isolated profile login. */
  loginProfile?: typeof loginOpenAICodexProfile
}

interface Operation {
  readonly ref: TeamCredentialRef
  readonly store: OpenAICodexProfileStore
  readonly cancellation: AbortController
  readonly challenge: Promise<TeamOAuthDeviceChallenge>
  readonly completion: Promise<void>
  suppressStatus: boolean
}

/**
 * Host broker using the existing Codex OAuth lifecycle. It deliberately
 * exposes no credential read method. Local development defaults to owner-only
 * files; PostgreSQL runtimes inject a shared envelope-encrypted backend.
 */
export class LocalTeamCredentialBroker implements TeamCredentialBroker {
  private readonly storage: TeamCredentialStoreBackend
  private readonly onStatusChange: NonNullable<LocalTeamCredentialBrokerOptions['onStatusChange']>
  private readonly onBackgroundError: NonNullable<LocalTeamCredentialBrokerOptions['onBackgroundError']>
  private readonly fetch: typeof fetch
  private readonly loginProfile: typeof loginOpenAICodexProfile
  private readonly operations = new Map<string, Operation>()

  constructor(options: LocalTeamCredentialBrokerOptions = {}) {
    this.storage = options.storage ?? new FileTeamCredentialStoreBackend(
      options.rootDir ?? join(dirname(openAICodexAuthPath()), 'team-credentials'),
    )
    this.onStatusChange = options.onStatusChange ?? (() => undefined)
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined)
    this.fetch = options.fetch ?? globalThis.fetch
    this.loginProfile = options.loginProfile ?? loginOpenAICodexProfile
  }

  async startOAuth(ref: TeamCredentialRef): Promise<TeamOAuthDeviceChallenge> {
    const key = operationKey(ref)
    const existing = this.operations.get(key)
    if (existing !== undefined) return existing.challenge

    const store = this.storage.open(ref)
    const cancellation = new AbortController()
    let challengeSettled = false
    let resolveChallenge: (challenge: TeamOAuthDeviceChallenge) => void = () => undefined
    let rejectChallenge: (error: unknown) => void = () => undefined
    const challenge = new Promise<TeamOAuthDeviceChallenge>((resolve, reject) => {
      resolveChallenge = resolve
      rejectChallenge = reject
    })
    const interaction: AuthInteraction = {
      signal: cancellation.signal,
      prompt: prompt => deviceCodePrompt(prompt, cancellation.signal),
      notify: event => {
        if (event.type !== 'device_code' || challengeSettled) return
        try {
          const projected = projectDeviceChallenge(event)
          challengeSettled = true
          resolveChallenge(projected)
        } catch (error: unknown) {
          challengeSettled = true
          rejectChallenge(error)
          cancellation.abort(error)
        }
      },
    }

    let operation: Operation
    const login = Promise.resolve().then(() => this.loginProfile(interaction, store))
    const completion = login.then(async () => {
      if (!challengeSettled) {
        challengeSettled = true
        rejectChallenge(new Error('OpenAI Codex device authorization returned no challenge'))
      }
      const profiles = await store.listProfiles()
      if (profiles.length === 1) {
        await this.notifyStatus(ref, 'active', undefined, 'authorizing')
      } else if (!operation.suppressStatus) {
        await this.notifyStatus(ref, 'reauth_required', 'OAuth did not produce exactly one account', 'authorizing')
      }
    }).catch(async (error: unknown) => {
      if (!challengeSettled) {
        challengeSettled = true
        rejectChallenge(error)
      }
      if (!operation.suppressStatus) {
        await this.notifyStatus(ref, 'reauth_required', safeTeamErrorMessage(error), 'authorizing')
      }
    }).finally(() => {
      if (this.operations.get(key) === operation) this.operations.delete(key)
    })
    operation = { ref, store, cancellation, challenge, completion, suppressStatus: false }
    this.operations.set(key, operation)
    try {
      return await challenge
    } catch (error: unknown) {
      cancellation.abort(error)
      await completion
      throw error
    }
  }

  async restartOAuth(ref: TeamCredentialRef): Promise<TeamOAuthDeviceChallenge> {
    const existing = this.operations.get(operationKey(ref))
    if (existing !== undefined) return existing.challenge
    await this.storage.delete(ref)
    return this.startOAuth(ref)
  }

  async cancelOAuth(ref: TeamCredentialRef): Promise<void> {
    const operation = this.operations.get(operationKey(ref))
    if (operation === undefined) return
    operation.cancellation.abort(new Error('OpenAI Codex contribution authorization cancelled'))
    await operation.completion
  }

  async inspectAuthorization(ref: TeamCredentialRef): Promise<TeamCredentialAuthorizationState> {
    if (this.operations.has(operationKey(ref))) return { status: 'authorizing' }
    const profiles = await this.store(ref).listProfiles()
    return profiles.length === 1
      ? { status: 'active' }
      : {
          status: 'reauth_required',
          lastError: 'authorization was interrupted; authorize this account again',
        }
  }

  async readUsage(ref: TeamCredentialRef, signal?: AbortSignal): Promise<OpenAICodexUsage> {
    try {
      return await readOpenAICodexRateLimits(this.store(ref), signal)
    } catch (error: unknown) {
      if (/sign-in|signed out|oauth|credential/iu.test(safeTeamErrorMessage(error))) {
        await this.notifyStatus(ref, 'reauth_required', safeTeamErrorMessage(error), 'active')
      }
      throw error
    }
  }

  async forwardResponses(ref: TeamCredentialRef, request: TeamResponsesForwardRequest): Promise<Response> {
    const store = this.store(ref)
    const models = createModels({ credentials: store })
    models.setProvider(openaiCodexProvider())
    const auth = await models.getAuth(OPENAI_CODEX_PROVIDER)
    const credential = await store.read(OPENAI_CODEX_PROVIDER)
    const access = auth?.auth.apiKey
    const accountId = credential?.type === 'oauth' && typeof credential.accountId === 'string'
      ? credential.accountId
      : undefined
    if (access === undefined || access.length === 0 || accountId === undefined || accountId.length === 0) {
      await this.notifyStatus(ref, 'reauth_required', 'OpenAI Codex is signed out', 'active')
      throw new Error('OpenAI Codex is signed out')
    }

    const headers = forwardedHeaders(request.headers)
    headers.set('authorization', `Bearer ${access}`)
    headers.set('chatgpt-account-id', accountId)
    headers.set('content-type', 'application/json')
    headers.set('accept', headers.get('accept') ?? 'text/event-stream')
    headers.set('openai-beta', headers.get('openai-beta') ?? 'responses=experimental')
    headers.set('originator', 'dsh-team')
    headers.set('session-id', request.sessionId)
    headers.set('thread-id', request.sessionId)
    headers.set('x-client-request-id', request.sessionId)
    headers.set('x-codex-routing-hint', `model=${request.model}`)
    const response = await this.fetch(OPENAI_CODEX_RESPONSES_URL, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: request.body,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
    if (response.status === 401 || response.status === 403) {
      await this.notifyStatus(ref, 'reauth_required', 'OpenAI Codex sign-in needs to be renewed', 'active')
    }
    return response
  }

  async revoke(ref: TeamCredentialRef): Promise<void> {
    const key = operationKey(ref)
    const operation = this.operations.get(key)
    if (operation !== undefined) {
      operation.suppressStatus = true
      operation.cancellation.abort(new Error('OpenAI Codex contribution revoked'))
      await operation.completion
      await this.removeCredential(operation)
      return
    }
    await this.storage.delete(ref)
  }

  async dispose(): Promise<void> {
    const operations = [...this.operations.values()]
    for (const operation of operations) {
      operation.suppressStatus = true
      operation.cancellation.abort(new Error('Team credential broker disposed'))
    }
    await Promise.all(operations.map(operation => operation.completion))
    await this.storage.dispose?.()
  }

  private async removeCredential(operation: Operation): Promise<void> {
    for (const profile of await operation.store.listProfiles()) await operation.store.removeProfile(profile.id)
    await this.storage.delete(operation.ref)
  }

  private async notifyStatus(
    ref: TeamCredentialRef,
    status: 'active' | 'reauth_required',
    lastError?: string,
    expectedStatus?: TeamContributionStatus,
  ): Promise<void> {
    try {
      await this.onStatusChange(ref.teamId, ref.accountId, status, lastError, expectedStatus)
    } catch (error: unknown) {
      try {
        await this.onBackgroundError(safeTeamErrorMessage(error))
      } catch {
        // Diagnostics must never turn detached OAuth completion into an
        // unhandled rejection. Startup reconciliation will retry persistence.
      }
    }
  }

  private store(ref: TeamCredentialRef): OpenAICodexProfileStore {
    return this.storage.open(ref)
  }
}

class FileTeamCredentialStoreBackend implements TeamCredentialStoreBackend {
  constructor(private readonly rootDir: string) {}

  open(ref: TeamCredentialRef): OpenAICodexProfileStore {
    return new OpenAICodexCredentialStore(credentialFilename(this.rootDir, ref))
  }

  async delete(ref: TeamCredentialRef): Promise<void> {
    await rm(credentialFilename(this.rootDir, ref), { force: true })
  }
}

function deviceCodePrompt(prompt: AuthPrompt, operationSignal: AbortSignal): Promise<string> {
  if (prompt.type === 'select') return Promise.resolve('device_code')
  const signal = prompt.signal === undefined
    ? operationSignal
    : AbortSignal.any([prompt.signal, operationSignal])
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true })
  })
}

function projectDeviceChallenge(event: Extract<AuthEvent, { type: 'device_code' }>): TeamOAuthDeviceChallenge {
  const verificationUrl = new URL(event.verificationUri)
  if (verificationUrl.protocol !== 'https:') throw new Error('OpenAI returned an unsafe device authorization URL')
  const userCode = event.userCode.trim()
  if (!/^[A-Za-z0-9-]{4,32}$/u.test(userCode)) throw new Error('OpenAI returned an invalid device authorization code')
  const expiresInSeconds = event.expiresInSeconds ?? 15 * 60
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 60 * 60) {
    throw new Error('OpenAI returned an invalid device authorization expiry')
  }
  return {
    method: 'device_code',
    verificationUrl: verificationUrl.toString(),
    userCode,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('OpenAI Codex device authorization aborted')
}

const FORWARDED_HEADER_NAMES = new Set(['accept', 'openai-beta', 'user-agent'])

function forwardedHeaders(input: Readonly<Record<string, string>>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase()
    if (!FORWARDED_HEADER_NAMES.has(normalized) || value.length > 1024 || /[\r\n]/u.test(value)) continue
    headers.set(normalized, value)
  }
  return headers
}

function operationKey(ref: TeamCredentialRef): string {
  return `${ref.teamId}:${ref.accountId}`
}

function credentialFilename(rootDir: string, ref: TeamCredentialRef): string {
  return join(rootDir, safePathSegment(ref.teamId), `${safePathSegment(ref.accountId)}.json`)
}

function safePathSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error('credential reference is invalid')
  return value
}

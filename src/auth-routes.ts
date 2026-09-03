/** Same-origin Web settings routes for OpenAI Codex OAuth. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loginOpenAICodex, loginOpenAICodexLocalProfile, logoutOpenAICodex, openAICodexAuthStatus } from './auth.ts'
import type { OutboundNetwork } from './network.ts'
import type { OpenAICodexCredentialStore } from './store.ts'
import type { CodexProfileSummary } from './store.ts'
import type { ImageToolPolicy, ImageToolPreferences, ResponseApiPreferences } from './tool-policy.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexUsage } from './usage.ts'
import type { CodexQuotaSnapshot } from './quota/types.ts'
import { assembleOpenAICodexProfileQuota } from './quota/profiles.ts'
import { safeExternalErrorMessage } from './safe-message.ts'
import type {
  OpenAICodexAuthorizationFailure,
  OpenAICodexLoginChallenge,
  OpenAICodexProfilesStatus,
} from './shared/types.ts'
import type { LocalRoutingEventLedger } from './local-routing-events.ts'
import {
  isOpenAICodexAuthorizationPopupAttemptToken,
  isOpenAICodexAuthorizationUrl,
  OPENAI_CODEX_AUTHORIZATION_POPUP_PATH,
  OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
  OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_TTL_MS,
} from './shared/authorization-popup.ts'

/** Plugin-owned status endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
/** Plugin-owned browser-login endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
/** Plugin-owned logout endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
/** Secret-free list of named profiles and their current usage. */
export const OPENAI_CODEX_PROFILES_PATH = '/plugins/dsh-openai-codex/profiles'
/** Fast secret-free profile directory without live quota reads. */
export const OPENAI_CODEX_PROFILE_DIRECTORY_PATH = '/plugins/dsh-openai-codex/profiles/directory'
/** Begin OAuth for a new named profile. */
export const OPENAI_CODEX_PROFILE_LOGIN_PATH = '/plugins/dsh-openai-codex/profiles/login'
/** Cancel the current browser-login operation without removing stored profiles. */
export const OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH = '/plugins/dsh-openai-codex/profiles/login/cancel'
/** Move one profile to the front of the global allocation order. */
export const OPENAI_CODEX_PROFILE_PRIORITY_PATH = '/plugins/dsh-openai-codex/profiles/priority'
/** Rename one profile without exposing its credentials. */
export const OPENAI_CODEX_PROFILE_RENAME_PATH = '/plugins/dsh-openai-codex/profiles/rename'
/** Remove one profile from this plugin. */
export const OPENAI_CODEX_PROFILE_REMOVE_PATH = '/plugins/dsh-openai-codex/profiles/remove'
/** Plugin-owned image-tool preference endpoint consumed by its browser half. */
export const OPENAI_CODEX_IMAGE_TOOL_SETTINGS_PATH = '/plugins/dsh-openai-codex/image-tools'
/** Plugin-owned Responses API experiment endpoint consumed by its browser half. */
export const OPENAI_CODEX_RESPONSE_API_SETTINGS_PATH = '/plugins/dsh-openai-codex/response-api'
/** Secret-free effective outbound network mode. */
export const OPENAI_CODEX_NETWORK_STATUS_PATH = '/plugins/dsh-openai-codex/network'
/** Secret-free aggregate quota used by the sidebar footer. */
export const OPENAI_CODEX_QUOTA_PATH = '/plugins/dsh-openai-codex/quota'
/** Browser-safe metadata-only receipts for recent local Codex requests. */
export const OPENAI_CODEX_ROUTING_EVENTS_PATH = '/plugins/dsh-openai-codex/routing-events'

/** Browser-safe state of the active OpenAI Codex authentication lifecycle. */
export type OpenAICodexWebAuthStatus =
  | { status: 'signed-out' }
  | { status: 'signing-in' }
  | { status: 'signed-in'; usage: OpenAICodexUsage; quotaError?: string }
  | { status: 'error'; reason: OpenAICodexAuthorizationFailure }

/** Browser-safe account profile with its current quota projection. */
export interface OpenAICodexWebProfile extends CodexProfileSummary {
  usage: OpenAICodexUsage
  /** Whether the newest local provider attempt selected this profile. */
  inUse: boolean
  quotaError?: string
}

/** Browser-safe state for the complete named-profile collection. */
export type OpenAICodexWebProfilesStatus = OpenAICodexProfilesStatus<OpenAICodexWebProfile>

/** Browser-safe local profile metadata that never includes credentials or live quota. */
export interface OpenAICodexWebProfileDirectoryEntry extends CodexProfileSummary {
  /** Whether the newest local provider attempt selected this profile. */
  readonly inUse: boolean
}

/** Browser-safe lifecycle state for the fast local profile directory. */
export type OpenAICodexWebProfileDirectoryStatus = OpenAICodexProfilesStatus<OpenAICodexWebProfileDirectoryEntry>

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000

type LoginAttemptPhase = 'active' | 'committing' | 'cancelled'
type LoginAttemptErrorCode = OpenAICodexAuthorizationFailure | 'authorization-cancelled'

class LoginAttemptError extends Error {
  constructor(readonly code: LoginAttemptErrorCode) {
    super(code)
    this.name = 'LoginAttemptError'
  }
}

interface LoginAttempt {
  readonly addProfile: boolean
  readonly cancellation: AbortController
  readonly waiters: Array<{
    resolve(value: OpenAICodexLoginChallenge): void
    reject(error: unknown): void
  }>
  phase: LoginAttemptPhase
  challenge?: OpenAICodexLoginChallenge
  timeout?: ReturnType<typeof setTimeout>
  operation?: Promise<void>
}

export interface OpenAICodexWebAuthOptions {
  /** Maximum time an OAuth callback may remain pending. */
  readonly timeoutMs?: number
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('OpenAI Codex sign-in aborted')
}

/** Reject when the provider prompt or its enclosing browser login is cancelled. */
function waitForPromptAbort(prompt: AuthPrompt, operationSignal: AbortSignal): Promise<string> {
  const signal = prompt.signal === undefined
    ? operationSignal
    : AbortSignal.any([prompt.signal, operationSignal])
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(abortReason(signal))
    }, { once: true })
  })
}

/** One lifecycle owner for the callback server, challenge, and public status. */
export class OpenAICodexWebAuth {
  private state: OpenAICodexWebAuthStatus = { status: 'signed-out' }
  private attempt: LoginAttempt | undefined
  private readonly operations = new Set<Promise<void>>()
  private readonly timeoutMs: number

  constructor(
    private readonly store: OpenAICodexCredentialStore,
    options: OpenAICodexWebAuthOptions = {},
    private readonly routingEvents?: LocalRoutingEventLedger,
  ) {
    this.timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : DEFAULT_LOGIN_TIMEOUT_MS
  }

  /**
   * Read current public state, consulting durable storage while idle.
   * @returns Browser-safe authentication and quota state.
   */
  async status(): Promise<OpenAICodexWebAuthStatus> {
    if (this.attempt !== undefined) return this.state
    if (this.state.status === 'error') return this.state
    return this.readStoredStatus()
  }

  /**
   * List every profile with secret-free quota metadata.
   * @returns Browser-safe profile collection state.
   */
  async profilesStatus(): Promise<OpenAICodexWebProfilesStatus> {
    if (this.attempt !== undefined) return { status: 'signing-in' }
    if (this.state.status === 'error') return this.state
    const profiles = await this.store.listProfiles()
    return {
      status: 'ready',
      profiles: await Promise.all(profiles.map(async (profile) => {
        const inUse = this.routingEvents?.currentProfileId() === profile.id
        try {
          return { ...profile, usage: await readOpenAICodexRateLimits(this.store.forProfile(profile.id)), inUse }
        } catch (error: unknown) {
          return { ...profile, usage: { rateLimits: [] }, inUse, quotaError: safeExternalErrorMessage(error) }
        }
      })),
    }
  }

  /**
   * List every profile without opening its credential store or reading live quota.
   * @returns Browser-safe profile metadata with the current local selection.
   */
  async profileDirectoryStatus(): Promise<OpenAICodexWebProfileDirectoryStatus> {
    if (this.attempt !== undefined) return { status: 'signing-in' }
    if (this.state.status === 'error') return this.state
    const profiles = await this.store.listProfiles()
    const currentProfileId = this.routingEvents?.currentProfileId()
    return {
      status: 'ready',
      profiles: profiles.map(profile => ({
        id: profile.id,
        label: profile.label,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        inUse: currentProfileId === profile.id,
      })),
    }
  }

  /**
   * Read the sidebar's display-safe aggregate quota.
   *
   * Profile order is the global allocation order. Usage failures remain
   * represented as unreadable quota while every stored profile stays counted.
   */
  async quotaSnapshot(): Promise<CodexQuotaSnapshot> {
    const status = await this.profilesStatus()
    if (status.status !== 'ready') {
      return {
        currentAccountName: null,
        currentRemainingPercent: null,
        currentResetsAt: null,
        poolAccountCount: 0,
        poolRemainingPercent: null,
        refreshedAt: Date.now(),
      }
    }
    return assembleOpenAICodexProfileQuota(status.profiles)
  }

  /**
   * Start or join the current browser-login operation.
   * @returns Provider authorization challenge.
   */
  async signIn(): Promise<OpenAICodexLoginChallenge> {
    const attempt = this.attempt ?? this.start()
    if (attempt.challenge !== undefined) return attempt.challenge
    return new Promise<OpenAICodexLoginChallenge>((resolve, reject) => {
      attempt.waiters.push({ resolve, reject })
    })
  }

  /**
   * Start OAuth for a new profile without overwriting the active credential.
   * @returns Provider authorization challenge.
   */
  async signInProfile(): Promise<OpenAICodexLoginChallenge> {
    const attempt = this.attempt ?? this.start(true)
    if (attempt.challenge !== undefined) return attempt.challenge
    return new Promise<OpenAICodexLoginChallenge>((resolve, reject) => {
      attempt.waiters.push({ resolve, reject })
    })
  }

  /**
   * Cancel the current browser login without removing stored profiles.
   * @returns Whether a login was active and cancelled.
   */
  async cancelSignIn(): Promise<boolean> {
    const attempt = this.attempt
    if (attempt === undefined) return false
    return this.invalidateAttempt(attempt, new LoginAttemptError('authorization-cancelled'))
  }

  /** Wait for the current OAuth operation to settle without exposing its credential. */
  async waitForCompletion(): Promise<void> {
    await Promise.allSettled([...this.operations])
  }

  /**
   * Make one stored profile the first candidate for every Codex allocation.
   * @param profileId - Profile to move to the front of the allocation order.
   */
  async prioritizeProfile(profileId: string): Promise<void> {
    if (this.attempt !== undefined) throw new Error('wait for the current sign-in to finish')
    await this.store.prioritizeProfile(profileId)
  }

  /**
   * Rename one stored profile.
   * @param profileId - Profile to rename.
   * @param label - New human-facing label.
   */
  async renameProfile(profileId: string, label: string): Promise<void> {
    if (this.attempt !== undefined) throw new Error('wait for the current sign-in to finish')
    await this.store.renameProfile(profileId, label)
  }

  /**
   * Remove one stored profile and its credential.
   * @param profileId - Profile and credential to remove.
   */
  async removeProfile(profileId: string): Promise<void> {
    if (this.attempt !== undefined) throw new Error('wait for the current sign-in to finish')
    await this.store.removeProfile(profileId)
    this.state = await this.readStoredStatus()
  }

  /** Cancel any callback listener, wait for quiescence, then delete the credential. */
  async signOut(): Promise<void> {
    const attempt = this.attempt
    if (attempt?.phase === 'active') {
      this.invalidateAttempt(attempt, new LoginAttemptError('authorization-cancelled'))
    } else {
      attempt?.cancellation.abort(new LoginAttemptError('authorization-cancelled'))
    }
    await this.waitForCompletion()
    await logoutOpenAICodex(this.store)
    this.state = { status: 'signed-out' }
  }

  /** Stop the owned callback listener during plugin disposal. */
  async dispose(): Promise<void> {
    const attempt = this.attempt
    if (attempt?.phase === 'active') {
      this.invalidateAttempt(attempt, new LoginAttemptError('authorization-cancelled'))
    } else {
      attempt?.cancellation.abort(new LoginAttemptError('authorization-cancelled'))
    }
    await this.waitForCompletion()
  }

  private start(addProfile = false): LoginAttempt {
    const attempt: LoginAttempt = {
      addProfile,
      cancellation: new AbortController(),
      phase: 'active',
      waiters: [],
    }
    this.attempt = attempt
    this.state = { status: 'signing-in' }
    const interaction = {
      signal: attempt.cancellation.signal,
      prompt: prompt => prompt.type === 'select'
        ? Promise.resolve('browser')
        : waitForPromptAbort(prompt, attempt.cancellation.signal),
      notify: (event) => { this.onEvent(attempt, event) },
    } satisfies Parameters<typeof loginOpenAICodex>[0]
    const login = addProfile
      ? loginOpenAICodexLocalProfile(interaction, this.store, {
          beforeCommit: () => { this.beginCommit(attempt) },
        }).then(() => undefined)
      : loginOpenAICodex(interaction, this.store, {
          beforeCommit: () => { this.beginCommit(attempt) },
        })
    const operation = login.then(
      async () => {
        if (this.attempt === attempt && attempt.phase === 'committing') {
          this.state = await this.readStoredStatus()
        }
      },
      (error: unknown) => {
        this.rejectChallenge(attempt, error)
        if (this.attempt === attempt && attempt.phase !== 'cancelled') {
          this.state = { status: 'error', reason: 'authorization-failed' }
        }
      },
    ).finally(() => {
      if (attempt.timeout !== undefined) clearTimeout(attempt.timeout)
      if (this.attempt === attempt) this.attempt = undefined
      this.operations.delete(operation)
    })
    attempt.operation = operation
    this.operations.add(operation)
    attempt.timeout = setTimeout(() => {
      this.invalidateAttempt(attempt, new LoginAttemptError('authorization-timed-out'))
    }, this.timeoutMs)
    return attempt
  }

  private beginCommit(attempt: LoginAttempt): void {
    if (this.attempt !== attempt || attempt.phase !== 'active' || attempt.cancellation.signal.aborted) {
      throw new LoginAttemptError('authorization-cancelled')
    }
    attempt.phase = 'committing'
    if (attempt.timeout !== undefined) clearTimeout(attempt.timeout)
  }

  private invalidateAttempt(attempt: LoginAttempt, error: LoginAttemptError): boolean {
    if (this.attempt !== attempt || attempt.phase !== 'active') return false
    attempt.phase = 'cancelled'
    this.attempt = undefined
    if (attempt.timeout !== undefined) clearTimeout(attempt.timeout)
    this.state = error.code === 'authorization-timed-out'
      ? { status: 'error', reason: error.code }
      : { status: 'signed-out' }
    attempt.cancellation.abort(error)
    this.rejectChallenge(attempt, error)
    return true
  }

  private onEvent(attempt: LoginAttempt, event: AuthEvent): void {
    if (this.attempt !== attempt || attempt.phase !== 'active') return
    if (event.type !== 'auth_url') return
    const url = new URL(event.url)
    if (url.protocol !== 'https:') {
      const error = new Error('OpenAI returned an unsafe authorization URL')
      attempt.cancellation.abort(error)
      this.rejectChallenge(attempt, error)
      return
    }
    const challenge = { url: event.url }
    attempt.challenge = challenge
    for (const waiter of attempt.waiters.splice(0)) waiter.resolve(challenge)
  }

  private async readStoredStatus(): Promise<OpenAICodexWebAuthStatus> {
    const stored = await openAICodexAuthStatus(this.store)
    if (!stored.authenticated) return { status: 'signed-out' }
    try {
      return { status: 'signed-in', usage: await readOpenAICodexRateLimits(this.store) }
    } catch (error: unknown) {
      return { status: 'signed-in', usage: { rateLimits: [] }, quotaError: safeExternalErrorMessage(error) }
    }
  }

  private rejectChallenge(attempt: LoginAttempt, error: unknown): void {
    for (const waiter of attempt.waiters.splice(0)) waiter.reject(error)
  }
}

/** Whether a request comes from this loopback page rather than a remote site. */
function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase()
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') return false
  } catch {
    return false
  }
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

export const AUTHORIZATION_POPUP_SESSION_TTL_MS = OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_TTL_MS
const AUTHORIZATION_POPUP_SESSION_LIMIT = 64

type AuthorizationPopupSessionStatus = 'waiting' | 'ready' | 'acknowledged' | 'cancelled'
type AuthorizationPopupSessionSnapshot = {
  readonly status: AuthorizationPopupSessionStatus
  readonly authorizationUrl?: string
}
type AuthorizationPopupSessionWaiter = (snapshot: AuthorizationPopupSessionSnapshot | null) => void

interface AuthorizationPopupSession {
  readonly attemptToken: string
  readonly expiresAt: number
  readonly waiters: Set<AuthorizationPopupSessionWaiter>
  status: AuthorizationPopupSessionStatus
  authorizationUrl?: string
}

/** Short-lived, bounded handoff state shared by the settings page and adopted tab. */
export class AuthorizationPopupSessions {
  private readonly sessions = new Map<string, AuthorizationPopupSession>()
  private expiryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = AUTHORIZATION_POPUP_SESSION_TTL_MS,
    private readonly maxSessions = AUTHORIZATION_POPUP_SESSION_LIMIT,
  ) {}

  get size(): number { return this.sessions.size }

  open(attemptToken: string): AuthorizationPopupSessionStatus {
    this.expire()
    const existing = this.sessions.get(attemptToken)
    if (existing !== undefined) return existing.status
    this.store({
      attemptToken,
      expiresAt: this.now() + this.ttlMs,
      status: 'waiting',
      waiters: new Set(),
    })
    return 'waiting'
  }

  publish(attemptToken: string, authorizationUrl: string): AuthorizationPopupSessionStatus | null {
    this.expire()
    let session = this.sessions.get(attemptToken)
    if (session === undefined) {
      session = {
        attemptToken,
        expiresAt: this.now() + this.ttlMs,
        status: 'waiting',
        waiters: new Set(),
      }
      this.store(session)
    }
    if (session.status === 'cancelled') return null
    if (session.authorizationUrl !== undefined && session.authorizationUrl !== authorizationUrl) return null
    session.authorizationUrl = authorizationUrl
    if (session.status !== 'acknowledged') session.status = 'ready'
    this.notify(session, this.snapshot(session))
    return session.status
  }

  acknowledge(attemptToken: string): AuthorizationPopupSessionStatus | null {
    this.expire()
    const session = this.sessions.get(attemptToken)
    if (session === undefined || session.status === 'cancelled' || session.authorizationUrl === undefined) return null
    session.status = 'acknowledged'
    this.notify(session, this.snapshot(session))
    return session.status
  }

  cancel(attemptToken: string): AuthorizationPopupSessionStatus {
    this.expire()
    const existing = this.sessions.get(attemptToken)
    if (existing !== undefined) {
      existing.status = 'cancelled'
      delete existing.authorizationUrl
      this.notify(existing, this.snapshot(existing))
      return existing.status
    }
    this.store({
      attemptToken,
      expiresAt: this.now() + this.ttlMs,
      status: 'cancelled',
      waiters: new Set(),
    })
    return 'cancelled'
  }

  status(attemptToken: string): AuthorizationPopupSessionSnapshot | null {
    this.expire()
    const session = this.sessions.get(attemptToken)
    return session === undefined ? null : this.snapshot(session)
  }

  waitForNavigation(attemptToken: string): Promise<AuthorizationPopupSessionSnapshot | null> {
    this.expire()
    const session = this.sessions.get(attemptToken)
    if (session === undefined) return Promise.resolve(null)
    if (session.status !== 'waiting') return Promise.resolve(this.snapshot(session))
    return new Promise(resolve => { session.waiters.add(resolve) })
  }

  clear(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    for (const session of this.sessions.values()) this.notify(session, null)
    this.sessions.clear()
  }

  private expire(): void {
    const now = this.now()
    for (const [attemptToken, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(attemptToken)
        this.notify(session, null)
      }
    }
    this.scheduleExpiry()
  }

  private store(session: AuthorizationPopupSession): void {
    if (!this.sessions.has(session.attemptToken) && this.sessions.size >= Math.max(1, this.maxSessions)) {
      let evictionCandidate: string | undefined
      for (const [attemptToken, existing] of this.sessions) {
        evictionCandidate ??= attemptToken
        if (existing.status === 'acknowledged' || existing.status === 'cancelled') {
          evictionCandidate = attemptToken
          break
        }
      }
      if (evictionCandidate !== undefined) {
        const evicted = this.sessions.get(evictionCandidate)
        this.sessions.delete(evictionCandidate)
        if (evicted !== undefined) this.notify(evicted, null)
      }
    }
    this.sessions.set(session.attemptToken, session)
    this.scheduleExpiry()
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    let earliestExpiry: number | undefined
    for (const session of this.sessions.values()) {
      earliestExpiry = earliestExpiry === undefined ? session.expiresAt : Math.min(earliestExpiry, session.expiresAt)
    }
    if (earliestExpiry === undefined) return
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined
      this.expire()
    }, Math.max(0, earliestExpiry - this.now()))
    this.expiryTimer.unref?.()
  }

  private snapshot(session: AuthorizationPopupSession): AuthorizationPopupSessionSnapshot {
    return session.status === 'ready' && session.authorizationUrl !== undefined
      ? { status: 'ready', authorizationUrl: session.authorizationUrl }
      : { status: session.status }
  }

  private notify(session: AuthorizationPopupSession, snapshot: AuthorizationPopupSessionSnapshot | null): void {
    const waiters = [...session.waiters]
    session.waiters.clear()
    for (const resolve of waiters) resolve(snapshot)
  }
}

function popupAttemptFromRequest(req: IncomingMessage): string {
  const parsed = new URL(req.url ?? '', 'http://localhost')
  const attempts = parsed.searchParams.getAll('attempt')
  if (
    (parsed.pathname !== OPENAI_CODEX_AUTHORIZATION_POPUP_PATH
      && parsed.pathname !== OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH)
    || attempts.length !== 1
    || [...parsed.searchParams.keys()].some(key => key !== 'attempt')
    || !isOpenAICodexAuthorizationPopupAttemptToken(attempts[0] ?? '')
  ) throw new Error('invalid popup request')
  return attempts[0]!
}

function authorizationPopup(res: ServerResponse, attemptToken: string): void {
  const nonce = randomBytes(18).toString('base64')
  const sessionUrl = `${OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH}?attempt=${encodeURIComponent(attemptToken)}`
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在准备安全授权</title></head><body><main><p>正在打开 OpenAI 登录页面…</p></main><script nonce="${nonce}">try{window.name=''}catch{}window.location.replace(${JSON.stringify(sessionUrl)})</script></body></html>`
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
  })
  res.end(body)
}

function acceptsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept
  return (Array.isArray(accept) ? accept : [accept]).some(value => value?.toLowerCase().includes('text/html') === true)
}

function authorizationPopupRedirect(res: ServerResponse, authorizationUrl: string): void {
  res.writeHead(302, {
    location: authorizationUrl,
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end()
}

function authorizationPopupUnavailable(res: ServerResponse, reason: 'cancelled' | 'expired'): void {
  const body = reason === 'cancelled' ? '授权已取消，可以关闭此页面。' : '授权准备已过期，请关闭后重试。'
  res.writeHead(reason === 'cancelled' ? 409 : 410, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

function loginErrorResponse(res: ServerResponse, error: unknown): void {
  if (error instanceof LoginAttemptError) {
    const status = error.code === 'authorization-timed-out' ? 408 : 409
    json(res, status, { error: error.code })
    return
  }
  json(res, 400, { error: 'authorization-failed' })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.byteLength
    if (bytes > 16 * 1024) throw new Error('request body is too large')
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

type AuthorizationPopupSessionCommand =
  | { readonly kind: 'publish'; readonly attemptToken: string; readonly authorizationUrl: string }
  | { readonly kind: 'cancel'; readonly attemptToken: string }

function authorizationPopupSessionCommand(value: Record<string, unknown>): AuthorizationPopupSessionCommand {
  const keys = Object.keys(value).sort()
  const attemptToken = value.attemptToken
  if (typeof attemptToken !== 'string' || !isOpenAICodexAuthorizationPopupAttemptToken(attemptToken)) {
    throw new Error('invalid popup attempt')
  }
  if (keys.length === 2 && keys[0] === 'attemptToken' && keys[1] === 'authorizationUrl') {
    const authorizationUrl = value.authorizationUrl
    if (typeof authorizationUrl !== 'string' || !isOpenAICodexAuthorizationUrl(authorizationUrl)) {
      throw new Error('invalid authorization URL')
    }
    return { kind: 'publish', attemptToken, authorizationUrl }
  }
  if (keys.length === 2 && keys[0] === 'attemptToken' && keys[1] === 'cancel' && value.cancel === true) {
    return { kind: 'cancel', attemptToken }
  }
  throw new Error('invalid popup session command')
}

function exactStrings<const Key extends string>(
  value: Record<string, unknown>,
  keys: readonly Key[],
): Record<Key, string> {
  if (Object.keys(value).some(key => !keys.includes(key as Key))) throw new Error('request contains an unknown field')
  const result = {} as Record<Key, string>
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new Error(`${key} must be a non-empty string`)
    }
    result[key] = candidate.trim()
  }
  return result
}

function preferencePatch(value: Record<string, unknown>): Partial<ImageToolPreferences> {
  const allowed = new Set(['modifyReadImage', 'shareImagegenWithOtherModels'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('request contains an unknown image-tool setting')
  const patch: Partial<ImageToolPreferences> = {}
  for (const key of allowed as Set<keyof ImageToolPreferences>) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
    patch[key] = value[key]
  }
  return patch
}

function responseApiPatch(value: Record<string, unknown>): Partial<ResponseApiPreferences> {
  const allowed = new Set<keyof ResponseApiPreferences>(['useFastMode', 'useWebSocketContextReuse', 'useNativeCompaction'])
  if (Object.keys(value).some(key => !allowed.has(key as keyof ResponseApiPreferences))) {
    throw new Error('request contains an unknown Responses API setting')
  }
  const patch: Partial<ResponseApiPreferences> = {}
  for (const key of allowed) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
    patch[key] = value[key]
  }
  return patch
}

/**
 * Register the plugin-owned OAuth routes when the Web server is composed.
 *
 * @param ctx - Plugin context that owns the HTTP registrations.
 * @param store - Credential-safe profile store.
 * @param imageTools - Live image-tool policy exposed through settings routes.
 * @param network - Secret-free outbound network status owner.
 * @param routingEvents - Host-owned bounded metadata-only request ledger.
 */
export function registerOpenAICodexAuthRoutes(
  ctx: Context,
  store: OpenAICodexCredentialStore,
  imageTools: ImageToolPolicy,
  network: OutboundNetwork,
  routingEvents: LocalRoutingEventLedger,
): void {
  const auth = new OpenAICodexWebAuth(store, {}, routingEvents)
  const authorizationPopupSessions = new AuthorizationPopupSessions()
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTHORIZATION_POPUP_PATH,
        handler: (req, res) => {
          if (!trustedRequest(req)) { json(res, 403, { error: 'forbidden' }); return }
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const attemptToken = popupAttemptFromRequest(req)
            authorizationPopupSessions.open(attemptToken)
            authorizationPopup(res, attemptToken)
          } catch {
            json(res, 400, { error: 'invalid popup request' })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) { json(res, 403, { error: 'forbidden' }); return }
          if (req.method === 'GET') {
            try {
              const attemptToken = popupAttemptFromRequest(req)
              if (acceptsHtml(req)) {
                const handoff = await authorizationPopupSessions.waitForNavigation(attemptToken)
                if (handoff === null) { authorizationPopupUnavailable(res, 'expired'); return }
                if (handoff.status === 'cancelled') { authorizationPopupUnavailable(res, 'cancelled'); return }
                if (handoff.status !== 'ready' || handoff.authorizationUrl === undefined) {
                  authorizationPopupUnavailable(res, 'expired')
                  return
                }
                if (authorizationPopupSessions.acknowledge(attemptToken) !== 'acknowledged') {
                  authorizationPopupUnavailable(res, 'expired')
                  return
                }
                authorizationPopupRedirect(res, handoff.authorizationUrl)
                return
              }
              const status = authorizationPopupSessions.status(attemptToken)
              if (status === null) { json(res, 404, { status: 'expired' }); return }
              json(res, 200, { status: status.status })
            } catch {
              json(res, 400, { error: 'invalid popup session request' })
            }
            return
          }
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            json(res, 415, { error: 'application/json required' })
            return
          }
          try {
            const command = authorizationPopupSessionCommand(await readJson(req))
            if (command.kind === 'publish') {
              const status = authorizationPopupSessions.publish(command.attemptToken, command.authorizationUrl)
              if (status === null) { json(res, 409, { error: 'popup session is not writable' }); return }
              json(res, 200, { status: 'published' })
              return
            }
            json(res, 200, { status: authorizationPopupSessions.cancel(command.attemptToken) })
          } catch {
            json(res, 400, { error: 'invalid popup session request' })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_NETWORK_STATUS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          json(res, 200, network.status())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_QUOTA_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) { json(res, 403, { error: 'forbidden' }); return }
          try {
            json(res, 200, await auth.quotaSnapshot())
          } catch {
            json(res, 200, {
              currentAccountName: null,
              currentRemainingPercent: null,
              currentResetsAt: null,
              poolAccountCount: 0,
              poolRemainingPercent: null,
              refreshedAt: Date.now(),
            })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_ROUTING_EVENTS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) { json(res, 403, { error: 'forbidden' }); return }
          json(res, 200, { events: routingEvents.list(50) })
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          json(res, 200, await auth.status())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          try {
            json(res, 200, await auth.signIn())
          } catch (error: unknown) {
            loginErrorResponse(res, error)
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          await auth.signOut()
          json(res, 200, { ok: true })
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROFILE_DIRECTORY_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          json(res, 200, await auth.profileDirectoryStatus())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROFILES_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          json(res, 200, await auth.profilesStatus())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROFILE_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          try {
            json(res, 200, await auth.signInProfile())
          } catch (error: unknown) {
            loginErrorResponse(res, error)
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          json(res, 200, { cancelled: await auth.cancelSignIn() })
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROFILE_PRIORITY_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) { json(res, 403, { error: 'forbidden' }); return }
          try {
            const { profileId } = exactStrings(await readJson(req), ['profileId'])
            await auth.prioritizeProfile(profileId)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 400, { error: safeExternalErrorMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROFILE_RENAME_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          try {
            const { profileId, label } = exactStrings(await readJson(req), ['profileId', 'label'])
            await auth.renameProfile(profileId, label)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 400, { error: safeExternalErrorMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROFILE_REMOVE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          try {
            const { profileId } = exactStrings(await readJson(req), ['profileId'])
            await auth.removeProfile(profileId)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 400, { error: safeExternalErrorMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_IMAGE_TOOL_SETTINGS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          if (req.method === 'GET') {  json(res, 200, imageTools.snapshot()); return }
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          try {
            json(res, 200, await imageTools.update(preferencePatch(await readJson(req))))
          } catch (error: unknown) {
            json(res, 400, { error: safeExternalErrorMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_RESPONSE_API_SETTINGS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          if (req.method === 'GET') {  json(res, 200, imageTools.responseApiSnapshot()); return }
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          try {
            json(res, 200, await imageTools.updateResponseApi(responseApiPatch(await readJson(req))))
          } catch (error: unknown) {
            json(res, 400, { error: safeExternalErrorMessage(error) })
          }
        },
      }),
    ]
    return async () => {
      for (const dispose of routes) dispose()
      authorizationPopupSessions.clear()
      await auth.dispose()
    }
  }, 'dsh-openai-codex: Web OAuth routes')
}

/** Same-origin Web settings routes for OpenAI Codex OAuth. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loginOpenAICodex, loginOpenAICodexProfile, logoutOpenAICodex, openAICodexAuthStatus } from './auth.ts'
import type { OutboundNetwork } from './network.ts'
import type { OpenAICodexCredentialStore } from './store.ts'
import type { CodexProfileSummary } from './store.ts'
import type { ImageToolPolicy, ImageToolPreferences, ResponseApiPreferences } from './tool-policy.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexUsage } from './usage.ts'
import type { CodexQuotaSnapshot } from './quota/types.ts'
import { assembleOpenAICodexProfileQuota } from './quota/profiles.ts'
import { safeExternalErrorMessage } from './safe-message.ts'

/** Plugin-owned status endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
/** Plugin-owned browser-login endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
/** Plugin-owned logout endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
/** Secret-free list of named profiles and their current usage. */
export const OPENAI_CODEX_PROFILES_PATH = '/plugins/dsh-openai-codex/profiles'
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

/** Browser-safe state of the active OpenAI Codex authentication lifecycle. */
export type OpenAICodexWebAuthStatus =
  | { status: 'signed-out' }
  | { status: 'signing-in' }
  | { status: 'signed-in'; usage: OpenAICodexUsage; quotaError?: string }
  | { status: 'error'; message: string }

/** Browser-safe account profile with its current quota projection. */
export interface OpenAICodexWebProfile extends CodexProfileSummary {
  usage: OpenAICodexUsage
  quotaError?: string
}

/** Browser-safe state for the complete named-profile collection. */
export type OpenAICodexWebProfilesStatus =
  | { status: 'ready'; profiles: OpenAICodexWebProfile[] }
  | { status: 'signing-in' }
  | { status: 'error'; message: string }

/** Optional host-side app-server quota reader, kept behind the plugin boundary. */
export interface OpenAICodexQuotaReader {
  read(): Promise<CodexQuotaSnapshot>
}

interface LoginChallenge {
  url: string
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
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private challenge: LoginChallenge | undefined
  private challengeWaiters: Array<{ resolve(value: LoginChallenge): void; reject(error: unknown): void }> = []

  constructor(private readonly store: OpenAICodexCredentialStore) {}

  /**
   * Read current public state, consulting durable storage while idle.
   * @returns Browser-safe authentication and quota state.
   */
  async status(): Promise<OpenAICodexWebAuthStatus> {
    if (this.operation !== undefined) return this.state
    if (this.state.status === 'error') return this.state
    return this.readStoredStatus()
  }

  /**
   * List every profile with secret-free quota metadata.
   * @returns Browser-safe profile collection state.
   */
  async profilesStatus(): Promise<OpenAICodexWebProfilesStatus> {
    if (this.operation !== undefined) return { status: 'signing-in' }
    if (this.state.status === 'error') return this.state
    const profiles = await this.store.listProfiles()
    return {
      status: 'ready',
      profiles: await Promise.all(profiles.map(async (profile) => {
        try {
          return { ...profile, usage: await readOpenAICodexRateLimits(this.store.forProfile(profile.id)) }
        } catch (error: unknown) {
          return { ...profile, usage: { rateLimits: [] }, quotaError: safeExternalErrorMessage(error) }
        }
      })),
    }
  }

  /**
   * Read the sidebar's display-safe aggregate quota.
   *
   * Profile order is the global allocation order. Usage failures remain
   * represented as unreadable quota while every stored profile stays counted.
   */
  async quotaSnapshot(reader?: OpenAICodexQuotaReader): Promise<CodexQuotaSnapshot> {
    if (reader !== undefined) return reader.read()
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
  async signIn(): Promise<LoginChallenge> {
    if (this.operation === undefined) this.start()
    if (this.challenge !== undefined) return this.challenge
    return new Promise<LoginChallenge>((resolve, reject) => {
      this.challengeWaiters.push({ resolve, reject })
    })
  }

  /**
   * Start OAuth for a new profile without overwriting the active credential.
   * @returns Provider authorization challenge.
   */
  async signInProfile(): Promise<LoginChallenge> {
    if (this.operation === undefined) this.start(true)
    if (this.challenge !== undefined) return this.challenge
    return new Promise<LoginChallenge>((resolve, reject) => {
      this.challengeWaiters.push({ resolve, reject })
    })
  }

  /**
   * Cancel the current browser login without removing stored profiles.
   * @returns Whether a login was active and cancelled.
   */
  async cancelSignIn(): Promise<boolean> {
    const operation = this.operation
    const cancellation = this.cancellation
    if (operation === undefined || cancellation === undefined) return false
    cancellation.abort(new Error('OpenAI Codex sign-in cancelled'))
    await operation.catch(() => undefined)
    this.state = await this.readStoredStatus()
    return true
  }

  /** Wait for the current OAuth operation to settle without exposing its credential. */
  async waitForCompletion(): Promise<void> {
    await this.operation?.catch(() => undefined)
  }

  /**
   * Make one stored profile the first candidate for every Codex allocation.
   * @param profileId - Profile to move to the front of the allocation order.
   */
  async prioritizeProfile(profileId: string): Promise<void> {
    if (this.operation !== undefined) throw new Error('wait for the current sign-in to finish')
    await this.store.prioritizeProfile(profileId)
  }

  /**
   * Rename one stored profile.
   * @param profileId - Profile to rename.
   * @param label - New human-facing label.
   */
  async renameProfile(profileId: string, label: string): Promise<void> {
    if (this.operation !== undefined) throw new Error('wait for the current sign-in to finish')
    await this.store.renameProfile(profileId, label)
  }

  /**
   * Remove one stored profile and its credential.
   * @param profileId - Profile and credential to remove.
   */
  async removeProfile(profileId: string): Promise<void> {
    if (this.operation !== undefined) throw new Error('wait for the current sign-in to finish')
    await this.store.removeProfile(profileId)
    this.state = await this.readStoredStatus()
  }

  /** Cancel any callback listener, wait for quiescence, then delete the credential. */
  async signOut(): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex sign-in cancelled'))
    await this.operation?.catch(() => undefined)
    await logoutOpenAICodex(this.store)
    this.state = { status: 'signed-out' }
  }

  /** Stop the owned callback listener during plugin disposal. */
  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex plugin disposed'))
    await this.operation?.catch(() => undefined)
  }

  private start(addProfile = false): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.challenge = undefined
    this.state = { status: 'signing-in' }
    const interaction = {
      signal: cancellation.signal,
      prompt: prompt => prompt.type === 'select'
        ? Promise.resolve('browser')
        : waitForPromptAbort(prompt, cancellation.signal),
      notify: (event) => { this.onEvent(event) },
    } satisfies Parameters<typeof loginOpenAICodex>[0]
    const login = addProfile
      ? loginOpenAICodexProfile(interaction, this.store).then(() => undefined)
      : loginOpenAICodex(interaction, this.store)
    this.operation = login.then(
      async () => {
        this.state = await this.readStoredStatus()
      },
      (error: unknown) => {
        this.rejectChallenge(error)
        this.state = { status: 'error', message: safeExternalErrorMessage(error) }
      },
    ).finally(() => {
      this.operation = undefined
      this.cancellation = undefined
    })
  }

  private onEvent(event: AuthEvent): void {
    if (event.type !== 'auth_url') return
    const url = new URL(event.url)
    if (url.protocol !== 'https:') {
      const error = new Error('OpenAI returned an unsafe authorization URL')
      this.cancellation?.abort(error)
      this.rejectChallenge(error)
      return
    }
    const challenge = { url: event.url }
    this.challenge = challenge
    for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(challenge)
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

  private rejectChallenge(error: unknown): void {
    for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error)
  }
}

/** Whether a request comes from this loopback page rather than a remote site. */
function trustedRequest(req: IncomingMessage): boolean {
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

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
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
 */
export function registerOpenAICodexAuthRoutes(
  ctx: Context,
  store: OpenAICodexCredentialStore,
  imageTools: ImageToolPolicy,
  network: OutboundNetwork,
  quota?: OpenAICodexQuotaReader,
): void {
  const auth = new OpenAICodexWebAuth(store)
  ctx.effect(() => {
    const routes = [
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
            json(res, 200, await auth.quotaSnapshot(quota))
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
            json(res, 500, { error: safeExternalErrorMessage(error) })
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
            json(res, 400, { error: safeExternalErrorMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROFILE_LOGIN_CANCEL_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {  json(res, 405, { error: 'method not allowed' }); return }
          if (!trustedRequest(req)) {  json(res, 403, { error: 'forbidden' }); return }
          try {
            json(res, 200, { cancelled: await auth.cancelSignIn() })
          } catch (error: unknown) {
            json(res, 500, { error: safeExternalErrorMessage(error) })
          }
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
      await auth.dispose()
    }
  }, 'dsh-openai-codex: Web OAuth routes')
}

/** Host-owned Codex account-pool reader and cache. */

import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { resolveCodexAccounts, selectCodexAccount } from './accounts.ts'
import { readOpenAICodexAccountName } from './account-name.ts'
import { CodexQuotaAppServerWire } from './wire.ts'
import type { CodexAccountQuota, CodexQuotaSnapshot } from './types.ts'

const DEFAULT_REFRESH_INTERVAL_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_DISPOSE_GRACE_MS = 3_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Deployment policy for Codex homes and app-server lifecycle bounds. */
export interface CodexQuotaConfig {
  /** Ordered Codex homes used for the pool; activeAccountId selects the priority/current account. */
  accountHomes?: string[]
  /** Optional stable ids aligned with accountHomes; generated ordinal ids are used when omitted. */
  accountIds?: string[]
  /** Stable id selected for this plugin process; unknown ids fall back to the first account. */
  activeAccountId?: string
  /** Minimum time a successful or unavailable snapshot remains cached. */
  refreshIntervalMs?: number
  /** Deadline for one account's app-server requests. */
  requestTimeoutMs?: number
  /** Grace between managed child-process termination tiers. */
  disposeGraceMs?: number
  /** Codex executable name or absolute path in the subprocess execution world. */
  codexCommand?: string
}

/** Cordis loader schema for the host provider's explicit configuration. */
export const CodexQuotaConfigSchema: z<CodexQuotaConfig> = z.object({
  accountHomes: z.array(z.string()).default([]),
  accountIds: z.array(z.string()).default([]),
  activeAccountId: z.string().default(''),
  refreshIntervalMs: z.number().default(DEFAULT_REFRESH_INTERVAL_MS),
  requestTimeoutMs: z.number().default(DEFAULT_REQUEST_TIMEOUT_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  codexCommand: z.string().default('codex'),
})

interface ResolvedConfig {
  readonly accountHomes: readonly string[]
  readonly refreshIntervalMs: number
  readonly requestTimeoutMs: number
  readonly disposeGraceMs: number
  readonly codexCommand: string
}

export interface CodexAccountReadSpec {
  readonly accountHome: string
  readonly requestTimeoutMs: number
  readonly disposeGraceMs: number
  readonly codexCommand: string
  readonly cwd: string
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly signal?: AbortSignal
}

/** Host capabilities injected by the DSH subprocess service. */
export interface CodexQuotaProviderOptions {
  /** Spawn a managed process in DSH's execution world. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Working directory for the official Codex app-server process. */
  readonly cwd: string
  /** Generic diagnostic hook; account paths and credentials are never passed. */
  readonly warn?: (message: string) => void
  /** Host-only override used by deterministic tests and alternate readers. */
  readonly readAccount?: (spec: CodexAccountReadSpec) => Promise<CodexAccountQuota>
  /** Count of validated Pool profiles stored by the Host credential owner. */
  readonly readStoredProfileCount?: () => Promise<number>
}

function positiveTimer(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`codex-quota: ${name} must be finite, positive, and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

function absoluteHome(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new TypeError('codex-quota: accountHomes cannot contain an empty path')
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

/**
 * Resolve explicit config, then DSH pool homes, then the standard current Codex home.
 * @param configured - Ordered account homes supplied by plugin configuration.
 * @returns Deduplicated absolute account-home paths in active-account order.
 */
export function resolveCodexAccountHomes(configured: readonly string[] | undefined): readonly string[] {
  const fromEnv = process.env.DSH_CODEX_ACCOUNT_HOMES
  const selected = configured !== undefined && configured.length > 0
    ? configured
    : fromEnv !== undefined && fromEnv.trim().length > 0
      ? fromEnv.split(delimiter)
      : [process.env.CODEX_HOME ?? join(homedir(), '.codex')]
  return Object.freeze([...new Set(selected.map(absoluteHome))])
}

function codexAppServerArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', command, 'app-server', '--stdio']
    : [command, 'app-server', '--stdio']
}

async function disposeChild(wire: CodexQuotaAppServerWire, child: SubprocessHandle): Promise<void> {
  wire.close()
  try {
    child.stdin?.end()
  } catch {
    // Concurrent app-server exit does not change process-tree ownership.
  }
  child.terminate()
  await child.waitForExit()
  await child.done.catch(() => {})
}

/**
 * Read one Codex home through the official app-server protocol.
 * @param spec - Process, timeout, and account-home inputs for the isolated read.
 * @returns Display-safe account quota fields from the official app-server.
 */
export async function readCodexAccountQuota(spec: CodexAccountReadSpec): Promise<CodexAccountQuota> {
  const accountDisplayName = await readOpenAICodexAccountName(spec.accountHome)
  const controller = new AbortController()
  const abortFromCaller = (): void => {
    controller.abort(spec.signal?.reason)
  }
  if (spec.signal?.aborted) controller.abort(spec.signal.reason)
  else spec.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => {
    controller.abort(new Error('codex-quota: app-server request timed out'))
  }, spec.requestTimeoutMs)
  let child: SubprocessHandle | undefined
  let wire: CodexQuotaAppServerWire | undefined
  try {
    child = spec.spawn({
      argv: codexAppServerArgv(spec.codexCommand),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs: spec.disposeGraceMs,
      signal: controller.signal,
      env: { CODEX_HOME: spec.accountHome },
    })
    if (child.stdout === undefined || child.stdin === undefined) {
      throw new Error('codex-quota: subprocess provider did not provide app-server pipes')
    }
    wire = new CodexQuotaAppServerWire(child.stdout, child.stdin)
    const processFailure: Promise<never> = child.done.then(outcome => Promise.reject(new Error(
      `codex-quota: app-server exited before quota read settled (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
    )))
    void processFailure.catch(() => {})
    wire.start()
    await Promise.race([wire.initialize(controller.signal), processFailure])
    return await Promise.race([wire.read(controller.signal, accountDisplayName), processFailure])
  } finally {
    clearTimeout(timeout)
    spec.signal?.removeEventListener('abort', abortFromCaller)
    if (wire !== undefined && child !== undefined) {
      await disposeChild(wire, child)
    } else if (child !== undefined) {
      child.terminate()
      await child.waitForExit()
      await child.done.catch(() => {})
    }
  }
}

/**
 * Aggregate account reads without exposing account-home paths or failures.
 * @param accountHomes - Ordered configured homes used for the pool.
 * @param readAccount - Isolated reader invoked once for every configured home.
 * @param now - Clock used to stamp the point-in-time snapshot.
 * @param activeAccountHome - Selected home whose fields populate the current-account projection.
 * @returns A display-safe current-account and pool snapshot.
 */
export async function assembleCodexQuotaSnapshot(
  accountHomes: readonly string[],
  readAccount: (accountHome: string) => Promise<CodexAccountQuota>,
  now: () => number = Date.now,
  activeAccountHome?: string,
): Promise<CodexQuotaSnapshot> {
  const settled = await Promise.allSettled(accountHomes.map(readAccount))
  const readable = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const activeIndex = activeAccountHome === undefined ? 0 : accountHomes.indexOf(activeAccountHome)
  const currentResult = settled[activeIndex < 0 ? 0 : activeIndex]
  const current = currentResult?.status === 'fulfilled' ? currentResult.value : undefined
  const poolRemainingPercent = readable.length === 0
    ? null
    : Math.round(readable.reduce((total, account) => total + account.remainingPercent, 0) / readable.length)
  return Object.freeze({
    currentAccountName: current?.accountName ?? null,
    currentRemainingPercent: current?.remainingPercent ?? null,
    currentResetsAt: current?.resetsAt ?? null,
    poolAccountCount: accountHomes.length,
    poolRemainingPercent,
    refreshedAt: now(),
  })
}

/** Host-only provider that caches one display-safe account-pool projection. */
export class CodexQuotaProvider {
  private readonly config: ResolvedConfig
  private readonly options: CodexQuotaProviderOptions
  private readonly accounts: ReturnType<typeof resolveCodexAccounts>
  private readonly usesExplicitAccountHomes: boolean
  private activeAccountHome: string | undefined
  private selectionVersion = 0
  private cached: { readonly expiresAt: number; readonly snapshot: CodexQuotaSnapshot } | undefined
  private inFlight: Promise<CodexQuotaSnapshot> | undefined
  private readonly accountCache = new Map<string, { readonly expiresAt: number; readonly quota: CodexAccountQuota }>()
  private readonly accountInFlight = new Map<string, Promise<CodexAccountQuota>>()

  constructor(config: CodexQuotaConfig = {}, options: CodexQuotaProviderOptions) {
    const codexCommand = config.codexCommand?.trim() ?? 'codex'
    if (codexCommand.length === 0) throw new TypeError('codex-quota: codexCommand must not be empty')
    const configuredHomes = config.accountHomes
    const environmentHomes = process.env.DSH_CODEX_ACCOUNT_HOMES
    this.usesExplicitAccountHomes = (configuredHomes !== undefined && configuredHomes.length > 0)
      || (environmentHomes !== undefined && environmentHomes.trim().length > 0)
    const accountHomes = resolveCodexAccountHomes(configuredHomes)
    this.accounts = resolveCodexAccounts(accountHomes, config.accountIds)
    const activeAccount = selectCodexAccount(this.accounts, config.activeAccountId)
    this.config = {
      accountHomes,
      refreshIntervalMs: positiveTimer(
        'refreshIntervalMs',
        config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      ),
      requestTimeoutMs: positiveTimer(
        'requestTimeoutMs',
        config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      disposeGraceMs: positiveTimer(
        'disposeGraceMs',
        config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
      ),
      codexCommand,
    }
    this.activeAccountHome = activeAccount?.home
    this.options = options
  }

  /**
   * Update the current-account projection without changing the pool itself.
   * The next read starts a fresh snapshot so the displayed account cannot be
   * paired with quota data from the previous selection.
   */
  setActiveAccountHome(activeAccountHome: string | undefined): void {
    if (this.activeAccountHome === activeAccountHome) return
    this.activeAccountHome = activeAccountHome
    this.selectionVersion += 1
    this.cached = undefined
  }

  /**
   * Read one account's Host-only quota for request-time allocation.
   *
   * The result is cached with the same interval as the browser projection so
   * a burst of model requests does not start one app-server process per call.
   */
  readAccountQuota(accountId: string, signal?: AbortSignal): Promise<CodexAccountQuota | undefined> {
    const account = this.accounts.find(candidate => candidate.id === accountId)
    if (account === undefined) return Promise.resolve(undefined)
    const now = Date.now()
    const cached = this.accountCache.get(account.id)
    if (cached !== undefined && now < cached.expiresAt) return Promise.resolve(cached.quota)
    const existing = this.accountInFlight.get(account.id)
    if (existing !== undefined) return existing
    const pending = this.readAccountHome(account.home, signal)
      .then(quota => {
        this.accountCache.set(account.id, {
          expiresAt: Date.now() + this.config.refreshIntervalMs,
          quota,
        })
        return quota
      })
      .finally(() => {
        if (this.accountInFlight.get(account.id) === pending) this.accountInFlight.delete(account.id)
      })
    this.accountInFlight.set(account.id, pending)
    return pending
  }

  /**
   * Return one cached, display-safe account-pool snapshot.
   * @returns The latest account and pool quota projection.
   */
  async read(): Promise<CodexQuotaSnapshot> {
    if (this.usesExplicitAccountHomes) return this.readQuotaSnapshot()
    const poolAccountCount = await this.options.readStoredProfileCount?.() ?? 0
    if (poolAccountCount === 0) {
      return Object.freeze({
        currentAccountName: null,
        currentRemainingPercent: null,
        currentResetsAt: null,
        poolAccountCount: 0,
        poolRemainingPercent: null,
        refreshedAt: Date.now(),
      })
    }
    const snapshot = await this.readQuotaSnapshot()
    if (poolAccountCount === snapshot.poolAccountCount) return snapshot
    return Object.freeze({ ...snapshot, poolAccountCount })
  }

  private readQuotaSnapshot(): Promise<CodexQuotaSnapshot> {
    const now = Date.now()
    if (this.cached !== undefined && now < this.cached.expiresAt) {
      return Promise.resolve(this.cached.snapshot)
    }
    if (this.inFlight !== undefined) return this.inFlight
    const selectionVersion = this.selectionVersion
    const readAccount = (accountHome: string): Promise<CodexAccountQuota> => this.readAccountHome(accountHome)
    const pending = assembleCodexQuotaSnapshot(
      this.config.accountHomes,
      readAccount,
      Date.now,
      this.activeAccountHome,
    )
      .then((snapshot) => {
        if (selectionVersion !== this.selectionVersion) {
          // A startup Settings resolution raced the first read. Drop the
          // stale projection and immediately re-read against the new home.
          if (this.inFlight === pending) this.inFlight = undefined
          return this.readQuotaSnapshot()
        }
        this.cached = { expiresAt: Date.now() + this.config.refreshIntervalMs, snapshot }
        return snapshot
      })
      .finally(() => {
        if (this.inFlight === pending) this.inFlight = undefined
      })
    this.inFlight = pending
    return pending
  }

  private readAccountHome(accountHome: string, signal?: AbortSignal): Promise<CodexAccountQuota> {
    const spec: CodexAccountReadSpec = {
      accountHome,
      requestTimeoutMs: this.config.requestTimeoutMs,
      disposeGraceMs: this.config.disposeGraceMs,
      codexCommand: this.config.codexCommand,
      cwd: this.options.cwd,
      spawn: this.options.spawn,
      ...(signal === undefined ? {} : { signal }),
    }
    return (this.options.readAccount ?? readCodexAccountQuota)(spec).catch((error: unknown) => {
      this.options.warn?.('dsh-codex-shared-pool: one configured account could not be read')
      throw error
    })
  }
}

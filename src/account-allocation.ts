/** Host-only global-priority quota allocation and Session account replacement. */

import type { CredentialStore } from '@earendil-works/pi-ai'
import type { OpenAICodexUsage } from './usage.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexCredentialStore } from './store.ts'

const OPENAI_CODEX_SPARK_MODEL = 'gpt-5.3-codex-spark'

type UsageReader = (
  store: CredentialStore,
  signal?: AbortSignal,
) => Promise<OpenAICodexUsage>

type ProfileSwitchObserver = (
  sessionId: string,
  previousProfileId: string,
  profileId: string,
) => void

/** Host-only allocation result. Raw profile ids must never cross into Browser projections. */
export interface LocalProfileAllocation {
  readonly profileId: string
  /** Previously bound profile, or the first skipped priority candidate for a fresh Session. */
  readonly previousProfileId?: string
  readonly reason: import('./shared/types.ts').LocalRoutingReason
}

/**
 * Resolve the provider quota bucket that limits one Codex model.
 * @param model - Provider model id from the current request.
 * @returns Provider-defined quota bucket id.
 */
export function openAICodexQuotaBucket(model: string): 'codex' | 'codex_spark' {
  return model === OPENAI_CODEX_SPARK_MODEL ? 'codex_spark' : 'codex'
}

function isExhausted(usage: OpenAICodexUsage, bucketId: string): boolean {
  if (usage.individualLimit?.remainingPercent === 0) return true
  const bucket = usage.rateLimits.find(limit => limit.id === bucketId)
  return bucket?.windows.some(window => window.remainingPercent === 0) ?? false
}

function quotaResetAt(usage: OpenAICodexUsage, bucketId: string): number | undefined {
  const bucket = usage.rateLimits.find(limit => limit.id === bucketId)
  if (bucket === undefined || bucket.windows.length === 0) return undefined
  const resetTimes = bucket.windows
    .map(window => window.resetsAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return resetTimes.length === 0 ? undefined : Math.min(...resetTimes)
}

function hasKnownModelQuota(usage: OpenAICodexUsage, bucketId: string): boolean {
  const bucket = usage.rateLimits.find(limit => limit.id === bucketId)
  return bucket !== undefined && bucket.windows.length > 0
}

/**
 * Inspect the global priority before every request. When it is proven exhausted,
 * choose the usable fallback whose provider reset time is earliest and promote it
 * to global priority. Missing quota metadata remains a fail-open fallback only when
 * no account has proven model capacity. Concurrent replacement preserves its winner.
 *
 * @param store - Host-owned ordered profile and Session-binding store.
 * @param sessionId - Session receiving a provider request.
 * @param model - Codex model selected for the request.
 * @param signal - Optional request cancellation signal.
 * @param readUsage - Quota reader override used by focused tests.
 * @param onProfileSwitch - Called only by the request that commits a profile replacement.
 * @returns The committed profile and decision reason, or undefined when signed out.
 */
export async function allocateOpenAICodexSessionProfile(
  store: OpenAICodexCredentialStore,
  sessionId: string,
  model: string,
  signal?: AbortSignal,
  readUsage: UsageReader = readOpenAICodexRateLimits,
  onProfileSwitch?: ProfileSwitchObserver,
): Promise<LocalProfileAllocation | undefined> {
  const existing = await store.sessionProfileId(sessionId)
  const profiles = await store.listProfiles()
  const first = profiles[0]
  if (first === undefined) return undefined
  const bucketId = openAICodexQuotaBucket(model)
  const commit = async (
    profileId: string,
    reason: LocalProfileAllocation['reason'],
    skippedPriorityProfileId?: string,
  ): Promise<LocalProfileAllocation | undefined> => {
    if (existing === undefined) {
      const boundProfileId = await store.bindSessionProfile(sessionId, profileId)
      return {
        profileId: boundProfileId,
        ...boundProfileId === profileId && skippedPriorityProfileId !== undefined
          ? { previousProfileId: skippedPriorityProfileId }
          : {},
        reason,
      }
    }
    const replacement = await store.replaceSessionProfile(sessionId, existing, profileId)
    if (replacement?.replaced === true) onProfileSwitch?.(sessionId, existing, replacement.profileId)
    if (replacement === undefined) {
      return allocateOpenAICodexSessionProfile(store, sessionId, model, signal, readUsage, onProfileSwitch)
    }
    if (replacement.profileId !== profileId) {
      return { profileId: replacement.profileId, reason: 'concurrent_binding' }
    }
    return {
      profileId: replacement.profileId,
      ...replacement.replaced ? { previousProfileId: existing } : {},
      reason,
    }
  }

  const ensureUnchangedBinding = async (): Promise<LocalProfileAllocation | undefined | null> => {
    const concurrentBinding = await store.sessionProfileId(sessionId)
    if (concurrentBinding !== existing) {
      if (concurrentBinding !== undefined) {
        return { profileId: concurrentBinding, reason: 'concurrent_binding' }
      }
      return allocateOpenAICodexSessionProfile(store, sessionId, model, signal, readUsage, onProfileSwitch)
    }
    return null
  }

  const concurrent = await ensureUnchangedBinding()
  if (concurrent !== null) return concurrent
  let firstUsage: OpenAICodexUsage
  try {
    firstUsage = await readUsage(store.forProfile(first.id), signal)
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    return commit(first.id, 'quota_unknown')
  }
  if (!isExhausted(firstUsage, bucketId)) return commit(first.id, 'priority')

  const usable: Array<{ profileId: string; resetAt: number | undefined; index: number }> = []
  const unknown: Array<{ profileId: string; index: number }> = []
  for (const [index, profile] of profiles.slice(1).entries()) {
    const concurrent = await ensureUnchangedBinding()
    if (concurrent !== null) return concurrent
    let usage: OpenAICodexUsage
    try {
      usage = await readUsage(store.forProfile(profile.id), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      unknown.push({ profileId: profile.id, index })
      continue
    }
    if (isExhausted(usage, bucketId)) continue
    if (!hasKnownModelQuota(usage, bucketId)) {
      unknown.push({ profileId: profile.id, index })
      continue
    }
    usable.push({ profileId: profile.id, resetAt: quotaResetAt(usage, bucketId), index })
  }

  const selected = usable.sort((left, right) => (
    (left.resetAt ?? Number.POSITIVE_INFINITY) - (right.resetAt ?? Number.POSITIVE_INFINITY)
    || left.index - right.index
  ))[0]
  if (selected !== undefined) {
    const allocation = await commit(selected.profileId, 'quota_fallback', first.id)
    if (allocation?.profileId === selected.profileId && allocation.reason === 'quota_fallback') {
      await store.prioritizeProfile(selected.profileId)
    }
    return allocation
  }

  const failOpen = unknown.sort((left, right) => left.index - right.index)[0]
  if (failOpen !== undefined) return commit(failOpen.profileId, 'quota_unknown', first.id)

  return {
    profileId: existing ?? await store.bindSessionProfile(sessionId, first.id),
    reason: 'all_exhausted',
  }
}

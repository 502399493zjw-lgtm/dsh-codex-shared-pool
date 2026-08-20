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

/**
 * Scan the global profile order before every request and commit the first profile
 * whose model-specific quota is not proven exhausted. Missing quota metadata keeps
 * the inspected profile eligible. Concurrent replacement preserves its winner.
 *
 * @param store - Host-owned ordered profile and Session-binding store.
 * @param sessionId - Session receiving a provider request.
 * @param model - Codex model selected for the request.
 * @param signal - Optional request cancellation signal.
 * @param readUsage - Quota reader override used by focused tests.
 * @param onProfileSwitch - Called only by the request that commits a profile replacement.
 * @returns The profile id committed to the Session, or undefined when signed out.
 */
export async function allocateOpenAICodexSessionProfile(
  store: OpenAICodexCredentialStore,
  sessionId: string,
  model: string,
  signal?: AbortSignal,
  readUsage: UsageReader = readOpenAICodexRateLimits,
  onProfileSwitch?: ProfileSwitchObserver,
): Promise<string | undefined> {
  const existing = await store.sessionProfileId(sessionId)
  const profiles = await store.listProfiles()
  const first = profiles[0]
  if (first === undefined) return undefined
  const bucketId = openAICodexQuotaBucket(model)
  const commit = async (profileId: string): Promise<string | undefined> => {
    if (existing === undefined) return store.bindSessionProfile(sessionId, profileId)
    const replacement = await store.replaceSessionProfile(sessionId, existing, profileId)
    if (replacement?.replaced === true) onProfileSwitch?.(sessionId, existing, replacement.profileId)
    return replacement?.profileId
      ?? allocateOpenAICodexSessionProfile(store, sessionId, model, signal, readUsage, onProfileSwitch)
  }

  for (const profile of profiles) {
    const concurrentBinding = await store.sessionProfileId(sessionId)
    if (concurrentBinding !== existing) {
      if (concurrentBinding !== undefined) return concurrentBinding
      return allocateOpenAICodexSessionProfile(store, sessionId, model, signal, readUsage, onProfileSwitch)
    }
    let usage: OpenAICodexUsage
    try {
      usage = await readUsage(store.forProfile(profile.id), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      return commit(profile.id)
    }
    if (!isExhausted(usage, bucketId)) return commit(profile.id)
  }

  return existing ?? store.bindSessionProfile(sessionId, first.id)
}

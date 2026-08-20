import type { OpenAICodexUsage } from '../../shared/types.ts'

const CODEX_QUOTA_INVALIDATION_EVENT = 'dsh-openai-codex:quota-invalidated'

interface QuotaProfileProjection {
  readonly id: string
  readonly label: string
  readonly usage: OpenAICodexUsage
  readonly quotaError?: string
}

function codexQuotaProfilesRevision(profiles: readonly QuotaProfileProjection[]): string {
  return JSON.stringify(profiles.map((profile) => {
    const window = profile.usage.rateLimits
      .find(rateLimit => rateLimit.id === 'codex')
      ?.windows[0]
    return [
      profile.id,
      profile.label,
      window?.remainingPercent ?? null,
      window?.resetsAt ?? null,
      profile.quotaError !== undefined,
    ]
  }))
}

/** Notify mounted quota consumers that the profile-backed projection changed. */
export function invalidateCodexQuota(): void {
  window.dispatchEvent(new Event(CODEX_QUOTA_INVALIDATION_EVENT))
}

/** Subscribe to same-page quota invalidations without exposing profile credentials. */
export function subscribeCodexQuotaInvalidation(listener: () => void): () => void {
  window.addEventListener(CODEX_QUOTA_INVALIDATION_EVENT, listener)
  return () => { window.removeEventListener(CODEX_QUOTA_INVALIDATION_EVENT, listener) }
}

/**
 * Compare the browser-safe profile projection and invalidate quota consumers on change.
 * The first ready projection establishes a baseline and does not emit an extra read.
 */
export function observeCodexQuotaProfiles(
  previousRevision: string | undefined,
  profiles: readonly QuotaProfileProjection[],
  notify: () => void = invalidateCodexQuota,
): string {
  const nextRevision = codexQuotaProfilesRevision(profiles)
  if (previousRevision !== undefined && previousRevision !== nextRevision) notify()
  return nextRevision
}

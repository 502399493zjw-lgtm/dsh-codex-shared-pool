/** Host-side projection from ordered stored profiles to the browser quota snapshot. */

import type { OpenAICodexUsage } from '../usage.ts'
import type { CodexQuotaSnapshot } from './types.ts'

const PROFILE_TOTAL_QUOTA = 100

/** Minimum Browser-safe profile metadata needed for quota aggregation. */
export interface OpenAICodexProfileQuotaInput {
  readonly label: string
  readonly usage: OpenAICodexUsage
}

function primaryCodexWindow(profile: OpenAICodexProfileQuotaInput) {
  return profile.usage.rateLimits.find(limit => limit.id === 'codex')?.windows[0]
}

function hasExhaustedCodexQuota(profile: OpenAICodexProfileQuotaInput): boolean {
  if (profile.usage.individualLimit?.remainingPercent === 0) return true
  return profile.usage.rateLimits
    .find(limit => limit.id === 'codex')
    ?.windows.some(window => window.remainingPercent === 0) ?? false
}

/**
 * Assemble quota from the same ordered stored profiles shown in Settings.
 *
 * The current account follows request allocation: scan global priority order
 * and skip profiles whose regular Codex quota is proven exhausted. Unreadable
 * usage stays eligible and never removes a stored profile from the pool count.
 */
export function assembleOpenAICodexProfileQuota(
  profiles: readonly OpenAICodexProfileQuotaInput[],
  now: () => number = Date.now,
): CodexQuotaSnapshot {
  const currentProfile = profiles.find(profile => !hasExhaustedCodexQuota(profile))
    ?? profiles[0]
  const currentWindow = currentProfile === undefined ? undefined : primaryCodexWindow(currentProfile)
  const windows = profiles.map(primaryCodexWindow)
  const allRemainingQuotaKnown = windows.every(window => window !== undefined)
  const totalQuota = profiles.length * PROFILE_TOTAL_QUOTA
  const remainingQuota = windows.reduce(
    (total, window) => total + (window?.remainingPercent ?? 0),
    0,
  )

  return Object.freeze({
    currentAccountName: currentProfile?.label ?? null,
    currentRemainingPercent: currentWindow?.remainingPercent ?? null,
    currentResetsAt: currentWindow?.resetsAt ?? null,
    poolAccountCount: profiles.length,
    poolRemainingPercent: totalQuota === 0 || !allRemainingQuotaKnown
      ? null
      : Math.round((remainingQuota / totalQuota) * 100),
    refreshedAt: now(),
  })
}

import { useEffect, useState } from 'react'
import { subscribeCodexQuotaInvalidation } from './invalidation.ts'

/** Browser-safe aggregate returned by the plugin-owned quota route. */
export interface CodexQuotaSnapshot {
  readonly currentAccountName: string | null
  readonly currentRemainingPercent: number | null
  readonly currentResetsAt: number | null
  readonly poolAccountCount: number
  readonly poolRemainingPercent: number | null
  readonly refreshedAt: number
}

export const CODEX_QUOTA_PATH = '/plugins/dsh-openai-codex/quota'

/** Refresh cadence; Host caching prevents duplicate app-server reads. */
export const CODEX_QUOTA_POLL_INTERVAL_MS = 60_000

/** Minimum remote face shared by the sidebar summary and Settings section. */
export interface CodexQuotaReadFace {
  readonly read: () => Promise<CodexQuotaSnapshot>
}

/** Current browser-side projection of the polled Codex quota snapshot. */
export interface CodexQuotaViewState {
  readonly snapshot: CodexQuotaSnapshot | undefined
  readonly unavailable: boolean
}

/**
 * Poll the credential-safe Codex quota Remote for one mounted view.
 * @param read - typed Remote read callback.
 * @returns the latest snapshot and its neutral unavailable state.
 */
export function useCodexQuota(read: CodexQuotaReadFace['read']): CodexQuotaViewState {
  const [snapshot, setSnapshot] = useState<CodexQuotaSnapshot>()
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let active = true
    let requestRevision = 0
    const refresh = (): void => {
      const revision = ++requestRevision
      void read().then((next) => {
        if (!active || revision !== requestRevision) return
        setSnapshot(next)
        setUnavailable(next.currentRemainingPercent === null)
      }, () => {
        if (active && revision === requestRevision) setUnavailable(true)
      })
    }
    refresh()
    const unsubscribe = subscribeCodexQuotaInvalidation(refresh)
    const timer = setInterval(refresh, CODEX_QUOTA_POLL_INTERVAL_MS)
    return () => {
      active = false
      requestRevision += 1
      unsubscribe()
      clearInterval(timer)
    }
  }, [read])

  return { snapshot, unavailable }
}

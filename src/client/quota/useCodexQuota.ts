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
  /** The latest completed read failed; any retained snapshot is now stale. */
  readonly refreshFailed: boolean
}

/**
 * Poll the credential-safe Codex quota Remote for one mounted view.
 * @param read - typed Remote read callback.
 * @returns the last successful snapshot, availability, and read-failure state.
 */
export function useCodexQuota(read: CodexQuotaReadFace['read']): CodexQuotaViewState {
  const [snapshot, setSnapshot] = useState<CodexQuotaSnapshot>()
  const [unavailable, setUnavailable] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)

  useEffect(() => {
    let active = true
    let requestRevision = 0
    const refresh = (): void => {
      const revision = ++requestRevision
      void read().then((next) => {
        if (!active || revision !== requestRevision) return
        setSnapshot(next)
        setUnavailable(next.currentRemainingPercent === null)
        setRefreshFailed(false)
      }, () => {
        if (!active || revision !== requestRevision) return
        setUnavailable(true)
        setRefreshFailed(true)
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

  return { snapshot, unavailable, refreshFailed }
}

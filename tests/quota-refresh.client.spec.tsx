// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateCodexQuota,
  observeCodexQuotaProfiles,
} from '../src/client/quota/invalidation.ts'
import {
  CODEX_QUOTA_POLL_INTERVAL_MS,
  useCodexQuota,
  type CodexQuotaSnapshot,
} from '../src/client/quota/useCodexQuota.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function snapshot(poolAccountCount: number, remaining = 50): CodexQuotaSnapshot {
  return {
    currentAccountName: poolAccountCount === 0 ? null : 'priority',
    currentRemainingPercent: poolAccountCount === 0 ? null : remaining,
    currentResetsAt: null,
    poolAccountCount,
    poolRemainingPercent: poolAccountCount === 0 ? null : remaining,
    refreshedAt: poolAccountCount,
  }
}

function webProfile(id: string, remainingPercent: number) {
  return {
    id,
    label: id,
    usage: {
      rateLimits: [{
        id: 'codex',
        windows: [{ remainingPercent, windowSeconds: 604_800 }],
      }],
    },
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('Codex quota profile invalidation', () => {
  it('publishes changes for 0→1→3 profiles, priority reorder, deletion, and usage updates', () => {
    const notify = vi.fn()
    let revision = observeCodexQuotaProfiles(undefined, [], notify)
    expect(notify).not.toHaveBeenCalled()

    const one = [webProfile('a', 0)]
    revision = observeCodexQuotaProfiles(revision, one, notify)
    const three = [webProfile('a', 0), webProfile('b', 38), webProfile('c', 80)]
    revision = observeCodexQuotaProfiles(revision, three, notify)
    revision = observeCodexQuotaProfiles(revision, [three[1]!, three[0]!, three[2]!], notify)
    revision = observeCodexQuotaProfiles(revision, [three[0]!, three[2]!], notify)
    revision = observeCodexQuotaProfiles(revision, [webProfile('a', 0), webProfile('c', 79)], notify)

    expect(notify).toHaveBeenCalledTimes(5)
    expect(observeCodexQuotaProfiles(revision, [webProfile('a', 0), webProfile('c', 79)], notify))
      .toBe(revision)
    expect(notify).toHaveBeenCalledTimes(5)
  })
})

describe('Codex quota refresh hook', () => {
  it('refreshes immediately when Settings invalidates the profile projection', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(snapshot(0))
      .mockResolvedValueOnce(snapshot(3, 39))
    const view = renderHook(() => useCodexQuota(read))

    await waitFor(() => { expect(view.result.current.snapshot?.poolAccountCount).toBe(0) })
    act(() => { invalidateCodexQuota() })
    await waitFor(() => { expect(view.result.current.snapshot?.poolAccountCount).toBe(3) })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('retains the 60-second background poll', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue(snapshot(1))
    renderHook(() => useCodexQuota(read))

    await act(async () => { await Promise.resolve() })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODEX_QUOTA_POLL_INTERVAL_MS)
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not let an older read overwrite a newer invalidated response', async () => {
    const older = deferred<CodexQuotaSnapshot>()
    const newer = deferred<CodexQuotaSnapshot>()
    const read = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const view = renderHook(() => useCodexQuota(read))
    expect(read).toHaveBeenCalledTimes(1)

    act(() => { invalidateCodexQuota() })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { newer.resolve(snapshot(3, 39)); await newer.promise })
    expect(view.result.current.snapshot).toMatchObject({ poolAccountCount: 3, poolRemainingPercent: 39 })

    await act(async () => { older.resolve(snapshot(1, 1)); await older.promise })
    expect(view.result.current.snapshot).toMatchObject({ poolAccountCount: 3, poolRemainingPercent: 39 })
  })

  it('removes its invalidation listener and timer on unmount', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue(snapshot(1))
    const view = renderHook(() => useCodexQuota(read))
    await act(async () => { await Promise.resolve() })
    view.unmount()

    act(() => { invalidateCodexQuota() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODEX_QUOTA_POLL_INTERVAL_MS)
    })
    expect(read).toHaveBeenCalledTimes(1)
  })
})

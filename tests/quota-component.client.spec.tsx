// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronRightOutline14: ({ size }: { size?: number }) => <svg data-size={size} />,
}))

import {
  CodexQuotaFooter,
  CODEX_QUOTA_POLL_INTERVAL_MS,
  type CodexQuotaFooterProps,
  formatCodexResetTime,
} from '../src/client/quota/CodexQuotaFooter.tsx'
import css from '../src/client/quota/CodexQuotaFooter.module.css'
import { en, zh, type CodexQuotaLocaleKey } from '../src/client/quota/locales.ts'
import type { CodexQuotaSnapshot } from '../src/client/quota/useCodexQuota.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const SNAPSHOT = {
  currentAccountName: '经纬 钟',
  currentRemainingPercent: 73,
  currentResetsAt: null,
  poolAccountCount: 12,
  poolRemainingPercent: 61,
  refreshedAt: 1,
} as const

function translate(locale: Record<CodexQuotaLocaleKey, string>): CodexQuotaFooterProps['t'] {
  return (key, params) => {
    let value: string = locale[key]
    for (const [name, replacement] of Object.entries(params ?? {})) {
      value = value.replace(`{${name}}`, String(replacement))
    }
    return value
  }
}

const t = translate(zh)

function props(overrides: Partial<CodexQuotaFooterProps> = {}): CodexQuotaFooterProps {
  return {
    wide: true,
    read: vi.fn().mockResolvedValue(SNAPSHOT),
    openSettings: vi.fn(),
    t,
    ...overrides,
  } as CodexQuotaFooterProps
}

describe('unified Codex quota footer', () => {
  it('uses the settings account name and reserves blue for the current quota', async () => {
    const view = render(<CodexQuotaFooter {...props()} />)
    expect(await screen.findByText('经纬 钟')).toBeTruthy()

    const rows = view.container.querySelectorAll(`.${css.current}, .${css.pool}`)
    expect(rows).toHaveLength(2)
    expect(view.container.querySelector(`.${css.accountLine}`)?.textContent).toBe('Codex 账号：经纬 钟')
    expect(rows[0]?.textContent).toBe('剩余 73% · 重置时间未知')
    expect(rows[1]?.textContent).toBe('账号池 12 个账号 · 总剩余 61%')

    const blue = view.container.querySelectorAll(`.${css.quota}`)
    expect([...blue].map(node => node.textContent)).toEqual(['73%'])
    expect(view.container.querySelectorAll(`.${css.separator}`)).toHaveLength(2)
    const open = screen.getByRole('button', { name: '打开' })
    expect(view.container.querySelector(`.${css.accountLine}`)?.parentElement).toBe(open.parentElement)
    expect(rows[0]?.parentElement).toBe(view.container.firstElementChild)
    expect(rows[1]?.parentElement).toBe(view.container.firstElementChild)
  })

  it('opens the unified Codex settings section from the arrow action', async () => {
    const openSettings = vi.fn()
    render(<CodexQuotaFooter {...props({ openSettings })} />)
    await screen.findByText('经纬 钟')

    const open = screen.getByRole('button', { name: '打开' })
    expect(open.textContent).toBe('')
    expect(open.querySelector('svg')).not.toBeNull()
    fireEvent.click(open)

    expect(openSettings).toHaveBeenCalledOnce()
  })

  it('does not render the two-line block in the collapsed rail', () => {
    const read = vi.fn().mockResolvedValue(SNAPSHOT)
    const view = render(<CodexQuotaFooter {...props({ wide: false, read })} />)
    expect(view.container.childElementCount).toBe(0)
  })

  it.each([
    { locale: zh, failed: '更新失败', updated: '上次更新 2026-09-06 08:30' },
    { locale: en, failed: 'Update failed', updated: 'Last updated 2026-09-06 08:30' },
  ])('retains stale values and their update time after a failed poll, then recovers ($failed)', async ({ locale, failed, updated }) => {
    vi.useFakeTimers()
    const refreshedAt = new Date(2026, 8, 6, 8, 30).getTime()
    const recovery = Promise.withResolvers<CodexQuotaSnapshot>()
    const read = vi.fn()
      .mockResolvedValueOnce({ ...SNAPSHOT, refreshedAt })
      .mockRejectedValueOnce(new Error('private account path'))
      .mockReturnValueOnce(recovery.promise)
    const view = render(<CodexQuotaFooter {...props({ read, t: translate(locale) })} />)
    expect(screen.getByText(locale.loading)).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('73%')).toBeTruthy()
    expect(screen.queryByText(failed)).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_QUOTA_POLL_INTERVAL_MS) })
    expect(screen.getByText('73%')).toBeTruthy()
    expect(screen.getByText('61%')).toBeTruthy()
    expect(screen.getByText('经纬 钟')).toBeTruthy()
    const feedback = screen.getByRole('status')
    expect(feedback.textContent).toContain(failed)
    expect(feedback.textContent).toContain(updated)
    expect(feedback.getAttribute('aria-atomic')).toBe('true')
    expect(feedback.querySelector('time')?.dateTime).toBe(new Date(refreshedAt).toISOString())
    expect(view.container.firstElementChild?.getAttribute('data-stale')).toBe('true')
    expect(view.container.textContent).not.toContain('private account path')

    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_QUOTA_POLL_INTERVAL_MS) })
    expect(screen.getByRole('status').textContent).toContain(updated)
    expect(screen.getByText('73%')).toBeTruthy()
    await act(async () => {
      recovery.resolve({ ...SNAPSHOT, currentRemainingPercent: 42, poolRemainingPercent: 55, refreshedAt: refreshedAt + 120_000 })
      await recovery.promise
    })
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.getByText('55%')).toBeTruthy()
    expect(screen.queryByText('73%')).toBeNull()
    expect(screen.queryByText(failed)).toBeNull()
    expect(view.container.querySelector('time')).toBeNull()
    expect(view.container.firstElementChild?.hasAttribute('data-stale')).toBe(false)
  })

  it.each([zh, en])('distinguishes first load and first failure without inventing a previous update, then recovers', async (locale) => {
    vi.useFakeTimers()
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('private account path'))
      .mockResolvedValueOnce(SNAPSHOT)
    const view = render(<CodexQuotaFooter {...props({ read, t: translate(locale) })} />)
    expect(screen.getByText(locale.loading)).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(locale.unavailable)).toBeTruthy()
    expect(screen.queryByText(locale.loading)).toBeNull()
    expect(view.container.textContent).not.toContain('private account path')
    expect(view.container.textContent).not.toContain('%')
    expect(view.container.querySelector('time')).toBeNull()
    expect(view.container.firstElementChild?.hasAttribute('data-stale')).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_QUOTA_POLL_INTERVAL_MS) })
    expect(screen.getByText('73%')).toBeTruthy()
    expect(screen.queryByText(locale.unavailable)).toBeNull()
  })

  it.each([
    [null, '账号池 12 个账号'],
    [61, '账号池 12 个账号 · 总剩余 61%'],
  ])('keeps pool context when the current account cannot be summarized', async (
    poolRemainingPercent,
    expectedPool,
  ) => {
    const read = vi.fn().mockResolvedValue({
      ...SNAPSHOT,
      currentAccountName: null,
      currentRemainingPercent: null,
      poolRemainingPercent,
    })
    const view = render(<CodexQuotaFooter {...props({ read })} />)

    await waitFor(() => {
      expect(view.container.querySelector(`.${css.pool}`)?.textContent).toBe(expectedPool)
    })
    expect(screen.getByRole('button', { name: '打开' })).toBeTruthy()
  })

  it('marks retained pool data as stale only after a failed read when the current quota is unknown', async () => {
    vi.useFakeTimers()
    const refreshedAt = new Date(2026, 8, 6, 8, 30).getTime()
    const read = vi.fn()
      .mockResolvedValueOnce({
        ...SNAPSHOT,
        currentAccountName: null,
        currentRemainingPercent: null,
        refreshedAt,
      })
      .mockRejectedValueOnce(new Error('private transport error'))
    const view = render(<CodexQuotaFooter {...props({ read })} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(zh.unavailable)).toBeTruthy()
    expect(screen.getByText('61%')).toBeTruthy()
    expect(screen.queryByText('更新失败')).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_QUOTA_POLL_INTERVAL_MS) })
    expect(screen.getByText(zh.unavailable)).toBeTruthy()
    expect(view.container.querySelector(`.${css.pool}`)?.textContent).toBe('账号池 12 个账号 · 总剩余 61%')
    expect(screen.getByRole('status').textContent).toBe('更新失败 上次更新 2026-09-06 08:30')
    expect(view.container.firstElementChild?.getAttribute('data-stale')).toBe('true')
    expect(view.container.textContent).not.toContain('private transport error')
  })

  it('formats reset instants as local unpadded month and day with padded time', () => {
    const epochMs = new Date(2026, 7, 17, 5, 4).getTime()

    expect(formatCodexResetTime(epochMs)).toBe('8月17 05:04')
  })

  it('formats a known reset time and renders an unknown pool percentage neutrally', async () => {
    const read = vi.fn().mockResolvedValue({
      ...SNAPSHOT,
      currentResetsAt: 0,
      poolRemainingPercent: null,
    })
    const view = render(<CodexQuotaFooter {...props({ read })} />)

    expect(await screen.findByText(zh.resetAt.replace('{time}', formatCodexResetTime(0))))
      .toBeTruthy()
    expect(view.container.querySelector(`.${css.pool}`)?.textContent)
      .toBe('账号池 12 个账号 · 总剩余 —')
  })
})

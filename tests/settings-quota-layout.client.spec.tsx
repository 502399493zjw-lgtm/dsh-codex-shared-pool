// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement } = await import('react')
  const Icon = (props: Record<string, unknown>) => createElement('svg', props)
  return {
    Button: ({ children, icon, disabled, onClick, className }: {
      children?: ReactNode
      icon?: ReactNode
      disabled?: boolean
      onClick?: () => void
      className?: string
    }) => createElement('button', { type: 'button', disabled, onClick, className }, icon, children),
    Input: (props: Record<string, unknown>) => createElement('input', props),
    Modal: ({ open, children, footer, title }: {
      open?: boolean
      children?: ReactNode
      footer?: ReactNode
      title?: ReactNode
    }) => open ? createElement('section', {}, title, children, footer) : null,
    StateDot: (props: Record<string, unknown>) => createElement('span', props),
    IconChevronDownOutline14: Icon,
    IconGlobeOutline14: Icon,
    IconPlusOutline16: Icon,
    IconTrashOutline16: Icon,
  }
})

import { OpenAICodexSettings } from '../src/client/OpenAICodexSettings.tsx'
import { en, zh, type OpenAICodexSettingsKey } from '../src/client/locales.ts'
import { resetResponsePreferencesForTests } from '../src/client/response-preferences.ts'

afterEach(() => {
  cleanup()
  resetResponsePreferencesForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function response(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(value),
  } as Response
}

function requestPath(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

describe('local account quota presentation', () => {
  it.each([en, zh].flatMap(locale => [
    { locale, planType: 'pro', label: 'Pro 20x' },
    { locale, planType: 'prolite', label: 'Pro 5x' },
    { locale, planType: 'plus', label: 'Plus' },
    { locale, planType: undefined, label: locale.unknownSubscription },
    { locale, planType: 'unrecognized-plan', label: locale.unknownSubscription },
  ]))('shows $planType beside the subscription heading without estimate rows', async ({ locale, planType, label }) => {
    const profile = { id: 'sample', label: 'Sample account', createdAt: 1, updatedAt: 1,
      usage: { planType, rateLimits: [] } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input)
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) return response({ status: 'ready', profiles: [profile] })
      if (path.endsWith('/routing-events')) return response({ events: [] })
      return response({})
    }))
    render(<OpenAICodexSettings t={key => locale[key]} />)
    const title = await screen.findByRole('heading', { name: locale.subscriptionDetails })
    expect(within(title.parentElement!).getByText(label).parentElement).toBe(title.parentElement)
    expect(screen.queryByText(locale.subscriptionTier)).toBeNull()
    expect(screen.queryByText(locale.weeklyEstimate)).toBeNull()
    expect(screen.queryByText(/US\$/)).toBeNull()
  })

  it.each([en, zh])('groups model quotas and keeps compact values accessible', async (locale) => {
    const t = (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => {
      let value: string = locale[key]
      for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
      return value
    }
    const profile = { id: 'sample', label: 'Sample account', createdAt: 1, updatedAt: 1, usage: {
      rateLimits: [
        { id: 'codex', name: 'Codex', windows: [{ windowSeconds: 604800, remainingPercent: 0 }] },
        { id: 'spark', name: 'GPT-5.3-Codex-Spark', windows: [
          { windowSeconds: 18000, remainingPercent: 100 },
          { windowSeconds: 604800, remainingPercent: 37.5 },
        ] },
      ],
      individualLimit: { remainingPercent: 25, remaining: 50, limit: 200 },
    } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input)
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) return response({ status: 'ready', profiles: [profile] })
      if (path.endsWith('/routing-events')) return response({ events: [] })
      return response({})
    }))
    render(<OpenAICodexSettings t={t} />)
    await screen.findByRole('heading', { name: locale === en ? 'Subscription details' : '订阅信息' })
    const quotas = screen.getByRole('region', { name: locale === en ? 'Model quotas' : '模型额度' })
    expect(within(quotas).queryByRole('heading', { name: locale.modelQuotas })).toBeNull()
    expect(within(quotas).queryByText(locale.quotaRemaining)).toBeNull()
    expect(within(quotas).getByText(locale === en ? 'Exhausted' : '已用尽')).toBeDefined()
    expect(within(quotas).getByText(t('percentRemaining', { percent: '100' }))).toBeDefined()
    expect(within(quotas).getByText(t('percentRemaining', { percent: '37.5' }))).toBeDefined()
    const bars = within(quotas).getAllByRole('progressbar')
    expect(bars.map(bar => bar.getAttribute('aria-valuenow'))).toEqual(['0', '100', '37.5', '25'])
    expect(bars[2]?.getAttribute('aria-valuetext')).toBe(t('percentRemaining', { percent: '37.5' }))
    expect(within(quotas).getByText(t('exactRemaining', { remaining: 50, limit: 200 }))).toBeDefined()
  })

  it.each([en, zh])('labels each reset in the UI language and handles missing or elapsed instants without changing quota', async locale => {
    const now = new Date(2030, 0, 10, 12, 0).getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const fiveHourReset = new Date(2030, 0, 10, 17, 5).getTime()
    const weeklyReset = new Date(2030, 0, 17, 9, 30).getTime()
    const profile = { id: 'sample', label: 'Sample account', createdAt: 1, updatedAt: 1, usage: {
      rateLimits: [
        { id: 'codex', windows: [
          { windowSeconds: 18000, remainingPercent: 80, resetsAt: fiveHourReset },
          { windowSeconds: 604800, remainingPercent: 37.5, resetsAt: weeklyReset },
        ] },
        { id: 'missing', windows: [{ windowSeconds: 18000, remainingPercent: 60 }] },
        { id: 'invalid', windows: [{ windowSeconds: 18000, remainingPercent: 50, resetsAt: 9e15 }] },
        { id: 'elapsed', windows: [{ windowSeconds: 18000, remainingPercent: 0, resetsAt: now - 1 }] },
        { id: 'due', windows: [{ windowSeconds: 18000, remainingPercent: 10, resetsAt: now }] },
      ],
    } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input)
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) return response({ status: 'ready', profiles: [profile] })
      if (path.endsWith('/routing-events')) return response({ events: [] })
      return response({})
    }))
    const t = (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => Object.entries(params ?? {})
      .reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), locale[key] as string)
    render(<OpenAICodexSettings t={t} />)
    const quotas = await screen.findByRole('region', { name: locale.modelQuotas })
    const fiveHour = await within(quotas).findByText(locale === en ? 'Resets 1/10 at 17:05' : '1月10日 17:05 重置')
    const weekly = within(quotas).getByText(locale === en ? 'Resets 1/17 at 09:30' : '1月17日 09:30 重置')
    expect(fiveHour.closest('time')?.dateTime).toBe(new Date(fiveHourReset).toISOString())
    expect(weekly.closest('time')?.dateTime).toBe(new Date(weeklyReset).toISOString())
    const codexBars = within(quotas).getAllByRole('progressbar').slice(0, 2)
    expect(codexBars.map(bar => bar.getAttribute('aria-label'))).toEqual([locale.fiveHourLimit, locale.weeklyLimit])
    expect(codexBars.map(bar => document.getElementById(bar.getAttribute('aria-describedby')!)?.textContent)).toEqual([fiveHour.textContent, weekly.textContent])
    expect(within(quotas).getAllByText(locale === en ? 'Reset time unavailable' : '重置时间未知')).toHaveLength(2)
    expect(within(quotas).getAllByText(locale === en ? 'Reset time passed; awaiting update' : '重置时间已过，等待更新')).toHaveLength(2)
    expect(within(quotas).getAllByRole('progressbar').map(bar => bar.getAttribute('aria-valuenow'))).toEqual(['80', '37.5', '60', '50', '0', '10'])
  })

  it.each([en, zh])('leads account choices with recognizable names, followed by priority and readable status', async locale => {
    const profiles = [
      { id: 'work', label: 'Work Pro', createdAt: 1, updatedAt: 1, connectionStatus: 'connected', usage: { rateLimits: [] } },
      { id: 'blank', label: '   ', createdAt: 1, updatedAt: 1, connectionStatus: 'reauth-required', usage: { rateLimits: [] } },
      { id: 'pending', label: 'Personal', createdAt: 1, updatedAt: 1, usage: { rateLimits: [] } },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input)
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) return response({ status: 'ready', profiles })
      if (path.endsWith('/routing-events')) return response({ events: [] })
      return response({})
    }))
    const t = (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => Object.entries(params ?? {})
      .reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), locale[key] as string)
    render(<OpenAICodexSettings t={t} />)
    const list = screen.getByRole('complementary', { name: locale.accountList })
    const work = await within(list).findByRole('button', { name: /^Work Pro/ })
    expect(work.getAttribute('aria-current')).toBe('true')
    expect(within(work).getByText(t('priorityPosition', { rank: 1 }))).toBeDefined()
    expect(await within(work).findByText(locale.accountConnected)).toBeDefined()
    expect(within(work).getByText(locale.profileInUse)).toBeDefined()
    const fallback = t('accountAlias', { alias: 2 })
    const unnamed = within(list).getByRole('button', { name: new RegExp(`^${fallback}`) })
    expect(within(unnamed).getByText(locale.accountConnectionUnavailable)).toBeDefined()
    expect(within(list).getByRole('button', { name: new RegExp(`^Personal.*${locale.accountConnectionUnknown}`) })).toBeDefined()
    fireEvent.click(unnamed)
    expect(unnamed.getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('region', { name: fallback })).toBeDefined()
    expect(screen.getByRole('heading', { name: fallback })).toBeDefined()
  })
})

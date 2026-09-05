// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { en, type OpenAICodexSettingsKey } from '../src/client/locales.ts'
import { resetResponsePreferencesForTests } from '../src/client/response-preferences.ts'

afterEach(() => {
  cleanup()
  resetResponsePreferencesForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function response(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(value),
  } as Response
}

const t = (key: OpenAICodexSettingsKey, params?: Record<string, unknown>): string => {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

describe('OpenAI Codex local routing monitor', () => {
  it('groups the usage heading and subscription details without stacked spacing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) return response({
        status: 'ready', profiles: [{ id: 'local-a', label: 'Local account', createdAt: 1, updatedAt: 1, usage: { rateLimits: [] } }],
      })
      if (path.endsWith('/routing-events')) return response({ events: [] })
      return response({})
    }))
    render(<OpenAICodexSettings t={t} />)
    const title = await screen.findByRole('heading', { name: en.usageLimits })
    const summary = title.parentElement!
    expect(within(summary).getByText(en.subscriptionTier)).toBeDefined()
    expect(summary.style.gap).toBe('10px')
    expect(within(summary).getByText(en.subscriptionTier).parentElement!.parentElement!.style.marginBlock).toBe('0px')
    fireEvent.click(screen.getByRole('button', { name: en.renameProfile }))
    expect(screen.getByRole('textbox', { name: en.renameProfilePrompt })).toBeDefined()
  })

  it('ignores an old quota response after refreshing directory metadata', async () => {
    vi.useFakeTimers()
    let revision = 0
    let resolveOld!: (value: Response) => void
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/profiles/directory')) return response({ status: 'ready', profiles: [
        { id: 'local-a', label: revision ? 'Renamed account' : 'Original account', createdAt: 1, updatedAt: revision + 1 },
      ] })
      if (path.endsWith('/profiles')) {
        if (!revision) return new Promise<Response>(resolve => { resolveOld = resolve })
        return response({ status: 'ready', profiles: [
          { id: 'local-a', label: 'Stale quota label', usage: { rateLimits: [] }, connectionStatus: 'connected' },
        ] })
      }
      if (path.endsWith('/routing-events')) return response({ events: [] })
      return response({})
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<OpenAICodexSettings t={t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('button', { name: /Original account/ })).toBeDefined()
    revision = 1
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.getByRole('button', { name: /Renamed account/ })).toBeDefined()
    await act(async () => {
      resolveOld(response({ status: 'ready', profiles: [
        { id: 'local-a', label: 'Original account', usage: { rateLimits: [] }, connectionStatus: 'reauth-required' },
        { id: 'removed', label: 'Removed account', usage: { rateLimits: [] } },
      ] }))
    })
    expect(screen.queryByText('Removed account')).toBeNull()
    expect(screen.queryByText('Stale quota label')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain(en.accountConnected)
  })

  it('retains accounts after quota timeout and aborts loading on unmount', async () => {
    vi.useFakeTimers()
    let quotaSignal: AbortSignal | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/profiles/directory')) return response({ status: 'ready', profiles: [
        { id: 'local-a', label: 'Local account', createdAt: 1, updatedAt: 1 },
      ] })
      if (path.endsWith('/profiles')) {
        quotaSignal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      }
      if (path.endsWith('/routing-events')) return response({ events: [] })
      return response({})
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<OpenAICodexSettings t={t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('button', { name: /Local account/ })).toBeDefined()
    expect(screen.getByText(en.loadingQuota)).toBeDefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(screen.getByRole('button', { name: /Local account/ })).toBeDefined()
    expect(screen.queryByText(en.loadingQuota)).toBeNull()
    expect(screen.getByText(en.quotaUnavailable)).toBeDefined()
    expect(quotaSignal?.aborted).toBe(true)
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/profiles'))).toHaveLength(1)
    // Next periodic refresh can retry; disposing the page cancels that request.
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
    expect(quotaSignal?.aborted).toBe(false)
    view.unmount()
    expect(quotaSignal?.aborted).toBe(true)
  })

  it('bounds directory loading and exposes retry', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/profiles/directory')) return new Promise<Response>(() => {})
      return response({})
    }))
    render(<OpenAICodexSettings t={t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.queryByText(en.loadingAccount)).toBeNull()
    expect(screen.getByRole('button', { name: en.retry })).toBeDefined()
  })

  it('renders the local directory while quota remains pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/profiles/directory')) return response({ status: 'ready', profiles: [
        { id: 'local-a', label: 'Local account', createdAt: 1, updatedAt: 1 },
      ] })
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) return new Promise<Response>(() => {})
      if (path.endsWith('/routing-events')) return response({ events: [] })
      return response({})
    }))
    render(<OpenAICodexSettings t={t} />)
    expect(await screen.findByRole('button', { name: /Local account/ })).toBeDefined()
    expect(screen.queryByText(en.loadingAccount)).toBeNull()
    expect(screen.queryByText(en.accountConnected)).toBeNull()
  })

  it('keeps a signed-in profile connected when only quota telemetry is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) {
        return response({
          status: 'ready',
          profiles: [{
            id: 'private-a',
            label: 'Private A',
            createdAt: 1,
            updatedAt: 1,
            usage: { rateLimits: [] },
            inUse: true,
            connectionStatus: 'connected',
            quotaError: 'usage endpoint temporarily unavailable',
          }],
        })
      }
      if (path.endsWith('/routing-events')) return response({ events: [] })
      if (path.endsWith('/image-tools')) return response({ modifyReadImage: false, shareImagegenWithOtherModels: false })
      if (path.endsWith('/response-api')) return response({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })
      if (path.endsWith('/network')) return response({ enabled: false, httpProxy: false, httpsProxy: false, noProxy: false })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OpenAICodexSettings t={t} />)

    const profile = await screen.findByRole('button', { name: /Private A/ })
    expect(profile.querySelector('[state="done"]')).not.toBeNull()
    const connection = screen.getByRole('status')
    expect(connection.textContent).toContain(en.accountConnected)
    expect(connection.getAttribute('data-state')).toBe('done')
    expect(screen.queryByText(en.accountConnectionUnavailable)).toBeNull()
    expect(screen.getByText(en.quotaUnavailable)).toBeDefined()
  })

  it('keeps a reauthorization failure visible as a connection error', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) {
        return response({
          status: 'ready',
          profiles: [{
            id: 'private-a',
            label: 'Private A',
            createdAt: 1,
            updatedAt: 1,
            usage: { rateLimits: [] },
            inUse: true,
            connectionStatus: 'reauth-required',
            quotaError: 'OpenAI Codex sign-in needs to be renewed',
          }],
        })
      }
      if (path.endsWith('/routing-events')) return response({ events: [] })
      if (path.endsWith('/image-tools')) return response({ modifyReadImage: false, shareImagegenWithOtherModels: false })
      if (path.endsWith('/response-api')) return response({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })
      if (path.endsWith('/network')) return response({ enabled: false, httpProxy: false, httpsProxy: false, noProxy: false })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OpenAICodexSettings t={t} />)

    const profile = await screen.findByRole('button', { name: /Private A/ })
    expect(profile.querySelector('[state="error"]')).not.toBeNull()
    const connection = screen.getByRole('status')
    expect(connection.textContent).toContain(en.accountConnectionUnavailable)
    expect(connection.getAttribute('data-state')).toBe('error')
  })

  it('shows exactly one in-use marker for the current first-choice profile', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) {
        return response({
          status: 'ready',
          profiles: [
            { id: 'private-b', label: 'Private B', createdAt: 1, updatedAt: 2, usage: { rateLimits: [] }, inUse: false },
            { id: 'private-a', label: 'Private A', createdAt: 1, updatedAt: 1, usage: { rateLimits: [] }, inUse: true },
          ],
        })
      }
      if (path.endsWith('/routing-events')) return response({ events: [] })
      if (path.endsWith('/image-tools')) return response({ modifyReadImage: false, shareImagegenWithOtherModels: false })
      if (path.endsWith('/response-api')) return response({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })
      if (path.endsWith('/network')) return response({ enabled: false, httpProxy: false, httpsProxy: false, noProxy: false })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OpenAICodexSettings t={t} />)

    const activeProfile = await screen.findByRole('button', { name: /Private B/ })
    expect(within(activeProfile).getByText(en.profileInUse)).toBeDefined()
    expect(within(activeProfile).getByText('Priority 1')).toBeDefined()
    const secondProfile = screen.getByRole('button', { name: /Private A/ })
    expect(within(secondProfile).getByText('Priority 2')).toBeDefined()
    expect(screen.getAllByText(en.profileInUse)).toHaveLength(1)
    expect(screen.queryByText('Account A')).toBeNull()
    expect(screen.getByRole('button', { name: en.setPriorityProfile })).toBeDefined()
  })

  it('moves the single in-use marker after quota fallback promotes another profile', async () => {
    let profileReads = 0
    let switched = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) {
        profileReads += 1
        return response({
          status: 'ready',
          profiles: switched
            ? [
                { id: 'private-b', label: 'Private B', createdAt: 1, updatedAt: 2, usage: { rateLimits: [] }, inUse: true },
                { id: 'private-a', label: 'Private A', createdAt: 1, updatedAt: 1, usage: { rateLimits: [] }, inUse: false },
              ]
            : [
                { id: 'private-a', label: 'Private A', createdAt: 1, updatedAt: 1, usage: { rateLimits: [] }, inUse: false },
                { id: 'private-b', label: 'Private B', createdAt: 1, updatedAt: 2, usage: { rateLimits: [] }, inUse: false },
              ],
        })
      }
      if (path.endsWith('/routing-events')) {
        return response({
          events: switched
            ? [{
                id: 'event-1',
                profileAlias: 'A',
                previousProfileAlias: 'B',
                model: 'gpt-5.6-sol',
                reason: 'quota_fallback',
                unit: 'request',
                status: 'succeeded',
                startedAt: 1_000,
                finishedAt: 1_250,
              }]
            : [],
        })
      }
      if (path.endsWith('/image-tools')) return response({ modifyReadImage: false, shareImagegenWithOtherModels: false })
      if (path.endsWith('/response-api')) return response({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })
      if (path.endsWith('/network')) return response({ enabled: false, httpProxy: false, httpsProxy: false, noProxy: false })
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OpenAICodexSettings t={t} />)

    const originalPriority = await screen.findByRole('button', { name: /Private A/ })
    expect(within(originalPriority).getByText(en.profileInUse)).toBeDefined()
    switched = true
    await waitFor(() => {
      const promoted = screen.getByRole('button', { name: /Private B/ })
      expect(within(promoted).getByText(en.profileInUse)).toBeDefined()
      expect(screen.getAllByText(en.profileInUse)).toHaveLength(1)
    }, { timeout: 3_500 })
    expect(profileReads).toBeGreaterThanOrEqual(2)
  }, 5_000)

  it('starts collapsed and reveals only the three newest metadata-only request receipts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) {
        return response({
          status: 'ready',
          profiles: [
            { id: 'private-a', label: 'Private A', createdAt: 1, updatedAt: 1, usage: { rateLimits: [] } },
            { id: 'private-b', label: 'Private B', createdAt: 1, updatedAt: 1, usage: { rateLimits: [] } },
          ],
        })
      }
      if (path.endsWith('/routing-events')) {
        return response({
          events: [
            {
              id: 'event-1',
              profileAlias: 'B',
              previousProfileAlias: 'A',
              model: 'newest-model',
              reason: 'quota_fallback',
              unit: 'request',
              status: 'succeeded',
              startedAt: 4_000,
              finishedAt: 4_250,
            },
            {
              id: 'event-2',
              profileAlias: 'A',
              model: 'second-model',
              reason: 'priority',
              unit: 'request',
              status: 'succeeded',
              startedAt: 3_000,
              finishedAt: 3_250,
            },
            {
              id: 'event-3',
              profileAlias: 'B',
              model: 'third-model',
              reason: 'quota_unknown',
              unit: 'request',
              status: 'failed',
              startedAt: 2_000,
              finishedAt: 2_250,
            },
            {
              id: 'event-4',
              profileAlias: 'A',
              model: 'fourth-model',
              reason: 'priority',
              unit: 'request',
              status: 'succeeded',
              startedAt: 1_000,
              finishedAt: 1_250,
            },
          ],
        })
      }
      if (path.endsWith('/image-tools')) {
        return response({ modifyReadImage: false, shareImagegenWithOtherModels: false })
      }
      if (path.endsWith('/response-api')) {
        return response({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })
      }
      if (path.endsWith('/network')) {
        return response({ enabled: false, httpProxy: false, httpsProxy: false, noProxy: false })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OpenAICodexSettings t={t} />)

    const trigger = await screen.findByRole('button', { name: en.recentRequests })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(en.requestAttemptsOnly)).toBeNull()
    expect(screen.queryByText('newest-model')).toBeNull()

    fireEvent.click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.requestAttemptsOnly)).toBeDefined()
    expect(await screen.findByText('newest-model')).toBeDefined()
    expect(screen.getByText('second-model')).toBeDefined()
    expect(screen.getByText('third-model')).toBeDefined()
    expect(screen.queryByText('fourth-model')).toBeNull()
    expect(screen.getByText('Account A → Account B')).toBeDefined()
    expect(screen.getByText(en.routingReasonQuotaFallback)).toBeDefined()
    expect(screen.getAllByText(en.routingStatusSucceeded)).toHaveLength(2)
    expect(screen.getAllByText(en.oneRequest)).toHaveLength(3)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/dsh-openai-codex/routing-events',
        expect.objectContaining({ credentials: 'same-origin' }),
      )
    })
  })

  it.each([
    { routeResult: response({ events: [] }), expected: en.noRecentRequests },
    { routeResult: new Error('route unavailable'), expected: en.routingEventsUnavailable },
  ])('keeps account management usable in the $expected state', async ({ routeResult, expected }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles') || path.endsWith('/profiles/directory')) {
        return response({
          status: 'ready',
          profiles: [
            { id: 'private-a', label: 'Private A', createdAt: 1, updatedAt: 1, usage: { rateLimits: [] } },
          ],
        })
      }
      if (path.endsWith('/routing-events')) {
        if (routeResult instanceof Error) throw routeResult
        return routeResult
      }
      if (path.endsWith('/image-tools')) {
        return response({ modifyReadImage: false, shareImagegenWithOtherModels: false })
      }
      if (path.endsWith('/response-api')) {
        return response({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })
      }
      if (path.endsWith('/network')) {
        return response({ enabled: false, httpProxy: false, httpsProxy: false, noProxy: false })
      }
      throw new Error(`unexpected request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OpenAICodexSettings t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: en.recentRequests }))
    expect(await screen.findByText(expected)).toBeDefined()
    expect(screen.getByRole('button', { name: en.addAccount })).toHaveProperty('disabled', false)
  })
})

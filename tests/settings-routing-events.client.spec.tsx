// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  it('shows exactly one in-use marker for the current first-choice profile', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles')) {
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
    let routingReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles')) {
        profileReads += 1
        const switched = profileReads > 1
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
        routingReads += 1
        return response({
          events: routingReads > 1
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
      if (path.endsWith('/profiles')) {
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
      if (path.endsWith('/profiles')) {
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

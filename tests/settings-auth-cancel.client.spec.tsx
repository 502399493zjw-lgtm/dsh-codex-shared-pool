// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function requestPath(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function popupSessionResponse(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
  const path = requestPath(input)
  if (!path.includes('/auth/popup/session')) return undefined
  return init?.method === 'POST'
    ? response({ status: 'published' })
    : response({ status: 'acknowledged' })
}

function expectAuthorizationPublication(
  fetchMock: ReturnType<typeof vi.fn>,
  authorizationUrl: string,
): void {
  const publication = fetchMock.mock.calls.find(([input, init]) => {
    if (!requestPath(input as RequestInfo | URL).endsWith('/auth/popup/session') || init?.method !== 'POST') {
      return false
    }
    return (JSON.parse(String(init.body)) as { authorizationUrl?: string }).authorizationUrl === authorizationUrl
  })
  expect(publication).toBeDefined()
  expect(JSON.parse(String(publication?.[1]?.body))).toEqual({
    attemptToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    authorizationUrl,
  })
}

const t = (key: OpenAICodexSettingsKey, params?: Record<string, unknown>): string => {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

describe('OpenAI Codex settings authorization', () => {
  it('shows a manual cancel action while waiting, returns to signed out, and can retry', async () => {
    let resolveFirstLogin: ((value: Response) => void) | undefined
    const firstLogin = new Promise<Response>((resolve) => { resolveFirstLogin = resolve })
    let loginRequests = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sessionResponse = popupSessionResponse(input, init)
      if (sessionResponse !== undefined) return sessionResponse
      const path = requestPath(input)
      if (path.endsWith('/profiles/login/cancel')) return response({ cancelled: true })
      if (path.endsWith('/profiles/login')) {
        loginRequests += 1
        return loginRequests === 1
          ? firstLogin
          : response({ url: 'https://auth.openai.com/oauth/authorize?attempt=retry' })
      }
      if (path.endsWith('/profiles')) return response({ status: 'ready', profiles: [] })
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
    const firstPopup = {
      closed: false,
      opener: null,
      close: vi.fn(),
      location: { replace: vi.fn() },
    }
    const retryPopup = {
      closed: false,
      opener: null,
      close: vi.fn(),
      location: { replace: vi.fn() },
    }
    vi.spyOn(window, 'open')
      .mockReturnValueOnce(firstPopup as unknown as Window)
      .mockReturnValueOnce(retryPopup as unknown as Window)
    render(<OpenAICodexSettings t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: en.addAccount }))

    await screen.findByText(en.signingIn)
    const cancelAuthorization = screen.getByRole('button', { name: en.cancelAuthorization })
    expect(cancelAuthorization).toHaveProperty('disabled', false)
    fireEvent.click(cancelAuthorization)

    await screen.findByText(en.signInCancelled)
    expect(firstPopup.close).toHaveBeenCalledOnce()
    const retry = screen.getByRole('button', { name: en.addAccount })
    expect(retry).toHaveProperty('disabled', false)
    resolveFirstLogin?.(response({ url: 'https://auth.openai.com/oauth/authorize?attempt=late' }))
    await waitFor(() => { expect(firstPopup.location.replace).not.toHaveBeenCalled() })

    fireEvent.click(retry)

    await screen.findByText(en.signingIn)
    await waitFor(() => {
      expectAuthorizationPublication(fetchMock, 'https://auth.openai.com/oauth/authorize?attempt=retry')
    })
    expect(loginRequests).toBe(2)
  })

  it('cancels the login and restores the empty state when the popup closes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sessionResponse = popupSessionResponse(input, init)
      if (sessionResponse !== undefined) return sessionResponse
      const path = requestPath(input)
      if (path.endsWith('/profiles/login/cancel')) return response({ cancelled: true })
      if (path.endsWith('/profiles/login')) {
        return response({ url: 'https://auth.openai.com/oauth/authorize?attempt=close' })
      }
      if (path.endsWith('/profiles')) return response({ status: 'ready', profiles: [] })
      if (path.endsWith('/image-tools')) {
        return response({ modifyReadImage: false, shareImagegenWithOtherModels: false })
      }
      if (path.endsWith('/response-api')) {
        return response({ useFastMode: false, useWebSocketContextReuse: false, useNativeCompaction: false })
      }
      if (path.endsWith('/network')) {
        return response({ enabled: false, httpProxy: false, httpsProxy: false, noProxy: false })
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const popup = {
      closed: false,
      opener: null,
      close: vi.fn(),
      location: { replace: vi.fn() },
    }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    render(<OpenAICodexSettings t={t} />)
    const addAccount = await screen.findByRole('button', { name: en.addAccount })

    fireEvent.click(addAccount)

    await screen.findByText(en.signingIn)
    await waitFor(() => {
      expectAuthorizationPublication(fetchMock, 'https://auth.openai.com/oauth/authorize?attempt=close')
    })
    popup.closed = true
    await screen.findByText(en.signInCancelled, {}, { timeout: 1_000 })
    expect(screen.getByRole('button', { name: en.addAccount })).toHaveProperty('disabled', false)
    expect(fetchMock).toHaveBeenCalledWith(
      '/plugins/dsh-openai-codex/profiles/login/cancel',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('cancels when settings unmount before the authorization challenge arrives', async () => {
    let resolveLogin: ((value: Response) => void) | undefined
    const loginResponse = new Promise<Response>((resolve) => { resolveLogin = resolve })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles/login/cancel')) return response({ cancelled: true })
      if (path.endsWith('/profiles/login')) return loginResponse
      if (path.endsWith('/profiles')) return response({ status: 'ready', profiles: [] })
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
    const popup = {
      closed: false,
      opener: null,
      close: vi.fn(),
      location: { replace: vi.fn() },
    }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const view = render(<OpenAICodexSettings t={t} />)
    const addAccount = await screen.findByRole('button', { name: en.addAccount })

    fireEvent.click(addAccount)
    await screen.findByText(en.signingIn)
    view.unmount()

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/dsh-openai-codex/profiles/login/cancel',
        expect.objectContaining({ method: 'POST', keepalive: true }),
      )
    })
    resolveLogin?.(response({ url: 'https://auth.openai.test/authorize' }))
    await waitFor(() => { expect(popup.close).toHaveBeenCalledOnce() })
    expect(popup.location.replace).not.toHaveBeenCalled()
  })

  it('keeps authorization alive when the in-app browser adopts the new tab without a WindowProxy', async () => {
    const authorizationUrl = 'https://auth.openai.com/oauth/authorize?client_id=test&state=test'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/profiles/login/cancel')) return response({ cancelled: true })
      if (path.endsWith('/profiles/login')) return response({ url: authorizationUrl })
      if (path.includes('/auth/popup/session')) {
        return init?.method === 'POST'
          ? response({ status: 'ready' })
          : response({ status: 'acknowledged' })
      }
      if (path.endsWith('/profiles')) return response({ status: 'ready', profiles: [] })
      if (path.endsWith('/image-tools')) {
        return response({ modifyReadImage: false, shareImagegenWithOtherModels: false })
      }
      if (path.endsWith('/response-api')) {
        return response({ useFastMode: false, useWebSocketContextReuse: false })
      }
      if (path.endsWith('/network')) {
        return response({ enabled: false, httpProxy: false, httpsProxy: false, noProxy: false })
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const view = render(<OpenAICodexSettings t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: en.addAccount }))

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        expect.stringMatching(/^\/plugins\/dsh-openai-codex\/auth\/popup\?attempt=[a-f0-9]{64}$/),
        'dsh-openai-codex-authorization',
      )
    })
    await waitFor(() => {
      const publication = fetchMock.mock.calls.find(([input, init]) => (
        String(input) === '/plugins/dsh-openai-codex/auth/popup/session' && init?.method === 'POST'
      ))
      expect(publication).toBeDefined()
      expect(JSON.parse(String(publication?.[1]?.body))).toEqual({
        attemptToken: expect.stringMatching(/^[a-f0-9]{64}$/),
        authorizationUrl,
      })
    })

    view.unmount()

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/plugins/dsh-openai-codex/profiles/login/cancel',
      expect.anything(),
    )
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAuthorizationPopupBridge } from '../src/client/authorization-popup.ts'
import {
  OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
  OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_TTL_MS,
} from '../src/shared/authorization-popup.ts'

const ATTEMPT_TOKEN = 'cd'.repeat(32)
const AUTHORIZATION_URL = 'https://auth.openai.com/oauth/authorize?client_id=codex_cli'
const POLL_INTERVAL_MS = 200
const controllers: Array<NonNullable<ReturnType<typeof openAuthorizationPopupBridge>>> = []

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

function createPopup(): Window & { closed: boolean; close: ReturnType<typeof vi.fn> } {
  return { closed: false, close: vi.fn() } as unknown as Window & { closed: boolean; close: ReturnType<typeof vi.fn> }
}

function openController(popup: Window | null): NonNullable<ReturnType<typeof openAuthorizationPopupBridge>> {
  vi.spyOn(window.crypto, 'getRandomValues').mockImplementation((array) => {
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xcd)
    return array
  })
  vi.spyOn(window, 'open').mockReturnValue(popup)
  const controller = openAuthorizationPopupBridge()
  expect(controller).not.toBeNull()
  controllers.push(controller!)
  return controller!
}

describe('authorization popup Host-session acknowledgement', () => {
  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('publishes the provider URL before polling for bridge acknowledgement', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ status: 'published' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'waiting' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'acknowledged' }))
    const navigation = openController(createPopup()).navigate(AUTHORIZATION_URL)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    await expect(navigation).resolves.toBe(true)
    expect(fetchMock.mock.calls[0]).toEqual([
      OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ attemptToken: ATTEMPT_TOKEN, authorizationUrl: AUTHORIZATION_URL }),
      }),
    ])
    const pollUrl = `${OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH}?attempt=${ATTEMPT_TOKEN}`
    expect(fetchMock.mock.calls.slice(1, 3)).toEqual([
      [pollUrl, expect.objectContaining({ method: 'GET', cache: 'no-store' })],
      [pollUrl, expect.objectContaining({ method: 'GET', cache: 'no-store' })],
    ])
  })

  it('does not depend on a WindowProxy when the in-app browser adopts the tab', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ status: 'published' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'acknowledged' }))

    await expect(openController(null).navigate(AUTHORIZATION_URL)).resolves.toBe(true)
  })

  it('keeps waiting for the full Host-session lifetime before timing out', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => (
      init?.method === 'POST' ? jsonResponse({ status: 'published' }) : jsonResponse({ status: 'waiting' })
    ))
    const navigation = openController(createPopup()).navigate(AUTHORIZATION_URL)
    let result: boolean | undefined
    void navigation.then(value => { result = value })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_TTL_MS - 10_000)
    await expect(navigation).resolves.toBe(false)
  })

  it.each(['cancelled', 'expired'] as const)('stops when the Host session is %s', async (status) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ status: 'published' }))
      .mockResolvedValueOnce(jsonResponse({ status }))
    await expect(openController(createPopup()).navigate(AUTHORIZATION_URL)).resolves.toBe(false)
  })

  it('rejects navigation to a non-OpenAI endpoint before publishing it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(openController(createPopup()).navigate('https://example.com/oauth/authorize')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

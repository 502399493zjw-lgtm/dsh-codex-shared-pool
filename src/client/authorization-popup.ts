import {
  isOpenAICodexAuthorizationUrl,
  OPENAI_CODEX_AUTHORIZATION_POPUP_ATTEMPT_BYTES,
  OPENAI_CODEX_AUTHORIZATION_POPUP_PATH,
  OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
  OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_TTL_MS,
} from '../shared/authorization-popup.ts'

const POPUP_CLOSE_POLL_INTERVAL_MS = 250
const POPUP_SESSION_POLL_INTERVAL_MS = 200
const POPUP_HANDSHAKE_TIMEOUT_MS = OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_TTL_MS
const POPUP_WINDOW_NAME = 'dsh-openai-codex-authorization'

type PopupSessionStatus = 'acknowledged' | 'cancelled' | 'expired' | 'published' | 'ready' | 'waiting'

export interface AuthorizationPopupController {
  /** Codex's in-app browser can adopt the tab and return no WindowProxy. */
  readonly window: Window | null
  navigate(authorizationUrl: string): Promise<boolean>
  close(): void
}

function createAttemptToken(): string | null {
  try {
    const bytes = new Uint8Array(OPENAI_CODEX_AUTHORIZATION_POPUP_ATTEMPT_BYTES)
    window.crypto.getRandomValues(bytes)
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function popupIsClosed(popup: Window | null): boolean {
  if (popup === null) return false
  try {
    return popup.closed === true
  } catch {
    return false
  }
}

function readPopupSessionStatus(value: unknown): PopupSessionStatus | null {
  if (typeof value !== 'object' || value === null) return null
  const status = (value as Record<string, unknown>).status
  switch (status) {
    case 'acknowledged':
    case 'cancelled':
    case 'expired':
    case 'published':
    case 'ready':
    case 'waiting':
      return status
    default:
      return null
  }
}

function sessionRequestInit(method: 'GET' | 'POST', body?: string): RequestInit {
  return {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  }
}

/** Open a same-origin bridge synchronously and publish the provider URL through the Host. */
export function openAuthorizationPopupBridge(): AuthorizationPopupController | null {
  const attemptToken = createAttemptToken()
  if (attemptToken === null) return null

  const bridgeUrl = `${OPENAI_CODEX_AUTHORIZATION_POPUP_PATH}?attempt=${encodeURIComponent(attemptToken)}`
  let popup: Window | null
  try {
    popup = window.open(bridgeUrl, POPUP_WINDOW_NAME)
  } catch {
    return null
  }

  const pollUrl = `${OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH}?attempt=${encodeURIComponent(attemptToken)}`
  let active = true
  let navigationStarted = false
  let navigationSettled = false
  let pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let timeoutTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let resolveNavigation: ((value: boolean) => void) | undefined

  const stopTimers = () => {
    if (pollTimer !== undefined) globalThis.clearTimeout(pollTimer)
    if (timeoutTimer !== undefined) globalThis.clearTimeout(timeoutTimer)
    pollTimer = undefined
    timeoutTimer = undefined
  }
  const settleNavigation = (value: boolean) => {
    if (navigationSettled) return
    navigationSettled = true
    stopTimers()
    resolveNavigation?.(value)
    resolveNavigation = undefined
  }
  const pollForAcknowledgement = async (): Promise<void> => {
    if (!active || navigationSettled) return
    if (popupIsClosed(popup)) { settleNavigation(false); return }
    let response: Response
    try {
      response = await fetch(pollUrl, sessionRequestInit('GET'))
    } catch {
      if (active && !navigationSettled) {
        pollTimer = globalThis.setTimeout(() => { void pollForAcknowledgement() }, POPUP_SESSION_POLL_INTERVAL_MS)
      }
      return
    }
    if (!active || navigationSettled) return
    if (response.status >= 400 && response.status < 500) { settleNavigation(false); return }
    if (response.ok) {
      let status: PopupSessionStatus | null = null
      try { status = readPopupSessionStatus(await response.json()) } catch {}
      if (!active || navigationSettled) return
      if (status === 'acknowledged') { settleNavigation(true); return }
      if (status === 'cancelled' || status === 'expired') { settleNavigation(false); return }
    }
    pollTimer = globalThis.setTimeout(() => { void pollForAcknowledgement() }, POPUP_SESSION_POLL_INTERVAL_MS)
  }

  return {
    window: popup,
    navigate(authorizationUrl) {
      if (!active || navigationStarted || popupIsClosed(popup) || !isOpenAICodexAuthorizationUrl(authorizationUrl)) {
        return Promise.resolve(false)
      }
      navigationStarted = true
      const result = new Promise<boolean>((resolve) => { resolveNavigation = resolve })
      timeoutTimer = globalThis.setTimeout(() => { settleNavigation(false) }, POPUP_HANDSHAKE_TIMEOUT_MS)
      void fetch(
        OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
        sessionRequestInit('POST', JSON.stringify({ attemptToken, authorizationUrl })),
      ).then((response) => {
        if (!response.ok) { settleNavigation(false); return }
        void pollForAcknowledgement()
      }, () => { settleNavigation(false) })
      return result
    },
    close() {
      if (!active) return
      active = false
      settleNavigation(false)
      void fetch(
        OPENAI_CODEX_AUTHORIZATION_POPUP_SESSION_PATH,
        sessionRequestInit('POST', JSON.stringify({ attemptToken, cancel: true })),
      ).catch(() => undefined)
      try { popup?.close() } catch {}
    },
  }
}

/**
 * Observe an OAuth popup until it closes or the caller stops the observer.
 *
 * @param popup - Browser window opened for provider authorization.
 * @param onClosed - Callback invoked once after the popup closes.
 * @returns A disposer that stops observing without invoking the callback.
 */
export function watchAuthorizationPopupClose(
  popup: { readonly closed: boolean },
  onClosed: () => void,
): () => void {
  let active = true
  const timer = globalThis.setInterval(() => {
    if (!active || !popup.closed) return
    active = false
    globalThis.clearInterval(timer)
    onClosed()
  }, POPUP_CLOSE_POLL_INTERVAL_MS)
  return () => {
    if (!active) return
    active = false
    globalThis.clearInterval(timer)
  }
}

const POPUP_CLOSE_POLL_INTERVAL_MS = 250

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

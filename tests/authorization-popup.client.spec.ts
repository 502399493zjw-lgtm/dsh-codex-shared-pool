import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchAuthorizationPopupClose } from '../src/client/authorization-popup.ts'

describe('authorization popup lifecycle', () => {
  afterEach(() => { vi.useRealTimers() })

  it('reports a closed popup once', () => {
    vi.useFakeTimers()
    const popup = { closed: false }
    const onClosed = vi.fn()

    const dispose = watchAuthorizationPopupClose(popup, onClosed)
    popup.closed = true
    vi.runAllTimers()
    vi.runAllTimers()

    expect(onClosed).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('stops observing when disposed', () => {
    vi.useFakeTimers()
    const popup = { closed: false }
    const onClosed = vi.fn()

    const dispose = watchAuthorizationPopupClose(popup, onClosed)
    dispose()
    popup.closed = true
    vi.runAllTimers()

    expect(onClosed).not.toHaveBeenCalled()
  })
})

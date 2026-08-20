/** Codex Fast selector contributed to the composer's model menu. */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutline16,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { supportsCodexFastMode } from '../shared/model-capabilities.ts'
import { resolveFlyoutPosition, type FlyoutPosition } from './flyout-position.ts'
import {
  loadResponsePreferences,
  responsePreferencesSnapshot,
  subscribeResponsePreferences,
  updateResponsePreferences,
} from './response-preferences.ts'

/** Structural copy of the owner share declared by ui-model-selection. */
interface ModelMenuPreferenceOwner {
  selection: { provider: string; model: string } | null
  interactionId: string
  close: (restoreFocus?: boolean) => void
  registerItem: (node: HTMLButtonElement | null) => void
}

export type FastModeModelPreferenceProps =
  ModelMenuPreferenceOwner & PropsLocale<'settings.openai-codex'> & {
    /** Locale seat supplied by the DSH slot renderer. */
    t: PropsLocale<'settings.openai-codex'>['t']
  }

/** Render nothing outside supported OpenAI Codex models. */
export function FastModeModelPreference({
  selection,
  interactionId,
  close,
  registerItem,
  t,
}: FastModeModelPreferenceProps) {
  const supported = selection?.provider === 'openai-codex'
    && supportsCodexFastMode(selection.model)
  const preferences = useSyncExternalStore(
    subscribeResponsePreferences,
    responsePreferencesSnapshot,
  )
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const [flyoutPosition, setFlyoutPosition] = useState<FlyoutPosition>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const rowRef = useRef<HTMLButtonElement | null>(null)
  const flyoutRef = useRef<HTMLDivElement | null>(null)
  const setRowRef = useCallback((node: HTMLButtonElement | null) => {
    rowRef.current = node
    registerItem(node)
  }, [registerItem])

  useEffect(() => {
    setFlyoutOpen(false)
    setError(false)
    if (!supported) return
    void loadResponsePreferences().catch(() => { setError(true) })
  }, [selection?.model, selection?.provider, supported])

  // Portal placement escapes the conversation scroller's overflow clip. It
  // follows the row on nested scrolling/resizing and flips or clamps at the
  // actual viewport edge, matching DSH's own portal-menu behavior.
  useLayoutEffect(() => {
    if (!flyoutOpen) {
      setFlyoutPosition(undefined)
      return
    }
    const place = () => {
      const anchor = rowRef.current?.getBoundingClientRect()
      const flyout = flyoutRef.current
      if (anchor === undefined || flyout === null) return
      setFlyoutPosition(resolveFlyoutPosition(
        anchor,
        { width: flyout.offsetWidth, height: flyout.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ))
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [flyoutOpen, error, preferences])

  if (!supported) return null

  const fast = preferences?.useFastMode ?? false
  const choose = async (enabled: boolean): Promise<void> => {
    if (busy) return
    if (preferences !== undefined && fast === enabled) {
      close(true)
      return
    }
    setBusy(true)
    setError(false)
    try {
      await updateResponsePreferences({ useFastMode: enabled })
      close(true)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const onFlyoutKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setFlyoutOpen(false)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.stopPropagation()
      const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
      const current = options.indexOf(document.activeElement as HTMLButtonElement)
      const offset = event.key === 'ArrowDown' ? 1 : -1
      options[(Math.max(current, 0) + offset + options.length) % options.length]?.focus()
    }
  }

  return (
    <>
      <style>{`
        .dsh-codex-speed-cell:hover,
        .dsh-codex-speed-cell:focus-visible,
        .dsh-codex-speed-option:hover,
        .dsh-codex-speed-option:focus-visible {
          background: var(--dsw-alias-interactive-bg-hover) !important;
          outline: none;
        }
      `}</style>
      <button
        ref={setRowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={flyoutOpen}
        className="dsh-codex-speed-cell"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 40,
          padding: '0 10px', border: 0, borderRadius: 10, background: 'transparent',
          color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14,
          lineHeight: '22px', cursor: 'pointer', textAlign: 'left',
        }}
        onClick={() => { setFlyoutOpen(value => !value) }}
      >
        <span style={{ flex: '1 1 auto' }}>{t('speed')}</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {fast ? t('speedFast') : t('speedStandard')}
        </span>
        <span style={{ display: 'grid', placeItems: 'center', flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary)' }}>
          <IconChevronRightOutline14 />
        </span>
      </button>

      {flyoutOpen && createPortal((
        <div
          ref={flyoutRef}
          role="menu"
          aria-label={t('speed')}
          aria-busy={busy || preferences === undefined}
          data-dsh-model-preference-owner={interactionId}
          onKeyDown={onFlyoutKeyDown}
          onClick={(event) => { event.stopPropagation() }}
          style={{
            position: 'fixed',
            left: flyoutPosition?.left ?? 0,
            top: flyoutPosition?.top ?? 0,
            visibility: flyoutPosition === undefined ? 'hidden' : 'visible',
            zIndex: 1100,
            display: 'flex', flexDirection: 'column', width: 248, padding: 6,
            boxSizing: 'border-box',
            border: '1px solid var(--dsw-alias-border-inverted)', borderRadius: 12,
            background: 'var(--dsw-specific-menu)', boxShadow: 'var(--dsw-shadow-lv3)',
            color: 'var(--dsw-alias-label-primary)',
          }}
        >
          <div style={{ padding: '6px 10px 4px', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }}>
            {t('speed')}
          </div>
          {([false, true] as const).map((enabled) => {
            const selected = fast === enabled
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className="dsh-codex-speed-option"
                key={String(enabled)}
                disabled={busy || preferences === undefined}
                onClick={() => { void choose(enabled) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  minHeight: 56, padding: '7px 9px', border: 0, borderRadius: 10,
                  background: 'transparent', color: 'inherit', font: 'inherit',
                  textAlign: 'left', cursor: busy ? 'default' : 'pointer',
                  opacity: preferences === undefined ? 0.6 : 1,
                }}
              >
                <span style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>
                    {enabled ? t('speedFast') : t('speedStandard')}
                  </span>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' }}>
                    {enabled ? t('speedFastHint') : t('speedStandardHint')}
                  </span>
                </span>
                <span style={{ display: 'grid', placeItems: 'center', flex: '0 0 18px' }}>
                  {selected ? <IconCheckOutline16 /> : null}
                </span>
              </button>
            )
          })}
          {error && (
            <div role="alert" style={{ padding: '5px 9px 3px', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' }}>
              {t('speedSaveFailed')}
            </div>
          )}
        </div>
      ), document.body)}
    </>
  )
}

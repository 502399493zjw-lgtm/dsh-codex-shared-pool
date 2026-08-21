/** Complete stock-DSH model seat with Codex response-speed preferences. */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ModelDirectoryState,
  ModelSelectInjected,
} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { FastModeModelPreference, type FastModeModelPreferenceProps } from './FastModeModelPreference.tsx'
import { FastModeTriggerIcon } from './FastModeTriggerIcon.tsx'

interface FixedPosition {
  left: number
  top: number
}

interface CodexModelSelectProps extends ModelSelectInjected {
  /** The composer locks model changes while submission state forbids them. */
  locked: boolean
  /** Plugin locale face supplied by the slot renderer. */
  t: FastModeModelPreferenceProps['t']
}

interface DirectorySource {
  getSnapshot: () => ModelDirectoryState
  subscribe: (listener: () => void) => () => void
}

const menuSurface = {
  boxSizing: 'border-box',
  border: '1px solid var(--dsw-alias-border-inverted)',
  borderRadius: 12,
  background: 'var(--dsw-specific-menu)',
  boxShadow: 'var(--dsw-shadow-lv3)',
  color: 'var(--dsw-alias-label-primary)',
} as const

/** Public props alias kept narrow for component tests and slot registration. */
export type { CodexModelSelectProps }

/**
 * Render the whole documented `conversation.input.model` seat.
 *
 * Stock DSH rc.8 exposes this seat as a single occupant and does not expose
 * children inside its model menu. Shadowing the stock occupant at a lower
 * priority is the documented way for a plugin to extend the affordance.
 */
export function CodexModelSelect({
  locked,
  available,
  directory,
  load,
  select,
  t,
}: CodexModelSelectProps) {
  const source = directory as DirectorySource
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const [position, setPosition] = useState<FixedPosition>()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const interactionId = useId()

  const choices = useMemo(() => state.groups.flatMap(group => (
    group.models.map(model => ({ group, model }))
  )), [state.groups])
  const currentChoice = choices.find(choice => (
    choice.group.id === state.current?.provider && choice.model.id === state.current.model
  ))
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : reasoning.efforts.find(level => level.id === effectiveEffort)?.name
      ?? effectiveEffort
      ?? t('providerDefault')
  const modelLabel = currentChoice?.model.name ?? state.current?.model ?? t('selectModel')
  const selection = state.current === null
    ? null
    : { provider: state.current.provider, model: state.current.model }
  const busy = state.status === 'selecting'

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }, [])

  const show = () => {
    setPane('root')
    setOpen(true)
    load()
  }

  useEffect(() => {
    if (!available) return
    load()
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      if (target instanceof Element && target.closest(`[data-dsh-model-preference-owner="${interactionId}"]`) !== null) return
      close()
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [close, interactionId, open])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined)
      return
    }
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect()
      const menu = menuRef.current
      if (anchor === undefined || menu === null) return
      const margin = 8
      const left = Math.min(
        window.innerWidth - menu.offsetWidth - margin,
        Math.max(margin, anchor.right - menu.offsetWidth),
      )
      const above = anchor.top - menu.offsetHeight - margin
      const top = above >= margin
        ? above
        : Math.min(window.innerHeight - menu.offsetHeight - margin, anchor.bottom + margin)
      setPosition({ left, top: Math.max(margin, top) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, pane, state.groups.length])

  if (!available) return null

  const settle = (accepted: boolean) => {
    if (accepted) close(true)
  }
  const chooseModel = (next: ModelSelection) => {
    if (state.current?.provider === next.provider && state.current.model === next.model) {
      close(true)
      return
    }
    void select(next).then(settle)
  }
  const chooseEffort = (reasoningEffort: string | undefined) => {
    if (state.current === null) return
    const next: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
    void select(next).then(settle)
  }
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (pane === 'root') close(true)
      else setPane('root')
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"], [role="menuitemradio"]',
    )).filter(item => !item.disabled)
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const offset = event.key === 'ArrowDown' ? 1 : -1
    items[(Math.max(current, 0) + offset + items.length) % items.length]?.focus()
  }

  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 40,
    padding: '0 10px', border: 0, borderRadius: 10, background: 'transparent',
    color: 'inherit', font: 'inherit', fontSize: 14, lineHeight: '22px',
    cursor: 'pointer', textAlign: 'left',
  } as const
  const optionStyle = {
    ...rowStyle,
    minHeight: 38,
    padding: '7px 9px',
  } as const

  return (
    <div ref={rootRef} style={{ display: 'inline-flex', minWidth: 0 }}>
      <style>{`
        .dsh-codex-model-trigger:hover,
        .dsh-codex-model-trigger:focus-visible,
        .dsh-codex-model-row:hover,
        .dsh-codex-model-row:focus-visible {
          background: var(--dsw-alias-interactive-bg-hover) !important;
          outline: none;
        }
      `}</style>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-codex-model-trigger"
        aria-label={`${t('selectModel')}: ${modelLabel}${effortLabel === undefined ? '' : `, ${t('reasoningEffort')}: ${effortLabel}`}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${modelLabel}${effortLabel === undefined ? '' : ` · ${effortLabel}`}`}
        disabled={locked}
        onClick={() => { if (open) close(); else show() }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0,
          minHeight: 34, maxWidth: 280, padding: '4px 8px',
          border: '1px solid var(--dsw-alias-border-normal)', borderRadius: 18,
          background: 'transparent', color: 'var(--dsw-alias-label-primary)',
          font: 'inherit', fontSize: 14, cursor: locked ? 'default' : 'pointer',
        }}
      >
        <FastModeTriggerIcon selection={selection} title={t('speedFast')} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelLabel}</span>
        {effortLabel !== undefined && (
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>{effortLabel}</span>
        )}
        <IconChevronDownOutline14 />
      </button>

      {open && createPortal((
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('modelMenu')}
          aria-busy={state.status === 'loading' || busy}
          onKeyDown={moveFocus}
          style={{
            ...menuSurface,
            position: 'fixed', left: position?.left ?? 0, top: position?.top ?? 0,
            visibility: position === undefined ? 'hidden' : 'visible', zIndex: 1090,
            display: 'flex', flexDirection: 'column', width: 300, maxHeight: 430,
            padding: 6, overflow: 'auto',
          }}
        >
          {pane === 'root' && (
            <>
              <button
                type="button" role="menuitem" className="dsh-codex-model-row"
                onClick={() => { setPane('model') }} style={rowStyle}
              >
                <span style={{ flex: '1 1 auto' }}>{t('model')}</span>
                <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{modelLabel}</span>
                <IconChevronRightOutline14 />
              </button>
              {reasoning !== undefined && (
                <button
                  type="button" role="menuitem" className="dsh-codex-model-row"
                  onClick={() => { setPane('effort') }} style={rowStyle}
                >
                  <span style={{ flex: '1 1 auto' }}>{t('reasoningEffort')}</span>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{effortLabel}</span>
                  <IconChevronRightOutline14 />
                </button>
              )}
              <FastModeModelPreference
                selection={selection}
                interactionId={interactionId}
                close={close}
                registerItem={() => undefined}
                t={t}
              />
            </>
          )}

          {pane === 'model' && (
            <>
              <div style={{ padding: '6px 10px 4px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>
                {t('model')}
              </div>
              {state.status === 'loading' && state.groups.length === 0 && (
                <div style={{ padding: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{t('loadingModels')}</div>
              )}
              {state.error !== null && state.groups.length === 0 && (
                <div style={{ padding: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{t('modelsUnavailable')}</div>
              )}
              {state.groups.map(group => (
                <section role="group" aria-label={group.name} key={group.id}>
                  <div style={{ padding: '8px 10px 3px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
                    {group.name}
                  </div>
                  {group.models.map(model => {
                    const selected = state.current?.provider === group.id && state.current.model === model.id
                    return (
                      <button
                        type="button" role="menuitemradio" aria-checked={selected}
                        className="dsh-codex-model-row" disabled={busy} key={`${group.id}:${model.id}`}
                        onClick={() => { chooseModel({ provider: group.id, model: model.id }) }}
                        style={optionStyle}
                      >
                        <span style={{ flex: '1 1 auto' }}>{model.name}</span>
                        <span style={{ display: 'grid', placeItems: 'center', flex: '0 0 18px' }}>
                          {selected ? <IconCheckOutline16 /> : null}
                        </span>
                      </button>
                    )
                  })}
                </section>
              ))}
            </>
          )}

          {pane === 'effort' && reasoning !== undefined && (
            <>
              <div style={{ padding: '6px 10px 4px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>
                {t('reasoningEffort')}
              </div>
              {reasoning.defaultEffort === undefined && (
                <button
                  type="button" role="menuitemradio" aria-checked={effectiveEffort === undefined}
                  className="dsh-codex-model-row" disabled={busy}
                  onClick={() => { chooseEffort(undefined) }} style={optionStyle}
                >
                  <span style={{ flex: '1 1 auto' }}>{t('providerDefault')}</span>
                  {effectiveEffort === undefined ? <IconCheckOutline16 /> : null}
                </button>
              )}
              {reasoning.efforts.map(level => {
                const selected = effectiveEffort === level.id
                return (
                  <button
                    type="button" role="menuitemradio" aria-checked={selected}
                    className="dsh-codex-model-row" disabled={busy} key={level.id}
                    onClick={() => { chooseEffort(level.id) }} style={optionStyle}
                  >
                    <span style={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column' }}>
                      <span>{level.name}</span>
                      {level.description !== undefined && (
                        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{level.description}</span>
                      )}
                    </span>
                    <span style={{ display: 'grid', placeItems: 'center', flex: '0 0 18px' }}>
                      {selected ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      ), document.body)}
    </div>
  )
}

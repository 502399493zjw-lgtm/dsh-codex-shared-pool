import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import styles from './TeamSettings.module.css'

/** Body portal escapes the settings scroll container; every position is viewport bounded. */
export function TeamFloatingMenu({ anchorRef, label, className, children, onClose, align = 'start' }: {
  anchorRef: RefObject<HTMLElement | null>
  label: string
  className: string
  children: ReactNode
  onClose: () => void
  align?: 'start' | 'end'
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' })
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const positionMenu = () => {
      const rect = anchor.getBoundingClientRect()
      const margin = 12
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const width = Math.min(320, viewportWidth - margin * 2)
      const left = Math.max(margin, Math.min(align === 'end' ? rect.right - width : rect.left, viewportWidth - width - margin))
      const below = Math.max(0, viewportHeight - rect.bottom - margin - 6)
      const above = Math.max(0, rect.top - margin - 6)
      const useAbove = below < Math.min(menu.scrollHeight, 240) && above > below
      const maxHeight = Math.max(0, Math.min(viewportHeight - margin * 2, useAbove ? above : below))
      const height = Math.min(menu.scrollHeight, maxHeight)
      setPosition({ position: 'fixed', left, top: useAbove ? Math.max(margin, rect.top - height - 6) : Math.max(margin, Math.min(rect.bottom + 6, viewportHeight - maxHeight - margin)), width, maxHeight })
    }
    positionMenu()
    menu.focus()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(positionMenu)
    observer?.observe(menu)
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) closeRef.current()
    }
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    document.addEventListener('pointerdown', outside)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
      document.removeEventListener('pointerdown', outside)
    }
  }, [anchorRef, align])
  return createPortal(<div ref={menuRef} role="menu" aria-label={label} tabIndex={-1}
    className={`${styles.inviteDialog} ${styles.floatingMenu} ${className}`} style={position}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); onClose()
        anchorRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      } else if (event.key === 'Tab') onClose()
    }}>{children}</div>, document.body)
}

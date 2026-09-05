// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamFloatingMenu } from '../src/client/team/TeamFloatingMenu.tsx'

function Fixture() {
  const anchor = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  return <div ref={anchor}><button type="button" onClick={() => setOpen(true)}>Open</button>
    {open ? <TeamFloatingMenu anchorRef={anchor} label="Teams" className="test-menu" align="end" onClose={() => setOpen(false)}>
      <button type="button" role="menuitem" disabled>Current</button>
      <button type="button" role="menuitem">Join</button>
      <button type="button" role="menuitem">Create</button>
    </TeamFloatingMenu> : null}
  </div>
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps a right-edge menu fully inside a narrow viewport and scrolls long content', () => {
  vi.stubGlobal('innerWidth', 360)
  vi.stubGlobal('innerHeight', 500)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 308, right: 352, top: 68, bottom: 112, width: 44, height: 44, x: 308, y: 68, toJSON() {} })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(420)
  render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  const menu = screen.getByRole('menu')
  expect(menu.style.position).toBe('fixed')
  expect(menu.style.left).toBe('28px')
  expect(menu.style.width).toBe('320px')
  expect(menu.style.top).toBe('118px')
  expect(menu.style.maxHeight).toBe('370px')
})

it('opens above the trigger when the bottom edge leaves too little room', () => {
  vi.stubGlobal('innerWidth', 360)
  vi.stubGlobal('innerHeight', 500)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 20, right: 64, top: 420, bottom: 464, width: 44, height: 44, x: 20, y: 420, toJSON() {} })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300)
  render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  const menu = screen.getByRole('menu')
  expect(menu.style.left).toBe('12px')
  expect(menu.style.top).toBe('114px')
  expect(menu.style.maxHeight).toBe('402px')
})

it('supports arrow navigation, skips disabled items, and returns focus on Escape', () => {
  render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  const menu = screen.getByRole('menu')
  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Join' }))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Create' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }))
})

it('closes on an outside pointer event without trapping page focus', () => {
  render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
})

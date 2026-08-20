import { describe, expect, it } from 'vitest'
import { resolveFlyoutPosition } from '../src/client/flyout-position.ts'

describe('speed flyout placement', () => {
  it('opens on the right when the viewport has enough room', () => {
    expect(resolveFlyoutPosition(
      { left: 76, right: 316, bottom: 600 },
      { width: 248, height: 166 },
      { width: 900, height: 700 },
    )).toEqual({ left: 324, top: 438, side: 'right' })
  })

  it('flips left near the viewport edge', () => {
    expect(resolveFlyoutPosition(
      { left: 500, right: 740, bottom: 600 },
      { width: 248, height: 166 },
      { width: 800, height: 700 },
    )).toEqual({ left: 244, top: 438, side: 'left' })
  })

  it('clamps inside a narrow viewport when neither side fits', () => {
    expect(resolveFlyoutPosition(
      { left: 80, right: 320, bottom: 180 },
      { width: 248, height: 166 },
      { width: 400, height: 300 },
    )).toEqual({ left: 140, top: 18, side: 'right' })
  })
})

/** Viewport-safe placement for the composer speed flyout. */

export interface FlyoutAnchor {
  left: number
  right: number
  bottom: number
}

/** Measured flyout dimensions. */
export interface FlyoutSize {
  width: number
  height: number
}

/** Available browser viewport dimensions. */
export interface FlyoutViewport {
  width: number
  height: number
}

/** Viewport-safe flyout coordinates and selected anchor side. */
export interface FlyoutPosition {
  left: number
  top: number
  side: 'left' | 'right'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Prefer the anchor's right edge, flip left when it fits better, then clamp.
 *
 * @param anchor - Trigger element bounds.
 * @param size - Measured flyout dimensions.
 * @param viewport - Available viewport dimensions.
 * @returns Viewport-safe position.
 */
export function resolveFlyoutPosition(
  anchor: FlyoutAnchor,
  size: FlyoutSize,
  viewport: FlyoutViewport,
): FlyoutPosition {
  const margin = 12
  const gap = 8
  const rightCandidate = anchor.right + gap
  const leftCandidate = anchor.left - gap - size.width
  const rightFits = rightCandidate + size.width <= viewport.width - margin
  const leftFits = leftCandidate >= margin
  const preferredLeft = rightFits || !leftFits ? rightCandidate : leftCandidate
  const left = clamp(preferredLeft, margin, viewport.width - size.width - margin)
  // The speed row is the root menu's final row, so align the flyout bottoms.
  const topCandidate = anchor.bottom + 4 - size.height
  const top = clamp(topCandidate, margin, viewport.height - size.height - margin)

  return { left, top, side: left < anchor.left ? 'left' : 'right' }
}

import type { CanvasPanelData, Viewport } from '@/stores/canvas-store'

const GRID_SIZE = 40
/** Extra canvas-space margin around the viewport so panels don't flicker at the edges. */
const VISIBILITY_MARGIN = 200

/**
 * Off-viewport panels get "frozen" — their heavy content (iframes, terminals)
 * is hidden to save resources.
 */
export function isPanelVisible(
  panel: CanvasPanelData,
  viewport: Viewport,
  containerWidth: number,
  containerHeight: number
): boolean {
  // Keep only lightweight shells mounted until the first measurement. Assuming
  // everything is visible here briefly mounted and hydrated every transcript
  // during startup, which is exactly the high-water memory spike we avoid.
  if (!containerWidth || !containerHeight) return false

  const visibleLeft = -viewport.x / viewport.zoom - VISIBILITY_MARGIN
  const visibleTop = -viewport.y / viewport.zoom - VISIBILITY_MARGIN
  const visibleRight = visibleLeft + containerWidth / viewport.zoom + VISIBILITY_MARGIN * 2
  const visibleBottom = visibleTop + containerHeight / viewport.zoom + VISIBILITY_MARGIN * 2

  return (
    panel.x < visibleRight &&
    panel.x + panel.width > visibleLeft &&
    panel.y < visibleBottom &&
    panel.y + panel.height > visibleTop
  )
}

/** Converts a point relative to the container's top-left into canvas space. */
export function containerToCanvas(x: number, y: number, viewport: Viewport): { x: number; y: number } {
  return { x: (x - viewport.x) / viewport.zoom, y: (y - viewport.y) / viewport.zoom }
}

/**
 * Dot-grid background painted on the STATIC container instead of inside the
 * transformed layer: panning/zooming becomes two background-* property writes
 * (compositor work) instead of repositioning and re-rasterising a DOM node
 * that lives under the canvas transform.
 */
export function gridBackgroundStyle(viewport: Viewport): {
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
} {
  const size = GRID_SIZE * viewport.zoom
  // Screen-space dot radius. Matches the previous canvas-space formula
  // `max(1, min(2, 1.5 / zoom))` rendered under a `scale(zoom)` transform.
  const dot = Math.max(viewport.zoom, Math.min(2 * viewport.zoom, 1.5))
  return {
    backgroundImage: `radial-gradient(circle, var(--canvas-dot) ${dot}px, transparent ${dot}px)`,
    backgroundSize: `${size}px ${size}px`,
    backgroundPosition: `${viewport.x + size / 2}px ${viewport.y + size / 2}px`,
  }
}

export function formatViewportCoords(viewport: Viewport): string {
  return `${Math.round(-viewport.x / viewport.zoom)}, ${Math.round(-viewport.y / viewport.zoom)}`
}

export function viewportTransform(viewport: Viewport): string {
  return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`
}

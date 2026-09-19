/**
 * Pure geometry helpers for canvas figures. No DOM, no store — everything here
 * is a plain function over canvas-space numbers so it is trivially testable and
 * shared by the rendering layer, hit-testing and the create/move/resize
 * gestures (see docs/drawing.md §4, §6).
 */

import type {
  DrawingObject,
  FigureDirection,
} from './types'

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Normalize a drag from start (x1,y1) to end (x2,y2) into a bounding box with
 * non-negative width/height. The box always encloses both points.
 */
export function normalizeBox(x1: number, y1: number, x2: number, y2: number): Box {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  return { x, y, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

/**
 * Which diagonal of the box does a line/arrow run along, given the drag start
 * and end? The direction names the endpoint relative to the start:
 *   se = end is bottom-right, sw = bottom-left, ne = top-right, nw = top-left.
 */
export function figureDirection(x1: number, y1: number, x2: number, y2: number): FigureDirection {
  const dx = x2 - x1
  const dy = y2 - y1
  if (dx >= 0 && dy >= 0) return 'se'
  if (dx < 0 && dy >= 0) return 'sw'
  if (dx >= 0 && dy < 0) return 'ne'
  return 'nw'
}

/** The two endpoints (from/to) of a line/arrow for a box + direction. */
export function lineEndpoints(box: Box, direction: FigureDirection): { from: Point; to: Point } {
  const tl: Point = { x: box.x, y: box.y }
  const tr: Point = { x: box.x + box.width, y: box.y }
  const bl: Point = { x: box.x, y: box.y + box.height }
  const br: Point = { x: box.x + box.width, y: box.y + box.height }

  switch (direction) {
    case 'se': return { from: tl, to: br }
    case 'sw': return { from: tr, to: bl }
    case 'ne': return { from: bl, to: tr }
    case 'nw': return { from: br, to: tl }
  }
}

export interface ArrowGeometry {
  /** Path `d` for the shaft (stops short of the head so it never pokes through). */
  shaftD: string
  /** Three "x,y" points for the arrowhead <polygon> (tip first). */
  headPoints: string
}

/**
 * Build the shaft + arrowhead geometry for an arrow running from `from` to
 * `to`. The head scales with the stroke width so thin and thick arrows both
 * read correctly.
 */
export function arrowPath(from: Point, to: Point, strokeWidth: number): ArrowGeometry {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)

  // Degenerate (zero-length) arrow — render just a dot.
  if (len < 0.001) {
    const r = Math.max(2, strokeWidth)
    return {
      shaftD: `M ${from.x} ${from.y} L ${from.x} ${from.y}`,
      headPoints: `${to.x},${to.y} ${to.x - r},${to.y} ${to.x},${to.y - r}`,
    }
  }

  const angle = Math.atan2(dy, dx)
  const headLength = Math.max(10, strokeWidth * 4)
  const headWidth = Math.max(8, strokeWidth * 3)

  const baseX = to.x - headLength * Math.cos(angle)
  const baseY = to.y - headLength * Math.sin(angle)
  const perpX = -Math.sin(angle)
  const perpY = Math.cos(angle)

  const c1x = baseX + (headWidth / 2) * perpX
  const c1y = baseY + (headWidth / 2) * perpY
  const c2x = baseX - (headWidth / 2) * perpX
  const c2y = baseY - (headWidth / 2) * perpY

  return {
    shaftD: `M ${from.x} ${from.y} L ${baseX} ${baseY}`,
    headPoints: `${to.x},${to.y} ${c1x},${c1y} ${c2x},${c2y}`,
  }
}

/** Union bounding box of a set of figures (for selection outline / fit). */
export function unionBox(objects: DrawingObject[]): Box | null {
  if (objects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const o of objects) {
    minX = Math.min(minX, o.x)
    minY = Math.min(minY, o.y)
    maxX = Math.max(maxX, o.x + o.width)
    maxY = Math.max(maxY, o.y + o.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

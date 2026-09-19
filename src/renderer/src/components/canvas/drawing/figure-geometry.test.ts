import { describe, it, expect } from 'vitest'
import {
  normalizeBox,
  figureDirection,
  lineEndpoints,
  arrowPath,
  unionBox,
} from './figure-geometry'
import type { DrawingObject } from './types'

describe('normalizeBox', () => {
  it('normalizes a forward drag', () => {
    expect(normalizeBox(10, 20, 50, 80)).toEqual({ x: 10, y: 20, width: 40, height: 60 })
  })

  it('normalizes a backward drag', () => {
    expect(normalizeBox(50, 80, 10, 20)).toEqual({ x: 10, y: 20, width: 40, height: 60 })
  })

  it('handles a zero-size drag', () => {
    expect(normalizeBox(5, 5, 5, 5)).toEqual({ x: 5, y: 5, width: 0, height: 0 })
  })
})

describe('figureDirection', () => {
  it('se — end is bottom-right of start', () => {
    expect(figureDirection(0, 0, 10, 10)).toBe('se')
  })
  it('sw — end is bottom-left of start', () => {
    expect(figureDirection(10, 0, 0, 10)).toBe('sw')
  })
  it('ne — end is top-right of start', () => {
    expect(figureDirection(0, 10, 10, 0)).toBe('ne')
  })
  it('nw — end is top-left of start', () => {
    expect(figureDirection(10, 10, 0, 0)).toBe('nw')
  })
  it('zero delta counts as se', () => {
    expect(figureDirection(5, 5, 5, 5)).toBe('se')
  })
})

describe('lineEndpoints', () => {
  const box = { x: 0, y: 0, width: 100, height: 50 }

  it('se runs top-left to bottom-right', () => {
    expect(lineEndpoints(box, 'se')).toEqual({
      from: { x: 0, y: 0 },
      to: { x: 100, y: 50 },
    })
  })
  it('sw runs top-right to bottom-left', () => {
    expect(lineEndpoints(box, 'sw')).toEqual({
      from: { x: 100, y: 0 },
      to: { x: 0, y: 50 },
    })
  })
  it('ne runs bottom-left to top-right', () => {
    expect(lineEndpoints(box, 'ne')).toEqual({
      from: { x: 0, y: 50 },
      to: { x: 100, y: 0 },
    })
  })
  it('nw runs bottom-right to top-left', () => {
    expect(lineEndpoints(box, 'nw')).toEqual({
      from: { x: 100, y: 50 },
      to: { x: 0, y: 0 },
    })
  })
})

describe('arrowPath', () => {
  it('shaft stops short of the tip and the head points at the target', () => {
    const geo = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 2)
    expect(geo.shaftD).toMatch(/^M 0 0 L /)
    const baseX = parseFloat(geo.shaftD.split('L ')[1])
    expect(baseX).toBeGreaterThan(0)
    expect(baseX).toBeLessThan(100)
    expect(geo.headPoints.startsWith('100,0')).toBe(true)
  })

  it('head scales with stroke width', () => {
    const thin = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 1)
    const thick = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 8)
    const headSpan = (geo: typeof thin) => {
      const xs = geo.headPoints.split(' ').map((p) => parseFloat(p.split(',')[0]))
      return Math.max(...xs) - Math.min(...xs)
    }
    expect(headSpan(thick)).toBeGreaterThan(headSpan(thin))
  })

  it('a degenerate arrow renders a dot', () => {
    const geo = arrowPath({ x: 5, y: 5 }, { x: 5, y: 5 }, 2)
    expect(geo.shaftD).toBe('M 5 5 L 5 5')
  })
})

describe('unionBox', () => {
  const make = (id: string, x: number, y: number, w: number, h: number): DrawingObject => ({
    id,
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    stroke: '#000',
    strokeWidth: 2,
    fill: null,
    opacity: 1,
    zIndex: 1,
  })

  it('computes the bounding box of several figures', () => {
    expect(unionBox([make('a', 0, 0, 100, 50), make('b', 50, 25, 100, 50)])).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 75,
    })
  })

  it('returns null for an empty list', () => {
    expect(unionBox([])).toBeNull()
  })
})

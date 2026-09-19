import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { ActivityBadge } from './ActivityBadge'
import { ActivityRing } from './ActivityRing'
import { deriveActivity, type ActivityEvidence } from '@/lib/activity/derive-activity'
import { __resetMotionOwners } from '@/lib/activity/motion-owner'

const NOW = 50_000
const result = (e: ActivityEvidence) => deriveActivity(e, NOW)
const running = result({ entity: 'captain', live: { phase: 'working', observedAt: NOW - 10 } })

function mockReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
  window.matchMedia = globalThis.matchMedia
}

afterEach(() => {
  cleanup()
  __resetMotionOwners()
  vi.unstubAllGlobals()
})

describe('ActivityBadge', () => {
  it('has one accessible name and no live region', () => {
    mockReducedMotion(false)
    const { container } = render(
      <ActivityBadge result={result({ entity: 'captain', live: { phase: 'waiting_approval', observedAt: NOW } })} entityName="Captain" entityKey="c" region="r" />
    )
    expect(screen.getByRole('img', { name: 'Captain — Needs approval' })).toBeInTheDocument()
    expect(container.querySelector('[aria-live]')).toBeNull()
  })

  it('the motion owner breathes; a second indicator in the same region stays static', () => {
    mockReducedMotion(false)
    const { container } = render(
      <>
        <ActivityBadge result={running} entityName="A" entityKey="a" region="r" />
        <ActivityBadge result={running} entityName="B" entityKey="b" region="r" />
      </>
    )
    const motions = [...container.querySelectorAll('[data-activity-motion]')].map((el) => el.getAttribute('data-activity-motion'))
    expect(motions).toEqual(['breathe', 'none'])
  })

  it('is fully static under reduced motion', () => {
    mockReducedMotion(true)
    const { container } = render(<ActivityBadge result={running} entityName="A" entityKey="a" region="r" />)
    expect(container.querySelector('[data-activity-motion]')?.getAttribute('data-activity-motion')).toBe('none')
    expect(container.querySelector('.activity-breathe')).toBeNull()
  })

  it('draws unknown hollow and never animated', () => {
    mockReducedMotion(false)
    const { container } = render(
      <ActivityBadge result={result({ entity: 'task' })} entityName="T" entityKey="t" region="r" variant="dot" />
    )
    expect(screen.getByRole('img', { name: 'T — Status unavailable' })).toBeInTheDocument()
    expect(container.querySelector('.activity-breathe')).toBeNull()
  })

  it('shows the tool shimmer without progressbar semantics', () => {
    mockReducedMotion(false)
    const tool = result({ entity: 'commander', live: { phase: 'tool', observedAt: NOW, toolName: 'search' } })
    const { container } = render(<ActivityBadge result={tool} entityName="Commander" entityKey="cmd" region="r" />)
    expect(container.querySelector('.activity-shimmer')?.getAttribute('data-moving')).toBe('true')
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.querySelector('[aria-valuenow]')).toBeNull()
  })

  it('decorative badges are hidden from assistive technology', () => {
    mockReducedMotion(false)
    const { container } = render(<ActivityBadge result={running} entityName="A" entityKey="a" region="r" variant="dot" decorative />)
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('ActivityRing', () => {
  it('breathes only for thinking and is static under reduced motion', () => {
    mockReducedMotion(false)
    const thinking = result({ entity: 'commander', live: { phase: 'thinking', observedAt: NOW } })
    const { container, rerender } = render(<ActivityRing result={thinking} entityKey="c" region="r">x</ActivityRing>)
    expect(container.querySelector('.activity-ring-breathe')).not.toBeNull()
    rerender(<ActivityRing result={running} entityKey="c" region="r">x</ActivityRing>)
    expect(container.querySelector('.activity-ring-breathe')).toBeNull()
    cleanup()
    __resetMotionOwners()
    mockReducedMotion(true)
    const r2 = render(<ActivityRing result={thinking} entityKey="c" region="r">x</ActivityRing>)
    expect(r2.container.querySelector('.activity-ring-breathe')).toBeNull()
  })
})

// ── Token contrast (light and dark themes) ──────────────────

function hex(v: string): [number, number, number] {
  const h = v.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}
function luminance([r, g, b]: [number, number, number]): number {
  const c = [r, g, b].map((x) => {
    const s = x / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

describe('activity tone contrast', () => {
  const css = readFileSync(resolve(__dirname, '../../styles/globals.css'), 'utf8')
  const block = (selector: string, marker: string): Record<string, string> => {
    const start = css.indexOf(`${selector} {\n  ${marker}`)
    const body = css.slice(start, css.indexOf('}', start))
    const out: Record<string, string> = {}
    for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
    return out
  }
  const base = { light: block(':root', '--background'), dark: block('.dark', '--background') }
  const tones = { light: block(':root', '--activity-active'), dark: block('.dark', '--activity-active') }
  const resolveVar = (value: string, theme: 'light' | 'dark'): string => {
    const m = value.match(/^var\(--([\w-]+)\)$/)
    return m ? resolveVar(base[theme][m[1]], theme) : value
  }

  it.each(['light', 'dark'] as const)('every tone reaches 3:1 against the %s background', (theme) => {
    const bg = resolveVar(base[theme].background, theme)
    for (const name of ['activity-active', 'activity-attention', 'activity-review', 'activity-success', 'activity-danger', 'activity-muted']) {
      const value = resolveVar(tones[theme][name], theme)
      expect(contrast(value, bg), `${theme} ${name} ${value} on ${bg}`).toBeGreaterThanOrEqual(3)
    }
  })

  it.each(['light', 'dark'] as const)('badge text (foreground) reaches 4.5:1 on the %s background', (theme) => {
    const bg = resolveVar(base[theme].background, theme)
    expect(contrast(resolveVar(base[theme].foreground, theme), bg)).toBeGreaterThanOrEqual(4.5)
  })
})

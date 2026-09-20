import { describe, it, expect } from 'vitest'
import {
  agentHardCap,
  concurrencyFromSettings,
  defaultHardCap,
  effectiveLevel,
  evaluateResourcePressure,
  findPathOverlap,
  orderStartQueue,
  pathsOverlap,
  recommendLevel,
  validateLevelRequest,
  type OrderableStart
} from './concurrency'

const GiB = 1024 ** 3

describe('hard cap (#150)', () => {
  it('defaults to min(existing max_parallel_sessions, 5)', () => {
    expect(defaultHardCap(undefined)).toBe(1)
    expect(defaultHardCap(1)).toBe(1)
    expect(defaultHardCap(3)).toBe(3)
    expect(defaultHardCap(5)).toBe(5)
    expect(defaultHardCap(8)).toBe(5)
    expect(defaultHardCap('garbage')).toBe(1)
  })

  it('prefers an explicit concurrency_cap and falls back to the default otherwise', () => {
    expect(agentHardCap({ concurrency_cap: 5, max_parallel_sessions: 1 })).toBe(5)
    expect(agentHardCap({ concurrency_cap: 2, max_parallel_sessions: 9 })).toBe(2)
    expect(agentHardCap({ max_parallel_sessions: 9 })).toBe(5)
    expect(agentHardCap({ concurrency_cap: 0, max_parallel_sessions: 4 })).toBe(4)
    expect(agentHardCap(undefined)).toBe(1)
  })
})

describe('working level (#150)', () => {
  const cap = 5

  it('starts at 1 under Captain control, and is always clamped to the cap', () => {
    const settings = concurrencyFromSettings(undefined)
    expect(settings.captain_control).toBe(true)
    expect(effectiveLevel(settings, 'a', cap)).toEqual({ level: 1, source: 'captain', cap })
    const stored = concurrencyFromSettings({ concurrency: { levels: { a: 9 } } })
    expect(effectiveLevel(stored, 'a', cap).level).toBe(5)
  })

  it('a pin wins; Captain control off means the cap', () => {
    const pinned = concurrencyFromSettings({ concurrency: { levels: { a: 4 }, pinned: { a: 2 } } })
    expect(effectiveLevel(pinned, 'a', cap)).toEqual({ level: 2, source: 'pinned', cap })
    const off = concurrencyFromSettings({ concurrency: { captain_control: false, levels: { a: 2 } } })
    expect(effectiveLevel(off, 'a', cap)).toEqual({ level: 5, source: 'cap', cap })
  })

  it('accepts levels up to the cap of 5 and refuses anything above it', () => {
    const settings = concurrencyFromSettings(undefined)
    const ask = (level: unknown, reason: unknown = 'queue depth') => validateLevelRequest({ level, cap, settings, agentId: 'a', reason })
    expect(ask(5)).toEqual({ ok: true, level: 5 })
    expect(ask(1)).toEqual({ ok: true, level: 1 })
    const above = ask(6)
    expect(above.ok).toBe(false)
    expect(!above.ok && above.error).toMatch(/Refused: level 6 is above this agent's hard cap of 5/)
    expect(ask(0).ok).toBe(false)
    expect(ask(2.5).ok).toBe(false)
    expect(ask(3, '   ').ok).toBe(false)
  })

  it('refuses a Captain change to a pinned level or with Captain control off', () => {
    const pinned = concurrencyFromSettings({ concurrency: { pinned: { a: 2 } } })
    expect(validateLevelRequest({ level: 3, cap, settings: pinned, agentId: 'a', reason: 'x' })).toMatchObject({ ok: false })
    const off = concurrencyFromSettings({ concurrency: { captain_control: false } })
    expect(validateLevelRequest({ level: 3, cap, settings: off, agentId: 'a', reason: 'x' })).toMatchObject({ ok: false })
  })
})

describe('priority-aware queue order (#150)', () => {
  let seq = 0
  const start = (taskId: string, projectId: string, priority: string, minute: number): OrderableStart => ({
    taskId,
    projectId,
    priority,
    queuedAt: `2026-09-19T10:${String(minute).padStart(2, '0')}:00.000Z`,
    seq: ++seq
  })

  it('puts a critical ticket first within its project, FIFO within the same priority', () => {
    const queue = [
      start('low1', 'p', 'low', 0),
      start('med1', 'p', 'medium', 1),
      start('med2', 'p', 'medium', 2),
      start('high1', 'p', 'high', 3),
      start('crit', 'p', 'critical', 4)
    ]
    expect(orderStartQueue(queue).map((e) => e.taskId)).toEqual(['crit', 'high1', 'med1', 'med2', 'low1'])
  })

  it('breaks equal timestamps by insertion order', () => {
    const a = start('a', 'p', 'high', 5)
    const b = start('b', 'p', 'high', 5)
    expect(orderStartQueue([b, a]).map((e) => e.taskId)).toEqual(['a', 'b'])
  })

  it('does not starve another project: round robin across projects, oldest first', () => {
    const queue = [
      start('p1-a', 'p1', 'critical', 0),
      start('p1-b', 'p1', 'critical', 1),
      start('p1-c', 'p1', 'critical', 2),
      start('p2-low', 'p2', 'low', 3),
      start('p1-d', 'p1', 'critical', 4)
    ]
    const order = orderStartQueue(queue).map((e) => e.taskId)
    expect(order).toEqual(['p1-a', 'p2-low', 'p1-b', 'p1-c', 'p1-d'])
  })

  it('serves the project that started something least recently first', () => {
    const queue = [start('p1-a', 'p1', 'critical', 0), start('p1-b', 'p1', 'critical', 1), start('p2-low', 'p2', 'low', 2)]
    const served = (projectId: string): number => (projectId === 'p1' ? 7 : 0)
    expect(orderStartQueue(queue, served).map((e) => e.taskId)).toEqual(['p2-low', 'p1-a', 'p1-b'])
  })

  it('never lets priority cross a project boundary', () => {
    const queue = [start('p1-low', 'p1', 'low', 0), start('p2-crit', 'p2', 'critical', 1)]
    expect(orderStartQueue(queue).map((e) => e.taskId)).toEqual(['p1-low', 'p2-crit'])
  })
})

describe('file overlap (#150)', () => {
  it('matches the same file and a directory that holds it', () => {
    expect(pathsOverlap('src/main/a.ts', './src/main/a.ts')).toBe(true)
    expect(pathsOverlap('src/main/', 'src/main/a.ts')).toBe(true)
    expect(pathsOverlap('src/main/**', 'src/main/sub/b.ts')).toBe(true)
    expect(pathsOverlap('src\\main\\a.ts', 'src/main/a.ts')).toBe(true)
    expect(pathsOverlap('src/main/a.ts', 'src/main/ab.ts')).toBe(false)
    expect(pathsOverlap('src/mainx', 'src/main')).toBe(false)
    expect(findPathOverlap(['docs/x.md', 'src/a.ts'], ['src/'])).toEqual({ mine: 'src/a.ts', theirs: 'src/' })
    expect(findPathOverlap(['docs/x.md'], ['src/'])).toBeNull()
  })
})

describe('resource pressure (#150)', () => {
  it('is fine with free memory and low load', () => {
    expect(evaluateResourcePressure({ freeMemBytes: 8 * GiB, totalMemBytes: 32 * GiB, loadAvg1: 2, cpuCount: 8 }).underPressure).toBe(false)
  })

  it('flags low free memory and high CPU load', () => {
    const lowMem = evaluateResourcePressure({ freeMemBytes: 0.5 * GiB, totalMemBytes: 32 * GiB, loadAvg1: 1, cpuCount: 8 })
    expect(lowMem.underPressure).toBe(true)
    expect(lowMem.reasons[0]).toMatch(/free memory/)
    const busy = evaluateResourcePressure({ freeMemBytes: 16 * GiB, totalMemBytes: 32 * GiB, loadAvg1: 20, cpuCount: 8 })
    expect(busy.underPressure).toBe(true)
    expect(busy.reasons[0]).toMatch(/CPU load/)
  })
})

describe('recommendLevel (#150)', () => {
  const base = { cap: 5, level: 1, queued: 0, running: 1, serialChainQueued: 0, overlapQueued: 0, underPressure: false }

  it('suggests a raise for parallel demand, never above the cap', () => {
    expect(recommendLevel({ ...base, queued: 2 }).level).toBe(3)
    expect(recommendLevel({ ...base, queued: 12 }).level).toBe(5)
  })

  it('does not count serial-chain or overlapping starts as demand', () => {
    expect(recommendLevel({ ...base, queued: 2, serialChainQueued: 1, overlapQueued: 1 }).level).toBe(1)
  })

  it('holds or lowers under pressure', () => {
    expect(recommendLevel({ ...base, level: 4, running: 2, queued: 5, underPressure: true }).level).toBe(2)
  })
})

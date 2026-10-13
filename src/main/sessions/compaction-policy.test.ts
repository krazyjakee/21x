import { afterEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { DEFAULT_ROLLOVER_POLICY, evaluateRollover, normalizeRolloverPolicy, readRolloverPolicy, rolloverStageEnabled } from './compaction-policy'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const baseline = { contextTokens: 69, contextWindow: 100, compactions: 1, wakeups: 149, turns: 299, generationStartedAt: 1, now: 1 + 7 * 86_400_000 - 1 }
describe('planned rollover policy', () => {
  it.each([
    { reason: 'context', metric: { contextTokens: 70 } }, { reason: 'compactions', metric: { compactions: 2 } },
    { reason: 'wakeups', metric: { wakeups: 150 } }, { reason: 'turns', metric: { turns: 300 } },
    { reason: 'age', metric: { now: 1 + 7 * 86_400_000 } }
  ])('triggers exactly at the $reason threshold', ({ reason, metric }) => {
    const policy = { ...DEFAULT_ROLLOVER_POLICY, mode: 'on' as const }
    expect(evaluateRollover(baseline, policy).action).toBe('none')
    expect(evaluateRollover({ ...baseline, ...metric }, policy)).toMatchObject({ action: 'rollover', reasons: [reason] })
  })
  it('records observe decisions without activation and defers live turns or disabled stages', () => {
    const metrics = { ...baseline, turns: 300 }
    expect(evaluateRollover(metrics, DEFAULT_ROLLOVER_POLICY).action).toBe('none')
    expect(evaluateRollover(metrics, { ...DEFAULT_ROLLOVER_POLICY, mode: 'observe' }, false)).toMatchObject({ action: 'observe', deferred: null })
    expect(evaluateRollover(metrics, { ...DEFAULT_ROLLOVER_POLICY, mode: 'on' }, false)).toMatchObject({ action: 'observe', deferred: 'stage_disabled' })
    expect(evaluateRollover({ ...metrics, activeTurn: true }, { ...DEFAULT_ROLLOVER_POLICY, mode: 'on' })).toMatchObject({ action: 'observe', deferred: 'active_turn' })
  })
  it('keeps unknown context unknown and validates configured thresholds', () => {
    expect(evaluateRollover({ ...baseline, contextTokens: 10000, contextWindow: null }, { ...DEFAULT_ROLLOVER_POLICY, mode: 'on' }).action).toBe('none')
    expect(normalizeRolloverPolicy({ mode: 'invalid', contextRatio: 2, compactions: -1, wakeups: 0, turns: 0.5, maxAgeDays: NaN })).toEqual(DEFAULT_ROLLOVER_POLICY)
    expect(normalizeRolloverPolicy({ mode: 'observe', contextRatio: .8, compactions: 3, wakeups: 80, turns: 200, maxAgeDays: 2 })).toEqual({ mode: 'observe', contextRatio: .8, compactions: 3, wakeups: 80, turns: 200, maxAgeDays: 2 })
  })
  it('reads one shared settings policy and activates Captains before Commander', () => {
    const db = createPortableTestDb(); databases.push(db)
    expect(readRolloverPolicy(db.db)).toEqual(DEFAULT_ROLLOVER_POLICY)
    db.setSetting('sessions.rollover', 'on')
    db.setSetting('sessions.rollover_thresholds', JSON.stringify({ turns: 25 }))
    expect(readRolloverPolicy(db.db)).toMatchObject({ mode: 'on', turns: 25, contextRatio: .7 })
    db.setSetting('sessions.commander_managed', 'true')
    expect(rolloverStageEnabled(db.db, 'commander')).toBe(false)
    db.setSetting('sessions.captain_managed', 'true')
    expect(rolloverStageEnabled(db.db, 'captain')).toBe(true)
    expect(rolloverStageEnabled(db.db, 'commander')).toBe(true)
    db.setSetting('sessions.commander_managed', 'false')
    expect(rolloverStageEnabled(db.db, 'commander')).toBe(false)
  })
})

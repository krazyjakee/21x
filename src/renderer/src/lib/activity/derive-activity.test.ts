import { describe, expect, it } from 'vitest'
import { ACTIVITY_FINISH_ACCENT_MS, ACTIVITY_STALE_MS, ACTIVITY_STATES, type ActivityState } from '@shared/activity'
import {
  activityPresentation,
  deriveActivity,
  isQuietActivity,
  type ActivityEvidence,
  type ActivityResult
} from './derive-activity'

const NOW = 100_000
const fresh = NOW - 1_000

describe('deriveActivity: the eleven states', () => {
  const cases: Array<[string, ActivityEvidence, ActivityState, string]> = [
    ['running', { entity: 'task', live: { phase: 'working', observedAt: fresh } }, 'running', 'Running'],
    ['thinking', { entity: 'commander', live: { phase: 'thinking', observedAt: fresh } }, 'thinking', 'Thinking'],
    ['tool', { entity: 'commander', live: { phase: 'tool', observedAt: fresh, toolName: 'list_tasks' } }, 'tool', 'Using list_tasks'],
    ['waiting (approval)', { entity: 'task', live: { phase: 'waiting_approval', observedAt: fresh } }, 'waiting-for-user', 'Needs approval'],
    ['waiting (question)', { entity: 'task', live: { phase: 'question', observedAt: fresh } }, 'waiting-for-user', 'Needs your answer'],
    ['queued', { entity: 'task', queue: { reason: 'project_paused', observedAt: fresh } }, 'queued', 'Queued · project paused'],
    ['speaking', { entity: 'captain', live: { phase: 'idle', observedAt: fresh }, voice: { state: 'speaking' } }, 'speaking', 'Speaking'],
    ['listening', { entity: 'captain', voice: { state: 'listening' } }, 'listening', 'Listening'],
    ['finished (task)', { entity: 'task', lifecycle: 'ready_for_review' }, 'finished', 'Ready for review'],
    ['failed', { entity: 'task', live: { phase: 'error', observedAt: fresh, reason: 'exit 1' } }, 'failed', 'Failed'],
    ['idle', { entity: 'task', live: { phase: 'idle', observedAt: fresh } }, 'idle', 'Idle'],
    ['unknown', { entity: 'task' }, 'unknown', 'Status unavailable']
  ]

  it.each(cases)('%s', (_name, evidence, state, label) => {
    const r = deriveActivity(evidence, NOW)
    expect(r.state).toBe(state)
    expect(r.label).toBe(label)
  })

  it('covers every vocabulary state', () => {
    const covered = new Set(cases.map((c) => c[2]))
    for (const s of ACTIVITY_STATES) expect(covered.has(s)).toBe(true)
  })

  it('says "Replying" for a running Commander turn', () => {
    expect(deriveActivity({ entity: 'commander', live: { phase: 'working', observedAt: fresh } }, NOW).label).toBe('Replying')
  })

  it('keeps triaging/learning as a static detail on running', () => {
    const r = deriveActivity({ entity: 'task', live: { phase: 'working', observedAt: fresh }, lifecycle: 'triaging' }, NOW)
    expect(r).toMatchObject({ state: 'running', detail: 'Triaging' })
  })
})

describe('deriveActivity: unknown is never idle and lifecycle never proves running', () => {
  it.each(['agent_working', 'triaging', 'agent_learning', 'not_started'])('lifecycle %s alone is unknown', (lifecycle) => {
    const r = deriveActivity({ entity: 'task', lifecycle }, NOW)
    expect(r.state).toBe('unknown')
  })

  it('an empty store (no evidence) is unknown, not idle', () => {
    expect(deriveActivity({ entity: 'captain' }, NOW).state).toBe('unknown')
    expect(deriveActivity({ entity: 'commander', live: null }, NOW).state).toBe('unknown')
  })

  it('an unowned/unknown voice claim is never speaking', () => {
    const r = deriveActivity({ entity: 'captain', voice: { state: 'unknown' } }, NOW)
    expect(r.state).toBe('unknown')
    expect(r.detail).toBe('Voice state unavailable')
  })
})

describe('deriveActivity: freshness boundaries', () => {
  const at = (age: number): ActivityResult =>
    deriveActivity({ entity: 'task', live: { phase: 'working', observedAt: NOW - age } }, NOW)

  it('is fresh just before 15 s and unknown at 15 s', () => {
    expect(at(ACTIVITY_STALE_MS - 1).state).toBe('running')
    const stale = at(ACTIVITY_STALE_MS)
    expect(stale.state).toBe('unknown')
    expect(stale.lastKnown).toBe('running')
    expect(stale.detail).toBe('Last seen running')
  })

  it('reports when the running claim expires', () => {
    expect(at(1_000).expiresAt).toBe(NOW - 1_000 + ACTIVITY_STALE_MS)
  })

  it('verified idle also expires to unknown', () => {
    const r = deriveActivity({ entity: 'task', live: { phase: 'idle', observedAt: NOW - ACTIVITY_STALE_MS } }, NOW)
    expect(r.state).toBe('unknown')
    expect(isQuietActivity(r)).toBe(true)
  })

  it('an observation from the future (clock reset) is not fresh', () => {
    expect(deriveActivity({ entity: 'task', live: { phase: 'working', observedAt: NOW + 10 } }, NOW).state).toBe('unknown')
  })

  it('a known disconnect makes live claims unknown immediately', () => {
    const r = deriveActivity({ entity: 'task', live: { phase: 'working', observedAt: NOW }, disconnected: true }, NOW)
    expect(r.state).toBe('unknown')
    expect(r.detail).toContain('Disconnected')
  })

  it('stale queue membership is unknown, not queued', () => {
    const r = deriveActivity({ entity: 'task', queue: { reason: 'global_limit', observedAt: NOW - ACTIVITY_STALE_MS } }, NOW)
    expect(r.state).toBe('unknown')
  })

  it('a stale failure stays visible as the last result', () => {
    const r = deriveActivity({ entity: 'task', live: { phase: 'error', observedAt: NOW - ACTIVITY_STALE_MS - 1 } }, NOW)
    expect(r).toMatchObject({ state: 'unknown', lastKnown: 'failed', detail: 'Last result: Failed' })
  })
})

describe('deriveActivity: precedence and conflicts', () => {
  it('a blocking request outranks speech', () => {
    const r = deriveActivity({ entity: 'captain', live: { phase: 'waiting_approval', observedAt: fresh }, voice: { state: 'speaking' } }, NOW)
    expect(r.state).toBe('waiting-for-user')
  })

  it('speech outranks a running turn; the mic is a static detail', () => {
    const r = deriveActivity({ entity: 'captain', live: { phase: 'working', observedAt: fresh }, voice: { state: 'speaking', micOpen: true } }, NOW)
    expect(r).toMatchObject({ state: 'speaking', detail: 'Microphone open' })
  })

  it('a fresh queue claim and a fresh running claim reconcile to unknown instead of guessing', () => {
    const r = deriveActivity({ entity: 'task', live: { phase: 'working', observedAt: fresh }, queue: { reason: 'agent_limit', observedAt: fresh } }, NOW)
    expect(r.state).toBe('unknown')
    expect(r.detail).toBe('Reconciling queue and session')
  })

  it('a verified "not queued" read does not by itself say anything', () => {
    expect(deriveActivity({ entity: 'task', queue: null }, NOW).state).toBe('unknown')
  })

  it('names all six queue reasons', () => {
    const reasons: Record<string, string> = {
      global_limit: 'global session limit reached',
      agent_limit: 'agent session limit reached',
      project_limit: 'project session limit reached',
      global_pause: 'all projects paused',
      project_paused: 'project paused',
      project_daily_cap: 'daily budget reached'
    }
    for (const [reason, words] of Object.entries(reasons)) {
      const r = deriveActivity({ entity: 'task', queue: { reason, position: 2, observedAt: fresh } }, NOW)
      expect(r.state).toBe('queued')
      expect(r.label).toBe(`Queued · ${words}`)
      expect(r.detail).toBe(`#2 · ${words}`)
    }
  })
})

describe('deriveActivity: completion and failure', () => {
  it('an observed review transition gets the 3 s accent, then keeps the label', () => {
    const at = NOW - 500
    const evidence: ActivityEvidence = { entity: 'task', lifecycle: 'ready_for_review', outcome: { kind: 'finished', observedAt: at } }
    const during = deriveActivity(evidence, NOW)
    expect(during).toMatchObject({ state: 'finished', label: 'Ready for review', accent: true, expiresAt: at + ACTIVITY_FINISH_ACCENT_MS })
    const after = deriveActivity(evidence, at + ACTIVITY_FINISH_ACCENT_MS)
    expect(after).toMatchObject({ state: 'finished', label: 'Ready for review', accent: false })
  })

  it('a hydrated (unobserved) review status never gets the accent', () => {
    expect(deriveActivity({ entity: 'task', lifecycle: 'ready_for_review' }, NOW).accent).toBe(false)
  })

  it('completed stays "Completed" in the success tone', () => {
    expect(deriveActivity({ entity: 'task', lifecycle: 'completed' }, NOW)).toMatchObject({ label: 'Completed', tone: 'success' })
  })

  it('a Captain turn end is "Reply finished", never "Ready for review", then settles to idle', () => {
    const at = NOW - 100
    const evidence: ActivityEvidence = {
      entity: 'captain',
      live: { phase: 'idle', observedAt: at },
      outcome: { kind: 'finished', observedAt: at },
      lifecycle: 'ready_for_review'
    }
    expect(deriveActivity(evidence, NOW)).toMatchObject({ state: 'finished', label: 'Reply finished', accent: true })
    expect(deriveActivity(evidence, at + ACTIVITY_FINISH_ACCENT_MS).state).toBe('idle')
  })

  it('a new run clears the previous outcome', () => {
    const r = deriveActivity(
      { entity: 'captain', live: { phase: 'working', observedAt: NOW - 10 }, outcome: { kind: 'failed', observedAt: NOW - 5_000 } },
      NOW
    )
    expect(r.state).toBe('running')
  })

  it('cancellation is "Stopped" on idle, not failure or completion', () => {
    const r = deriveActivity(
      { entity: 'commander', live: { phase: 'idle', observedAt: fresh }, outcome: { kind: 'stopped', observedAt: fresh } },
      NOW
    )
    expect(r).toMatchObject({ state: 'idle', detail: 'Stopped' })
  })
})

describe('activityPresentation: motion and reduced motion', () => {
  const r = (state: ActivityEvidence): ActivityResult => deriveActivity(state, NOW)
  const running = r({ entity: 'task', live: { phase: 'working', observedAt: fresh } })
  const thinking = r({ entity: 'commander', live: { phase: 'thinking', observedAt: fresh } })
  const tool = r({ entity: 'commander', live: { phase: 'tool', observedAt: fresh } })

  it('only the motion owner animates, one motion per state', () => {
    expect(activityPresentation(running, { reducedMotion: false, motionOwner: true }).motion).toBe('breathe')
    expect(activityPresentation(thinking, { reducedMotion: false, motionOwner: true }).motion).toBe('ring')
    expect(activityPresentation(tool, { reducedMotion: false, motionOwner: true }).motion).toBe('shimmer')
    expect(activityPresentation(running, { reducedMotion: false, motionOwner: false }).motion).toBe('none')
  })

  it('reduced motion is fully static', () => {
    for (const result of [running, thinking, tool]) {
      expect(activityPresentation(result, { reducedMotion: true, motionOwner: true }).motion).toBe('none')
    }
    const finished = r({ entity: 'task', lifecycle: 'ready_for_review', outcome: { kind: 'finished', observedAt: NOW } })
    expect(activityPresentation(finished, { reducedMotion: true, motionOwner: true }).accent).toBe('static')
    expect(activityPresentation(finished, { reducedMotion: false, motionOwner: true }).accent).toBe('fade')
  })

  it.each<ActivityEvidence>([
    { entity: 'task', live: { phase: 'waiting_approval', observedAt: fresh } },
    { entity: 'task', queue: { observedAt: fresh } },
    { entity: 'captain', voice: { state: 'speaking' } },
    { entity: 'task', live: { phase: 'error', observedAt: fresh } },
    { entity: 'task', live: { phase: 'idle', observedAt: fresh } },
    { entity: 'task' }
  ])('non-active states never move (%#)', (evidence) => {
    expect(activityPresentation(r(evidence), { reducedMotion: false, motionOwner: true }).motion).toBe('none')
  })

  it('unknown is drawn hollow', () => {
    expect(activityPresentation(r({ entity: 'task' }), { reducedMotion: false, motionOwner: true }).hollow).toBe(true)
  })
})

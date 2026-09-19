/**
 * Per-project limits (#65), unit level: the settings block parses with
 * defaults, the admission check refuses for the right reason in the right
 * order, and the daily counter rolls over with the local day.
 */
import { describe, it, expect } from 'vitest'
import { checkAdmission, isGlobalAdmissionReason, type AdmissionContext, type CountedSession } from './agent-manager/admission'
import {
  GLOBAL_PAUSE_SETTING,
  buildProjectLimitState,
  describeQueueReason,
  getProjectDailyUsage,
  isAllProjectsPaused,
  localDayKey,
  projectAdmissionLimits,
  recordProjectSessionStart,
  recordProjectTokenUsage,
  setAllProjectsPaused
} from './project-limits'
import { DEFAULT_PROJECT_LIMITS, projectLimitsFromSettings } from '../shared/project-policies'
import type { AgentRecord, ProjectRecord, TaskRecord } from './database'

/** The three DB methods the module reads, over a plain map. */
function fakeStore(projects: Record<string, Partial<ProjectRecord>> = {}) {
  const settings = new Map<string, string>()
  return {
    settings,
    getSetting: (key: string) => settings.get(key),
    setSetting: (key: string, value: string) => { settings.set(key, value) },
    getProject: (id: string) => (projects[id] ? ({ id, name: id, settings: {}, ...projects[id] } as ProjectRecord) : undefined)
  }
}

const agent = { id: 'agent-1', config: { max_parallel_sessions: 5 } } as unknown as AgentRecord
const ctx = (taskId: string): AdmissionContext => ({
  agentId: agent.id,
  taskId,
  task: { id: taskId, project_id: 'p1' } as TaskRecord,
  agent
})
const running = (...ids: Array<[string, string]>): CountedSession[] =>
  ids.map(([taskId, projectId]) => ({ taskId, agentId: agent.id, projectId }))

describe('projectLimitsFromSettings', () => {
  it('defaults everything when the block is missing or malformed', () => {
    expect(projectLimitsFromSettings(undefined)).toEqual(DEFAULT_PROJECT_LIMITS)
    expect(projectLimitsFromSettings({ limits: 'nope' })).toEqual(DEFAULT_PROJECT_LIMITS)
    expect(projectLimitsFromSettings({ limits: { max_concurrent_agents: 0, daily_session_cap: -3, paused: 'yes' } })).toEqual(DEFAULT_PROJECT_LIMITS)
  })

  it('reads whole numbers and the pause', () => {
    expect(projectLimitsFromSettings({ limits: { max_concurrent_agents: '2', daily_session_cap: 10.7, daily_token_cap: 5000, paused: true } }))
      .toEqual({ max_concurrent_agents: 2, daily_session_cap: 10, daily_token_cap: 5000, paused: true })
  })
})

describe('checkAdmission with project limits', () => {
  it('queues with project_limit when the project has its agents running, and lets another project through', () => {
    const limits = { globalLimit: null, project: { projectId: 'p1', maxConcurrent: 1, paused: false, dailyCap: null, startedToday: 0 } }
    expect(checkAdmission(ctx('t2'), running(['t1', 'p1']), limits))
      .toEqual({ admitted: false, reason: 'project_limit', limit: 1, running: 1 })
    // A session in another project does not count against p1.
    expect(checkAdmission(ctx('t2'), running(['t1', 'p2']), limits)).toEqual({ admitted: true })
    // The requested task's own (stale) session never counts.
    expect(checkAdmission(ctx('t1'), running(['t1', 'p1']), limits)).toEqual({ admitted: true })
  })

  it('queues with project_daily_cap once the day is used up, even with free slots', () => {
    const limits = { globalLimit: null, project: { projectId: 'p1', maxConcurrent: null, paused: false, dailyCap: 3, startedToday: 3 } }
    expect(checkAdmission(ctx('t9'), [], limits)).toEqual({ admitted: false, reason: 'project_daily_cap', limit: 3, running: 3 })
    expect(checkAdmission(ctx('t9'), [], { ...limits, project: { ...limits.project, startedToday: 2 } })).toEqual({ admitted: true })
  })

  it('queues with project_paused and global_pause ahead of every other reason', () => {
    // Every other limit is also hit here; the pause still names itself.
    const paused = { globalLimit: null, project: { projectId: 'p1', maxConcurrent: 1, paused: true, dailyCap: 1, startedToday: 5 } }
    expect(checkAdmission(ctx('t2'), running(['t1', 'p1']), paused)).toMatchObject({ admitted: false, reason: 'project_paused' })
    expect(checkAdmission(ctx('t2'), running(['t1', 'p1']), { ...paused, globalPaused: true })).toMatchObject({ admitted: false, reason: 'global_pause' })
    expect(isGlobalAdmissionReason('global_pause')).toBe(true)
    expect(isGlobalAdmissionReason('project_paused')).toBe(false)
  })

  it('still applies the global and agent limits before the project cap', () => {
    const limits = { globalLimit: 1, project: { projectId: 'p1', maxConcurrent: 5, paused: false, dailyCap: null, startedToday: 0 } }
    expect(checkAdmission(ctx('t2'), running(['t1', 'p2']), limits)).toMatchObject({ reason: 'global_limit' })
  })
})

describe('daily counters', () => {
  it('count starts for the local day and reset on the next day', () => {
    const db = fakeStore()
    const day1 = new Date(2026, 8, 18, 23, 59)
    const day2 = new Date(2026, 8, 19, 0, 1)
    expect(getProjectDailyUsage(db, 'p1', day1)).toEqual({ date: localDayKey(day1), sessions: 0, tokens: 0 })
    recordProjectSessionStart(db, 'p1', day1)
    recordProjectSessionStart(db, 'p1', day1)
    recordProjectTokenUsage(db, 'p1', 1234, day1)
    expect(getProjectDailyUsage(db, 'p1', day1)).toMatchObject({ sessions: 2, tokens: 1234 })
    // Another project has its own row.
    expect(getProjectDailyUsage(db, 'p2', day1).sessions).toBe(0)
    // Midnight: a fresh day, and the first start of it overwrites the row.
    expect(getProjectDailyUsage(db, 'p1', day2)).toMatchObject({ sessions: 0, tokens: 0 })
    expect(recordProjectSessionStart(db, 'p1', day2)).toMatchObject({ date: localDayKey(day2), sessions: 1 })
  })

  it('survives a garbled row', () => {
    const db = fakeStore()
    db.setSetting('project_daily_usage:p1', '{not json')
    expect(getProjectDailyUsage(db, 'p1').sessions).toBe(0)
  })
})

describe('projectAdmissionLimits and the limit state', () => {
  it('turns the settings block and the counters into admission input', () => {
    const db = fakeStore({ p1: { settings: { limits: { max_concurrent_agents: 2, daily_session_cap: 4, paused: false } } } })
    recordProjectSessionStart(db, 'p1')
    expect(projectAdmissionLimits(db, 'p1')).toEqual({ projectId: 'p1', maxConcurrent: 2, paused: false, dailyCap: 4, startedToday: 1 })
    // An unknown project has the defaults: nothing limits it.
    expect(projectAdmissionLimits(db, 'ghost')).toEqual({ projectId: 'ghost', maxConcurrent: null, paused: false, dailyCap: null, startedToday: 0 })
  })

  it('treats a reached token cap as the day being used up, and an unreached one as no cap', () => {
    const db = fakeStore({ p1: { settings: { limits: { daily_token_cap: 100 } } } })
    expect(projectAdmissionLimits(db, 'p1').dailyCap).toBeNull()
    recordProjectSessionStart(db, 'p1')
    recordProjectTokenUsage(db, 'p1', 150)
    const limits = projectAdmissionLimits(db, 'p1')
    expect(limits.dailyCap).toBe(limits.startedToday)
    expect(checkAdmission(ctx('t1'), [], { globalLimit: null, project: limits })).toMatchObject({ reason: 'project_daily_cap' })
  })

  it('describes what the next start would wait for', () => {
    const db = fakeStore({ p1: { settings: { limits: { max_concurrent_agents: 1, daily_session_cap: 2 } } } })
    const queued = [{ taskId: 't3', agentId: agent.id, reason: 'project_limit' as const, queuedAt: 'now', position: 1 }]
    let state = buildProjectLimitState(db, 'p1', running(['t1', 'p1'], ['t2', 'p2']), queued)
    expect(state).toMatchObject({ projectId: 'p1', runningAgents: 1, maxConcurrentAgents: 1, dailySessionCap: 2, sessionsStartedToday: 0, blockedBy: 'project_limit', queued })
    expect(state.allProjectsPaused).toBe(false)

    recordProjectSessionStart(db, 'p1')
    recordProjectSessionStart(db, 'p1')
    state = buildProjectLimitState(db, 'p1', [], [])
    expect(state.blockedBy).toBe('project_daily_cap')

    setAllProjectsPaused(db, true)
    expect(isAllProjectsPaused(db)).toBe(true)
    expect(db.getSetting(GLOBAL_PAUSE_SETTING)).toBe('1')
    expect(buildProjectLimitState(db, 'p1', [], []).blockedBy).toBe('global_pause')
    setAllProjectsPaused(db, false)
    expect(buildProjectLimitState(db, 'p2', [], []).blockedBy).toBeNull()
  })

  it('has a sentence for every reason that tells the Captain not to retry', () => {
    for (const reason of ['project_limit', 'project_daily_cap', 'project_paused', 'global_pause', 'global_limit', 'agent_limit']) {
      expect(describeQueueReason(reason, 2, 2)).toContain('do not call start_task again')
    }
    expect(describeQueueReason('project_daily_cap', 40, 40)).toContain('40')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectOverviewEntry } from '@shared/project-overview'

type Listener = (event: unknown) => void

const api = vi.hoisted(() => {
  const listeners: Record<string, Listener[]> = {}
  const subscribe = (name: string) => vi.fn((cb: Listener) => {
    ;(listeners[name] ??= []).push(cb)
    return () => { listeners[name] = (listeners[name] ?? []).filter((l) => l !== cb) }
  })
  return {
    listeners,
    overviewApi: { getAllStatuses: vi.fn() },
    projectApi: { onStatusChanged: subscribe('project:statusChanged'), onChanged: subscribe('project:changed') },
    escalationApi: { onHeldChanged: subscribe('escalation:heldChanged') },
    onTaskUpdated: subscribe('task:updated'),
    onTaskCreated: subscribe('task:created'),
    onTaskDeleted: subscribe('task:deleted'),
    onAgentStatus: subscribe('agent:status'),
    onAgentStartQueueChanged: subscribe('agent:startQueueChanged')
  }
})
vi.mock('@/lib/ipc-client', () => api)

import { OVERVIEW_FALLBACK_POLL_MS, OVERVIEW_REFRESH_DEBOUNCE_MS, resetOverviewStoreForTests, useOverviewStore } from './overview-store'

function emit(name: string, event: unknown = {}): void {
  for (const listener of api.listeners[name] ?? []) listener(event)
}

function entry(project_id: string, running = 0): ProjectOverviewEntry {
  return {
    project_id, name: project_id, brief: '', is_default: false, sort_order: 0,
    status: { project_id, counts: { running, queued: 0, awaiting_review: 0, awaiting_approval: 0, blocked: 0 }, summary: '', top_blockers: [], updated_at: null },
    pending_approvals: 0, held_actions: 0, running_agents: running, paused: false, all_projects_paused: false,
    blocked_by: null, last_activity_at: null, needs_attention: false
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  resetOverviewStoreForTests()
  for (const key of Object.keys(api.listeners)) delete api.listeners[key]
  api.overviewApi.getAllStatuses.mockResolvedValue([entry('p1')])
})

afterEach(() => {
  resetOverviewStoreForTests()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('overview-store', () => {
  it('loads once on start and subscribes to every live event', async () => {
    const stop = useOverviewStore.getState().start()
    await flush()

    expect(api.overviewApi.getAllStatuses).toHaveBeenCalledTimes(1)
    expect(useOverviewStore.getState().entries.map((e) => e.project_id)).toEqual(['p1'])
    for (const name of ['task:updated', 'task:created', 'task:deleted', 'agent:status', 'agent:startQueueChanged', 'project:statusChanged', 'project:changed', 'escalation:heldChanged']) {
      expect(api.listeners[name], name).toHaveLength(1)
    }
    stop()
  })

  it('folds a burst of task and agent events into one debounced refresh', async () => {
    const stop = useOverviewStore.getState().start()
    await flush()
    api.overviewApi.getAllStatuses.mockResolvedValue([entry('p1', 2)])

    emit('task:updated', { taskId: 't1', updates: { status: 'agent_working' } })
    emit('task:created', { task: { id: 't2' } })
    emit('agent:status', { taskId: 't1', status: 'running' })
    emit('escalation:heldChanged', { held: [] })
    expect(api.overviewApi.getAllStatuses).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(OVERVIEW_REFRESH_DEBOUNCE_MS - 1)
    expect(api.overviewApi.getAllStatuses).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(api.overviewApi.getAllStatuses).toHaveBeenCalledTimes(2)
    expect(useOverviewStore.getState().entries[0].running_agents).toBe(2)
    stop()
  })

  it('fetches again after an event that lands mid-fetch', async () => {
    let release: (value: ProjectOverviewEntry[]) => void = () => {}
    api.overviewApi.getAllStatuses.mockImplementationOnce(() => new Promise<ProjectOverviewEntry[]>((resolve) => { release = resolve }))
    // start() kicks off the first load, which stays pending until released.
    const stop = useOverviewStore.getState().start()
    await flush()

    emit('task:updated', { taskId: 't1', updates: {} })
    await vi.advanceTimersByTimeAsync(OVERVIEW_REFRESH_DEBOUNCE_MS)
    expect(api.overviewApi.getAllStatuses).toHaveBeenCalledTimes(1)

    release([entry('p1', 1)])
    await flush()
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(api.overviewApi.getAllStatuses).toHaveBeenCalledTimes(2)
    stop()
  })

  it('polls slowly as a fallback and stops everything when the last view leaves', async () => {
    const stopA = useOverviewStore.getState().start()
    const stopB = useOverviewStore.getState().start()
    await flush()
    const loads = api.overviewApi.getAllStatuses.mock.calls.length

    await vi.advanceTimersByTimeAsync(OVERVIEW_FALLBACK_POLL_MS)
    await flush()
    expect(api.overviewApi.getAllStatuses).toHaveBeenCalledTimes(loads + 1)
    expect(api.listeners['task:updated']).toHaveLength(1)

    stopA()
    expect(api.listeners['task:updated']).toHaveLength(1)
    stopB()
    expect(api.listeners['task:updated']).toHaveLength(0)

    emit('task:updated', { taskId: 't1', updates: {} })
    await vi.advanceTimersByTimeAsync(OVERVIEW_FALLBACK_POLL_MS + OVERVIEW_REFRESH_DEBOUNCE_MS)
    expect(api.overviewApi.getAllStatuses).toHaveBeenCalledTimes(loads + 1)
  })

  it('records an error and keeps the last good entries', async () => {
    const stop = useOverviewStore.getState().start()
    await flush()
    api.overviewApi.getAllStatuses.mockRejectedValueOnce(new Error('offline'))

    await useOverviewStore.getState().fetchAll()

    expect(useOverviewStore.getState().error).toBe('offline')
    expect(useOverviewStore.getState().entries).toHaveLength(1)
    stop()
  })
})

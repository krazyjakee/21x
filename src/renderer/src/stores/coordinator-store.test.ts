import { describe, it, expect, beforeEach, vi } from 'vitest'

const taskApi = vi.hoisted(() => ({
  getCoordinatorTaskId: vi.fn(async (projectId?: string) => `mm-${projectId}` as string | null),
}))
vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  taskApi,
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
  projectApi: { getAll: vi.fn(async () => []) },
}))

import { getCaptainTaskId, captainAgentIdFor, useCoordinatorStore } from './coordinator-store'
import { useProjectStore } from './project-store'
import { DEFAULT_PROJECT_ID } from '@shared/projects'

/** One Captain id per project (#55), asked for once each. */
describe('coordinator-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCoordinatorStore.setState({ captainTaskIds: {} })
    useProjectStore.setState({ currentProjectId: DEFAULT_PROJECT_ID })
  })

  it('loads each project\'s id once and keeps them apart', async () => {
    const { load } = useCoordinatorStore.getState()
    const [a1, a2, b] = await Promise.all([load('proj-a'), load('proj-a'), load('proj-b')])
    expect(a1).toBe('mm-proj-a')
    expect(a2).toBe('mm-proj-a')
    expect(b).toBe('mm-proj-b')
    expect(taskApi.getCoordinatorTaskId).toHaveBeenCalledTimes(2)

    await load('proj-a')
    expect(taskApi.getCoordinatorTaskId).toHaveBeenCalledTimes(2)
    expect(useCoordinatorStore.getState().captainTaskIds).toEqual({ 'proj-a': 'mm-proj-a', 'proj-b': 'mm-proj-b' })
  })

  it('answers for the current project outside React', async () => {
    await useCoordinatorStore.getState().load('proj-b')
    expect(getCaptainTaskId()).toBeNull()
    useProjectStore.setState({ currentProjectId: 'proj-b' })
    expect(getCaptainTaskId()).toBe('mm-proj-b')
    expect(getCaptainTaskId('proj-a')).toBeNull()
  })

  it('survives a bridge that cannot answer', async () => {
    taskApi.getCoordinatorTaskId.mockRejectedValueOnce(new Error('no main'))
    await expect(useCoordinatorStore.getState().load('proj-x')).resolves.toBeNull()
  })
})

describe('captainAgentIdFor', () => {
  const agents = [
    { id: 'default-agent', is_default: true },
    { id: 'codex', is_default: false },
    { id: 'claude', is_default: false },
  ]

  it("prefers the project's Captain agent, then its default agent, then the app default", () => {
    expect(captainAgentIdFor({ captain_agent_id: 'codex', default_agent_id: 'claude' }, agents)).toBe('codex')
    expect(captainAgentIdFor({ captain_agent_id: null, default_agent_id: 'claude' }, agents)).toBe('claude')
    expect(captainAgentIdFor({ captain_agent_id: null, default_agent_id: null }, agents)).toBe('default-agent')
    expect(captainAgentIdFor(undefined, agents)).toBe('default-agent')
  })

  it('skips an agent that no longer exists and copes with an empty list', () => {
    expect(captainAgentIdFor({ captain_agent_id: 'gone', default_agent_id: 'claude' }, agents)).toBe('claude')
    expect(captainAgentIdFor({ captain_agent_id: 'gone', default_agent_id: null }, [{ id: 'only' }])).toBe('only')
    expect(captainAgentIdFor(undefined, [])).toBeNull()
  })
})

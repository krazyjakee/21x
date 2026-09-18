import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LinearPlugin } from './linear-plugin'
import { PluginActionId, type PluginContext } from './types'
import { TaskStatus } from '../../shared/constants'
import type { DatabaseManager, TaskRecord } from '../database'
import type { OAuthManager } from '../oauth/oauth-manager'

const mockClientInstance = {
  getIssue: vi.fn(),
  getWorkflowStates: vi.fn(),
  updateIssue: vi.fn(),
  addComment: vi.fn()
}

vi.mock('./linear-client', () => ({
  LinearClient: function LinearClient() {
    return mockClientInstance
  }
}))

const STATES = [
  { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' }
]

function makeContext(): PluginContext {
  return {
    db: {} as unknown as DatabaseManager,
    oauthManager: {
      getValidToken: vi.fn().mockResolvedValue('token-1')
    } as unknown as OAuthManager
  }
}

const task = {
  id: 'task-1',
  source_id: 'src-1',
  external_id: 'issue-1',
  status: TaskStatus.NotStarted
} as unknown as TaskRecord

describe('LinearPlugin change status action', () => {
  let plugin: LinearPlugin

  beforeEach(() => {
    vi.clearAllMocks()
    plugin = new LinearPlugin()
    mockClientInstance.getIssue.mockResolvedValue({ id: 'issue-1', team: { id: 'team-1' } })
    mockClientInstance.getWorkflowStates.mockResolvedValue(STATES)
    mockClientInstance.updateIssue.mockResolvedValue(undefined)
  })

  it('advertises only actions it can run', () => {
    expect(plugin.getActions({}).map((a) => a.id)).toContain(PluginActionId.ChangeStatus)
  })

  it('moves the issue to the Linear state named by the user', async () => {
    const result = await plugin.executeAction(
      PluginActionId.ChangeStatus,
      task,
      'in progress',
      {},
      makeContext()
    )

    expect(mockClientInstance.getWorkflowStates).toHaveBeenCalledWith('team-1')
    expect(mockClientInstance.updateIssue).toHaveBeenCalledWith('issue-1', { stateId: 'state-progress' })
    expect(result).toEqual({ success: true, taskUpdate: { status: TaskStatus.AgentWorking } })
  })

  it('accepts a local status and completes the task for a completed state', async () => {
    const result = await plugin.executeAction(
      PluginActionId.ChangeStatus,
      task,
      'completed',
      {},
      makeContext()
    )

    expect(mockClientInstance.updateIssue).toHaveBeenCalledWith('issue-1', { stateId: 'state-done' })
    expect(result).toEqual({ success: true, taskUpdate: { status: TaskStatus.Completed } })
  })

  it('reports an error when no workflow state matches', async () => {
    const result = await plugin.executeAction(
      PluginActionId.ChangeStatus,
      task,
      'Shipped',
      {},
      makeContext()
    )

    expect(mockClientInstance.updateIssue).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Shipped')
  })

  it('requires a status', async () => {
    const result = await plugin.executeAction(PluginActionId.ChangeStatus, task, '  ', {}, makeContext())
    expect(result).toEqual({ success: false, error: 'Status is required' })
  })
})

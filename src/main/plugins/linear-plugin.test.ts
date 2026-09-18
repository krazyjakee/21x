import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LinearPlugin } from './linear-plugin'
import { PluginActionId, type PluginContext } from './types'
import { TaskStatus } from '../../shared/constants'
import type { DatabaseManager, TaskRecord } from '../database'
import type { OAuthManager } from '../oauth/oauth-manager'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { LINEAR_ISSUES_FIRST_SYNC, LINEAR_ISSUES_RESYNC, LINEAR_UPLOAD_URL } from '../../../test/fixtures/linear-issues'

const mockClientInstance = {
  getIssue: vi.fn(),
  getIssues: vi.fn(),
  getWorkflowStates: vi.fn(),
  updateIssue: vi.fn(),
  addComment: vi.fn(),
  getAttachmentMetadata: vi.fn(),
  downloadAttachment: vi.fn()
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

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    db: {} as unknown as DatabaseManager,
    oauthManager: {
      getValidToken: vi.fn().mockResolvedValue('token-1')
    } as unknown as OAuthManager,
    ...overrides
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

// ── Fixture-based import ─────────────────────────────────────

describe('LinearPlugin importTasks', () => {
  let plugin: LinearPlugin
  let db: DatabaseManager
  let ctx: PluginContext
  let sourceId: string
  let attachmentsDir: string

  function taskFor(externalId: string): TaskRecord | undefined {
    return db.getTaskByExternalId(sourceId, externalId)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    plugin = new LinearPlugin()
    attachmentsDir = mkdtempSync(join(tmpdir(), '20x-linear-'))
    ;({ db } = createTestDb())
    db.getAttachmentsDir = vi.fn(() => attachmentsDir)
    ctx = makeContext({ db })
    sourceId = db.createTaskSource({ name: 'Linear', plugin_id: 'linear', mcp_server_id: null })!.id

    mockClientInstance.getIssues.mockResolvedValue(LINEAR_ISSUES_FIRST_SYNC)
    mockClientInstance.getAttachmentMetadata.mockResolvedValue({ id: 'att-1', title: 'login-loop.png' })
    mockClientInstance.downloadAttachment.mockResolvedValue({
      buffer: Buffer.from('png-bytes'),
      contentType: 'image/png'
    })
  })

  afterEach(() => {
    rmSync(attachmentsDir, { recursive: true, force: true })
  })

  it('imports issues with their mapped fields', async () => {
    const result = await plugin.importTasks(sourceId, { assignee_id: 'user-1' }, ctx)

    expect(result).toEqual({ imported: 3, updated: 0, errors: [] })
    expect(mockClientInstance.getIssues).toHaveBeenCalledWith('user-1')

    expect(taskFor('iss-1')).toMatchObject({
      title: 'Fix login redirect',
      status: TaskStatus.AgentWorking,
      priority: 'high',
      assignee: 'Ana',
      due_date: '2026-10-02',
      labels: ['Bug', 'Auth'],
      source: 'Linear',
      source_id: sourceId,
      external_id: 'iss-1'
    })
    expect(taskFor('iss-1')!.description).toContain('Users bounce back to /login')

    // No priority (0) is low; Todo is not started; Done is completed.
    expect(taskFor('iss-2')).toMatchObject({ status: TaskStatus.NotStarted, priority: 'low', assignee: '', labels: [] })
    expect(taskFor('iss-3')).toMatchObject({ status: TaskStatus.Completed, priority: 'critical', labels: ['Security'] })
  })

  it('downloads files linked from the description and points the markdown at the local copy', async () => {
    await plugin.importTasks(sourceId, {}, ctx)

    const task = taskFor('iss-1')!
    expect(mockClientInstance.downloadAttachment).toHaveBeenCalledWith(LINEAR_UPLOAD_URL)
    expect(task.attachments).toHaveLength(1)
    const attachment = task.attachments[0] as unknown as Record<string, unknown>
    expect(attachment).toMatchObject({ filename: 'login-loop.png', mime_type: 'image/png', linear_url: LINEAR_UPLOAD_URL })
    expect(readdirSync(attachmentsDir)).toEqual([`${attachment.id}-login-loop.png`])

    // Linear upload links expire; the description must use the saved copy.
    expect(task.description).toContain(`![login-loop.png](app-attachment://${task.id}/${attachment.id})`)
    expect(task.description).not.toContain(LINEAR_UPLOAD_URL)
  })

  it('refreshes existing tasks on a later sync without re-downloading files', async () => {
    await plugin.importTasks(sourceId, {}, ctx)
    const ids = { login: taskFor('iss-1')!.id, changelog: taskFor('iss-2')!.id }

    mockClientInstance.getIssues.mockResolvedValue(LINEAR_ISSUES_RESYNC)
    const result = await plugin.importTasks(sourceId, {}, ctx)

    expect(result).toEqual({ imported: 0, updated: 2, errors: [] })
    // Done in Linear completes the task here.
    expect(taskFor('iss-1')).toMatchObject({ id: ids.login, status: TaskStatus.Completed })
    // Still open in Linear: fields refresh, but 20x keeps the workflow state it had.
    expect(taskFor('iss-2')).toMatchObject({
      id: ids.changelog,
      title: 'Write the 2.0 changelog',
      assignee: 'Ben',
      status: TaskStatus.NotStarted
    })
    expect(mockClientInstance.downloadAttachment).toHaveBeenCalledTimes(1)
    expect(taskFor('iss-1')!.attachments).toHaveLength(1)
  })

  it('keeps the task when a file download fails', async () => {
    mockClientInstance.downloadAttachment.mockRejectedValue(new Error('Failed to download file: 403'))

    const result = await plugin.importTasks(sourceId, {}, ctx)

    expect(result).toEqual({ imported: 3, updated: 0, errors: [] })
    expect(taskFor('iss-1')!.attachments).toEqual([])
    expect(taskFor('iss-1')!.description).toContain(LINEAR_UPLOAD_URL)
  })

  it('reports an API failure and imports nothing', async () => {
    mockClientInstance.getIssues.mockRejectedValue(new Error('Linear GraphQL error: rate limited'))

    const result = await plugin.importTasks(sourceId, {}, ctx)

    expect(result).toEqual({ imported: 0, updated: 0, errors: ['Import failed: Linear GraphQL error: rate limited'] })
    expect(db.getTasks()).toHaveLength(0)
  })

  it('requires a valid OAuth token', async () => {
    const expired = makeContext({ db })
    ;(expired.oauthManager!.getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    expect(await plugin.importTasks(sourceId, {}, expired)).toEqual({
      imported: 0, updated: 0, errors: ['OAuth token expired. Please re-authenticate.']
    })

    expect(await plugin.importTasks(sourceId, {}, { db })).toEqual({
      imported: 0, updated: 0, errors: ['OAuth manager not available']
    })
    expect(mockClientInstance.getIssues).not.toHaveBeenCalled()
  })
})

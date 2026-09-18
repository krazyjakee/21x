import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../database'
import type { GitHubIssue, GitHubManager } from '../github-manager'
import { TaskStatus } from '../../shared/constants'
import { resolveSourcedStatus, upsertSourcedTask } from './sourced-tasks'
import { GitHubIssuesPlugin } from './github-issues-plugin'
import type { PluginContext } from './types'

let db: DatabaseManager
let ctx: PluginContext
let sourceId: string

beforeEach(() => {
  ;({ db } = createTestDb())
  ctx = { db }
  sourceId = db.createTaskSource({ name: 'GitHub', plugin_id: 'github-issues', mcp_server_id: null })!.id
})

function importOpen(externalId: string, status: string = TaskStatus.NotStarted) {
  return upsertSourcedTask(ctx, sourceId, externalId, { title: 'Issue', status }, { title: 'Issue', source: 'GitHub' })
}

describe('resolveSourcedStatus', () => {
  it.each([
    // [local status, source status, status written]
    [TaskStatus.NotStarted, TaskStatus.Completed, TaskStatus.Completed],
    [TaskStatus.AgentWorking, TaskStatus.Completed, TaskStatus.Completed],
    [TaskStatus.Completed, TaskStatus.Completed, undefined],
    [TaskStatus.Completed, TaskStatus.NotStarted, TaskStatus.NotStarted],
    [TaskStatus.Completed, TaskStatus.AgentWorking, TaskStatus.NotStarted],
    [TaskStatus.AgentWorking, TaskStatus.NotStarted, undefined],
    [TaskStatus.ReadyForReview, TaskStatus.AgentWorking, undefined],
    [TaskStatus.AgentWorking, undefined, undefined]
  ])('local %s + source %s -> %s', (local, source, expected) => {
    expect(resolveSourcedStatus(local, source)).toBe(expected)
  })
})

describe('upsertSourcedTask', () => {
  it('creates a task linked to the source with the source status', () => {
    const result = upsertSourcedTask(ctx, sourceId, '1', { title: 'Fix it', status: TaskStatus.AgentWorking }, {
      title: 'fallback',
      source: 'GitHub',
      repos: ['o/r']
    })

    expect(result?.created).toBe(true)
    expect(result?.task).toMatchObject({
      title: 'Fix it',
      status: TaskStatus.AgentWorking,
      source_id: sourceId,
      external_id: '1',
      source: 'GitHub',
      repos: ['o/r']
    })
  })

  it('completes an open task and saves its other fields when the source closes the item', () => {
    const created = importOpen('1')!.task
    db.updateTask(created.id, { status: TaskStatus.AgentWorking })

    const result = upsertSourcedTask(ctx, sourceId, '1', {
      title: 'Renamed at source',
      priority: 'high',
      status: TaskStatus.Completed
    }, { title: 'Issue' })

    expect(result?.created).toBe(false)
    expect(db.getTask(created.id)).toMatchObject({
      title: 'Renamed at source',
      priority: 'high',
      status: TaskStatus.Completed
    })
  })

  it('keeps the local workflow status while the item is open at the source', () => {
    const created = importOpen('1')!.task
    db.updateTask(created.id, { status: TaskStatus.ReadyForReview })

    importOpen('1', TaskStatus.NotStarted)

    expect(db.getTask(created.id)?.status).toBe(TaskStatus.ReadyForReview)
  })

  it('reopens a task that the source reopened', () => {
    const created = importOpen('1', TaskStatus.Completed)!.task
    expect(created.status).toBe(TaskStatus.Completed)

    importOpen('1', TaskStatus.AgentWorking)

    expect(db.getTask(created.id)?.status).toBe(TaskStatus.NotStarted)
  })

  it('keeps a task completed only in 20x (complete_at_source: false) completed after a refresh', () => {
    const created = importOpen('1')!.task
    db.updateTask(created.id, { status: TaskStatus.Completed, complete_at_source: false })

    importOpen('1', TaskStatus.NotStarted)
    importOpen('1', TaskStatus.AgentWorking)

    expect(db.getTask(created.id)).toMatchObject({ status: TaskStatus.Completed, complete_at_source: false })
  })
})

describe('GitHub Issues import through upsertSourcedTask', () => {
  function makeIssue(state: string): GitHubIssue {
    return {
      number: 7,
      title: 'Crash on start',
      body: 'Stack trace',
      state,
      assignees: [],
      labels: [],
      milestone: null,
      created_at: '',
      updated_at: ''
    }
  }

  it('updates the local task, without an import error, when the issue was closed at the source', async () => {
    const fetchIssues = vi.fn().mockResolvedValue([makeIssue('open')])
    const plugin = new GitHubIssuesPlugin({ fetchIssues } as unknown as GitHubManager)
    const config = { owner: 'o', repo: 'r', state: 'all' }

    expect(await plugin.importTasks(sourceId, config, ctx)).toEqual({ imported: 1, updated: 0, errors: [] })
    const task = db.getTaskByExternalId(sourceId, '7')!
    expect(task.status).toBe(TaskStatus.NotStarted)

    fetchIssues.mockResolvedValue([{ ...makeIssue('closed'), title: 'Crash on start (fixed)' }])
    expect(await plugin.importTasks(sourceId, config, ctx)).toEqual({ imported: 0, updated: 1, errors: [] })
    expect(db.getTask(task.id)).toMatchObject({ status: TaskStatus.Completed, title: 'Crash on start (fixed)' })
  })
})

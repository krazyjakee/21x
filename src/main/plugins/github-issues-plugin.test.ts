import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * GitHubManager shells out to the `gh` CLI, so the "HTTP layer" for this
 * plugin is `gh api`. The mock below stands in for the CLI: each test decides
 * what stdout (or error) a given `gh` invocation produces, and the real
 * GitHubManager parses it.
 */
const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn()
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')
  execFileMock[customPromisify] = (...args: unknown[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const callback = (error: Error | null, stdout = '', stderr = '') => {
        if (error) reject(error)
        else resolve({ stdout, stderr })
      }
      execFileMock(...args, callback)
    })
  return { execFileMock }
})

vi.mock('child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn()
}))

import { GitHubManager } from '../github-manager'
import { GitHubIssuesPlugin } from './github-issues-plugin'
import { PluginActionId, type PluginContext } from './types'
import { TaskStatus } from '../../shared/constants'
import type { DatabaseManager, TaskRecord } from '../database'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { GITHUB_ISSUES_FIRST_SYNC, GITHUB_ISSUES_RESYNC } from '../../../test/fixtures/github-issues'

type GhCallback = (error: Error | null, stdout?: string, stderr?: string) => void

/** stdout for a `gh` invocation, or a thrown error for a failing one. */
let ghHandler: (args: string[]) => string
let ghCalls: string[][]

function respondWith(handler: (args: string[]) => string): void {
  ghHandler = handler
}

/** The `gh api --paginate <path>` call that lists issues. */
function issuesListPath(args: string[]): string | undefined {
  return args[0] === 'api' && args[1] === '--paginate' && args[2].startsWith('/repos/') && args[2].includes('/issues?')
    ? args[2]
    : undefined
}

const config = { owner: 'acme', repo: 'widgets', state: 'open' }

let db: DatabaseManager
let ctx: PluginContext
let sourceId: string
let plugin: GitHubIssuesPlugin

beforeEach(() => {
  ghCalls = []
  execFileMock.mockReset()
  execFileMock.mockImplementation((file: string, args: string[], optionsOrCallback: unknown, maybeCallback?: GhCallback) => {
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as GhCallback
    expect(file).toBe('gh')
    ghCalls.push(args)
    try {
      callback(null, ghHandler(args), '')
    } catch (err) {
      callback(err as Error, '', '')
    }
  })
  respondWith((args) => {
    if (issuesListPath(args)) return JSON.stringify(GITHUB_ISSUES_FIRST_SYNC)
    return ''
  })

  ;({ db } = createTestDb())
  ctx = { db }
  sourceId = db.createTaskSource({ name: 'GitHub', plugin_id: 'github-issues', mcp_server_id: null })!.id
  plugin = new GitHubIssuesPlugin(new GitHubManager())
})

function taskFor(externalId: string): TaskRecord | undefined {
  return db.getTaskByExternalId(sourceId, externalId)
}

describe('GitHubIssuesPlugin importTasks', () => {
  it('asks gh for the configured repository and state', async () => {
    await plugin.importTasks(sourceId, config, ctx)
    expect(ghCalls).toEqual([['api', '--paginate', '/repos/acme/widgets/issues?per_page=100&state=open']])
  })

  it('passes assignee and label filters through to the API query', async () => {
    await plugin.importTasks(sourceId, { ...config, assignee: 'alice', labels: 'bug,p1' }, ctx)
    const query = new URL('https://api.github.com' + issuesListPath(ghCalls[0])!).searchParams
    expect(query.get('assignee')).toBe('alice')
    expect(query.get('labels')).toBe('bug,p1')
    expect(query.get('state')).toBe('open')
  })

  it('imports issues with their mapped fields and skips pull requests', async () => {
    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result).toEqual({ imported: 3, updated: 0, errors: [] })

    expect(taskFor('12')).toMatchObject({
      title: 'Crash on startup',
      status: TaskStatus.AgentWorking,
      priority: 'high',
      assignee: 'alice',
      due_date: '2026-10-15',
      labels: ['bug', 'in progress'],
      repos: ['acme/widgets'],
      source: 'GitHub',
      source_id: sourceId,
      external_id: '12'
    })
    expect(taskFor('12')!.description).toContain('Stack trace')

    expect(taskFor('13')).toMatchObject({
      title: 'Docs typo',
      description: '',
      status: TaskStatus.ReadyForReview,
      priority: 'low',
      assignee: '',
      labels: ['needs review']
    })

    // A closed issue is imported as a completed task.
    expect(taskFor('15')).toMatchObject({ status: TaskStatus.Completed, priority: 'low', labels: [] })

    // The issues API lists pull requests too; #14 is one.
    expect(taskFor('14')).toBeUndefined()
  })

  it('updates existing tasks on a later sync and lets the source close them', async () => {
    await plugin.importTasks(sourceId, config, ctx)
    const originalId = taskFor('12')!.id

    respondWith(() => JSON.stringify(GITHUB_ISSUES_RESYNC))
    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result).toEqual({ imported: 0, updated: 3, errors: [] })
    // Same task, refreshed: closed at GitHub completes it here.
    expect(taskFor('12')).toMatchObject({
      id: originalId,
      title: 'Crash on startup (fixed)',
      status: TaskStatus.Completed,
      labels: ['bug']
    })
    // An issue that is still open keeps the workflow state 20x gave it, even
    // though its labels no longer say "review".
    expect(taskFor('13')).toMatchObject({ status: TaskStatus.ReadyForReview, labels: [] })
    expect(db.getTasks().filter((t) => t.source_id === sourceId)).toHaveLength(3)
  })

  it('reopens a task the source reopened', async () => {
    await plugin.importTasks(sourceId, config, ctx)
    expect(taskFor('15')!.status).toBe(TaskStatus.Completed)

    respondWith(() => JSON.stringify(GITHUB_ISSUES_RESYNC.map((issue) =>
      issue.number === 15 ? { ...issue, state: 'open' } : issue
    )))
    await plugin.importTasks(sourceId, config, ctx)

    expect(taskFor('15')!.status).toBe(TaskStatus.NotStarted)
  })

  it('reports a failing gh call without touching the database', async () => {
    respondWith(() => { throw new Error('gh: Not Found (HTTP 404)') })

    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result).toEqual({ imported: 0, updated: 0, errors: ['Import failed: gh: Not Found (HTTP 404)'] })
    expect(db.getTasks()).toHaveLength(0)
  })

  it('reports unparseable gh output as an import error', async () => {
    respondWith(() => 'gh: To get started with GitHub CLI, please run: gh auth login')

    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^Import failed: /)
  })
})

describe('GitHubIssuesPlugin writes back through gh', () => {
  it('closes the issue and syncs labels when the local task changes', async () => {
    await plugin.importTasks(sourceId, config, ctx)
    const task = taskFor('12')!

    await plugin.exportUpdate(task, { status: TaskStatus.Completed, labels: ['bug'] }, config, ctx)

    expect(ghCalls.at(-1)).toEqual([
      'api', '-X', 'PATCH', '/repos/acme/widgets/issues/12',
      '-f', 'state=closed',
      '--raw-field', 'labels=["bug"]'
    ])
  })

  it('posts a comment for the Add Comment action', async () => {
    await plugin.importTasks(sourceId, config, ctx)
    const task = taskFor('13')!

    const result = await plugin.executeAction(PluginActionId.AddComment, task, 'Fixed in #16', config, ctx)

    expect(result).toEqual({ success: true })
    expect(ghCalls.at(-1)).toEqual([
      'api', '-X', 'POST', '/repos/acme/widgets/issues/13/comments', '-f', 'body=Fixed in #16'
    ])
  })

  it('surfaces a gh failure as an action error', async () => {
    await plugin.importTasks(sourceId, config, ctx)
    const task = taskFor('13')!
    respondWith(() => { throw new Error('gh: Forbidden (HTTP 403)') })

    const result = await plugin.executeAction(PluginActionId.CloseIssue, task, undefined, config, ctx)

    expect(result).toEqual({ success: false, error: 'Action failed: gh: Forbidden (HTTP 403)' })
  })
})

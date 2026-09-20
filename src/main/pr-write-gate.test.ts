import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import {
  activateAuthorizationDispatch,
  prepareAuthorizationDispatch,
  recordHumanAuthorization,
  revokeAuthorization
} from './authorization'
import { OPEN_DRAFT_PR_TOOL, prWriteTools } from './mcp-servers/pr-write-tools'
import { handlePrWriteRoute, setPrWriteRunner } from './pr-write-gate'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))

describe('narrow draft pull-request capability gate', () => {
  let db: ReturnType<typeof createTestDb>['db']
  let projectId: string
  let taskId: string
  let rootId: string
  let workspace: string
  const head = 'a'.repeat(40)
  const url = 'https://github.com/krazyjakee/21x/pull/999'

  beforeEach(() => {
    db = createTestDb().db
    projectId = db.createProject({ name: '21x' })!.id
    db.addProjectRepo(projectId, { provider: 'github', org: 'krazyjakee', name: '21x', default_branch: 'main' })
    taskId = db.createTask(makeTask({ title: 'Implement capability repair', type: 'coding', project_id: projectId, repos: ['krazyjakee/21x'] }))!.id
    workspace = mkdtempSync(join(tmpdir(), '21x-pr-gate-'))
    mkdirSync(join(workspace, '21x', '.git'), { recursive: true })
    vi.spyOn(db, 'getWorkspaceDir').mockReturnValue(workspace)
    const text = 'Implement the unified capability repair'
    const origin = recordHumanAuthorization(db, {
      messageId: 'human-coding-task', text, at: Date.now(), source: 'project-chat',
      sessionId: 'coding-session', taskId, projectId
    })
    rootId = origin.id
    activateAuthorizationDispatch(db, prepareAuthorizationDispatch(db, {
      key: 'coding-task-dispatch', taskId, text, messageId: origin.messageId
    }))
  })

  afterEach(() => {
    setPrWriteRunner(null)
    db.close()
    rmSync(workspace, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const scope = () => ({ parentTaskId: null, taskId, artifactTaskId: taskId, projectId })

  it('pushes without force, opens one exact draft and recovers an identical retry', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    let existing: Record<string, unknown> | null = null
    setPrWriteRunner(async (command, args) => {
      calls.push({ command, args })
      if (command === 'git') {
        if (args[0] === 'rev-parse') return `${head}\n`
        if (args[0] === 'branch') return 'fix/capabilities\n'
        if (args[0] === 'status') return ''
        if (args[0] === 'remote') return 'git@github.com:krazyjakee/21x.git\n'
        if (args[0] === 'merge-base' || args[0] === 'push') return ''
      }
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(existing ? [existing] : [])
      if (args[0] === 'pr' && args[1] === 'create') {
        existing = { url, isDraft: true, state: 'OPEN', headRefOid: head, baseRefName: 'main' }
        return `${url}\n`
      }
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(existing)
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    })

    const request = { repo: 'krazyjakee/21x', title: 'Unify intent capabilities', body: 'Implements the audited contract.' }
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, request, scope())).toEqual({
      status: 'opened', pr_url: url, draft: true, head_sha: head, base: 'main'
    })
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, request, scope())).toEqual({
      status: 'already_done', pr_url: url, draft: true, head_sha: head, base: 'main'
    })
    expect(calls.filter((call) => call.command === 'git' && call.args[0] === 'push')).toHaveLength(1)
    expect(calls.filter((call) => call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create')).toHaveLength(1)
    expect(calls.flatMap((call) => call.args)).not.toContain('--force')
    expect(calls.flatMap((call) => call.args)).not.toContain('merge')
    expect(calls.flatMap((call) => call.args)).not.toContain('approve')
  })

  it('rechecks revocation after asynchronous inspection and before pushing', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    setPrWriteRunner(async (command, args) => {
      calls.push({ command, args })
      if (command === 'git' && args[0] === 'rev-parse') return `${head}\n`
      if (command === 'git' && args[0] === 'branch') return 'fix/capabilities\n'
      if (command === 'git' && args[0] === 'status') return ''
      if (command === 'git' && args[0] === 'remote') return 'https://github.com/krazyjakee/21x.git\n'
      if (command === 'git' && args[0] === 'merge-base') return ''
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        revokeAuthorization(db, rootId, 'withdrawn during PR inspection')
        return '[]'
      }
      if (command === 'git' && args[0] === 'push') throw new Error('push must not run')
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    })
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'No longer authorized' }, scope()))
      .toMatchObject({ status: 'refused', code: 'capability_refused', authorization_status: 'revoked', origin_node_id: rootId })
    expect(calls.some((call) => call.command === 'git' && call.args[0] === 'push')).toBe(false)
  })

  it('refuses raw, cross-repository, dirty and notification-bearing requests', async () => {
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'Raw' }))
      .toMatchObject({ status: 'refused', code: 'task_scope_required' })
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'other/repo', title: 'Cross scope' }, scope()))
      .toMatchObject({ status: 'refused', code: 'repo_not_in_project' })
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'Ping @someone' }, scope()))
      .toMatchObject({ status: 'refused', code: 'payload_rejected' })
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'Secret', body: 'ghp_1234567890abcdefghijklmnop' }, scope()))
      .toMatchObject({ status: 'refused', code: 'credential_escalation' })
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'Extra', token: 'caller-selected' }, scope()))
      .toMatchObject({ status: 'refused', code: 'payload_rejected' })

    setPrWriteRunner(async (command, args) => {
      if (command === 'git' && args[0] === 'rev-parse') return `${head}\n`
      if (command === 'git' && args[0] === 'branch') return 'fix/capabilities\n'
      if (command === 'git' && args[0] === 'status') return ' M src/main/file.ts\n'
      if (command === 'git' && args[0] === 'remote') return 'https://github.com/krazyjakee/21x.git\n'
      throw new Error('must stop at dirty status')
    })
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'Dirty' }, scope()))
      .toMatchObject({ status: 'refused', code: 'worktree_dirty' })
  })

  it('advertises only draft opening, without merge or approval arguments', () => {
    expect(prWriteTools.map((tool) => tool.name)).toEqual([OPEN_DRAFT_PR_TOOL])
    const schema = prWriteTools[0].inputSchema as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(['repo', 'title', 'body', 'base'])
  })
})

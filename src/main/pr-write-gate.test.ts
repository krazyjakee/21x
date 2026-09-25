import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import { OPEN_DRAFT_PR_TOOL, prWriteTools } from './mcp-servers/pr-write-tools'
import { handlePrWriteRoute, setPrWriteRunner } from './pr-write-gate'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))

describe('narrow draft pull-request capability gate', () => {
  let db: ReturnType<typeof createTestDb>['db']
  let projectId: string
  let taskId: string
  let sessionNonce: string
  let workspace: string
  const head = 'a'.repeat(40)
  const url = 'https://github.com/krazyjakee/21x/pull/999'

  beforeEach(() => {
    db = createTestDb().db
    projectId = db.createProject({ name: '21x' })!.id
    db.addProjectRepo(projectId, { provider: 'github', org: 'krazyjakee', name: '21x', default_branch: 'main' })
    taskId = db.createTask(makeTask({ title: 'Implement capability repair', type: 'coding', project_id: projectId, repos: ['krazyjakee/21x'] }))!.id
    sessionNonce = db.rotateTaskMcpScopeNonce(taskId)
    workspace = mkdtempSync(join(tmpdir(), '21x-pr-gate-'))
    mkdirSync(join(workspace, '21x', '.git'), { recursive: true })
    vi.spyOn(db, 'getWorkspaceDir').mockReturnValue(workspace)
  })

  afterEach(() => {
    vi.useRealTimers()
    setPrWriteRunner(null)
    db.close()
    rmSync(workspace, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const scope = () => ({ parentTaskId: null, taskId, artifactTaskId: taskId, projectId, agentId: 'test-agent', sessionNonce })
  const gitState = (command: string, args: string[], options: { dirty?: boolean; pushUrl?: string } = {}): string | null => {
    if (command !== 'git') return null
    if (args[0] === 'rev-parse') return `${head}\n`
    if (args[0] === 'branch') return 'fix/capabilities\n'
    if (args[0] === 'status') return options.dirty ? ' M src/main/file.ts\n' : ''
    if (args[0] === 'remote' && args.includes('--push')) return `${options.pushUrl ?? 'https://github.com/krazyjakee/21x.git'}\n`
    if (args[0] === 'remote') return 'https://github.com/krazyjakee/21x.git\n'
    if (args[0] === 'config') return ''
    if (args[0] === 'merge-base' || args[0] === 'push') return ''
    if (args[0] === 'ls-remote') return `${head}\trefs/heads/fix/capabilities\n`
    return null
  }

  it('pushes without force, opens one exact draft and recovers an identical retry', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    let existing: Record<string, unknown> | null = null
    setPrWriteRunner(async (command, args) => {
      calls.push({ command, args })
      const git = gitState(command, args)
      if (git !== null) return git
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

  it.each(['repository_removed', 'task_repo_removed', 'stale_session'] as const)('rechecks %s after the final remote lookup and before creating', async (change) => {
    let lookups = 0
    let created = false
    setPrWriteRunner(async (command, args) => {
      const git = gitState(command, args)
      if (git !== null) return git
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        lookups++
        if (lookups === 2) {
          if (change === 'repository_removed') db.removeProjectRepo(db.getProjectRepos(projectId)[0].id)
          if (change === 'task_repo_removed') db.updateTask(taskId, { repos: [] })
          if (change === 'stale_session') db.rotateTaskMcpScopeNonce(taskId)
        }
        return '[]'
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        created = true
        return `${url}\n`
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    })

    const result = await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'Final boundary' }, scope())
    expect(result).toMatchObject({
      status: 'refused',
      code: change === 'task_repo_removed' ? 'repo_not_in_task' : change === 'stale_session' ? 'stale_task_session' : 'repo_not_in_project'
    })
    expect(created).toBe(false)
  })

  it('refuses a replaced signed session before inspecting or mutating the repository', async () => {
    const oldScope = scope()
    db.rotateTaskMcpScopeNonce(taskId)
    const run = vi.fn()
    setPrWriteRunner(run)
    expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'Stale session' }, oldScope))
      .toMatchObject({ status: 'refused', code: 'stale_task_session' })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a real Git worktree whose authorized fetch URL has a different pushurl', async () => {
    const repoDir = join(workspace, '21x')
    const other = mkdtempSync(join(tmpdir(), '21x-other-remote-'))
    try {
      rmSync(repoDir, { recursive: true, force: true })
      mkdirSync(repoDir, { recursive: true })
      execFileSync('git', ['init', '--initial-branch=fix/capabilities'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir })
      execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repoDir })
      execFileSync('git', ['init', '--bare'], { cwd: other })
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/krazyjakee/21x.git'], { cwd: repoDir })
      execFileSync('git', ['remote', 'set-url', '--add', '--push', 'origin', other], { cwd: repoDir })
      setPrWriteRunner(null)

      expect(await handlePrWriteRoute(db, `/${OPEN_DRAFT_PR_TOOL}`, { repo: 'krazyjakee/21x', title: 'Wrong destination' }, scope()))
        .toMatchObject({ status: 'refused', code: 'push_destination_mismatch' })
      expect(execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: other, encoding: 'utf8' })).toBe('')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
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
      const git = gitState(command, args, { dirty: true })
      if (git !== null) return git
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

/**
 * Repos, provider and org resolve from the task's project (#50). The global
 * settings are a fallback for the Default project only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { makeTask } from '../../../test/helpers/task-fixtures'
import type { DatabaseManager } from '../database'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import { setupTaskWorktrees } from './worktree-setup'
import { resolveTaskRepos, validateProjectRepos } from './project-repos'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

function fakeManagers() {
  const lister = () => ({ fetchOrgRepos: vi.fn(async () => [] as Array<{ fullName: string; defaultBranch: string }>) })
  return {
    worktreeManager: { setupWorkspaceForTask: vi.fn(async (taskId: string) => `/tmp/ws/${taskId}`) },
    githubManager: lister(),
    gitlabManager: lister(),
    forgejoManager: lister()
  }
}

describe('setupTaskWorktrees resolves from the task project', () => {
  it('gives tasks in two projects with different orgs and providers worktrees from the right place', async () => {
    db.setSetting('github_org', 'global-org')
    db.setSetting('git_provider', 'github')
    const alpha = db.createProject({ name: 'Alpha', git_provider: 'gitlab', git_org: 'alpha-group' })!
    const beta = db.createProject({ name: 'Beta', git_provider: 'forgejo', git_org: 'beta-org' })!
    db.addProjectRepo(alpha.id, { name: 'api', provider: 'gitlab', default_branch: 'develop' })
    db.addProjectRepo(beta.id, { name: 'api', provider: 'forgejo', org: 'beta-org' })
    const inAlpha = db.createTask(makeTask({ title: 'A', project_id: alpha.id, repos: ['api'] }))!
    const inBeta = db.createTask(makeTask({ title: 'B', project_id: beta.id, repos: ['api'] }))!
    const managers = fakeManagers()

    await setupTaskWorktrees(db, managers as never, inAlpha.id)
    await setupTaskWorktrees(db, managers as never, inBeta.id)

    expect(managers.worktreeManager.setupWorkspaceForTask).toHaveBeenCalledWith(
      inAlpha.id, [{ fullName: 'alpha-group/api', defaultBranch: 'develop', cloneUrl: undefined }], 'alpha-group', 'gitlab'
    )
    expect(managers.worktreeManager.setupWorkspaceForTask).toHaveBeenCalledWith(
      inBeta.id, [{ fullName: 'beta-org/api', defaultBranch: 'main', cloneUrl: undefined }], 'beta-org', 'forgejo'
    )
    expect(managers.gitlabManager.fetchOrgRepos).toHaveBeenCalledWith('alpha-group')
    expect(managers.forgejoManager.fetchOrgRepos).toHaveBeenCalledWith('beta-org')
    expect(managers.githubManager.fetchOrgRepos).not.toHaveBeenCalled()
  })

  it('falls back to the global org and provider for the Default project only', () => {
    db.setSetting('github_org', 'global-org')
    db.setSetting('git_provider', 'gitlab')
    const plain = db.createProject({ name: 'Plain' })!

    expect(resolveTaskRepos(db, { project_id: DEFAULT_PROJECT_ID, repos: ['app'] }))
      .toEqual([{ fullName: 'global-org/app', name: 'app', org: 'global-org', provider: 'gitlab', defaultBranch: null }])
    // No org of its own and no project repo: nothing to clone, rather than the global org.
    expect(resolveTaskRepos(db, { project_id: plain.id, repos: ['app'] })).toEqual([])
  })

  it('runs a task of a project with no repos in an empty workspace', async () => {
    const empty = db.createProject({ name: 'Empty' })!
    const task = db.createTask(makeTask({ title: 'No repos', project_id: empty.id }))!
    const managers = fakeManagers()

    expect(await setupTaskWorktrees(db, managers as never, task.id)).toBeUndefined()
    expect(managers.worktreeManager.setupWorkspaceForTask).not.toHaveBeenCalled()
  })
})

describe('validateProjectRepos', () => {
  it('rejects a repo of another project', () => {
    const alpha = db.createProject({ name: 'Alpha', git_org: 'alpha' })!
    const beta = db.createProject({ name: 'Beta', git_org: 'beta' })!
    db.addProjectRepo(alpha.id, { name: 'web' })
    db.addProjectRepo(beta.id, { name: 'secret' })

    expect(validateProjectRepos(db, alpha.id, ['web'])).toEqual({ repos: ['alpha/web'] })
    const result = validateProjectRepos(db, alpha.id, ['beta/secret'])
    expect('error' in result && result.error).toContain('beta/secret')
  })
})

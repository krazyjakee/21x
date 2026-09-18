import { join } from 'path'
import { existsSync } from 'fs'
import type { DatabaseManager } from '../database'
import { TaskStatus } from '../../shared/constants'
import { isCoordinatorTask } from '../../shared/task-roles'
import type { WorktreeManager } from '../worktree-manager'
import type { GitHubManager } from '../github-manager'
import type { GitLabManager } from '../gitlab-manager'
import type { ForgejoManager } from '../forgejo-manager'
import { resolveRepoProvider, type GitProvider } from '../repo-providers'

interface GitManagers {
  worktreeManager: WorktreeManager | null
  githubManager: GitHubManager | null
  gitlabManager: GitLabManager | null
  forgejoManager: ForgejoManager | null
}

type RepoLister = { fetchOrgRepos(org: string): Promise<Array<{ fullName: string; defaultBranch: string; cloneUrl?: string }>> }

function providerManager(managers: GitManagers, provider: GitProvider): RepoLister | null {
  if (provider === 'gitlab') return managers.gitlabManager
  if (provider === 'forgejo') return managers.forgejoManager
  return managers.githubManager
}

/**
 * Sets up git worktrees for a task's repos if needed.
 * Skips for coordinator rows, heartbeat sessions and tasks without repos.
 */
export async function setupTaskWorktrees(
  db: DatabaseManager,
  managers: GitManagers,
  taskId: string
): Promise<string | undefined> {
  const { worktreeManager } = managers
  if (taskId.startsWith('heartbeat-')) return undefined

  if (!worktreeManager) return undefined

  const gitProvider = db.getSetting('git_provider') || 'github'
  const configuredOrg = db.getSetting('github_org')

  const task = db.getTask(taskId)
  if (!task || isCoordinatorTask(task)) return undefined
  if (!task.repos || !Array.isArray(task.repos) || task.repos.length === 0) return undefined

  const workspaceDir = db.getWorkspaceDir(taskId)
  const missingRepoFolders = task.repos.some((repo) => {
    const repoName = repo.split('/').pop() || repo
    return !existsSync(join(workspaceDir, repoName))
  })

  // Triage sessions normally should not allocate worktrees, but if the user
  // starts the real agent before the task status flips out of Triaging and the
  // repo folders are missing, repair the workspace on demand.
  if (task.status === TaskStatus.Triaging && !task.session_id && !missingRepoFolders) return undefined

  try {
    console.log(`[AgentManager] setupWorktreeIfNeeded: defaultProvider=${gitProvider}, configuredOrg=${configuredOrg || 'unset'}, taskRepos=${task.repos.join(', ')}`)

    // Group by provider + org: each repo is cloned with the CLI of the
    // provider it was attached from (see repo-providers.ts).
    const reposByGroup = new Map<string, { provider: GitProvider; org: string; repoNames: string[] }>()
    for (const repoName of task.repos) {
      const org = repoName.includes('/') ? repoName.split('/')[0] : configuredOrg
      if (!org) {
        console.warn(`[AgentManager] Skipping repo without org and no configured github_org: ${repoName}`)
        continue
      }
      const fullName = repoName.includes('/') ? repoName : `${org}/${repoName}`
      const provider = resolveRepoProvider(db, fullName)
      if (!providerManager(managers, provider)) {
        console.warn(`[AgentManager] No ${provider} manager available, skipping worktree setup for ${fullName}`)
        continue
      }
      const key = `${provider}:${org}`
      const group = reposByGroup.get(key) || { provider, org, repoNames: [] }
      group.repoNames.push(fullName)
      reposByGroup.set(key, group)
    }

    if (reposByGroup.size === 0) return undefined

    let resolvedWorkspaceDir: string | undefined

    for (const { provider, org, repoNames } of reposByGroup.values()) {
      let orgRepos: Array<{ fullName: string; defaultBranch: string; cloneUrl?: string }> = []

      try {
        orgRepos = await providerManager(managers, provider)?.fetchOrgRepos(org) ?? []
      } catch (error) {
        console.warn(`[AgentManager] Failed to fetch ${provider} repo metadata for org "${org}", falling back to task repo names:`, error)
      }

      const branchByRepo = new Map(orgRepos.map((repo) => [repo.fullName, repo.defaultBranch]))
      const cloneUrlByRepo = new Map(orgRepos.map((repo) => [repo.fullName, repo.cloneUrl]))
      const reposForSetup = repoNames.map((fullName) => ({
        fullName,
        defaultBranch: branchByRepo.get(fullName) || 'main',
        cloneUrl: cloneUrlByRepo.get(fullName)
      }))

      console.log(`[AgentManager] Setting up ${reposForSetup.length} ${provider} repo(s) for org "${org}": ${reposForSetup.map((repo) => repo.fullName).join(', ')}`)

      const workspaceDirForOrg = await worktreeManager.setupWorkspaceForTask(
        taskId,
        reposForSetup,
        org,
        provider
      )
      resolvedWorkspaceDir = resolvedWorkspaceDir || workspaceDirForOrg
    }

    return resolvedWorkspaceDir
  } catch (error) {
    console.error(`[AgentManager] Worktree setup failed:`, error)
    return undefined
  }
}

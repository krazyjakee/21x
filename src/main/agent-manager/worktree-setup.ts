import { join } from 'path'
import { existsSync } from 'fs'
import type { DatabaseManager } from '../database'
import { TaskStatus } from '../../shared/constants'
import type { WorktreeManager } from '../worktree-manager'
import type { GitHubManager } from '../github-manager'
import type { GitLabManager } from '../gitlab-manager'

interface GitManagers {
  worktreeManager: WorktreeManager | null
  githubManager: GitHubManager | null
  gitlabManager: GitLabManager | null
}

/**
 * Sets up git worktrees for a task's repos if needed.
 * Skips for mastermind sessions or tasks without repos.
 */
export async function setupTaskWorktrees(
  db: DatabaseManager,
  managers: GitManagers,
  taskId: string
): Promise<string | undefined> {
  const { worktreeManager, githubManager, gitlabManager } = managers
  if (taskId === 'mastermind-session' || taskId.startsWith('heartbeat-')) return undefined

  if (!worktreeManager) return undefined

  const gitProvider = db.getSetting('git_provider') || 'github'
  const configuredOrg = db.getSetting('github_org')

  const task = db.getTask(taskId)
  if (!task) return undefined
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
    console.log(`[AgentManager] setupWorktreeIfNeeded: provider=${gitProvider}, configuredOrg=${configuredOrg || 'unset'}, taskRepos=${task.repos.join(', ')}`)

    if (gitProvider === 'gitlab' && !gitlabManager) {
      console.warn(`[AgentManager] No ${gitProvider} manager available, skipping worktree setup`)
      return undefined
    }
    if (gitProvider !== 'gitlab' && !githubManager) {
      console.warn(`[AgentManager] No ${gitProvider} manager available, skipping worktree setup`)
      return undefined
    }

    const reposByOrg = new Map<string, string[]>()
    for (const repoName of task.repos) {
      const org = repoName.includes('/') ? repoName.split('/')[0] : configuredOrg
      if (!org) {
        console.warn(`[AgentManager] Skipping repo without org and no configured github_org: ${repoName}`)
        continue
      }
      const fullName = repoName.includes('/') ? repoName : `${org}/${repoName}`
      const existing = reposByOrg.get(org) || []
      existing.push(fullName)
      reposByOrg.set(org, existing)
    }

    if (reposByOrg.size === 0) return undefined

    let resolvedWorkspaceDir: string | undefined

    for (const [org, repoNames] of reposByOrg.entries()) {
      let orgRepos: Array<{ fullName: string; defaultBranch: string; cloneUrl?: string }> = []

      try {
        if (gitProvider === 'gitlab' && gitlabManager) {
          orgRepos = await gitlabManager.fetchOrgRepos(org)
        } else if (githubManager) {
          orgRepos = await githubManager.fetchOrgRepos(org)
        }
      } catch (error) {
        console.warn(`[AgentManager] Failed to fetch repo metadata for org "${org}", falling back to task repo names:`, error)
      }

      const branchByRepo = new Map(orgRepos.map((repo) => [repo.fullName, repo.defaultBranch]))
      const cloneUrlByRepo = new Map(orgRepos.map((repo) => [repo.fullName, repo.cloneUrl]))
      const reposForSetup = repoNames.map((fullName) => ({
        fullName,
        defaultBranch: branchByRepo.get(fullName) || 'main',
        cloneUrl: cloneUrlByRepo.get(fullName)
      }))

      console.log(`[AgentManager] Setting up ${reposForSetup.length} repo(s) for org "${org}": ${reposForSetup.map((repo) => repo.fullName).join(', ')}`)

      const workspaceDirForOrg = await worktreeManager.setupWorkspaceForTask(
        taskId,
        reposForSetup,
        org,
        gitProvider
      )
      resolvedWorkspaceDir = resolvedWorkspaceDir || workspaceDirForOrg
    }

    return resolvedWorkspaceDir
  } catch (error) {
    console.error(`[AgentManager] Worktree setup failed for ${gitProvider}:`, error)
    return undefined
  }
}

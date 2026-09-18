import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'

type GitProvider = 'github' | 'gitlab'

/** GitHub / GitLab CLIs and the per-task worktrees built from them. */
export function registerGitHandlers({ db, githubManager, gitlabManager, worktreeManager, workspaceCleanupScheduler }: IpcDeps): void {
  ipcMain.handle('github:checkCli', async () => githubManager.checkGhCli())
  ipcMain.handle('github:fetchOrgs', async () => githubManager.fetchUserOrgs())
  ipcMain.handle('github:fetchOrgRepos', async (_, org: string) => githubManager.fetchOrgRepos(org))
  ipcMain.handle('github:fetchUserRepos', async () => githubManager.fetchUserRepos())
  ipcMain.handle('github:fetchPullRequestDetails', async (_, url: string) => githubManager.fetchPullRequestDetails(url))

  ipcMain.handle('gitlab:checkCli', async () => gitlabManager?.checkGlabCli() ?? { installed: false, authenticated: false })
  ipcMain.handle('gitlab:fetchOrgs', async () => gitlabManager?.fetchUserOrgs() ?? [])
  ipcMain.handle('gitlab:fetchOrgRepos', async (_, org: string) => gitlabManager?.fetchOrgRepos(org) ?? [])
  ipcMain.handle('gitlab:fetchUserRepos', async () => gitlabManager?.fetchUserRepos() ?? [])

  ipcMain.handle(
    'worktree:setup',
    async (_, taskId: string, repos: { fullName: string; defaultBranch: string; cloneUrl?: string }[], org: string, provider?: GitProvider) => {
      const resolvedProvider = provider || (db.getSetting('git_provider') as GitProvider | null) || 'github'
      return worktreeManager.setupWorkspaceForTask(taskId, repos, org, resolvedProvider)
    }
  )

  ipcMain.handle('worktree:changes', async (_, taskId: string, repos: { fullName: string }[]) => {
    return worktreeManager.getTaskChanges(taskId, repos)
  })

  ipcMain.handle('worktree:files', async (_, taskId: string, repos: { fullName: string }[]) => {
    return worktreeManager.getTaskFiles(taskId, repos)
  })

  ipcMain.handle('worktree:readFile', (_, taskId: string, repoFullName: string | null, filePath: string) => {
    return worktreeManager.readTaskFile(taskId, repoFullName, filePath)
  })

  ipcMain.handle('worktree:cleanup', async (_, taskId: string, repos: { fullName: string }[], org: string, removeTaskDir?: boolean) => {
    await worktreeManager.cleanupTaskWorkspace(taskId, repos, org, removeTaskDir ?? true)
  })

  ipcMain.handle('workspace:runCleanupNow', async () => {
    if (!workspaceCleanupScheduler) return { cleaned: 0, errors: ['Cleanup scheduler not initialized'] }
    return workspaceCleanupScheduler.runNow()
  })
}

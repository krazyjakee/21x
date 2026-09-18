import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { FORGEJO_LOGIN_SETTING, isGitProvider, recordRepoProviders, type GitProvider } from '../repo-providers'

const TEA_UNAVAILABLE = { installed: false, authenticated: false, logins: [], code: 'not-installed' }

/** GitHub / GitLab / Forgejo CLIs and the per-task worktrees built from them. */
export function registerGitHandlers({ db, githubManager, gitlabManager, forgejoManager, worktreeManager, workspaceCleanupScheduler }: IpcDeps): void {
  ipcMain.handle('github:checkCli', async () => githubManager.checkGhCli())
  ipcMain.handle('github:fetchOrgs', async () => githubManager.fetchUserOrgs())
  ipcMain.handle('github:fetchOrgRepos', async (_, org: string) => githubManager.fetchOrgRepos(org))
  ipcMain.handle('github:fetchUserRepos', async () => githubManager.fetchUserRepos())
  ipcMain.handle('github:fetchPullRequestDetails', async (_, url: string) => {
    // Pull request artifacts share one channel; Forgejo URLs are recognised by
    // matching their host against the configured tea logins.
    if (forgejoManager && !/^https:\/\/github\.com\//i.test(url) && await forgejoManager.isForgejoUrl(url)) {
      return forgejoManager.fetchPullRequestDetails(url)
    }
    return githubManager.fetchPullRequestDetails(url)
  })

  ipcMain.handle('gitlab:checkCli', async () => gitlabManager?.checkGlabCli() ?? { installed: false, authenticated: false })
  ipcMain.handle('gitlab:fetchOrgs', async () => gitlabManager?.fetchUserOrgs() ?? [])
  ipcMain.handle('gitlab:fetchOrgRepos', async (_, org: string) => gitlabManager?.fetchOrgRepos(org) ?? [])
  ipcMain.handle('gitlab:fetchUserRepos', async () => gitlabManager?.fetchUserRepos() ?? [])

  // Forgejo goes through the tea CLI and its logins.
  ipcMain.handle('forgejo:checkCli', async () => forgejoManager?.checkTeaCli() ?? TEA_UNAVAILABLE)
  ipcMain.handle('forgejo:setLogin', async (_, loginName: string | null) => {
    db.setSetting(FORGEJO_LOGIN_SETTING, loginName ?? '')
    return forgejoManager?.checkTeaCli() ?? TEA_UNAVAILABLE
  })
  ipcMain.handle('forgejo:fetchOrgs', async () => forgejoManager?.fetchUserOrgs() ?? [])
  ipcMain.handle('forgejo:fetchOrgRepos', async (_, org: string) => forgejoManager?.fetchOrgRepos(org) ?? [])
  ipcMain.handle('forgejo:fetchUserRepos', async () => forgejoManager?.fetchUserRepos() ?? [])

  ipcMain.handle('git:recordRepoProviders', (_, repoFullNames: string[], provider: GitProvider) => {
    if (!isGitProvider(provider) || !Array.isArray(repoFullNames)) return
    recordRepoProviders(db, repoFullNames, provider)
  })

  ipcMain.handle(
    'worktree:setup',
    async (_, taskId: string, repos: { fullName: string; defaultBranch: string; cloneUrl?: string }[], org: string, provider?: GitProvider) => {
      const configured = db.getSetting('git_provider')
      const resolvedProvider: GitProvider = provider || (isGitProvider(configured) ? configured : 'github')
      if (provider) recordRepoProviders(db, repos.map((repo) => repo.fullName), provider)
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

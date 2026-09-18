import { useCallback, useEffect, useState } from 'react'
import { useSettingsStore, type GitProvider } from '@/stores/settings-store'
import { taskApi, worktreeApi, onWorktreeProgress, gitApi } from '@/lib/ipc-client'
import { subscribe } from '@/lib/shared-ipc-listeners'
import type { Task } from '@/types'
import type { GitHubRepo } from '@/types/electron'

type UpdateTask = (taskId: string, data: Record<string, unknown>) => Promise<void>

/**
 * Adding/removing task repos: git CLI auth check → org picker → repo selector,
 * plus worktree provisioning for sessions that are already running.
 */
export function useRepoSetupFlow(
  task: Task | undefined,
  sessionId: string | null,
  onUpdateTask: UpdateTask | undefined,
  fetchTasks: () => void
) {
  const githubOrg = useSettingsStore((s) => s.githubOrg)
  const checkGhCli = useSettingsStore((s) => s.checkGhCli)
  const checkGlabCli = useSettingsStore((s) => s.checkGlabCli)
  const checkTeaCli = useSettingsStore((s) => s.checkTeaCli)
  const setGithubOrg = useSettingsStore((s) => s.setGithubOrg)

  const [showGhSetup, setShowGhSetup] = useState(false)
  const [showOrgPicker, setShowOrgPicker] = useState(false)
  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [orgProvider, setOrgProvider] = useState<GitProvider>('github')
  const [isSettingUpWorktree, setIsSettingUpWorktree] = useState(false)

  // Shared listener to avoid MaxListeners warnings with many open panels.
  useEffect(() => {
    if (!task?.id) return

    return subscribe(
      'worktree:progress',
      (cb) => onWorktreeProgress(cb),
      (event: { taskId?: string; done?: boolean }) => {
        if (event.taskId !== task.id) return
        setIsSettingUpWorktree(!event.done)
      }
    )
  }, [task?.id])

  const handleGhSetupComplete = useCallback(() => {
    setShowGhSetup(false)
    if (!githubOrg) {
      setShowOrgPicker(true)
    } else {
      setShowRepoSelector(true)
    }
  }, [githubOrg])

  const handleOrgSelected = useCallback(async (org: string, provider: GitProvider) => {
    await setGithubOrg(org)
    setOrgProvider(provider)
    setShowOrgPicker(false)
    setShowRepoSelector(true)
  }, [setGithubOrg])

  const handleAddRepos = useCallback(async () => {
    // At least one git provider must be authenticated.
    const [ghStatus, glabStatus, teaStatus] = await Promise.all([
      checkGhCli().catch(() => ({ installed: false, authenticated: false })),
      checkGlabCli().catch(() => ({ installed: false, authenticated: false })),
      checkTeaCli().catch(() => ({ installed: false, authenticated: false }))
    ])
    const anyAuthed = (ghStatus.installed && ghStatus.authenticated) ||
                      (glabStatus.installed && glabStatus.authenticated) ||
                      (teaStatus.installed && teaStatus.authenticated)
    if (!anyAuthed) {
      setShowGhSetup(true)
      return
    }
    if (!githubOrg) {
      setShowOrgPicker(true)
      return
    }
    setShowRepoSelector(true)
  }, [githubOrg, checkGhCli, checkGlabCli, checkTeaCli])

  const handleReposConfirmed = useCallback(async (selectedRepos: GitHubRepo[], selectedOrg: string, selectedProvider: GitProvider) => {
    if (!task) return
    setShowRepoSelector(false)

    if (selectedOrg && selectedOrg !== githubOrg) {
      await setGithubOrg(selectedOrg)
    }
    setOrgProvider(selectedProvider)

    const repoNames = selectedRepos.map((r) => r.fullName)
    const merged = [...new Set([...task.repos, ...repoNames])]
    // Remember the provider so the workspace is later cloned with its CLI.
    await gitApi.recordRepoProviders(repoNames, selectedProvider).catch(() => {})

    // If the task already has a live or persisted coding session, provision the
    // new repo worktrees immediately so the agent can use them without restart.
    const newRepos = selectedRepos.filter((r) => !task.repos.includes(r.fullName))
    const hasActiveOrPersistedSession = !!(sessionId || task.session_id)
    if (hasActiveOrPersistedSession && newRepos.length > 0 && selectedOrg) {
      try {
        setIsSettingUpWorktree(true)
        await worktreeApi.setup(
          task.id,
          newRepos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch })),
          selectedOrg,
          selectedProvider
        )
      } catch (err) {
        console.error('Failed to setup worktrees for new repos:', err)
      } finally {
        setIsSettingUpWorktree(false)
      }
    }

    if (onUpdateTask) {
      await onUpdateTask(task.id, { repos: merged })
    } else {
      await taskApi.update(task.id, { repos: merged })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks, sessionId, githubOrg, setGithubOrg])

  const handleUpdateRepos = useCallback(async (repos: string[]) => {
    if (!task) return

    // A running session has worktrees for the removed repos; clean them up.
    const removedRepos = task.repos.filter((r) => !repos.includes(r))
    if (sessionId && removedRepos.length > 0 && githubOrg) {
      worktreeApi
        .cleanup(task.id, removedRepos.map((r) => ({ fullName: r })), githubOrg, false)
        .catch((err) => console.error('Failed to cleanup removed repo worktrees:', err))
    }

    if (onUpdateTask) {
      await onUpdateTask(task.id, { repos })
    } else {
      await taskApi.update(task.id, { repos })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks, sessionId, githubOrg])

  return {
    githubOrg,
    orgProvider,
    isSettingUpWorktree,
    showGhSetup,
    setShowGhSetup,
    showOrgPicker,
    setShowOrgPicker,
    showRepoSelector,
    setShowRepoSelector,
    handleGhSetupComplete,
    handleOrgSelected,
    handleAddRepos,
    handleReposConfirmed,
    handleUpdateRepos
  }
}

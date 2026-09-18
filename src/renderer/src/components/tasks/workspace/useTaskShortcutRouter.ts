import { useCallback, useEffect, type RefObject } from 'react'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useArtifactStore, PinnedArtifactTabId } from '@/stores/artifact-store'
import { dispatchShortcutFeedback, onTaskShortcut, TaskShortcutAction } from '@/lib/keyboard-shortcuts'
import { isAgentConfigured } from '@shared/agent-utils'
import { ArtifactType, type Artifact } from '@shared/artifacts'
import { TaskStatus } from '@/types'
import type { Agent, Task } from '@/types'

interface TaskShortcutRouterOptions {
  task: Task | undefined
  agents: Agent[]
  artifacts: Artifact[]
  activeArtifactTabId: string | null
  workspaceBodyRef: RefObject<HTMLDivElement | null>
  onComplete: () => Promise<void>
  onStartSession: () => Promise<void>
  onResumeSession: () => Promise<void>
  onStartFreshSession: () => Promise<void>
  onTriage: () => Promise<void>
  onSnooze: () => void
}

/** Routes global task keyboard shortcuts addressed to this task into workspace actions. */
export function useTaskShortcutRouter({
  task,
  agents,
  artifacts,
  activeArtifactTabId,
  workspaceBodyRef,
  onComplete,
  onStartSession,
  onResumeSession,
  onStartFreshSession,
  onTriage,
  onSnooze
}: TaskShortcutRouterOptions) {
  const selectArtifactTab = useArtifactStore((s) => s.selectTab)
  const setRailExpanded = useArtifactStore((s) => s.setRailExpanded)

  const handleRunShortcut = useCallback(() => {
    if (!task) return
    // Read at call time so the workspace needn't re-render on streamed deltas.
    const session = useAgentStore.getState().sessions.get(task.id)
    const sessionId = session?.sessionId ?? null
    const hasMessages = (session?.messages.length ?? 0) > 0
    const idle = (session?.status ?? SessionStatus.IDLE) === SessionStatus.IDLE
    const assignedAgent = task.agent_id ? agents.find((agent) => agent.id === task.agent_id) : null
    const triageAgent = !task.agent_id ? (agents.find((agent) => agent.is_default) || agents[0] || null) : null
    if (task.agent_id && isAgentConfigured(assignedAgent) && !task.session_id && !sessionId && idle && task.status !== TaskStatus.Completed) {
      void onStartSession()
    } else if (task.agent_id && task.session_id && !sessionId && idle && !hasMessages) {
      void onResumeSession()
    } else if (task.agent_id && task.session_id && !sessionId && idle && hasMessages) {
      void onStartFreshSession()
    } else if (!task.agent_id && triageAgent && isAgentConfigured(triageAgent) && idle && task.status !== TaskStatus.Completed && task.status !== TaskStatus.Triaging) {
      void onTriage()
    }
  }, [agents, onResumeSession, onStartFreshSession, onStartSession, onTriage, task])

  useEffect(() => onTaskShortcut(({ action, taskId }) => {
    if (!task || task.id !== taskId) return
    // Hidden canvas panels stay mounted; only the visible workspace should act.
    const workspace = workspaceBodyRef.current
    if (workspace && window.getComputedStyle(workspace).visibility === 'hidden') return
    if (action === TaskShortcutAction.COMPLETE) {
      void onComplete()
      return
    }
    if (action === TaskShortcutAction.RUN) {
      handleRunShortcut()
      return
    }
    if (action === TaskShortcutAction.SNOOZE) {
      onSnooze()
      return
    }
    if (action === TaskShortcutAction.OPEN_DETAILS) {
      selectArtifactTab(task.id, PinnedArtifactTabId.DETAILS, true)
      return
    }
    if (action === TaskShortcutAction.OPEN_CHANGES) {
      selectArtifactTab(task.id, PinnedArtifactTabId.CHANGES, true)
      return
    }
    if (action === TaskShortcutAction.OPEN_OUTPUT) {
      if (task.output_fields.length > 0) selectArtifactTab(task.id, PinnedArtifactTabId.OUTPUT, true)
      else dispatchShortcutFeedback('This task has no output fields', true)
      return
    }
    if (action === TaskShortcutAction.OPEN_ARTIFACT) {
      const artifact = artifacts
        .filter((candidate) => candidate.type !== ArtifactType.PR)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (artifact) selectArtifactTab(task.id, artifact.id, true)
      else setRailExpanded(task.id, true)
      return
    }
    // Remaining actions target a PR: prefer the open PR tab, else the newest.
    const pullRequest =
      artifacts.find((artifact) => artifact.id === activeArtifactTabId && artifact.type === ArtifactType.PR) ??
      artifacts
        .filter((artifact) => artifact.type === ArtifactType.PR)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!pullRequest) {
      dispatchShortcutFeedback('This task has no pull request', true)
      return
    }
    if (action === TaskShortcutAction.OPEN_PR) {
      selectArtifactTab(task.id, pullRequest.id, true)
    } else if (action === TaskShortcutAction.COPY_PR_URL && pullRequest.url) {
      void navigator.clipboard.writeText(pullRequest.url)
        .then(() => dispatchShortcutFeedback('Pull-request URL copied'))
        .catch(() => dispatchShortcutFeedback('Could not copy the pull-request URL', true))
    } else if (action === TaskShortcutAction.COPY_PR_BRANCH && pullRequest.url) {
      void window.electronAPI.github.fetchPullRequestDetails(pullRequest.url)
        .then((details) => navigator.clipboard.writeText(details.headRefName))
        .then(() => dispatchShortcutFeedback('Pull-request branch copied'))
        .catch(() => dispatchShortcutFeedback('Could not copy the pull-request branch', true))
    }
  }), [activeArtifactTabId, artifacts, handleRunShortcut, onComplete, onSnooze, selectArtifactTab, setRailExpanded, task, workspaceBodyRef])
}

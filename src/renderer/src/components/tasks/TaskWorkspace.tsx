import { LayoutList, Send, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { TaskDetailView } from './TaskDetailView'
import { ChangesPanel } from './ChangesPanel'
import { OutputFieldsDisplay } from './OutputFieldsDisplay'
import { TaskHeaderBar, TaskPrimaryAction } from './TaskHeaderBar'
import { WorktreeProgressOverlay } from '@/components/github/WorktreeProgressOverlay'
import { useAgentSessionActions } from '@/hooks/use-agent-session'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useTaskStore } from '@/stores/task-store'
import { taskApi, worktreeApi, taskSourceApi, attachmentApi, artifactApi } from '@/lib/ipc-client'
import { taskImageSaver, withAttachmentNote } from '@/lib/chat-image-attachments'
import { memo, useEffect, useCallback, useRef, useState, useMemo } from 'react'
import { TaskStatus } from '@/types'
import type { Task, FileAttachment, OutputField, Agent } from '@/types'
import { isAgentConfigured } from '@shared/agent-utils'
import { useUIStore } from '@/stores/ui-store'
import { useArtifactStore, PinnedArtifactTabId } from '@/stores/artifact-store'
import { ArtifactType } from '@shared/artifacts'
import { ArtifactsPanel } from '@/components/artifacts/ArtifactsPanel'
import { ArtifactRail } from '@/components/artifacts/ArtifactRail'
import type { Artifact, ArtifactUIState } from '@shared/artifacts'
import { useResizableTranscript } from './workspace/useResizableTranscript'
import { useRepoSetupFlow } from './workspace/useRepoSetupFlow'
import { useTaskFeedbackFlow } from './workspace/useTaskFeedbackFlow'
import { useTaskShortcutRouter } from './workspace/useTaskShortcutRouter'
import { TaskWorkspaceDialogs } from './workspace/TaskWorkspaceDialogs'
import { TaskTranscriptPane } from './workspace/TaskTranscriptPane'

const EMPTY_ARTIFACTS: Artifact[] = []
const DEFAULT_ARTIFACT_UI: ArtifactUIState = { open: false, activeTabId: null, railExpanded: false }

/** Controls which columns are visible in the TaskWorkspace grid */
export type TaskWorkspaceLayout = 'both' | 'task-only' | 'transcript-only'

interface TaskWorkspaceProps {
  task?: Task
  agents: Agent[]
  onEdit: () => void
  onDelete: () => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
  onUpdateOutputFields: (fields: OutputField[]) => void
  onCompleteTask: (completeAtSource?: boolean) => void
  onAssignAgent: (taskId: string, agentId: string | null) => void
  onUpdateTask?: (taskId: string, data: Record<string, unknown>) => Promise<void>
  onNavigateToTask?: (taskId: string) => void
  /** When provided, each subtask shows an action to open it as a separate canvas window/panel. */
  onOpenSubtaskInWindow?: (taskId: string) => void
  onBack?: () => void
  onOpenFullView?: () => void
  /** Override the layout — which panels to show. Default: 'both' */
  panelLayout?: TaskWorkspaceLayout
}

function TaskWorkspaceComponent({
  task,
  agents,
  onEdit,
  onDelete,
  onUpdateAttachments,
  onUpdateOutputFields,
  onCompleteTask,
  onAssignAgent,
  onUpdateTask,
  onNavigateToTask,
  onOpenSubtaskInWindow,
  onBack,
  onOpenFullView,
  panelLayout = 'both'
}: TaskWorkspaceProps) {
  const { start, resume, switchAgent, abort, stop, sendMessage, approve } = useAgentSessionActions(task?.id)
  // Narrow per-field selectors: the transcript (TaskTranscriptPane) owns the
  // messages subscription, so streamed deltas don't re-render this workspace.
  const sessionId = useAgentStore((s) => (task?.id ? s.sessions.get(task.id)?.sessionId ?? null : null))
  const sessionStatus = useAgentStore((s) => (task?.id ? s.sessions.get(task.id)?.status : undefined) ?? SessionStatus.IDLE)
  const hasMessages = useAgentStore((s) => (task?.id ? s.sessions.get(task.id)?.messages.length ?? 0 : 0) > 0)
  const removeSession = useAgentStore((s) => s.removeSession)
  const fetchSettings = useSettingsStore((s) => s.fetchSettings)

  const [changesSummary, setChangesSummary] = useState<{ files: number; additions: number; deletions: number } | null>(null)
  const [kickoffMessage, setKickoffMessage] = useState('')
  const [showSkillSelector, setShowSkillSelector] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [showSnooze, setShowSnooze] = useState(false)
  const [parentTask, setParentTask] = useState<Task | null>(null)
  const startingRef = useRef(false)
  const submittedQuestionIdsRef = useRef(new Set<string>())
  const openTaskOnCanvas = useUIStore((s) => s.openTaskOnCanvas)
  const artifacts = useArtifactStore((s) => task?.id ? (s.artifactsByTask[task.id] || EMPTY_ARTIFACTS) : EMPTY_ARTIFACTS)
  const artifactUI = useArtifactStore((s) => task?.id ? (s.uiByTask[task.id] || DEFAULT_ARTIFACT_UI) : DEFAULT_ARTIFACT_UI)
  const hydrateArtifacts = useArtifactStore((s) => s.hydrate)
  const selectArtifactTab = useArtifactStore((s) => s.selectTab)
  const removeArtifact = useArtifactStore((s) => s.removeArtifact)
  const setArtifactsOpen = useArtifactStore((s) => s.setOpen)
  const setRailExpanded = useArtifactStore((s) => s.setRailExpanded)
  const upsertArtifact = useArtifactStore((s) => s.upsertArtifact)

  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const updateTaskInStore = useTaskStore((s) => s.updateTask)

  const { workspaceBodyRef, transcriptWidth, handleResizeStart, handleResizeMove, handleResizeEnd } =
    useResizableTranscript(artifactUI.open)
  const repoSetup = useRepoSetupFlow(task, sessionId, onUpdateTask, fetchTasks)
  const { githubOrg } = repoSetup

  // Derive subtasks reactively from the task store so status changes (e.g., from
  // mobile-initiated sessions) update immediately without needing a re-fetch.
  const allTasks = useTaskStore((s) => s.tasks)
  const subtasks = useMemo(() => {
    if (!task) return []
    return allTasks
      .filter((t) => t.parent_task_id === task.id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at))
  }, [allTasks, task?.id])
  const siblingSubtasks = useMemo(() => {
    if (!task?.parent_task_id) return []
    return allTasks
      .filter((candidate) => candidate.parent_task_id === task.parent_task_id && candidate.id !== task.id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  }, [allTasks, task?.id, task?.parent_task_id])

  useEffect(() => {
    if (!task?.id) return
    void hydrateArtifacts(task.id, artifactApi).catch((error) => {
      console.error('[TaskWorkspace] Failed to hydrate artifacts:', error)
    })
  }, [hydrateArtifacts, task?.id])

  useEffect(() => { fetchSettings() }, [])

  useEffect(() => {
    if (!task) {
      setParentTask(null)
      return
    }
    if (task.parent_task_id) {
      taskApi.getById(task.parent_task_id).then(p => setParentTask(p ?? null)).catch(() => setParentTask(null))
    } else {
      setParentTask(null)
    }
  }, [task?.id, task?.parent_task_id])

  const handleAddSubtask = useCallback(async (title: string) => {
    if (!task) return
    try {
      const newSubtask = await taskApi.create({
        title,
        parent_task_id: task.id,
        type: task.type as 'general' | 'coding' | 'manual' | 'review' | 'approval',
        priority: task.priority as 'critical' | 'high' | 'medium' | 'low',
        repos: task.repos,
      })
      if (newSubtask) {
        fetchTasks() // Subtasks are derived reactively from the store
      }
    } catch (err) {
      console.error('[TaskWorkspace] Failed to create subtask:', err)
    }
  }, [task, fetchTasks])

  const handleReorderSubtasks = useCallback(async (orderedIds: string[]) => {
    if (!task) return
    try {
      await taskApi.reorderSubtasks(task.id, orderedIds)
      fetchTasks()
    } catch (err) {
      console.error('[TaskWorkspace] Failed to reorder subtasks:', err)
      fetchTasks() // Re-fetch to restore actual order
    }
  }, [task, fetchTasks])

  // Re-fetch tasks when agent status changes (status is updated in DB by agent-manager).
  // Debounced to 500ms to prevent cascading re-fetches when multiple canvas panels
  // observe simultaneous status transitions — each would otherwise trigger an
  // independent fetchTasks() call that replaces the entire tasks array and causes
  // a cascade of re-renders through AppLayout → all child components.
  const prevStatusRef = useRef(sessionStatus)
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = sessionStatus
    if (prev !== sessionStatus) {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current)
      fetchDebounceRef.current = setTimeout(() => {
        fetchDebounceRef.current = null
        fetchTasks()
      }, 500)
    }
    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current)
    }
  }, [sessionStatus, fetchTasks])

  // Stop session when task transitions to completed, but keep transcript.
  // Tracks the previous status so resuming an already-completed task doesn't auto-stop.
  const prevTaskStatusRef = useRef(task?.status)
  useEffect(() => {
    const prevStatus = prevTaskStatusRef.current
    prevTaskStatusRef.current = task?.status
    if (sessionId && task?.status === TaskStatus.Completed && prevStatus !== TaskStatus.Completed) {
      stop()
        .then(() => {
          if (task && task.repos.length > 0 && githubOrg) {
            worktreeApi.cleanup(task.id, task.repos.map((r) => ({ fullName: r })), githubOrg).catch(console.error)
          }
        })
        .catch(console.error)
    }
    // Triage finished (Triaging → NotStarted): drop the triage session.
    if (prevStatus === TaskStatus.Triaging && task?.status === TaskStatus.NotStarted) {
      removeSession(task.id)
    }
  }, [task?.status, sessionId, stop, task, githubOrg, removeSession])

  // Clean up stale triage session when returning to a task that was triaged while unmounted.
  // If the task is no longer Triaging, has no persisted session_id, but the in-memory session
  // still has a sessionId (leftover from the triage agent), remove it so the Start button shows.
  useEffect(() => {
    if (
      task &&
      task.status !== TaskStatus.Triaging &&
      !task.session_id &&
      sessionId &&
      sessionStatus === SessionStatus.IDLE
    ) {
      removeSession(task.id)
    }
  }, [task?.id]) // intentionally run only on mount/task switch

  const handleStartSession = useCallback(async () => {
    if (!task?.agent_id || startingRef.current || sessionId) return
    startingRef.current = true

    try {
      await start(task.agent_id, task.id)
    } catch (err) {
      console.error('Failed to start session:', err)
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, sessionId, start])

  const handleResumeSession = useCallback(async () => {
    if (!task?.agent_id || !task?.session_id || startingRef.current || sessionId) return
    startingRef.current = true
    try {
      await resume(task.agent_id, task.id, task.session_id)
    } catch (err) {
      console.error('Failed to resume session:', err)
      // Session expired — refresh tasks to clear session_id in UI
      fetchTasks()
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, task?.session_id, sessionId, resume, fetchTasks])

  const handleAssignAgent = useCallback(
    (agentId: string | null) => {
      if (!task) return

      // Unassigning stops and removes the session entirely.
      if (!agentId && sessionId) {
        stop().then(() => removeSession(task.id)).catch(console.error)
        onAssignAgent(task.id, agentId)
        return
      }

      // Reassigning to a DIFFERENT agent while a conversation already
      // exists (e.g. switching off a model that ran out of credits) — hand
      // off instead of just changing the field, so the new agent picks up
      // with a recap of what happened instead of a blank slate.
      const hasExistingConversation = Boolean(sessionId || task.session_id)
      if (agentId && task.agent_id && task.agent_id !== agentId && hasExistingConversation) {
        // On failure, fall back to a plain reassignment so the selection sticks.
        switchAgent(task.id, agentId)
          .catch((err) => console.error('[TaskWorkspace] Agent switch failed:', err))
          .finally(() => onAssignAgent(task.id, agentId))
        return
      }

      onAssignAgent(task.id, agentId)
    },
    [task, sessionId, stop, switchAgent, onAssignAgent, removeSession]
  )

  const handleTriage = useCallback(async () => {
    if (!task || task.agent_id) return

    const defaultAgent = agents.find((a) => a.is_default) || agents[0]
    if (!defaultAgent) return

    try {
      await taskApi.update(task.id, { status: TaskStatus.Triaging })
      updateTaskInStore(task.id, { status: TaskStatus.Triaging })
      await start(defaultAgent.id, task.id)
    } catch (error) {
      console.error('[TaskWorkspace] Triage failed:', error)
      await taskApi.update(task.id, { status: TaskStatus.NotStarted })
      updateTaskInStore(task.id, { status: TaskStatus.NotStarted })
    }
  }, [task, agents, start, updateTaskInStore])

  const handleAbort = useCallback(() => {
    if (sessionId) {
      abort().catch(console.error)
    }
  }, [sessionId, abort])

  /**
   * Gives the composer a session to talk to, starting or resuming one if the
   * task has none live.
   *
   * `allowFreshStart` covers the case where the persisted `session_id` can no
   * longer be resumed. The main process reports that as "ended" — it does so
   * for every completed or reviewed task whose adapter session is gone, and
   * for a session left behind by a previously assigned agent. Answering a
   * question in a dead session is meaningless, so that caller keeps the old
   * behaviour, but a plain message must still wake the agent.
   */
  const ensureChatSession = useCallback(async (allowFreshStart = false): Promise<string | null> => {
    if (!task?.agent_id) return null

    const latestSession = useAgentStore.getState().sessions.get(task.id)
    if (latestSession?.sessionId) return latestSession.sessionId

    if (task.session_id) {
      const resumedSessionId = await resume(task.agent_id, task.id, task.session_id)
      if (!resumedSessionId) {
        // `resume` has already cleared the dead `session_id` in the database.
        fetchTasks()
        if (!allowFreshStart) return null
        // The initial prompt is skipped: the transcript already carries the
        // task, and the message the user just typed is the new instruction.
        return start(task.agent_id, task.id, undefined, true)
      }
      return resumedSessionId
    }

    return start(task.agent_id, task.id)
  }, [fetchTasks, resume, start, task?.agent_id, task?.id, task?.session_id])

  const handleSend = useCallback(
    async (message: string, options?: { attachments?: Array<{ id: string; filename: string; size: number; mime_type: string }> }) => {
      // Read messages from the store at call time instead of closing over the
      // render-time array: depending on messages gives this callback a new
      // identity on every streamed delta, which defeats React.memo on every
      // transcript row receiving it as a prop.
      const messages = (task?.id && useAgentStore.getState().sessions.get(task.id)?.messages) || []
      // Route unresolved question responses through approve(), even if status lags.
      let questionIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].partType === 'question' && messages[i].tool?.questions) {
          questionIndex = i
          break
        }
      }
      const hasActiveQuestion = questionIndex >= 0
        && !messages.slice(questionIndex + 1).some((m) => m.role === 'user')
      if (hasActiveQuestion) {
        const question = messages[questionIndex]
        const questionKey = question.tool?.requestId || question.id
        if (submittedQuestionIdsRef.current.has(questionKey)) return
        submittedQuestionIdsRef.current.add(questionKey)
        try {
          const readySessionId = await ensureChatSession()
          if (!readySessionId) {
            submittedQuestionIdsRef.current.delete(questionKey)
            throw new Error('The agent session did not start')
          }
          const responseType = question.tool?.name === 'permission' ? 'permission' : 'question'
          await approve(true, withAttachmentNote(message, options?.attachments), responseType, question.tool?.requestId)
        } catch (error) {
          submittedQuestionIdsRef.current.delete(questionKey)
          throw error
        }
        return
      }

      // Thrown, not swallowed: the composer has already cleared the text, so a
      // silent return leaves the user staring at an idle transcript with no
      // idea that the message went nowhere.
      if (!task?.agent_id && !useAgentStore.getState().sessions.get(task?.id ?? '')?.sessionId) {
        throw new Error('Assign an agent to this task before sending a message')
      }
      // An empty id here is not a failure: `start` goes through admission
      // control and returns '' when the task is queued behind the concurrency
      // limit. sendMessage then falls back to sendByTaskId, and the main
      // process resumes or starts the session immediately — a direct message
      // is exempt from the limits.
      await ensureChatSession(true)
      await sendMessage(message, options)
    },
    [approve, ensureChatSession, sendMessage, task?.agent_id, task?.id]
  )

  const handleAddAttachmentPaths = useCallback(async (filePaths: string[]) => {
    if (!task?.id || filePaths.length === 0) return []
    const saved = await Promise.all(filePaths.map((fp) => attachmentApi.save(task.id, fp)))
    const merged = [...task.attachments]
    const seen = new Set(merged.map((a) => a.id))
    for (const attachment of saved) {
      if (seen.has(attachment.id)) continue
      seen.add(attachment.id)
      merged.push(attachment)
    }
    onUpdateAttachments(merged)
    return saved
  }, [onUpdateAttachments, task?.attachments, task?.id])

  // Pasted images (#144): main stores them as task attachments and updates the task.
  const handleSaveImages = useMemo(() => (task?.id ? taskImageSaver(task.id) : undefined), [task?.id])

  const handlePickAttachments = useCallback(async () => {
    if (!task?.id) return []
    const filePaths = await attachmentApi.pick()
    if (!filePaths.length) return []
    return handleAddAttachmentPaths(filePaths)
  }, [handleAddAttachmentPaths, task?.id])

  const feedback = useTaskFeedbackFlow({
    task,
    sessionId,
    hasMessages,
    onCompleteTask,
    ensureChatSession,
    start,
    sendMessage
  })
  const { handleCompleteTask } = feedback

  const handleSnooze = useCallback(async (isoString: string) => {
    if (!task) return
    setShowSnooze(false)
    if (onUpdateTask) {
      await onUpdateTask(task.id, { snoozed_until: isoString })
    } else {
      await taskApi.update(task.id, { snoozed_until: isoString })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks])

  const handleUnsnooze = useCallback(async () => {
    if (!task) return
    if (onUpdateTask) {
      await onUpdateTask(task.id, { snoozed_until: null })
    } else {
      await taskApi.update(task.id, { snoozed_until: null })
    }
    fetchTasks()
  }, [task, onUpdateTask, fetchTasks])

  const handleReassign = useCallback(async (userIds: string[], displayName: string) => {
    if (!task) return
    const result = await taskSourceApi.reassign(task.id, userIds, displayName)
    if (result.success) {
      if (onUpdateTask) await onUpdateTask(task.id, { assignee: displayName })
      fetchTasks()
    } else {
      console.error('[workspace] Reassign failed:', result.error)
    }
  }, [task, onUpdateTask, fetchTasks])

  const handleStartFreshSession = useCallback(async () => {
    if (!task?.agent_id) return
    startingRef.current = true
    try {
      if (sessionId) {
        await stop()
      }
      await removeSession(task.id)
      if (onUpdateTask) {
        await onUpdateTask(task.id, { session_id: null })
      }

      await start(task.agent_id, task.id)
    } catch (err) {
      console.error('Failed to start fresh session:', err)
    } finally {
      startingRef.current = false
    }
  }, [task?.agent_id, task?.id, sessionId, start, stop, removeSession, onUpdateTask])

  const handleEditAgent = useCallback((agentId: string) => setEditingAgentId(agentId), [])

  const handleUpdateSkillIds = useCallback(async (skillIds: string[] | null) => {
    if (task?.id && onUpdateTask) await onUpdateTask(task.id, { skill_ids: skillIds })
  }, [onUpdateTask, task?.id])
  const handleUpdateDescription = useCallback(async (description: string) => {
    if (!task?.id) return
    if (onUpdateTask) {
      await onUpdateTask(task.id, { description })
    } else {
      await taskApi.update(task.id, { description })
      updateTaskInStore(task.id, { description })
    }
  }, [onUpdateTask, task?.id, updateTaskInStore])
  const handleShowSkillSelector = useCallback(() => setShowSkillSelector(true), [])
  const handleShowSnooze = useCallback(() => setShowSnooze(true), [])
  const handleUpdateAutoFlags = useCallback(async (updates: Record<string, unknown>) => {
    if (!task?.id) return
    if (onUpdateTask) {
      await onUpdateTask(task.id, updates)
    } else {
      await taskApi.update(task.id, updates)
      updateTaskInStore(task.id, updates)
    }
  }, [onUpdateTask, task?.id, updateTaskInStore])
  const handleUpdateNextSubtaskIds = useCallback(async (nextSubtaskIds: string[]) => {
    if (!task?.id) return
    if (onUpdateTask) await onUpdateTask(task.id, { next_subtask_ids: nextSubtaskIds })
    else await updateTaskInStore(task.id, { next_subtask_ids: nextSubtaskIds })
  }, [onUpdateTask, task?.id, updateTaskInStore])

  const handleRename = useCallback(async (title: string) => {
    if (!task?.id) return
    if (onUpdateTask) await onUpdateTask(task.id, { title })
    else {
      await taskApi.update(task.id, { title })
      updateTaskInStore(task.id, { title })
    }
  }, [onUpdateTask, task?.id, updateTaskInStore])

  const handleStatusChange = useCallback(async (status: TaskStatus) => {
    if (!task?.id || status === task.status) return
    // Completing a task has feedback and external-source side effects, so keep
    // it on the same path as the persistent Complete action.
    if (status === TaskStatus.Completed) {
      await handleCompleteTask()
      return
    }
    if (onUpdateTask) await onUpdateTask(task.id, { status })
    else {
      await taskApi.update(task.id, { status })
      updateTaskInStore(task.id, { status })
    }
  }, [handleCompleteTask, onUpdateTask, task?.id, task?.status, updateTaskInStore])

  const handleOpenFolder = useCallback(async () => {
    if (!task?.id) return
    const workspaceDir = await window.electronAPI.tasks.getWorkspaceDir(task.id)
    await window.electronAPI.shell.openPath(workspaceDir)
  }, [task?.id])

  const handleKickoff = useCallback(async () => {
    const message = kickoffMessage.trim()
    if (!message) return
    if (!task?.agent_id) {
      await handleTriage()
      return
    }
    setKickoffMessage('')
    await handleSend(message)
  }, [handleSend, handleTriage, kickoffMessage, task?.agent_id])

  const handlePullRequests = useCallback((pullRequests: Array<{ repo: string; prNumber?: number; prUrl?: string; prState?: string; prTitle?: string; ciStatus?: 'passing' | 'failing' | 'pending' | 'none' }>) => {
    if (!task?.id) return
    for (const pullRequest of pullRequests) {
      if (!pullRequest.prUrl) continue
      upsertArtifact({
        taskId: task.id,
        type: ArtifactType.PR,
        title: pullRequest.prTitle || `Pull request #${pullRequest.prNumber || ''}`.trim(),
        url: pullRequest.prUrl,
        updatedAt: Date.now()
      }, false)
    }
  }, [task?.id, upsertArtifact])

  useTaskShortcutRouter({
    task,
    agents,
    artifacts,
    activeArtifactTabId: artifactUI.activeTabId,
    workspaceBodyRef,
    onComplete: handleCompleteTask,
    onStartSession: handleStartSession,
    onResumeSession: handleResumeSession,
    onStartFreshSession: handleStartFreshSession,
    onTriage: handleTriage,
    onSnooze: handleShowSnooze
  })

  if (!task) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          icon={LayoutList}
          title="No task selected"
          description="Select a task from the sidebar to view its details, or create a new one"
        />
      </div>
    )
  }

  // Persisted sessions count as started even before their transcript is hydrated.
  const hasSession = !!task.session_id || !!sessionId || sessionStatus !== SessionStatus.IDLE || hasMessages
  const assignedAgent = task.agent_id ? agents.find((a) => a.id === task.agent_id) : null
  const assignedAgentConfigured = isAgentConfigured(assignedAgent)
  // Triage uses the default agent (or the first agent in the list as a fallback).
  const triageAgent = !task.agent_id ? (agents.find((a) => a.is_default) || agents[0] || null) : null
  const triageAgentConfigured = isAgentConfigured(triageAgent)
  const canResume = task.agent_id && task.session_id && !sessionId && sessionStatus === SessionStatus.IDLE && !hasMessages
  const canRestart = task.agent_id && task.session_id && !sessionId && sessionStatus === SessionStatus.IDLE && hasMessages
  const canStart = task.agent_id && assignedAgentConfigured && !task.session_id && !sessionId && sessionStatus === SessionStatus.IDLE
    && task.status !== TaskStatus.Completed
  const canTriage = !task.agent_id && agents.length > 0 && triageAgentConfigured && sessionStatus === SessionStatus.IDLE
    && task.status !== TaskStatus.Completed && task.status !== TaskStatus.Triaging

  let primaryAction: TaskPrimaryAction | null = null
  let handlePrimaryAction: (() => void) | undefined
  if (task.status === TaskStatus.ReadyForReview || task.status === TaskStatus.Completed) {
    if (task.status !== TaskStatus.Completed) {
      primaryAction = TaskPrimaryAction.COMPLETE
      handlePrimaryAction = () => void handleCompleteTask()
    }
  } else if (canStart) {
    primaryAction = TaskPrimaryAction.START
    handlePrimaryAction = () => void handleStartSession()
  } else if (canResume) {
    primaryAction = TaskPrimaryAction.RESUME
    handlePrimaryAction = () => void handleResumeSession()
  } else if (canRestart) {
    primaryAction = TaskPrimaryAction.RESTART
    handlePrimaryAction = () => void handleStartFreshSession()
  } else if (canTriage) {
    primaryAction = TaskPrimaryAction.TRIAGE
    handlePrimaryAction = () => void handleTriage()
  }

  const detailsView = (
    <TaskDetailView
      task={task}
      agents={agents}
      onEdit={onEdit}
      onDelete={onDelete}
      onUpdateAttachments={onUpdateAttachments}
      onUpdateOutputFields={onUpdateOutputFields}
      onCompleteTask={handleCompleteTask}
      onAssignAgent={handleAssignAgent}
      onUpdateRepos={repoSetup.handleUpdateRepos}
      onAddRepos={repoSetup.handleAddRepos}
      onUpdateSkillIds={handleUpdateSkillIds}
      onUpdateDescription={handleUpdateDescription}
      onAddSkills={handleShowSkillSelector}
      onStartAgent={handleStartSession}
      canStartAgent={!!canStart}
      onResumeAgent={handleResumeSession}
      canResumeAgent={!!canResume}
      onRestartAgent={handleStartFreshSession}
      canRestartAgent={!!canRestart}
      onSnooze={handleShowSnooze}
      onUnsnooze={handleUnsnooze}
      onReassign={handleReassign}
      onTriage={handleTriage}
      canTriage={!!canTriage}
      onEditAgent={handleEditAgent}
      onUpdateAutoFlags={handleUpdateAutoFlags}
      subtasks={subtasks}
      siblingSubtasks={siblingSubtasks}
      parentTask={parentTask}
      onUpdateNextSubtaskIds={handleUpdateNextSubtaskIds}
      onNavigateToTask={onNavigateToTask}
      onOpenSubtaskInWindow={onOpenSubtaskInWindow}
      onAddSubtask={handleAddSubtask}
      onReorderSubtasks={handleReorderSubtasks}
      displayMode={hasSession ? 'panel' : 'prestart'}
      showOutputFields={!hasSession || panelLayout === 'task-only'}
      showPrimaryActions={!hasSession || panelLayout === 'task-only'}
    />
  )

  const transcriptView = (
    <TaskTranscriptPane
      taskId={task.id}
      agentId={task.agent_id ?? undefined}
      onStop={handleAbort}
      onRestart={handleStartFreshSession}
      onSend={handleSend}
      onPickAttachments={handlePickAttachments}
      onAddAttachmentPaths={handleAddAttachmentPaths}
      onSaveImages={handleSaveImages}
    />
  )

  const openDetails = () => {
    if (artifactUI.open && artifactUI.activeTabId === PinnedArtifactTabId.DETAILS) setArtifactsOpen(task.id, false)
    else selectArtifactTab(task.id, PinnedArtifactTabId.DETAILS, true)
  }

  return (
    <>
      <div className="ui-scale relative flex h-full min-h-0 flex-col bg-background">
        <TaskHeaderBar
          task={task}
          agent={assignedAgent}
          agents={agents}
          onAssignAgent={handleAssignAgent}
          action={primaryAction}
          onAction={handlePrimaryAction}
          onComplete={() => void handleCompleteTask()}
          onStatusChange={handleStatusChange}
          onBack={onBack}
          onRename={handleRename}
          detailsOpen={artifactUI.open && artifactUI.activeTabId === PinnedArtifactTabId.DETAILS}
          showDetailsToggle={hasSession && panelLayout === 'both'}
          onToggleDetails={openDetails}
          onEdit={onEdit}
          onSnooze={handleShowSnooze}
          onOpenCanvas={() => openTaskOnCanvas(task.id)}
          onOpenFolder={() => void handleOpenFolder()}
          onOpenFullView={onOpenFullView}
          onDelete={onDelete}
        />
        <div ref={workspaceBodyRef} className="relative flex min-h-0 flex-1 overflow-hidden">
          {panelLayout === 'task-only' || (!hasSession && panelLayout === 'both') ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
              <div className="min-h-0 flex-1">{detailsView}</div>
              {!hasSession && panelLayout === 'both' && task.status !== TaskStatus.Completed && (
                <div className="sticky bottom-0 mx-auto w-full max-w-[780px] shrink-0 border-t border-border/50 bg-background/95 px-6 py-3 backdrop-blur">
                  <div className="flex items-end gap-2 rounded-xl border border-border/50 bg-card p-2 shadow-lg">
                    <textarea
                      value={kickoffMessage}
                      onChange={(event) => setKickoffMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleKickoff() }
                      }}
                      placeholder={task.agent_id ? 'Add kickoff instructions…' : 'Add context, then triage this task…'}
                      className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
                      aria-label="Kickoff instructions"
                    />
                    <Button onClick={() => void handleKickoff()} disabled={!kickoffMessage.trim()} className="h-9 gap-1.5">
                      {task.agent_id ? <Send className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                      {task.agent_id ? 'Start' : 'Triage'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : panelLayout === 'transcript-only' ? (
            <div className="min-h-0 min-w-0 flex-1">{transcriptView}</div>
          ) : (
            <>
              <div data-testid="transcript-pane" className="min-h-0 min-w-0 shrink-0" style={{ width: artifactUI.open ? transcriptWidth : 'auto', flex: artifactUI.open ? undefined : 1 }}>
                {transcriptView}
              </div>
              {artifactUI.open ? (
                <>
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize transcript"
                    onPointerDown={handleResizeStart}
                    onPointerMove={handleResizeMove}
                    onPointerUp={handleResizeEnd}
                    onPointerCancel={handleResizeEnd}
                    className="group relative w-1 shrink-0 cursor-col-resize bg-border/50 hover:bg-primary/50"
                  />
                  <ArtifactsPanel
                    taskId={task.id}
                    artifacts={artifacts}
                    ui={artifactUI}
                    artifactApi={artifactApi}
                    hasChanges
                    hasOutput={task.output_fields.length > 0}
                    changesCount={changesSummary?.files}
                    onSelectTab={(tabId) => selectArtifactTab(task.id, tabId, true)}
                    onCloseTab={(artifactId) => removeArtifact(task.id, artifactId)}
                    onToggleOpen={() => setArtifactsOpen(task.id, false)}
                    onToggleRail={() => setRailExpanded(task.id, !artifactUI.railExpanded)}
                    details={detailsView}
                    changes={<ChangesPanel taskId={task.id} repos={task.repos} className="h-full" onSummary={setChangesSummary} onPullRequests={handlePullRequests} />}
                    output={<OutputFieldsDisplay fields={task.output_fields} onChange={onUpdateOutputFields} isActive={task.status !== TaskStatus.Completed} onComplete={handleCompleteTask} taskUpdatedAt={task.updated_at} />}
                    className="min-w-[320px] flex-1 border-l border-border/50"
                  />
                </>
              ) : (
                <ArtifactRail
                  artifacts={artifacts}
                  expanded={artifactUI.railExpanded}
                  activeTabId={artifactUI.activeTabId}
                  agentActive={sessionStatus === SessionStatus.WORKING}
                  hasChanges
                  hasOutput={task.output_fields.length > 0}
                  changesCount={changesSummary?.files}
                  onSelectTab={(tabId) => selectArtifactTab(task.id, tabId, true)}
                  onToggleExpanded={() => setRailExpanded(task.id, !artifactUI.railExpanded)}
                />
              )}
            </>
          )}
        </div>
        <WorktreeProgressOverlay taskId={task.id} visible={repoSetup.isSettingUpWorktree} />
      </div>

      <TaskWorkspaceDialogs
        task={task}
        agents={agents}
        repoSetup={repoSetup}
        feedback={feedback}
        showSkillSelector={showSkillSelector}
        onShowSkillSelectorChange={setShowSkillSelector}
        onUpdateSkillIds={handleUpdateSkillIds}
        showSnooze={showSnooze}
        onShowSnoozeChange={setShowSnooze}
        onSnooze={handleSnooze}
        editingAgentId={editingAgentId}
        onEditingAgentIdChange={setEditingAgentId}
        onStartFreshSession={handleStartFreshSession}
      />
    </>
  )
}

export const TaskWorkspace = memo(TaskWorkspaceComponent)

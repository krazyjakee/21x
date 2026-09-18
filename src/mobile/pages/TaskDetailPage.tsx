import { getSourceCompletionDescription, getTaskSourceName } from '@shared/task-completion'
import { useMemo, useCallback, useEffect, useState, useRef } from 'react'
import { TaskStatus } from '@shared/constants'
import { isAgentConfigured } from '@shared/agent-utils'
import { CollapsibleDescription } from '../components/CollapsibleDescription'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore, SessionStatus } from '../stores/agent-store'
import { api } from '../api/client'
import { useSessionControls } from '../hooks/useSessionControls'
import { useTaskCompletionFlow } from '../hooks/useTaskCompletionFlow'
import { TaskBadges } from '../components/TaskBadges'
import { ArtifactCard } from '../components/ArtifactCard'
import { PageHeader } from '../components/PageHeader'
import { ParentTaskContext } from '../components/ParentTaskContext'
import { SubtasksSection } from '../components/SubtasksSection'
import { FeedbackModal } from '../components/FeedbackModal'
import { TaskAgentBar } from '../components/TaskAgentBar'
import { TaskPropertiesGrid, type SessionActions } from '../components/TaskPropertiesGrid'
import { TaskPrimaryCta } from '../components/TaskPrimaryCta'
import { QueuedStartNotice } from '../components/QueuedStartNotice'
import { TranscriptPreview } from '../components/TranscriptPreview'
import { useArtifactStore } from '../stores/artifact-store'
import { cn } from '../lib/utils'
import type { Route } from '../App'

export function TaskDetailPage({ taskId, onNavigate }: { taskId: string; onNavigate: (route: Route) => void }) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const updateTask = useTaskStore((s) => s.updateTask)
  const agents = useAgentStore((s) => s.agents)
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)

  const [activeSection, setActiveSection] = useState<'details' | 'artifacts'>('details')
  const artifactsByTask = useArtifactStore((s) => s.artifactsByTask)
  const hydrateArtifacts = useArtifactStore((s) => s.hydrate)
  const artifactLoadingTaskIds = useArtifactStore((s) => s.loadingTaskIds)
  const artifacts = artifactsByTask.get(taskId) || []
  const artifactsLoading = artifactLoadingTaskIds.has(taskId)
  const { handleStart: _startSession, handleResume: _resumeSession, handleStop: _stopSession, busyRef } = useSessionControls(taskId)
  const { completeModal, handleCompleteTask, handleFeedbackSubmit, handleFeedbackSkip, cancelCompletion } =
    useTaskCompletionFlow(task, session?.sessionId)

  useEffect(() => {
    if (task) void hydrateArtifacts(taskId)
  }, [hydrateArtifacts, task, taskId])

  const isSessionRunning = !!session?.sessionId && (session.status === SessionStatus.WORKING || session.status === SessionStatus.WAITING_APPROVAL)

  const handleAssignAgent = useCallback(async (agentId: string | null) => {
    if (!task) return
    await updateTask(task.id, { agent_id: agentId || null })
  }, [task, updateTask])

  const handleTriage = useCallback(async () => {
    if (!task || task.agent_id || busyRef.current) return
    const defaultAgent = agents.find((a) => a.is_default) || agents[0]
    if (!defaultAgent) return
    busyRef.current = true
    try {
      await updateTask(task.id, { status: TaskStatus.Triaging })
      initSession(task.id, '', defaultAgent.id)
      const { sessionId } = await api.sessions.start(defaultAgent.id, task.id)
      initSession(task.id, sessionId, defaultAgent.id)
    } catch (e) {
      console.error('Failed to triage:', e)
      endSession(task.id)
      await updateTask(task.id, { status: TaskStatus.NotStarted })
    } finally {
      busyRef.current = false
    }
  }, [task, agents, updateTask, initSession, endSession])

  const handleReorderSubtasks = useCallback(async (orderedIds: string[]) => {
    if (!task) return
    try {
      await api.tasks.reorderSubtasks(task.id, orderedIds)
    } catch (err) {
      console.error('[TaskDetailPage] Failed to reorder subtasks:', err)
    }
  }, [task])

  const handleStart = useCallback(() => {
    if (task?.agent_id) _startSession(task.agent_id)
  }, [task?.agent_id, _startSession])

  const handleResume = useCallback(() => {
    if (task?.agent_id && task?.session_id) _resumeSession(task.agent_id, task.session_id)
  }, [task?.agent_id, task?.session_id, _resumeSession])

  const handleStop = useCallback(() => {
    if (session?.sessionId) _stopSession(session.sessionId)
  }, [session?.sessionId, _stopSession])

  // Match desktop behavior: once an explicit completion moves a learning task
  // to Completed, terminate the learning session but keep its transcript.
  const previousTaskStatusRef = useRef(task?.status)
  useEffect(() => {
    const previousStatus = previousTaskStatusRef.current
    previousTaskStatusRef.current = task?.status
    if (session?.sessionId && task?.status === TaskStatus.Completed && previousStatus !== TaskStatus.Completed) {
      void _stopSession(session.sessionId)
    }
  }, [task?.status, session?.sessionId, _stopSession])

  // IMPORTANT: Do NOT use .filter() / .map() / [] inside a Zustand 5 selector.
  // Zustand 5 passes `() => selector(state)` directly to useSyncExternalStore's
  // getSnapshot, which must return referentially-stable values. .filter() creates
  // a new array on every call, violating that contract. useShallow's useRef-based
  // caching also fails under rapid WebSocket updates because the subscription
  // handler mutates the ref between renders, causing Object.is to always fail.
  // The safe pattern: select the raw store array (stable ref) + useMemo.
  const allTasks = useTaskStore((s) => s.tasks)

  const subtasks = useMemo(
    () =>
      allTasks
        .filter((t) => t.parent_task_id === taskId)
        .sort((a, b) => {
          const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0)
          if (orderDiff !== 0) return orderDiff
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        }),
    [allTasks, taskId]
  )

  const parentTask = useMemo(() => {
    if (!task?.parent_task_id) return null
    return allTasks.find((t) => t.id === task.parent_task_id) || null
  }, [allTasks, task?.parent_task_id])

  const siblingSubtasks = useMemo(() => {
    if (!task?.parent_task_id) return []
    return allTasks
      .filter((candidate) => candidate.parent_task_id === task.parent_task_id && candidate.id !== task.id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  }, [allTasks, task?.id, task?.parent_task_id])

  if (!task) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader onBack={() => onNavigate({ page: 'list' })} title="Not found" />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Task not found</div>
      </div>
    )
  }

  // Block start/triage when the relevant agent is missing a provider or model
  // (mirrors desktop TaskDetailView).
  const assignedAgent = task.agent_id ? agents.find((a) => a.id === task.agent_id) : null
  const triageAgent = !task.agent_id ? (agents.find((a) => a.is_default) || agents[0] || null) : null
  const assignedAgentConfigured = isAgentConfigured(assignedAgent)
  const triageAgentConfigured = isAgentConfigured(triageAgent)
  const unconfiguredAgent = assignedAgent && !assignedAgentConfigured
    ? assignedAgent
    : (triageAgent && !triageAgentConfigured ? triageAgent : null)

  const sessionActions: SessionActions = {
    canStart: !!task.agent_id && assignedAgentConfigured && !task.session_id && (!session || session.status === SessionStatus.IDLE) && task.status !== TaskStatus.Completed,
    // Don't offer Resume while a session is already running.
    canResume: !!task.agent_id && !!task.session_id && !isSessionRunning && !session?.sessionId && (!session || session.status === SessionStatus.IDLE),
    canStop: isSessionRunning,
    canTriage: !task.agent_id && agents.length > 0 && triageAgentConfigured && task.status !== TaskStatus.Completed && task.status !== TaskStatus.Triaging && !isSessionRunning,
    onStart: handleStart,
    onResume: handleResume,
    onStop: handleStop,
    onTriage: handleTriage
  }
  const canComplete = task.status !== TaskStatus.Completed && !isSessionRunning

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        onBack={() => parentTask ? onNavigate({ page: 'detail', taskId: parentTask.id }) : onNavigate({ page: 'list' })}
        title={task.title}
        rightAction={
          <button
            onClick={() => onNavigate({ page: 'edit', taskId })}
            className="p-2 active:opacity-60 hover:bg-accent rounded-md transition-colors"
            aria-label="Edit task"
          >
            <svg className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>
            </svg>
          </button>
        }
      />

      <TaskAgentBar task={task} agents={agents} assignedAgentName={assignedAgent?.name} onAssignAgent={handleAssignAgent} />

      <QueuedStartNotice taskId={taskId} />

      <div className="shrink-0 border-b border-border/50 px-4 py-2">
        <div className="grid grid-cols-2 rounded-md bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setActiveSection('details')}
            className={cn('rounded px-3 py-1.5 transition-colors', activeSection === 'details' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}
          >
            Details
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('artifacts')}
            className={cn('rounded px-3 py-1.5 transition-colors', activeSection === 'artifacts' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}
          >
            Artifacts{artifacts.length > 0 ? ` (${artifacts.length})` : ''}
          </button>
        </div>
      </div>

      <div className={cn('flex-1 overflow-y-auto', activeSection !== 'details' && 'hidden')}>
        {parentTask &&<ParentTaskContext parentTask={parentTask} onNavigate={onNavigate} />}

        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border flex-wrap">
          <TaskBadges task={task} />
        </div>

        {/* Always rendered when editable so users can add a description inline. */}
        <div className="px-4 py-4 border-b border-border">
          <CollapsibleDescription
            taskId={task.id}
            description={task.description || ''}
            size="sm"
            collapsedLines={3}
            onSave={async (description) => {
              await updateTask(task.id, { description })
            }}
          />
        </div>

        <TaskPropertiesGrid
          task={task}
          siblingSubtasks={siblingSubtasks}
          agents={agents}
          session={session}
          isAssignedAgent={!!assignedAgent}
          unconfiguredAgent={unconfiguredAgent}
          actions={sessionActions}
          onAssignAgent={handleAssignAgent}
          onNavigate={onNavigate}
        />

        {/* Subtasks are only shown on parent tasks, not on subtasks themselves. */}
        {!task.parent_task_id && subtasks.length > 0 && (
          <SubtasksSection
            subtasks={subtasks}
            onNavigateToTask={(id) => onNavigate({ page: 'detail', taskId: id })}
            onReorderSubtasks={handleReorderSubtasks}
          />
        )}

        <TaskPrimaryCta status={task.status} actions={sessionActions} canComplete={canComplete} onComplete={handleCompleteTask} />

        {task.agent_id && <TranscriptPreview taskId={taskId} messages={session?.messages ?? []} onNavigate={onNavigate} />}
      </div>

      <div className={cn('flex-1 overflow-y-auto p-4', activeSection !== 'artifacts' && 'hidden')}>
        {artifactsLoading && artifacts.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Scanning workspace…</div>
        )}
        {!artifactsLoading && artifacts.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <svg className="h-8 w-8 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
            <p className="text-sm">No artifacts yet</p>
            <p className="max-w-xs text-xs">Files created by the agent will appear here.</p>
          </div>
        )}
        {artifacts.length > 0 && (
          <div className="space-y-2">
            {artifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                onOpen={() => onNavigate({ page: 'artifact', taskId, artifactId: artifact.id })}
              />
            ))}
          </div>
        )}
      </div>

      {completeModal && (
        <FeedbackModal
          completionDescription={getSourceCompletionDescription(task)}
          sourceName={task.source_id ? getTaskSourceName(task) : undefined}
          withFeedback={completeModal.withFeedback}
          onSubmit={handleFeedbackSubmit}
          onSkip={handleFeedbackSkip}
          onCancel={cancelCompletion}
        />
      )}
    </div>
  )
}

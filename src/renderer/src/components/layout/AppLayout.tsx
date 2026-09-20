import { useEffect, useState, useCallback, useMemo, lazy, Suspense } from 'react'
import { Sidebar } from './Sidebar'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { InfiniteCanvas } from '@/components/canvas/InfiniteCanvas'
import { OnboardingWizard, shouldShowOnboarding } from '@/components/onboarding/OnboardingWizard'
import { ProgressToastStack } from '@/components/ui/ProgressToastStack'
import { VoiceOverlay } from '@/components/voice/VoiceOverlay'
import { useVoiceControl } from '@/hooks/use-voice-control'
import { useUiRemoteControl } from '@/hooks/use-ui-remote-control'
import { useRecordingChrome } from '@/hooks/use-recording-chrome'
import { useTasks } from '@/hooks/use-tasks'
import { useUIStore } from '@/stores/ui-store'
import { useAgentStore } from '@/stores/agent-store'
import { useProjectStore } from '@/stores/project-store'
import { useAgentAutoStart } from '@/hooks/use-agent-auto-start'
import { useOverdueNotifications } from '@/hooks/use-overdue-notifications'
import { agentSessionApi, settingsApi, projectApi, onTaskSourceActionFailed } from '@/lib/ipc-client'
import { isOverdue, isSnoozed } from '@/lib/utils'
import { onShortcutFeedback } from '@/lib/keyboard-shortcuts'
import { TASK_STATUSES, TaskStatus } from '@/types'
import type { FileAttachment, OutputField, Task, UpdateTaskDTO } from '@/types'
import { SubtaskPickerDialog } from '@/components/tasks/SubtaskPickerDialog'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog'
import { TopBar } from './TopBar'
import { NavRail } from './NavRail'
import { TaskDialogs } from './TaskDialogs'
import { ProjectEditorDialog } from '@/components/projects/ProjectEditorDialog'
import { useActiveTaskActions } from './hooks/use-active-task-actions'
import { useGlobalShortcuts } from './hooks/use-global-shortcuts'
import { CommanderCallHost } from '@/components/commander/CommanderCallHost'
import { CommanderPictureInPicture } from '@/components/commander/CommanderPictureInPicture'

// Lazy-load heavy workspaces so they are only imported when their view is active;
// this keeps the initial bundle small and first render fast.
const SkillWorkspace = lazy(() => import('@/components/skills/SkillWorkspace').then(m => ({ default: m.SkillWorkspace })))
const SettingsWorkspace = lazy(() => import('@/components/settings/SettingsWorkspace').then(m => ({ default: m.SettingsWorkspace })))
const DashboardWorkspace = lazy(() => import('@/components/dashboard/DashboardWorkspace').then(m => ({ default: m.DashboardWorkspace })))
const CommanderWorkspace = lazy(() => import('@/components/commander/CommanderWorkspace').then(m => ({ default: m.CommanderWorkspace })))
const OverviewWorkspace = lazy(() => import('@/components/overview/OverviewWorkspace').then(m => ({ default: m.OverviewWorkspace })))
const OrchestratorPanel = lazy(() => import('@/components/orchestrator/OrchestratorPanel').then(m => ({ default: m.OrchestratorPanel })))

const workspaceFallback = <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading...</div>

export function AppLayout() {
  const { tasks, allTasks, everyTask, selectedTask, updateTask, selectTask } = useTasks()
  // Individual selectors so unrelated agent store changes (e.g. session messages) don't re-render the layout
  const agents = useAgentStore((s) => s.agents)
  const fetchAgents = useAgentStore((s) => s.fetchAgents)
  const sidebarView = useUIStore((s) => s.sidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const openCreateModal = useUIStore((s) => s.openCreateModal)
  const openEditModal = useUIStore((s) => s.openEditModal)
  const openDeleteModal = useUIStore((s) => s.openDeleteModal)
  const showOrchestrator = useUIStore((s) => s.showOrchestrator)
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)

  const [cmdOpen, setCmdOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [subtaskPickerOpen, setSubtaskPickerOpen] = useState(false)

  useEffect(() => {
    fetchAgents()
    // Restores the persisted current project; task views scope to it.
    void useProjectStore.getState().init()
    return projectApi.onChanged(() => { void useProjectStore.getState().fetchProjects() })
  }, [])

  const [toast, setToast] = useState<{ message: string; isError?: boolean } | null>(null)
  const showToast = useCallback((message: string, isError?: boolean) => {
    setToast({ message, isError })
    setTimeout(() => setToast(null), isError ? 5000 : 3000)
  }, [])

  useEffect(() => onShortcutFeedback(({ message, isError }) => showToast(message, isError)), [showToast])

  // A completion that the main process could not push to the source sends the
  // task back to review. Without this the user sees the task reappear with no
  // reason given.
  useEffect(() => {
    return onTaskSourceActionFailed(({ taskTitle, error }) => {
      showToast(`Could not complete "${taskTitle}" at its source: ${error}`, true)
    })
  }, [showToast])

  const selectedTaskId = selectedTask?.id
  const {
    commandActions,
    completeTask,
    completionDialog,
    activeSubtasks,
    selectSubtask,
    handleGoToFullView,
    handleNavigateFromDashboardPreview
  } = useActiveTaskActions({
    tasks,
    allTasks,
    selectedTaskId,
    selectTask,
    showToast,
    setCmdOpen,
    setShortcutsOpen,
    setSubtaskPickerOpen
  })

  useGlobalShortcuts(commandActions, setCmdOpen)

  const handleEditSelectedTask = useCallback(() => {
    if (selectedTaskId) openEditModal(selectedTaskId)
  }, [openEditModal, selectedTaskId])
  const handleDeleteSelectedTask = useCallback(() => {
    if (selectedTaskId) openDeleteModal(selectedTaskId)
  }, [openDeleteModal, selectedTaskId])
  const handleUpdateSelectedAttachments = useCallback(
    async (attachments: FileAttachment[]) => {
      if (selectedTaskId) await updateTask(selectedTaskId, { attachments })
    },
    [selectedTaskId, updateTask]
  )
  const handleUpdateSelectedOutputFields = useCallback(
    async (output_fields: OutputField[]) => {
      if (selectedTaskId) await updateTask(selectedTaskId, { output_fields })
    },
    [selectedTaskId, updateTask]
  )
  const handleCompleteSelectedTask = useCallback(async (completeAtSource?: boolean) => {
    if (selectedTaskId) await completeTask(selectedTaskId, { selectNextTask: true, completeAtSource })
  }, [completeTask, selectedTaskId])

  const handleAssignAgent = useCallback(async (taskId: string, agentId: string | null) => {
    await updateTask(taskId, { agent_id: agentId })
  }, [updateTask])
  const handleUpdateTask = useCallback(async (taskId: string, data: Record<string, unknown>) => {
    await updateTask(taskId, data as UpdateTaskDTO)
  }, [updateTask])
  const handleDashboardTaskStatusChange = useCallback(async (task: Task, status: TaskStatus) => {
    try {
      if (status === TaskStatus.Completed) {
        await completeTask(task.id)
        return
      }
      await updateTask(task.id, { status })

      // Dropping into an execution stage replaces opening the ticket and
      // pressing Triage/Start. The main process owns the exact behavior: an
      // unassigned task is triaged, an assigned task starts, and a constrained
      // start is queued through normal admission control.
      if (status === TaskStatus.Triaging || status === TaskStatus.AgentWorking) {
        const result = await agentSessionApi.startTask(task.id)
        if (result.action === 'no_action') {
          throw new Error('No configured agent is available to start this task')
        }
        if (result.action === 'queued') {
          showToast(`Queued "${task.title}" to start${result.queuePosition ? ` (position ${result.queuePosition})` : ''}`)
        }
      }
    } catch (error) {
      const statusLabel = TASK_STATUSES.find((entry) => entry.value === status)?.label ?? status
      showToast(`Could not move "${task.title}" to ${statusLabel}: ${error instanceof Error ? error.message : String(error)}`, true)
    }
  }, [completeTask, showToast, updateTask])
  const handleNavigateToTask = useCallback((taskId: string) => selectTask(taskId), [selectTask])

  const overdueCount = useMemo(
    () => tasks.filter(
      (t) => isOverdue(t.due_date) && t.status !== TaskStatus.Completed && !isSnoozed(t.snoozed_until)
    ).length,
    [tasks]
  )

  // Every project's tasks: reminders from other projects still arrive, named by project.
  useOverdueNotifications(everyTask)

  const [onboardingOpen, setOnboardingOpen] = useState(false)

  // Auto-open onboarding on first launch or major/minor version bumps
  useEffect(() => {
    Promise.all([
      settingsApi.get('setup_completed_version'),
      window.electronAPI?.app?.getVersion()
    ]).then(([completedVersion, currentVersion]) => {
      if (currentVersion && shouldShowOnboarding(completedVersion, currentVersion)) {
        setOnboardingOpen(true)
      }
    })
  }, [])

  const handleOnboardingChange = (open: boolean) => {
    setOnboardingOpen(open)
    if (!open) {
      window.electronAPI?.app?.getVersion().then((v) => {
        if (v) settingsApi.set('setup_completed_version', v)
      })
    }
  }

  // Sessions are read non-reactively via getState() inside the hook
  // Auto-start runs for every project, not only the one on screen.
  useAgentAutoStart({
    tasks: everyTask,
    agents,
    showToast
  })

  useVoiceControl()
  // Publishes the screen for agent tools, and applies their UI commands.
  useUiRemoteControl()
  // Turns the chrome crimson while the microphone is live.
  useRecordingChrome()

  // Track the zoom factor so the macOS traffic-light margin stays constant in physical pixels
  useEffect(() => {
    const update = () => {
      // outerWidth is in device-independent screen px (stable); innerWidth shrinks/grows with zoom
      const factor = window.outerWidth && window.innerWidth
        ? window.outerWidth / window.innerWidth
        : 1
      if (factor > 0) {
        document.documentElement.style.setProperty('--zoom-factor', String(factor))
      }
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return (
    <>
      {completionDialog}
      <TopBar onOpenCommandPalette={() => setCmdOpen(true)} />

      {/* ── Content area: left rail + optional sidebar + workspace + orchestrator ── */}
      <div className="app-chrome-field flex flex-1 min-h-0 overflow-hidden bg-background">
        <NavRail />

        {sidebarView !== 'dashboard' && sidebarView !== 'canvas' && sidebarView !== 'commander' && sidebarView !== 'overview' && !sidebarCollapsed && (
          <Sidebar
            tasks={tasks}
            selectedTaskId={selectedTask?.id || null}
            overdueCount={overdueCount}
            onSelectTask={selectTask}
            onCreateTask={openCreateModal}
          />
        )}

        {/* Workspace — floats as a rounded card, shrinks when orchestrator is open */}
        <main className="flex flex-col flex-1 min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-card m-2 transition-all duration-200">
          <div className="flex-1 h-0 overflow-hidden relative">
            {/* Canvas — always mounted so iframes/terminals survive navigation */}
            <div
              className="absolute inset-0"
              style={{ visibility: sidebarView === 'canvas' && activeModal !== 'settings' ? 'visible' : 'hidden' }}
            >
              <InfiniteCanvas />
            </div>

            {activeModal === 'settings' ? (
              <Suspense fallback={workspaceFallback}>
                <SettingsWorkspace />
              </Suspense>
            ) : sidebarView === 'dashboard' ? (
              <Suspense fallback={workspaceFallback}>
                <DashboardWorkspace onTaskStatusChange={handleDashboardTaskStatusChange} />
              </Suspense>
            ) : sidebarView === 'skills' ? (
              <Suspense fallback={workspaceFallback}>
                <SkillWorkspace />
              </Suspense>
            ) : sidebarView === 'commander' ? (
              <Suspense fallback={workspaceFallback}>
                <CommanderWorkspace />
              </Suspense>
            ) : sidebarView === 'overview' ? (
              <Suspense fallback={workspaceFallback}>
                <OverviewWorkspace />
              </Suspense>
            ) : sidebarView !== 'canvas' ? (
              <TaskWorkspace
                task={selectedTask}
                agents={agents}
                onEdit={handleEditSelectedTask}
                onDelete={handleDeleteSelectedTask}
                onUpdateAttachments={handleUpdateSelectedAttachments}
                onUpdateOutputFields={handleUpdateSelectedOutputFields}
                onCompleteTask={handleCompleteSelectedTask}
                onAssignAgent={handleAssignAgent}
                onUpdateTask={handleUpdateTask}
                onNavigateToTask={handleNavigateToTask}
                onBack={() => selectTask(null)}
              />
            ) : null}
          </div>
        </main>

        {/* Captain drawer — sits beside the workspace, shifts main content left */}
        <div
          className={`flex-shrink-0 transition-all duration-200 ease-in-out overflow-hidden ${
            showOrchestrator ? 'w-[340px]' : 'w-0'
          }`}
        >
          <div className="h-full w-[340px] py-2 pr-2">
            <Suspense fallback={null}>
              <OrchestratorPanel onClose={() => setShowOrchestrator(false)} />
            </Suspense>
          </div>
        </div>
      </div>

      <StatusBar />

      <TaskDialogs
        agents={agents}
        showToast={showToast}
        completeTask={completeTask}
        onGoToFullView={handleGoToFullView}
        onNavigateFromPreview={handleNavigateFromDashboardPreview}
        onAssignAgent={handleAssignAgent}
        onUpdateTask={handleUpdateTask}
      />

      <OnboardingWizard open={onboardingOpen} onOpenChange={handleOnboardingChange} />

      <ProjectEditorDialog />

      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 border rounded-lg shadow-lg text-sm animate-in fade-in slide-in-from-bottom-2 ${toast.isError ? 'bg-destructive text-destructive-foreground' : 'bg-card'}`}>
          {toast.message}
        </div>
      )}

      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} actions={commandActions} />
      <SubtaskPickerDialog
        open={subtaskPickerOpen}
        onOpenChange={setSubtaskPickerOpen}
        subtasks={activeSubtasks}
        onSelect={selectSubtask}
      />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* Background progress toasts (setup, task progress, etc.) */}
      <ProgressToastStack />

      {/* Voice transcript bubble, audio state, and confirmation cards */}
      <CommanderCallHost />
      <CommanderPictureInPicture />
      <VoiceOverlay />
    </>
  )
}

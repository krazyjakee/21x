import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { useUIStore } from '@/stores/ui-store'
import { useTaskCompletion } from '@/hooks/use-task-completion'
import { isSnoozed } from '@/lib/utils'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'
import { dispatchTaskShortcut, focusComposerInput, getNextNudgeMessage, TaskShortcutAction } from '@/lib/keyboard-shortcuts'
import { selectVoiceReady, useVoiceStore } from '@/stores/voice-store'
import { composerCanSubmit, MASTERMIND_COMPOSER_KEY, sendComposerMessage, setActiveComposer } from '@/lib/voice-dictation-target'
import type { CommandPaletteActions } from '../CommandPalette'

interface UseActiveTaskActionsOptions {
  tasks: Task[]
  allTasks: Task[]
  selectedTaskId: string | undefined
  selectTask: (id: string | null) => void
  showToast: (message: string, isError?: boolean) => void
  setCmdOpen: Dispatch<SetStateAction<boolean>>
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>
  setSubtaskPickerOpen: Dispatch<SetStateAction<boolean>>
}

/**
 * Actions on the "active" task — the dashboard preview if one is open,
 * otherwise the selected task. Shared by the command palette and the global
 * keyboard shortcuts.
 */
export function useActiveTaskActions({
  tasks,
  allTasks,
  selectedTaskId,
  selectTask,
  showToast,
  setCmdOpen,
  setShortcutsOpen,
  setSubtaskPickerOpen
}: UseActiveTaskActionsOptions) {
  const sidebarView = useUIStore((s) => s.sidebarView)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const openDeleteModal = useUIStore((s) => s.openDeleteModal)
  const dashboardPreviewTaskId = useUIStore((s) => s.dashboardPreviewTaskId)
  const closeDashboardPreview = useUIStore((s) => s.closeDashboardPreview)
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const openTaskOnCanvas = useUIStore((s) => s.openTaskOnCanvas)

  const filteredTasksRef = useRef(tasks)
  filteredTasksRef.current = tasks

  // Completion is server-confirmed through the shared hook (same for every source).
  const { requestComplete, completionDialog } = useTaskCompletion({ onToast: showToast })

  const selectNextActiveTask = useCallback(
    (completedTaskId: string) => {
      const activeTasks = filteredTasksRef.current.filter(
        (t) => t.id !== completedTaskId && t.status !== TaskStatus.Completed
      )
      selectTask(activeTasks.length > 0 ? activeTasks[0].id : null)
    },
    [selectTask]
  )

  const completeTask = useCallback(
    async (taskId: string, options?: { selectNextTask?: boolean; completeAtSource?: boolean }) => {
      await requestComplete(taskId, {
        completeAtSource: options?.completeAtSource,
        onCompleted: options?.selectNextTask
          ? (task) => selectNextActiveTask(task.id)
          : undefined
      })
    },
    [requestComplete, selectNextActiveTask]
  )

  const handleGoToFullView = useCallback((taskId: string) => {
    closeDashboardPreview()
    selectTask(taskId)
    setSidebarView('tasks')
  }, [closeDashboardPreview, selectTask, setSidebarView])

  const handleNavigateFromDashboardPreview = useCallback(
    (taskId: string) => {
      closeDashboardPreview()
      handleGoToFullView(taskId)
    },
    [closeDashboardPreview, handleGoToFullView]
  )

  const activeTaskId = dashboardPreviewTaskId || selectedTaskId || null
  const activeTask = useMemo(
    () => activeTaskId ? allTasks.find((task) => task.id === activeTaskId) : undefined,
    [activeTaskId, allTasks]
  )
  const activeSubtasks = useMemo(
    () => activeTask
      ? allTasks
          .filter((task) => task.parent_task_id === activeTask.id)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at))
      : [],
    [activeTask, allTasks]
  )

  const runTaskShortcut = useCallback((action: TaskShortcutAction) => {
    if (!activeTaskId) {
      showToast('Select a task first', true)
      return
    }
    dispatchTaskShortcut({ action, taskId: activeTaskId })
  }, [activeTaskId, showToast])

  const openSubtasks = useCallback(() => {
    if (!activeTask) {
      showToast('Select a task first', true)
    } else if (activeSubtasks.length === 0) {
      showToast('This task has no subtasks', true)
    } else {
      setSubtaskPickerOpen(true)
    }
  }, [activeSubtasks.length, activeTask, setSubtaskPickerOpen, showToast])

  const openParentTask = useCallback(() => {
    if (!activeTask) {
      showToast('Select a task first', true)
      return
    }
    if (!activeTask.parent_task_id) {
      showToast('This task has no parent', true)
      return
    }
    if (dashboardPreviewTaskId) handleNavigateFromDashboardPreview(activeTask.parent_task_id)
    else selectTask(activeTask.parent_task_id)
  }, [activeTask, dashboardPreviewTaskId, handleNavigateFromDashboardPreview, selectTask, showToast])

  const openActiveTaskOnCanvas = useCallback(() => {
    if (!activeTaskId) {
      setSidebarView('canvas')
      return
    }
    openTaskOnCanvas(activeTaskId)
  }, [activeTaskId, openTaskOnCanvas, setSidebarView])

  const selectSubtask = useCallback((taskId: string) => {
    if (dashboardPreviewTaskId) handleNavigateFromDashboardPreview(taskId)
    else selectTask(taskId)
  }, [dashboardPreviewTaskId, handleNavigateFromDashboardPreview, selectTask])

  const runActiveHeartbeat = useCallback(async () => {
    if (!activeTaskId) {
      showToast('Select a task first', true)
      return
    }
    try {
      const result = await window.electronAPI.heartbeat.runNow(activeTaskId)
      const feedback = {
        sent: ['Heartbeat check started', false],
        no_file: ['This task has no heartbeat.md file', true],
        no_agent: ['This task has no heartbeat agent', true],
        in_progress: ['A heartbeat check is already running', true],
        error: ['Could not run the heartbeat check', true]
      } as const
      const [message, isError] = feedback[result]
      showToast(message, isError)
    } catch {
      showToast('Could not run the heartbeat check', true)
    }
  }, [activeTaskId, showToast])

  const navigateVisibleTask = useCallback((direction: 1 | -1) => {
    const renderedIds = Array.from(document.querySelectorAll<HTMLElement>('[data-keyboard-task-id]'))
      .filter((element) => element.offsetParent !== null)
      .map((element) => element.dataset.keyboardTaskId)
      .filter((id): id is string => !!id)
    const fallbackIds = tasks
      .filter((task) => !task.parent_task_id && task.status !== TaskStatus.Completed && !isSnoozed(task.snoozed_until))
      .map((task) => task.id)
    const ids = renderedIds.length > 0 ? renderedIds : fallbackIds
    if (ids.length === 0) return
    const currentIndex = selectedTaskId ? ids.indexOf(selectedTaskId) : -1
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : ids.length - 1
      : Math.max(0, Math.min(ids.length - 1, currentIndex + direction))
    if (activeModal === 'settings') closeModal()
    setSidebarView('tasks')
    selectTask(ids[nextIndex])
  }, [activeModal, closeModal, selectTask, selectedTaskId, setSidebarView, tasks])

  const openSelectedTask = useCallback(() => {
    if (activeTaskId) handleGoToFullView(activeTaskId)
  }, [activeTaskId, handleGoToFullView])

  const clearTaskSelection = useCallback(() => {
    if (dashboardPreviewTaskId) closeDashboardPreview()
    else selectTask(null)
  }, [closeDashboardPreview, dashboardPreviewTaskId, selectTask])

  const focusSearch = useCallback(() => {
    if (sidebarView !== 'tasks' && sidebarView !== 'skills') {
      setCmdOpen(true)
      return
    }
    if (sidebarCollapsed) useUIStore.getState().setSidebarCollapsed(false)
    // Wait a tick so a just-expanded sidebar has mounted its search input.
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>(`[data-keyboard-shortcut-search="${sidebarView}"]`)?.focus()
    }, 0)
  }, [setCmdOpen, sidebarCollapsed, sidebarView])

  const focusComposer = useCallback(() => {
    if (focusComposerInput()) {
      return true
    }
    showToast('No message composer is available', true)
    return false
  }, [showToast])

  const completeActiveTask = useCallback(() => {
    if (activeTaskId) dispatchTaskShortcut({ action: TaskShortcutAction.COMPLETE, taskId: activeTaskId })
    else showToast('Select a task first', true)
  }, [activeTaskId, showToast])

  const deleteActiveTask = useCallback(() => {
    if (dashboardPreviewTaskId) openDeleteModal(dashboardPreviewTaskId)
    else if (selectedTaskId) openDeleteModal(selectedTaskId)
    else showToast('Select a task first', true)
  }, [dashboardPreviewTaskId, openDeleteModal, selectedTaskId, showToast])

  const toggleTaskAudio = useCallback(() => {
    const voice = useVoiceStore.getState()
    if (!selectVoiceReady(voice)) {
      showToast('Voice input is not ready', true)
      return
    }
    if (voice.turnId) {
      void voice.endTurn()
      return
    }
    if (!activeTaskId || !composerCanSubmit(activeTaskId)) {
      showToast('Open a task with an active message composer first', true)
      return
    }
    setActiveComposer(activeTaskId)
    const loop = voice.conversation && composerCanSubmit(activeTaskId)
    void voice.toggleTurn(loop ? 'conversation' : 'dictation')
  }, [activeTaskId, showToast])

  const nudgeActiveTask = useCallback(() => {
    if (!activeTaskId) {
      showToast('Select a task first', true)
      return
    }
    if (!sendComposerMessage(activeTaskId, getNextNudgeMessage())) {
      showToast('Open the task message composer first', true)
      return
    }
    showToast('Nudge sent')
  }, [activeTaskId, showToast])

  const toggleMastermindAudio = useCallback(() => {
    const voice = useVoiceStore.getState()
    if (!selectVoiceReady(voice)) {
      showToast('Voice input is not ready', true)
      return
    }
    if (voice.turnId) {
      void voice.endTurn()
      return
    }
    setShowOrchestrator(true)
    setActiveComposer(MASTERMIND_COMPOSER_KEY)
    window.setTimeout(() => {
      const loop = useVoiceStore.getState().conversation && composerCanSubmit(MASTERMIND_COMPOSER_KEY)
      void useVoiceStore.getState().toggleTurn(loop ? 'conversation' : 'dictation')
    }, 0)
  }, [setShowOrchestrator, showToast])

  const commandActions: CommandPaletteActions = useMemo(() => ({
    nextTask: () => navigateVisibleTask(1),
    previousTask: () => navigateVisibleTask(-1),
    openTask: openSelectedTask,
    clearSelection: clearTaskSelection,
    focusSearch,
    focusComposer,
    completeTask: completeActiveTask,
    snoozeTask: () => runTaskShortcut(TaskShortcutAction.SNOOZE),
    runTask: () => runTaskShortcut(TaskShortcutAction.RUN),
    nudgeTask: nudgeActiveTask,
    deleteTask: deleteActiveTask,
    showShortcuts: () => setShortcutsOpen(true),
    openDetails: () => runTaskShortcut(TaskShortcutAction.OPEN_DETAILS),
    openChanges: () => runTaskShortcut(TaskShortcutAction.OPEN_CHANGES),
    openOutput: () => runTaskShortcut(TaskShortcutAction.OPEN_OUTPUT),
    openArtifact: () => runTaskShortcut(TaskShortcutAction.OPEN_ARTIFACT),
    openPullRequest: () => runTaskShortcut(TaskShortcutAction.OPEN_PR),
    openSubtasks,
    openParentTask,
    openTaskOnCanvas: openActiveTaskOnCanvas,
    runHeartbeat: () => { void runActiveHeartbeat() },
    copyPullRequestUrl: () => runTaskShortcut(TaskShortcutAction.COPY_PR_URL),
    copyPullRequestBranch: () => runTaskShortcut(TaskShortcutAction.COPY_PR_BRANCH),
    toggleTaskAudio,
    toggleMastermindAudio
  }), [clearTaskSelection, completeActiveTask, deleteActiveTask, focusComposer, focusSearch, navigateVisibleTask, nudgeActiveTask, openActiveTaskOnCanvas, openParentTask, openSelectedTask, openSubtasks, runActiveHeartbeat, runTaskShortcut, setShortcutsOpen, toggleMastermindAudio, toggleTaskAudio])

  return {
    commandActions,
    completeTask,
    completionDialog,
    activeSubtasks,
    selectSubtask,
    handleGoToFullView,
    handleNavigateFromDashboardPreview
  }
}

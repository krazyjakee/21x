import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { filterToProject, getCurrentProjectId, useProjectStore } from '@/stores/project-store'
import { useArtifactStore } from '@/stores/artifact-store'
import { SETTINGS_TABS, SettingsTab } from '@/types'
import {
  type UiCommand,
  type UiCommandResult,
  type UiStateSnapshot,
} from '@shared/ui-commands'

/**
 * Applies one UI command from outside the renderer, and reports the screen
 * back out.
 *
 * These are plain functions, not a hook, for two reasons: the stores are read
 * at call time so nothing can hold a stale selection, and the whole surface can
 * be tested without mounting the application.
 *
 * A command is always addressed by task ID.
 */

/** Registry ID (`artifactId`) to the tab ID the artifact panel uses. */
function resolveArtifactTabId(taskId: string, artifactId: string): string | null {
  const artifacts = useArtifactStore.getState().getArtifacts(taskId)
  const match =
    artifacts.find((artifact) => artifact.workpieceKey === artifactId) ??
    artifacts.find((artifact) => artifact.id === artifactId)
  return match?.id ?? null
}

function isKnownTask(taskId: string): boolean {
  return useTaskStore.getState().tasks.some((task) => task.id === taskId)
}

function toSettingsTab(value: string | undefined): SettingsTab | null {
  if (!value) return null
  const match = SETTINGS_TABS.find((tab) => tab.value === value)
  return match ? match.value : null
}

export function applyUiCommand(command: UiCommand): UiCommandResult {
  const ui = useUIStore.getState()

  switch (command.kind) {
    case 'navigate': {
      if (command.view === 'settings') {
        const tab = toSettingsTab(command.settingsTab)
        if (tab) ui.setSettingsTab(tab)
        ui.openSettings()
        return { applied: true }
      }
      // The settings pane covers the workspace, so leaving it is part of
      // going anywhere else.
      if (ui.activeModal === 'settings') ui.closeModal()
      ui.setSidebarView(command.view)
      return { applied: true }
    }

    case 'switch_project': {
      const projects = useProjectStore.getState()
      const project = projects.projects.find((p) => p.id === command.projectId)
      if (!project || project.archived) return { applied: false, detail: 'That project is not available' }
      projects.setCurrentProject(command.projectId)
      // The Commander view shows no project; land on the dashboard so the
      // switch is visible. A project view keeps its place.
      if (ui.activeModal === 'settings') ui.closeModal()
      if (ui.sidebarView === 'commander') ui.setSidebarView('dashboard')
      return { applied: true }
    }

    case 'open_task': {
      if (!isKnownTask(command.taskId)) return { applied: false, detail: 'That task is not loaded' }
      useTaskStore.getState().selectTask(command.taskId)

      if (command.where === 'modal') {
        if (ui.activeModal === 'settings') ui.closeModal()
        ui.setSidebarView('dashboard')
        ui.openDashboardPreview(command.taskId)
        return { applied: true }
      }

      if (ui.activeModal === 'settings') ui.closeModal()
      ui.closeDashboardPreview()
      ui.setSidebarView('tasks')
      return { applied: true }
    }

    case 'open_artifact': {
      if (!isKnownTask(command.taskId)) return { applied: false, detail: 'That task is not loaded' }

      // The caller names the artifact by its registry ID. The tab is keyed
      // differently — the registry ID is the workpiece key — so the tab is
      // resolved here rather than making a caller guess at the encoding.
      const tabId = resolveArtifactTabId(command.taskId, command.artifactId)
      if (!tabId) return { applied: false, detail: 'That artifact is not on screen yet' }

      // The artifact panel lives in the task workspace, so that task has to be
      // the open one for the user to see anything.
      useTaskStore.getState().selectTask(command.taskId)
      if (ui.activeModal === 'settings') ui.closeModal()
      ui.setSidebarView('tasks')
      ui.closeDashboardPreview()
      useArtifactStore.getState().openArtifact(command.taskId, tabId)
      return { applied: true }
    }
  }
}

/** The screen, as an agent tool reads it. */
export function collectUiState(): UiStateSnapshot {
  const ui = useUIStore.getState()
  const tasks = useTaskStore.getState()
  const selected = tasks.selectedTaskId
  const projectId = getCurrentProjectId()

  return {
    view: ui.sidebarView,
    projectId,
    modal: ui.activeModal,
    selectedTaskId: selected,
    selectedTaskTitle: tasks.tasks.find((task) => task.id === selected)?.title ?? null,
    dashboardPreviewTaskId: ui.dashboardPreviewTaskId,
    captainOpen: ui.showOrchestrator,
    settingsTab: ui.activeModal === 'settings' ? ui.settingsTab : null,
    // Agent approval requests are not surfaced in the renderer.
    waitingForYou: false,
    visibleTaskIds: filterToProject(tasks.tasks, projectId).slice(0, 50).map((task) => task.id),
  }
}

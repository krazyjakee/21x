import { BrowserWindow, ipcMain } from 'electron'
import type {
  CreateProjectData, UpdateProjectData,
  CreateProjectRepoData, UpdateProjectRepoData,
  CreateProjectResourceData, UpdateProjectResourceData
} from '../database'
import type { IpcDeps } from './deps'
import { guardedIpcSend } from '../guarded-ipc-send'
import { readCaptainMemory, type CaptainMemory } from '../agent-manager/captain-context'
import { buildProjectStatus, readProjectStatusHistory } from '../project-status'
import type { ProjectStatus, ProjectStatusHistoryPage } from '../../shared/project-status'
import type { ProjectChangedEvent } from '../../shared/projects'
import { approveHeldAction, listHeldActions, rejectHeldAction } from '../escalation'

export const PROJECT_CHANGED_CHANNEL = 'project:changed'

/**
 * Tells every window that a project's row, repos or resources changed, from
 * whichever side wrote it (the editor over IPC, or the Commander's tools).
 * The project store refetches, and an open editor for that project reloads.
 */
export function broadcastProjectChanged(event: ProjectChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) guardedIpcSend(win.webContents, PROJECT_CHANGED_CHANNEL, event)
  }
}

/** Projects, their repos and their context-only resources. */
export function registerProjectHandlers({ db, agentManager }: IpcDeps): void {
  const changed = <T>(value: T, projectId: string | null | undefined, kind: ProjectChangedEvent['kind']): T => {
    if (projectId) broadcastProjectChanged({ projectId, kind })
    return value
  }
  // Project status (#58): counts from the database and live sessions, plus
  // the Captain's narrative snapshot.
  ipcMain.handle('project:getStatus', (_, projectId: string): ProjectStatus => buildProjectStatus(db, agentManager, projectId))
  // Status history (#72): one bounded page of the journal, newest first, for
  // the project editor's read-only view. Full summaries; the page cap still holds.
  ipcMain.handle('project:getStatusHistory', (_, projectId: string, query?: { limit?: number; cursor?: string | null }): ProjectStatusHistoryPage =>
    readProjectStatusHistory(db, projectId, { limit: query?.limit, cursor: query?.cursor ?? undefined }, { summaryChars: 2_000, listItems: 16, itemChars: 200, totalChars: 40_000 }))
  ipcMain.handle('project:getAll', (_, opts?: { includeArchived?: boolean }) => db.getProjects(opts))
  ipcMain.handle('project:get', (_, id: string) => db.getProject(id))
  ipcMain.handle('project:getDefault', () => db.getDefaultProject())
  ipcMain.handle('project:create', (_, data: CreateProjectData) => {
    const created = db.createProject(data)
    return changed(created, created?.id, 'created')
  })
  ipcMain.handle('project:update', (_, id: string, data: UpdateProjectData) => {
    const updated = db.updateProject(id, data)
    // #65: a pause lifted or a cap raised in the editor must start queued work now.
    if (data.settings !== undefined) agentManager.recheckStartQueue()
    return changed(updated, updated?.id, 'updated')
  })
  ipcMain.handle('project:archive', (_, id: string, archived?: boolean) => {
    const updated = db.archiveProject(id, archived ?? true)
    return changed(updated, updated?.id, archived ?? true ? 'archived' : 'restored')
  })
  ipcMain.handle('project:reorder', (_, orderedIds: string[]) => db.reorderProjects(orderedIds))
  // The memory file the project's Captain keeps in its workspace (#55),
  // read-only for the project editor. Null when the project has no Captain.
  ipcMain.handle('project:getCaptainMemory', (_, projectId: string): CaptainMemory | null => {
    const coordinator = db.getCoordinatorTask(projectId)
    return coordinator ? readCaptainMemory(db.getWorkspaceDir(coordinator.id)) : null
  })
  // Moves a top-level task, its subtasks and recurrence instances into another project.
  ipcMain.handle('project:moveTask', (event, taskId: string, projectId: string) => {
    const moved = db.moveTaskToProject(taskId, projectId)
    if (moved) {
      for (const task of moved) guardedIpcSend(event.sender, 'task:updated', { taskId: task.id, updates: task })
    }
    return moved ?? null
  })

  ipcMain.handle('projectRepo:list', (_, projectId: string) => db.getProjectRepos(projectId))
  ipcMain.handle('projectRepo:add', (_, projectId: string, data: CreateProjectRepoData) =>
    changed(db.addProjectRepo(projectId, data), projectId, 'repos'))
  ipcMain.handle('projectRepo:update', (_, id: string, data: UpdateProjectRepoData) => {
    const updated = db.updateProjectRepo(id, data)
    return changed(updated, updated?.project_id, 'repos')
  })
  ipcMain.handle('projectRepo:remove', (_, id: string) => {
    const projectId = db.getProjectRepo(id)?.project_id
    return changed(db.removeProjectRepo(id), projectId, 'repos')
  })
  ipcMain.handle('projectRepo:reorder', (_, projectId: string, orderedIds: string[]) =>
    changed(db.reorderProjectRepos(projectId, orderedIds), projectId, 'repos'))

  ipcMain.handle('projectResource:list', (_, projectId: string) => db.getProjectResources(projectId))
  ipcMain.handle('projectResource:add', (_, projectId: string, data: CreateProjectResourceData) =>
    changed(db.addProjectResource(projectId, data), projectId, 'resources'))
  ipcMain.handle('projectResource:update', (_, id: string, data: UpdateProjectResourceData) => {
    const updated = db.updateProjectResource(id, data)
    return changed(updated, updated?.project_id, 'resources')
  })
  ipcMain.handle('projectResource:remove', (_, id: string) => {
    const projectId = db.getProjectResource(id)?.project_id
    return changed(db.removeProjectResource(id), projectId, 'resources')
  })
  ipcMain.handle('projectResource:reorder', (_, projectId: string, orderedIds: string[]) =>
    changed(db.reorderProjectResources(projectId, orderedIds), projectId, 'resources'))

  // ── Limits and pause (#65) ──
  ipcMain.handle('projectLimits:getState', (_, projectId: string) => agentManager.getProjectLimitState(projectId))
  ipcMain.handle('projectLimits:isAllPaused', () => agentManager.isAllProjectsPaused())
  // Also the Commander's "pause all projects" (#61) once it has a tool for it.
  ipcMain.handle('projectLimits:pauseAll', (_, paused: boolean) => {
    agentManager.pauseAllProjects(paused === true)
    return agentManager.isAllProjectsPaused()
  })

  // ── Escalation policy: held Captain calls (#66) ──
  ipcMain.handle('escalation:listHeld', (_, projectId?: string) => listHeldActions(projectId))
  ipcMain.handle('escalation:approve', (_, id: string) => approveHeldAction(id))
  ipcMain.handle('escalation:reject', (_, id: string, note?: string) => rejectHeldAction(id, note))
}

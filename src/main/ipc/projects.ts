import { ipcMain } from 'electron'
import type {
  CreateProjectData, UpdateProjectData,
  CreateProjectRepoData, UpdateProjectRepoData,
  CreateProjectResourceData, UpdateProjectResourceData
} from '../database'
import type { IpcDeps } from './deps'
import { guardedIpcSend } from '../guarded-ipc-send'
import { readMastermindMemory, type MastermindMemory } from '../agent-manager/mastermind-context'

/** Projects, their repos and their context-only resources. */
export function registerProjectHandlers({ db }: IpcDeps): void {
  ipcMain.handle('project:getAll', (_, opts?: { includeArchived?: boolean }) => db.getProjects(opts))
  ipcMain.handle('project:get', (_, id: string) => db.getProject(id))
  ipcMain.handle('project:getDefault', () => db.getDefaultProject())
  ipcMain.handle('project:create', (_, data: CreateProjectData) => db.createProject(data))
  ipcMain.handle('project:update', (_, id: string, data: UpdateProjectData) => db.updateProject(id, data))
  ipcMain.handle('project:archive', (_, id: string, archived?: boolean) => db.archiveProject(id, archived ?? true))
  ipcMain.handle('project:reorder', (_, orderedIds: string[]) => db.reorderProjects(orderedIds))
  // The memory file the project's Mastermind keeps in its workspace (#55),
  // read-only for the project editor. Null when the project has no Mastermind.
  ipcMain.handle('project:getMastermindMemory', (_, projectId: string): MastermindMemory | null => {
    const coordinator = db.getCoordinatorTask(projectId)
    return coordinator ? readMastermindMemory(db.getWorkspaceDir(coordinator.id)) : null
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
  ipcMain.handle('projectRepo:add', (_, projectId: string, data: CreateProjectRepoData) => db.addProjectRepo(projectId, data))
  ipcMain.handle('projectRepo:update', (_, id: string, data: UpdateProjectRepoData) => db.updateProjectRepo(id, data))
  ipcMain.handle('projectRepo:remove', (_, id: string) => db.removeProjectRepo(id))
  ipcMain.handle('projectRepo:reorder', (_, projectId: string, orderedIds: string[]) => db.reorderProjectRepos(projectId, orderedIds))

  ipcMain.handle('projectResource:list', (_, projectId: string) => db.getProjectResources(projectId))
  ipcMain.handle('projectResource:add', (_, projectId: string, data: CreateProjectResourceData) => db.addProjectResource(projectId, data))
  ipcMain.handle('projectResource:update', (_, id: string, data: UpdateProjectResourceData) => db.updateProjectResource(id, data))
  ipcMain.handle('projectResource:remove', (_, id: string) => db.removeProjectResource(id))
  ipcMain.handle('projectResource:reorder', (_, projectId: string, orderedIds: string[]) => db.reorderProjectResources(projectId, orderedIds))
}

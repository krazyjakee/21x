import { ipcMain } from 'electron'
import { required, type IpcDeps } from './deps'
import type { CreateTaskGroupData, TaskGroupReviewData } from '../../shared/task-groups'

export function registerTaskGroupHandlers(deps: IpcDeps): void {
  const service = () => required(deps.taskGroups, 'TaskGroupService')
  ipcMain.handle('taskGroups:list', (_, projectId: string, includeDissolved?: boolean) => service().list(projectId, includeDissolved))
  ipcMain.handle('taskGroups:get', (_, id: string) => service().get(id))
  ipcMain.handle('taskGroups:history', (_, taskId: string) => service().history(taskId))
  ipcMain.handle('taskGroups:create', (_, data: CreateTaskGroupData) => service().create(data))
  ipcMain.handle('taskGroups:add', (_, id: string, taskIds: string[]) => service().add(id, taskIds))
  ipcMain.handle('taskGroups:remove', (_, id: string, taskId: string) => service().remove(id, taskId))
  ipcMain.handle('taskGroups:dissolve', (_, id: string) => service().dissolve(id))
  ipcMain.handle('taskGroups:move', (_, id: string, status: string) => service().move(id, status))
  ipcMain.handle('taskGroups:review', (_, data: TaskGroupReviewData) => service().review(data))
}

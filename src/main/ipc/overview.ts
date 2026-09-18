import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { buildProjectOverview } from '../project-overview'
import type { ProjectOverviewEntry } from '../../shared/project-overview'

/**
 * The all-projects overview (#63): every active project's status and card
 * facts in one call, so the overview view refreshes with a single round trip
 * whenever a task or session changes.
 */
export function registerOverviewHandlers({ db, agentManager }: IpcDeps): void {
  ipcMain.handle('project:getAllStatuses', (): ProjectOverviewEntry[] => buildProjectOverview(db, agentManager))
}

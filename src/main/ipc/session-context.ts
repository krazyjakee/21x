import { ipcMain } from 'electron'
import { assertTrustedSender } from '../ipc-sender'
import { SessionContextService } from '../sessions/context-service'
import type { IpcDeps } from './deps'

export function registerSessionContextHandlers(deps: IpcDeps): void {
  const service = new SessionContextService(deps.db)
  ipcMain.handle('sessionContext:getSnapshot', (event, scope: unknown) => {
    assertTrustedSender(event, 'sessionContext:getSnapshot')
    return service.getSnapshot(scope)
  })
  ipcMain.handle('sessionContext:setPolicy', (event, policy: unknown) => {
    assertTrustedSender(event, 'sessionContext:setPolicy')
    return service.setPolicy(policy)
  })
}

import { ipcMain } from 'electron'
import { ConnectorBridgeService } from '../connectors/bridge/service'
import { getConnectorRuntime } from '../connectors/bridge/runtime'
import type { ConnectorBridgeCredentialInput, ConnectorBridgeOAuthConnectInput } from '../../shared/connector-bridge'
import type { ConnectorCredentialStorage } from '../connectors/credentials'
import type { IpcDeps } from './deps'

/** Legacy desktop adapter; connector behavior is shared with the portable service. */
export function registerConnectorHandlers({ db }: IpcDeps): void {
  const service = new ConnectorBridgeService(() => getConnectorRuntime(db))
  ipcMain.handle('connectors:bridgePieces', () => service.bridgePieces())
  ipcMain.handle('connectors:ensureInstance', (_, pieceName: string, instanceId?: string) => service.ensureInstance(pieceName, instanceId))
  ipcMain.handle('connectors:credentialStatus', (_, instanceId: string) => service.credentialStatus(instanceId))
  ipcMain.handle('connectors:setCredentials', (_, instanceId: string, input: ConnectorBridgeCredentialInput, storage?: ConnectorCredentialStorage) =>
    service.setCredentials(instanceId, input, storage))
  ipcMain.handle('connectors:oauthConnect', (_, instanceId: string, input: ConnectorBridgeOAuthConnectInput, storage?: ConnectorCredentialStorage) =>
    service.oauthConnect(instanceId, input, storage))
  ipcMain.handle('connectors:clearCredentials', (_, instanceId: string) => service.clearCredentials(instanceId))
  ipcMain.handle('connectors:syncStatus', (_, instanceId: string) => service.syncStatus(instanceId))
}

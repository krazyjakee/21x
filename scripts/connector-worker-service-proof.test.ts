import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createPackagedConnectorTransport, validateConnectorResources } from '../src/main/connectors/piece-host/packaged-resources'
import Database from 'better-sqlite3'
import { applySchema } from '../src/main/database/schema'
import { closeConnectorRuntime, getConnectorRuntime } from '../src/main/connectors/bridge/runtime-core'
import { ConnectorBridgeCore } from '../src/main/plugins/connector-bridge-core'
import { ConnectorBridgeService } from '../src/main/connectors/bridge/service'
import { DatabaseManager } from '../src/main/database/manager'
import { tmpdir } from 'node:os'

describe('staged connector worker resources', () => {
  it.skipIf(process.env.TAURI_STANDALONE_SERVICE_PROOFS !== '1')('runs both pinned local hooks from contained resources with system Node hidden', async () => {
    const resources = resolve('src-tauri/resources')
    expect(validateConnectorResources(resources).nodeVersion).toBe(process.version.slice(1))
    const database = new Database(':memory:')
    applySchema(database)
    const source = new DatabaseManager({ paths: { profileRoot: tmpdir(), workspaceRoot: tmpdir(), attachmentRoot: tmpdir() },
      managedTaskMcp: { disabled: true } })
    source.db = database
    const host = {
      createTransport: () => createPackagedConnectorTransport(resources),
      openExternal: () => { throw new Error('External OAuth is not exercised by this fixture') } }
    const runtime = getConnectorRuntime(source, host)
    const service = new ConnectorBridgeService(() => getConnectorRuntime(source, host))
    const trello = service.ensureInstance('@activepieces/piece-trello')
    const todoist = service.ensureInstance('@activepieces/piece-todoist')
    const plugin = new ConnectorBridgeCore({ runtime: () => getConnectorRuntime(source, host) })
    expect(plugin.engineFor(source).store).toBe(runtime.store)
    await expect(plugin.importTasks('fixture-source', {}, { db: source })).resolves.toMatchObject({ errors: ['Choose a connector piece'] })
    expect(service.setCredentials(trello.instanceId, { username: 'fixture', password: 'fixture' }, 'session')).toEqual({ ok: true, storage: 'session' })
    expect(service.credentialStatus(trello.instanceId).storage).toBe('session')
    runtime.credentialStore.set(todoist.instanceId, { type: 'oauth2', clientId: 'fixture', clientSecret: null, accessToken: 'fixture-access',
      refreshToken: null, expiresAt: null, tokenType: 'Bearer', scope: null }, 'session')
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(runtime.client.runTrigger({ instanceId: trello.instanceId, pieceName: '@activepieces/piece-trello',
        pieceVersion: '0.6.0', triggerName: 'deadline', hook: 'onDisable', timeoutMs: 2000 })).resolves.toBeNull()
      await expect(runtime.client.runTrigger({ instanceId: todoist.instanceId, pieceName: '@activepieces/piece-todoist',
        pieceVersion: '0.5.0', triggerName: 'task_completed', hook: 'onDisable', timeoutMs: 2000 })).resolves.toBeNull()
      expect(runtime.client.starts).toBe(1)
      service.clearCredentials(trello.instanceId)
      expect(service.credentialStatus(trello.instanceId).storage).toBeNull()
      await plugin.close()
      await closeConnectorRuntime(source)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await Promise.all([plugin.close(), closeConnectorRuntime(source)])
      database.close()
    }
  }, 10_000)
})

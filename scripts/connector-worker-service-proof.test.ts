import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createPackagedConnectorTransport, validateConnectorResources } from '../src/main/connectors/piece-host/packaged-resources'
import Database from 'better-sqlite3'
import { applySchema } from '../src/main/database/schema'
import { closeConnectorRuntime, getConnectorRuntime } from '../src/main/connectors/bridge/runtime-core'

describe('staged connector worker resources', () => {
  it.skipIf(process.env.TAURI_STANDALONE_SERVICE_PROOFS !== '1')('runs both pinned local hooks from contained resources with system Node hidden', async () => {
    const resources = resolve('src-tauri/resources')
    expect(validateConnectorResources(resources).nodeVersion).toBe(process.version.slice(1))
    const database = new Database(':memory:')
    applySchema(database)
    const source = { db: database }
    const runtime = getConnectorRuntime(source, {
      createTransport: () => createPackagedConnectorTransport(resources),
      openExternal: () => { throw new Error('External OAuth is not exercised by this fixture') } })
    const trello = runtime.store.createInstance({ pieceName: '@activepieces/piece-trello', pieceVersion: '0.6.0' })
    const todoist = runtime.store.createInstance({ pieceName: '@activepieces/piece-todoist', pieceVersion: '0.5.0' })
    runtime.credentialStore.set(trello.id, { type: 'custom_auth', props: { api_key: 'fixture', token: 'fixture' } }, 'session')
    runtime.credentialStore.set(todoist.id, { type: 'oauth2', clientId: 'fixture', clientSecret: null, accessToken: 'fixture-access',
      refreshToken: null, expiresAt: null, tokenType: 'Bearer', scope: null }, 'session')
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(runtime.client.runTrigger({ instanceId: trello.id, pieceName: '@activepieces/piece-trello',
        pieceVersion: '0.6.0', triggerName: 'deadline', hook: 'onDisable', timeoutMs: 2000 })).resolves.toBeNull()
      await expect(runtime.client.runTrigger({ instanceId: todoist.id, pieceName: '@activepieces/piece-todoist',
        pieceVersion: '0.5.0', triggerName: 'task_completed', hook: 'onDisable', timeoutMs: 2000 })).resolves.toBeNull()
      expect(runtime.client.starts).toBe(1)
      await closeConnectorRuntime(source)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await closeConnectorRuntime(source)
      database.close()
    }
  }, 10_000)
})

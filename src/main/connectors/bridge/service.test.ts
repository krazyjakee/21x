import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../../../test/helpers/portable-db-test-helper'
import { getSecretStorage } from '../../platform/secret-storage'
import { ConnectorBridgeService } from './service'
import { closeConnectorRuntime, ConnectorRuntimeClosedError, getConnectorRuntime } from './runtime-core'

const TRELLO = '@activepieces/piece-trello'
const TODOIST = '@activepieces/piece-todoist'

describe('portable connector form service', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  let service: ConnectorBridgeService
  const host = {
    createTransport: () => { throw new Error('Form operations must not start a worker') },
    openExternal: () => { throw new Error('External OAuth is not exercised by this fixture') }
  }
  beforeEach(() => {
    source = createPortableDbFixture()
    service = new ConnectorBridgeService(() => getConnectorRuntime(source.db, host))
    vi.spyOn(getSecretStorage(), 'isEncryptionAvailable').mockReturnValue(false)
  })
  afterEach(async () => {
    await closeConnectorRuntime(source.db)
    source.rawDb.close()
    vi.restoreAllMocks()
  })

  it('lists only mapped pins and returns independent form metadata without credentials or endpoint URLs', () => {
    const pieces = service.bridgePieces()
    expect(pieces.map(piece => piece.pieceName)).toEqual([TRELLO, TODOIST])
    expect(pieces[1].oauth).toMatchObject({ scopes: ['data:read_write'], clientSecretRequired: true })
    pieces[0].authLabels.password = 'changed'
    pieces[0].configProps[0].key = 'changed'
    pieces[1].oauth!.scopes.push('changed')
    const fresh = service.bridgePieces()
    expect(fresh[0].authLabels.password).toBe('Token')
    expect(fresh[0].configProps[0].key).toBe('board_id')
    expect(fresh[1].oauth!.scopes).toEqual(['data:read_write'])
    expect(fresh[1].oauth).not.toHaveProperty('tokenUrl')
  })

  it('reuses a matching instance and creates the exact current pin when switching pieces', () => {
    const trello = service.ensureInstance(TRELLO)
    expect(service.ensureInstance(TRELLO, trello.instanceId)).toEqual(trello)
    const todoist = service.ensureInstance(TODOIST, trello.instanceId)
    expect(todoist.instanceId).not.toBe(trello.instanceId)
    const runtime = getConnectorRuntime(source.db, host)
    expect(runtime.store.getInstance(trello.instanceId)?.pieceVersion).toBe('0.6.0')
    expect(runtime.store.getInstance(todoist.instanceId)?.pieceVersion).toBe('0.5.0')
    expect(runtime.client.starts).toBe(0)
  })

  it('rejects unknown pieces and instances without creating records or echoing inputs', () => {
    expect(() => service.ensureInstance('unreviewed-fixture-piece')).toThrow('Unknown connector piece')
    expect(() => service.credentialStatus('unreviewed-fixture-instance')).toThrow('Connector not found')
    expect(service.setCredentials('missing', { password: 'fixture-secret' }, 'session')).toEqual({ ok: false, error: 'Connector not found' })
    expect(source.rawDb.prepare('SELECT COUNT(*) AS n FROM connector_instances').get()).toEqual({ n: 0 })
  })

  it('keeps explicit session credentials out of SQLite and all form responses, then clears them', () => {
    const { instanceId } = service.ensureInstance(TRELLO)
    expect(service.setCredentials(instanceId, { username: ' fixture-key ', password: ' fixture-token ' }, 'session'))
      .toEqual({ ok: true, storage: 'session' })
    const status = service.credentialStatus(instanceId)
    expect(status).toEqual({ storage: 'session', persistentAvailable: false })
    expect(JSON.stringify(source.rawDb.prepare('SELECT * FROM connector_instances').all())).not.toContain('fixture-token')
    expect(getConnectorRuntime(source.db, host).credentialStore.get(instanceId)).toEqual({ type: 'basic', username: 'fixture-key', password: 'fixture-token' })
    service.clearCredentials(instanceId)
    expect(service.credentialStatus(instanceId).storage).toBeNull()
    expect(getConnectorRuntime(source.db, host).credentialStore.get(instanceId)).toBeNull()
  })

  it('refuses default persistent storage with remediation and no silent session fallback', () => {
    const { instanceId } = service.ensureInstance(TRELLO)
    const result = service.setCredentials(instanceId, { username: 'fixture-key', password: 'fixture-token' })
    expect(result).toMatchObject({ ok: false, sessionOnlyAvailable: true, remediation: expect.any(String) })
    expect(JSON.stringify(result)).not.toContain('fixture-token')
    expect(service.credentialStatus(instanceId).storage).toBeNull()
  })

  it('bounds and validates credentials before storage and requires the OAuth path for Todoist', () => {
    const { instanceId } = service.ensureInstance(TRELLO)
    expect(service.setCredentials(instanceId, { username: 'key', password: ' ' }, 'session')).toEqual({ ok: false, error: 'Token is required' })
    expect(service.setCredentials(instanceId, { username: 'key', password: 'x'.repeat(4097) }, 'session')).toEqual({ ok: false, error: 'Token is too long' })
    const todoist = service.ensureInstance(TODOIST)
    expect(service.setCredentials(todoist.instanceId, { secret: 'fixture-token' }, 'session')).toEqual({ ok: false, error: 'Todoist connects through OAuth; use Connect' })
    expect(service.credentialStatus(instanceId).storage).toBeNull()
    expect(service.credentialStatus(todoist.instanceId).oauth).toEqual({ state: 'none', expiresAt: null })
  })

  it('passes only mapped OAuth scopes and returns write-only success', async () => {
    const { instanceId } = service.ensureInstance(TODOIST)
    const connect = vi.spyOn(getConnectorRuntime(source.db, host).credentials, 'connect').mockResolvedValue(undefined)
    expect(await service.oauthConnect(instanceId, { clientId: 'fixture-client', clientSecret: 'fixture-secret' }, 'session'))
      .toEqual({ ok: true, storage: 'session' })
    expect(connect).toHaveBeenCalledWith(instanceId, { clientId: 'fixture-client', clientSecret: 'fixture-secret', scopes: ['data:read_write'] }, 'session')
    const trello = service.ensureInstance(TRELLO)
    expect(await service.oauthConnect(trello.instanceId, {})).toEqual({ ok: false, error: 'Trello does not use OAuth' })
    expect(connect).toHaveBeenCalledOnce()
  })

  it('projects retry and dead-letter counts without returning cursor or payload contents', () => {
    const { instanceId } = service.ensureInstance(TRELLO)
    expect(service.syncStatus(instanceId)).toEqual({ lastError: null, lastSyncedAt: null, attemptCount: 0, nextRetryAt: null, deadLetterCount: 0 })
    const { store } = getConnectorRuntime(source.db, host)
    store.updateSyncState(instanceId, { cursor: { hidden: 'fixture-cursor' }, lastError: 'fixture timeout', lastSyncedAt: 1000, attemptCount: 2, nextRetryAt: 2000 })
    store.addDeadLetter(instanceId, { payload: { hidden: 'fixture-payload' }, error: 'fixture timeout' })
    expect(service.syncStatus(instanceId)).toEqual({ lastError: 'fixture timeout', lastSyncedAt: 1000, attemptCount: 2, nextRetryAt: 2000, deadLetterCount: 1 })
  })

  it('resolves lifecycle admission for every database operation after runtime close', async () => {
    const { instanceId } = service.ensureInstance(TRELLO)
    await closeConnectorRuntime(source.db)
    for (const call of [
      () => service.ensureInstance(TRELLO), () => service.credentialStatus(instanceId),
      () => service.setCredentials(instanceId, {}, 'session'), () => service.clearCredentials(instanceId),
      () => service.syncStatus(instanceId)
    ]) expect(call).toThrow(ConnectorRuntimeClosedError)
    await expect(service.oauthConnect(instanceId, {})).rejects.toBeInstanceOf(ConnectorRuntimeClosedError)
    expect(source.rawDb.open).toBe(true)
  })
})

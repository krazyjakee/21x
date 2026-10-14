import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture as createTestDb } from '../../../../test/helpers/portable-db-test-helper'
import { closeConnectorRuntime, ConnectorRuntimeClosedError, disposeConnectorRuntime, getConnectorRuntime as resolveRuntime } from './runtime-core'
import { PieceHostShutdownIncompleteError } from '../piece-host/client'
import { PieceCancelledError } from '../piece-host/errors'
import { ConnectorCredentialStoreClosedError } from '../credentials'
import { ConnectorCredentialMutationBusyError } from '../credential-admission'
import { ConnectorBridgeEngine } from './engine'

const host = {
  createTransport: () => { throw new Error('Lifetime controls must not start a worker') },
  openExternal: () => { throw new Error('Lifetime controls must not open a browser') }
}
const getConnectorRuntime = (source: Parameters<typeof resolveRuntime>[0]) => resolveRuntime(source, host)

describe('connector runtime ownership', () => {
  const sources: ReturnType<typeof createTestDb>[] = []
  function fixture() {
    const source = createTestDb()
    sources.push(source)
    return source
  }
  afterEach(async () => {
    for (const source of sources) {
      await closeConnectorRuntime(source.db)
      source.rawDb.close()
    }
    sources.length = 0
    vi.restoreAllMocks()
  })

  it('retains a cancelled credential read through disposal and a failed close without reviving the runtime', async () => {
    const source = fixture()
    const runtime = getConnectorRuntime(source.db)
    const instance = runtime.store.createInstance({ pieceName: '@activepieces/piece-trello', pieceVersion: '0.6.0' })
    const secret = { type: 'secret_text' as const, secret: 'fixture-session-token' }
    runtime.credentialStore.set(instance.id, secret, 'session')
    let finish!: (value: null) => void
    const credentials = new Promise<null>(done => { finish = done })
    const read = vi.spyOn(runtime.credentials, 'get').mockReturnValue(credentials)
    const result = expect(runtime.client.runAction({ instanceId: 'fixture', pieceName: '@activepieces/piece-trello',
      pieceVersion: '0.6.0', actionName: 'get_board' })).rejects.toBeInstanceOf(PieceCancelledError)
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
      disposeConnectorRuntime(source.db)
      await result
      expect(() => getConnectorRuntime(source.db)).toThrow(ConnectorRuntimeClosedError)
      await expect(closeConnectorRuntime(source.db, 5)).rejects.toBeInstanceOf(PieceHostShutdownIncompleteError)
      expect(source.rawDb.open).toBe(true)
      expect(runtime.credentialStore.get(instance.id)).toEqual(secret)
      let closed = false
      const retry = closeConnectorRuntime(source.db).then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      finish(null)
      await retry
      expect(() => runtime.credentialStore.get(instance.id)).toThrow(ConnectorCredentialStoreClosedError)
      expect(runtime.client.starts).toBe(0)
      expect(() => getConnectorRuntime(source.db)).toThrow(ConnectorRuntimeClosedError)
    } finally { finish(null); await result }
  })

  it('closes an unused source without allocating a worker or allowing later creation', async () => {
    const source = fixture()
    await closeConnectorRuntime(source.db)
    expect(() => getConnectorRuntime(source.db)).toThrow(ConnectorRuntimeClosedError)
    expect(source.rawDb.open).toBe(true)
  })

  it('validates the deadline before stopping an existing runtime', async () => {
    const source = fixture()
    const runtime = getConnectorRuntime(source.db)
    await expect(closeConnectorRuntime(source.db, 0)).rejects.toBeInstanceOf(RangeError)
    expect(getConnectorRuntime(source.db)).toBe(runtime)
    await closeConnectorRuntime(source.db)
    expect(runtime.client.starts).toBe(0)
  })

  it('shares the edit fence with real direct calls, OAuth refresh and bridge admission', async () => {
    const source = fixture()
    const runtime = getConnectorRuntime(source.db)
    const instance = runtime.store.createInstance({ pieceName: '@activepieces/piece-trello', pieceVersion: '0.6.0' })
    const engine = new ConnectorBridgeEngine({ runtime })
    let finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    const edit = runtime.runCredentialMutation(instance.id, async () => {
      runtime.credentialStore.set(instance.id, { type: 'basic', username: 'fixture-key', password: 'fixture-token' }, 'session')
      await held
    })
    await expect(runtime.client.runAction({ instanceId: instance.id, pieceName: instance.pieceName, pieceVersion: instance.pieceVersion, actionName: 'get_board' })).rejects.toBeInstanceOf(ConnectorCredentialMutationBusyError)
    await expect(runtime.credentials.get(instance.id)).rejects.toBeInstanceOf(ConnectorCredentialMutationBusyError)
    await expect(engine.sync('fixture-source', { piece_name: instance.pieceName, connector_instance_id: instance.id, props: { board_id: 'fixture-board' } }, { db: source.db })).rejects.toBeInstanceOf(ConnectorCredentialMutationBusyError)
    await expect(runtime.runCredentialMutation(instance.id, () => runtime.credentialStore.clear(instance.id))).rejects.toBeInstanceOf(ConnectorCredentialMutationBusyError)
    expect(runtime.client.starts).toBe(0)
    finish()
    await edit
    await runtime.runCredentialMutation(instance.id, () => runtime.credentialStore.clear(instance.id))
    expect(runtime.credentialStore.get(instance.id)).toBeNull()
    await engine.close()
  })

  it('refuses a credential edit after public cancellation until its raw credential read settles', async () => {
    const source = fixture()
    const runtime = getConnectorRuntime(source.db)
    const instance = runtime.store.createInstance({ pieceName: '@activepieces/piece-trello', pieceVersion: '0.6.0' })
    let finish!: (value: null) => void
    const held = new Promise<null>(resolve => { finish = resolve })
    const read = vi.spyOn(runtime.credentials, 'get').mockReturnValue(held)
    const cancel = new AbortController()
    const result = expect(runtime.client.runAction({ instanceId: instance.id, pieceName: instance.pieceName, pieceVersion: instance.pieceVersion, actionName: 'get_board', signal: cancel.signal })).rejects.toBeInstanceOf(PieceCancelledError)
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    cancel.abort()
    await result
    await expect(runtime.runCredentialMutation(instance.id, () => runtime.credentialStore.clear(instance.id))).rejects.toBeInstanceOf(ConnectorCredentialMutationBusyError)
    finish(null)
    await vi.waitFor(async () => { await runtime.runCredentialMutation(instance.id, () => runtime.credentialStore.clear(instance.id)) })
    expect(runtime.client.starts).toBe(0)
  })

  it('retains a killed worker exit receipt after public cancellation before admitting an edit', async () => {
    const source = fixture()
    let exit!: (code: number | null) => void
    const postMessage = vi.fn(), kill = vi.fn()
    const runtime = resolveRuntime(source.db, { openExternal: host.openExternal, createTransport: () => ({ postMessage, kill,
      onMessage(handler) { queueMicrotask(() => handler({ kind: 'ready' })) }, onExit(handler) { exit = handler } }) })
    const instance = runtime.store.createInstance({ pieceName: '@activepieces/piece-trello', pieceVersion: '0.6.0' })
    const cancel = new AbortController()
    const result = expect(runtime.client.runAction({ instanceId: instance.id, pieceName: instance.pieceName, pieceVersion: instance.pieceVersion, actionName: 'get_board', signal: cancel.signal })).rejects.toBeInstanceOf(PieceCancelledError)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce())
    cancel.abort()
    await result
    expect(kill).toHaveBeenCalledOnce()
    await expect(runtime.runCredentialMutation(instance.id, () => runtime.credentialStore.clear(instance.id))).rejects.toBeInstanceOf(ConnectorCredentialMutationBusyError)
    exit(null)
    await vi.waitFor(async () => { await runtime.runCredentialMutation(instance.id, () => runtime.credentialStore.clear(instance.id)) })
    expect(runtime.client.starts).toBe(1)
  })
})

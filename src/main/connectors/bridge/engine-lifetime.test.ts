import { describe, expect, it, vi } from 'vitest'
import { ConnectorBridgeClosedError, ConnectorBridgeEngine, ConnectorBridgeShutdownIncompleteError, type BridgeRuntime } from './engine'
import type { PluginContext } from '../../plugins/types'

function fixture() {
  let finish!: () => void
  const held = new Promise<null>(resolve => { finish = () => resolve(null) })
  const get = vi.fn(() => held)
  const getInstance = vi.fn(() => ({ id: 'instance', pieceName: '@activepieces/piece-trello',
    pieceVersion: '0.6.0', enabled: true }))
  const runAction = vi.fn()
  const store = { getInstance }
  const runtime = { store, credentials: { get }, client: { runAction } } as unknown as BridgeRuntime
  const engine = new ConnectorBridgeEngine({ runtime })
  const config = { piece_name: '@activepieces/piece-trello', connector_instance_id: 'instance', props: {} }
  const ctx = {} as PluginContext
  return { finish, get, getInstance, runAction, engine, config, ctx }
}

describe('connector bridge job ownership', () => {
  it('joins active raw credentials and refuses new work before reading the store', async () => {
    const f = fixture()
    const active = f.engine.sync('source', f.config, f.ctx)
    expect(f.engine.sync('source', f.config, f.ctx)).toBe(active)
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce())
    let closed = false
    const close = f.engine.close().then(() => { closed = true })
    const reads = f.getInstance.mock.calls.length
    await expect(f.engine.sync('source', f.config, f.ctx)).rejects.toBeInstanceOf(ConnectorBridgeClosedError)
    await expect(f.engine.pushUpdate({ external_id: 'card' }, { title: 'changed' }, f.config, { queueOnFailure: true }))
      .rejects.toBeInstanceOf(ConnectorBridgeClosedError)
    expect(f.getInstance).toHaveBeenCalledTimes(reads)
    expect(closed).toBe(false)
    f.finish()
    expect((await active).errors[0]).toContain('not connected')
    await close
    expect(f.engine.isBusy('instance')).toBe(false)
  })

  it('rejects an update queued behind an active sync without starting another credential read', async () => {
    const f = fixture()
    const active = f.engine.sync('source', f.config, f.ctx)
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce())
    const queued = expect(f.engine.pushUpdate({ external_id: 'card' }, { title: 'changed' }, f.config, { queueOnFailure: true }))
      .rejects.toBeInstanceOf(ConnectorBridgeClosedError)
    let closed = false
    const close = f.engine.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    f.finish()
    await active
    await queued
    await close
    expect(f.get).toHaveBeenCalledOnce()
    expect(f.runAction).not.toHaveBeenCalled()
  })

  it('retains raw job ownership after a shutdown deadline', async () => {
    const f = fixture()
    const active = f.engine.sync('source', f.config, f.ctx)
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce())
    await expect(f.engine.close(5)).rejects.toBeInstanceOf(ConnectorBridgeShutdownIncompleteError)
    expect(f.engine.isBusy('instance')).toBe(true)
    let closed = false
    const retry = f.engine.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    f.finish()
    await active
    await retry
    expect(f.engine.isBusy('instance')).toBe(false)
  })

  it('closes before an admitted job starts without touching credentials', async () => {
    const f = fixture()
    const active = expect(f.engine.sync('source', f.config, f.ctx)).rejects.toBeInstanceOf(ConnectorBridgeClosedError)
    await f.engine.close()
    await active
    expect(f.get).not.toHaveBeenCalled()
    expect(f.runAction).not.toHaveBeenCalled()
  })

  it('rejects an invalid deadline before changing admission', async () => {
    const f = fixture()
    await expect(f.engine.close(0)).rejects.toBeInstanceOf(RangeError)
    const active = f.engine.sync('source', f.config, f.ctx)
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce())
    f.finish()
    await active
    await f.engine.close()
  })
})

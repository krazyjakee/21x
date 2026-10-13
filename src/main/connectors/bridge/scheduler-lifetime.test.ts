import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_BRIDGE_PLUGIN_ID } from './engine'
import { BridgeScheduler, BridgeSchedulerShutdownIncompleteError, type BridgeSchedulerOptions } from './scheduler'

function fixture() {
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const getTaskSources = vi.fn(() => [{ id: 'source', plugin_id: CONNECTOR_BRIDGE_PLUGIN_ID, enabled: true,
    config: { connector_instance_id: 'instance', poll_interval_minutes: 1 } }])
  const getSyncState = vi.fn(() => null)
  const runSource = vi.fn(() => held)
  const options = { db: { getTaskSources }, store: { getSyncState }, isBusy: () => false,
    runSource, tickMs: 10 } as unknown as BridgeSchedulerOptions
  return { finish, getTaskSources, getSyncState, runSource, scheduler: new BridgeScheduler(options) }
}

describe('connector polling shutdown ownership', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces an active pass and joins its source callback after stopping the timer', async () => {
    const f = fixture()
    vi.useFakeTimers()
    f.scheduler.start()
    const pass = f.scheduler.tick()
    expect(f.scheduler.tick()).toBe(pass)
    await vi.waitFor(() => expect(f.runSource).toHaveBeenCalledOnce())
    expect(f.runSource).toHaveBeenCalledOnce()
    let closed = false
    const close = f.scheduler.close().then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(100)
    expect(closed).toBe(false)
    expect(f.runSource).toHaveBeenCalledOnce()
    await f.scheduler.tick()
    expect(f.getTaskSources).toHaveBeenCalledOnce()
    expect(() => f.scheduler.start()).toThrow('shutting down')
    f.finish()
    await pass
    await close
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains source ownership across a close deadline', async () => {
    const f = fixture()
    const pass = f.scheduler.tick()
    await vi.waitFor(() => expect(f.runSource).toHaveBeenCalledOnce())
    await expect(f.scheduler.close(5)).rejects.toBeInstanceOf(BridgeSchedulerShutdownIncompleteError)
    let closed = false
    const retry = f.scheduler.close().then(() => { closed = true })
    await vi.waitFor(() => expect(f.runSource).toHaveBeenCalledOnce())
    expect(closed).toBe(false)
    f.finish()
    await pass
    await retry
    expect(f.runSource).toHaveBeenCalledOnce()
    await f.scheduler.tick()
    expect(f.getTaskSources).toHaveBeenCalledOnce()
  })

  it('closes before a queued pass without reading the database', async () => {
    const f = fixture()
    const pass = f.scheduler.tick()
    await f.scheduler.close()
    await pass
    expect(f.getTaskSources).not.toHaveBeenCalled()
    expect(f.runSource).not.toHaveBeenCalled()
  })

  it('rejects an invalid deadline before changing admission', async () => {
    const f = fixture()
    await expect(f.scheduler.close(3001)).rejects.toBeInstanceOf(RangeError)
    const pass = f.scheduler.tick()
    await vi.waitFor(() => expect(f.runSource).toHaveBeenCalledOnce())
    expect(f.runSource).toHaveBeenCalledOnce()
    f.finish()
    await pass
    await f.scheduler.close()
  })

  it('joins already scheduled source work when a later source lookup throws', async () => {
    const f = fixture()
    const source = f.getTaskSources()[0]
    f.getTaskSources.mockReturnValue([source, { ...source, id: 'second',
      config: { ...source.config, connector_instance_id: 'second-instance' } }])
    f.getSyncState.mockImplementationOnce(() => null).mockImplementationOnce(() => { throw new Error('Fixture store failed') })
    const pass = f.scheduler.tick()
    const result = expect(pass).rejects.toThrow('Fixture store failed')
    await vi.waitFor(() => expect(f.runSource).toHaveBeenCalledOnce())
    let closed = false
    const close = f.scheduler.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    f.finish()
    await result
    await close
    expect(f.runSource).toHaveBeenCalledWith('source')
  })
})

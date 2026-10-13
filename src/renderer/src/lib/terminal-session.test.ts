import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@shared/desktop-api'
import { createTerminalViewSession, closeNativeTerminalPanel } from './terminal-session'
import { installDesktopHost, type DesktopHost } from './desktop-api'
import type { DesktopClientState } from './desktop-client'
import { useCanvasStore } from '@/stores/canvas-store'

const cleanups: Array<() => void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); await Promise.resolve(); vi.useRealTimers() })
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail }), resolve: (value: T) => resolve(value), reject: (reason: unknown) => reject(reason) } }
function fixture(kind: 'electron' | 'tauri' = 'tauri', id = 'panel-1') {
  let connection: DesktopClientState = { status: 'ready', engineEpoch: kind === 'tauri' ? 'engine-1' : null }
  const observers = new Set<() => void>(), data = new Set<(value: { id: string; data: string }) => void>(), exits = new Set<(value: { id: string }) => void>()
  const api = {
    create: vi.fn().mockResolvedValue({ pid: 4242 }), write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), kill: vi.fn().mockResolvedValue(undefined),
    getCwd: vi.fn().mockResolvedValue({ cwd: '/selected/workspace' }), getBuffer: vi.fn().mockResolvedValue({ lines: ['recent line'] }),
    onData: vi.fn((listener: (value: { id: string; data: string }) => void) => { data.add(listener); return () => data.delete(listener) }),
    onExit: vi.fn((listener: (value: { id: string }) => void) => { exits.add(listener); return () => exits.delete(listener) })
  }
  const host: DesktopHost & { hydrationPending: boolean } = {
    kind, api: { terminal: api } as unknown as DesktopApi, get connection() { return connection }, hydrationPending: false,
    supports: () => true, subscribeConnection(listener) { observers.add(listener); return () => { observers.delete(listener) } },
    dispose() { connection = { status: 'disconnected', engineEpoch: connection.engineEpoch }; for (const observer of [...observers]) observer(); observers.clear() }
  }
  const callbacks = { onData: vi.fn(), onExit: vi.fn(), onRecentText: vi.fn(), onReady: vi.fn(), onError: vi.fn(), onCwd: vi.fn() }
  const session = createTerminalViewSession({ host, id, cols: 80, rows: 24, cwd: '/renderer/persisted/path', ...callbacks })
  cleanups.push(() => host.dispose(), () => session.dispose())
  const setConnection = (status: DesktopClientState['status'], epoch = 'engine-1', pending = false) => {
    connection = { status, engineEpoch: epoch }; host.hydrationPending = pending; for (const observer of [...observers]) observer()
  }
  const remount = () => {
    const callbacks = { onData: vi.fn(), onExit: vi.fn(), onRecentText: vi.fn(), onReady: vi.fn(), onError: vi.fn(), onCwd: vi.fn() }
    const session = createTerminalViewSession({ host, id, cols: 80, rows: 24, ...callbacks })
    cleanups.push(() => session.dispose()); return { session, callbacks }
  }
  return { host, api, session, callbacks, remount, setConnection, data: (text: string) => { for (const listener of [...data]) listener({ id, data: text }) }, exit: () => { for (const listener of [...exits]) listener({ id }) } }
}

describe('terminal view ownership and recent-text recovery', () => {
  it('subscribes before spawn and preserves early actual output separately from the recent-text snapshot', async () => {
    const f = fixture()
    f.api.create.mockImplementation(async () => { expect(f.api.onData).toHaveBeenCalledOnce(); expect(f.api.onExit).toHaveBeenCalledOnce(); f.data('early prompt'); return { pid: 4242 } })
    await f.session.start()
    expect(f.callbacks.onData).toHaveBeenCalledExactlyOnceWith('early prompt')
    expect(f.api.create).toHaveBeenCalledWith('panel-1', 80, 24)
    expect(f.callbacks.onRecentText).toHaveBeenCalledExactlyOnceWith(['recent line'])
    expect(f.callbacks.onReady).toHaveBeenLastCalledWith(true, true)
    f.session.write('echo user input\r'); expect(f.api.write).toHaveBeenCalledExactlyOnceWith('panel-1', 'echo user input\r')
  })
  it('preserves a native process on view detach and closes it only from an explicit captured-PID canvas close', async () => {
    vi.useFakeTimers()
    const f = fixture(); cleanups.push(installDesktopHost(f.host)); await f.session.start()
    useCanvasStore.setState({ panels: [{ id: 'panel-1', type: 'terminal', title: 'Terminal', x: 0, y: 0, width: 400, height: 300, zIndex: 1 }], edges: [], isLoaded: false })
    f.session.dispose(); await Promise.resolve()
    expect(f.api.kill).not.toHaveBeenCalled()
    useCanvasStore.getState().removePanel('panel-1')
    await Promise.resolve()
    expect(f.api.kill).toHaveBeenCalledExactlyOnceWith('panel-1', 4242)
    await closeNativeTerminalPanel('panel-1'); expect(f.api.kill).toHaveBeenCalledOnce()
  })
  it('does not grant cleanup authority from a persisted terminal panel or retry a discarded unavailable receipt', async () => {
    const f = fixture(); cleanups.push(installDesktopHost(f.host))
    await closeNativeTerminalPanel('persisted-panel-with-guessed-pid')
    expect(f.api.kill).not.toHaveBeenCalled()
    await f.session.start(); f.setConnection('disconnected')
    await closeNativeTerminalPanel('panel-1'); expect(f.api.kill).not.toHaveBeenCalled()
    f.setConnection('ready', 'engine-2')
    await closeNativeTerminalPanel('panel-1'); expect(f.api.kill).not.toHaveBeenCalled()
    expect(f.api.create).toHaveBeenCalledOnce()
  })
  it('discards a failed explicit close receipt and never retries the kill automatically', async () => {
    const f = fixture(); cleanups.push(installDesktopHost(f.host)); await f.session.start(); f.session.dispose()
    f.api.kill.mockRejectedValueOnce(new Error('Close was not acknowledged'))
    await expect(closeNativeTerminalPanel('panel-1')).rejects.toThrow('Close was not acknowledged')
    await closeNativeTerminalPanel('panel-1')
    expect(f.api.kill).toHaveBeenCalledExactlyOnceWith('panel-1', 4242)
  })
  it('verifies the current same-epoch process before attaching and never replays typed input', async () => {
    const f = fixture(); await f.session.start(); f.session.write('only once\r')
    f.setConnection('disconnected'); f.session.write('must not run\r')
    f.setConnection('ready', 'engine-1', true)
    expect(f.api.create).toHaveBeenCalledOnce()
    f.setConnection('ready')
    await vi.waitFor(() => expect(f.api.getBuffer).toHaveBeenCalledTimes(2))
    expect(f.api.create).toHaveBeenCalledOnce()
    expect(f.api.getCwd).toHaveBeenCalledWith('panel-1', 4242)
    expect(f.api.getBuffer).toHaveBeenCalledTimes(2)
    expect(f.api.write).toHaveBeenCalledExactlyOnceWith('panel-1', 'only once\r')
    expect(f.api.kill).not.toHaveBeenCalled()
  })
  it('treats a null cwd as unavailable evidence and does not respawn automatically', async () => {
    const f = fixture(); await f.session.start(); f.api.getCwd.mockResolvedValue({ cwd: null })
    f.setConnection('disconnected'); f.setConnection('ready')
    await vi.waitFor(() => expect(f.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('could not be verified')))
    expect(f.api.create).toHaveBeenCalledOnce(); f.session.write('must not run\r'); expect(f.api.write).not.toHaveBeenCalled()
  })
  it('reverifies a seen same-epoch ID on a new view and preserves the process on detach', async () => {
    const f = fixture(); await f.session.start(); f.session.dispose()
    await Promise.resolve(); f.api.getCwd.mockClear()
    const next = f.remount(); await next.session.start()
    expect(f.api.getCwd).toHaveBeenCalledExactlyOnceWith('panel-1', 4242)
    expect(f.api.create).toHaveBeenCalledOnce(); expect(f.api.kill).not.toHaveBeenCalled()
    expect(next.callbacks.onRecentText).toHaveBeenCalledWith(['recent line'])
  })
  it('retains seen-ID tombstones across lost epochs and refuses automatic spawn after a view remount', async () => {
    const f = fixture(); await f.session.start(); f.session.dispose()
    f.setConnection('disconnected'); f.setConnection('ready', 'engine-2')
    const next = f.remount(); await next.session.start()
    expect(f.api.create).toHaveBeenCalledOnce()
    expect(next.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('earlier connection'))
    next.session.write('must not execute\r'); expect(f.api.write).not.toHaveBeenCalled()
    f.api.create.mockResolvedValue({ pid: 5252 })
    await next.session.restart()
    expect(f.api.create).toHaveBeenCalledTimes(2); expect(next.callbacks.onReady).toHaveBeenLastCalledWith(true, true)
  })
  it('does not automatically restart a terminal that exited while its view was hidden', async () => {
    const f = fixture(); await f.session.start(); f.session.dispose(); f.exit()
    f.api.getCwd.mockResolvedValue({ cwd: null })
    const next = f.remount(); await next.session.start()
    expect(f.api.create).toHaveBeenCalledOnce()
    expect(next.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('could not be verified'))
    expect(next.callbacks.onExit).not.toHaveBeenCalled()
  })
  it('never respawns when a current process closes between recovery verification and the next read', async () => {
    const f = fixture(); await f.session.start()
    f.api.getCwd.mockImplementationOnce(async () => { f.exit(); return { cwd: '/selected/workspace' } })
    f.setConnection('disconnected'); f.setConnection('ready')
    await vi.waitFor(() => expect(f.callbacks.onExit).toHaveBeenCalledOnce())
    await Promise.resolve(); await Promise.resolve()
    expect(f.api.create).toHaveBeenCalledOnce()
    expect(f.api.write).not.toHaveBeenCalled()
  })
  it('surfaces a failed native resize acknowledgement and ignores failures from retired epochs', async () => {
    const f = fixture(); await f.session.start()
    f.api.resize.mockRejectedValueOnce(new Error('Resize was not confirmed'))
    f.session.resize(100, 40); await Promise.resolve(); await Promise.resolve()
    expect(f.callbacks.onError).toHaveBeenCalledWith('The terminal resize was not confirmed.')
    const old = deferred<void>(); f.api.resize.mockReturnValueOnce(old.promise)
    f.session.resize(120, 50); f.setConnection('disconnected'); f.setConnection('ready', 'engine-2')
    f.callbacks.onError.mockClear(); old.reject(new Error('Retired resize failure')); await Promise.resolve(); await Promise.resolve()
    expect(f.callbacks.onError).not.toHaveBeenCalled()
  })
  it('fences a changed epoch, delayed snapshot and cwd cleanup without automatically creating a new shell', async () => {
    const f = fixture(), history = deferred<{ lines: string[] }>()
    f.api.getBuffer.mockReturnValueOnce(history.promise)
    const start = f.session.start()
    await vi.waitFor(() => expect(f.api.getBuffer).toHaveBeenCalledOnce())
    f.setConnection('disconnected'); f.setConnection('ready', 'engine-2')
    history.resolve({ lines: ['retired history'] }); await start
    expect(f.callbacks.onRecentText).not.toHaveBeenCalled()
    expect(f.api.create).toHaveBeenCalledOnce(); expect(f.callbacks.onReady).not.toHaveBeenCalledWith(true, true)
    expect(f.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('earlier connection'))
    f.session.dispose(); expect(f.api.kill).not.toHaveBeenCalled()
  })
  it('does not restore readiness or a PID receipt if actual exit beats create or history replies', async () => {
    const f = fixture(), create = deferred<{ pid: number }>()
    cleanups.push(installDesktopHost(f.host)); f.api.create.mockReturnValueOnce(create.promise)
    const start = f.session.start(); f.exit(); create.resolve({ pid: 4242 }); await start
    expect(f.callbacks.onExit).toHaveBeenCalledOnce(); expect(f.callbacks.onReady).not.toHaveBeenCalledWith(true, true)
    await closeNativeTerminalPanel('panel-1'); expect(f.api.kill).not.toHaveBeenCalled()
    f.api.create.mockResolvedValue({ pid: 4243 })
    await f.session.restart(); expect(f.api.create).toHaveBeenCalledTimes(2)
    const history = deferred<{ lines: string[] }>(); f.api.getBuffer.mockReturnValueOnce(history.promise)
    const restart = f.session.restart()
    await vi.waitFor(() => expect(f.api.getBuffer).toHaveBeenCalledTimes(2))
    f.exit(); history.resolve({ lines: ['closed terminal'] }); await restart
    f.session.write('no process\r'); expect(f.api.write).not.toHaveBeenCalled()
  })
  it('discards delayed native detach cwd when the service identity changes', async () => {
    const f = fixture(), cwd = deferred<{ cwd: string | null }>(); await f.session.start()
    f.api.getCwd.mockReturnValueOnce(cwd.promise)
    f.session.dispose(); f.setConnection('disconnected'); f.setConnection('ready', 'engine-2')
    cwd.resolve({ cwd: '/old/dir' }); await Promise.resolve(); await Promise.resolve()
    expect(f.callbacks.onCwd).not.toHaveBeenCalled(); expect(f.api.kill).not.toHaveBeenCalled()
  })
  it('preserves Electron cwd capture and exact-PID cleanup, including a create reply after unmount', async () => {
    const f = fixture('electron'), create = deferred<{ pid: number }>()
    f.api.create.mockReturnValueOnce(create.promise)
    const start = f.session.start(); f.session.dispose(); create.resolve({ pid: 111 }); await start
    expect(f.api.create).toHaveBeenCalledWith('panel-1', 80, 24, '/renderer/persisted/path')
    expect(f.api.kill).toHaveBeenCalledExactlyOnceWith('panel-1', 111)
    expect(f.api.getBuffer).not.toHaveBeenCalled(); expect(f.api.getCwd).not.toHaveBeenCalled()
  })
})

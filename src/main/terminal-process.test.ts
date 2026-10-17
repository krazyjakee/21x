import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'child_process'
import { createNodePty, createPythonPty } from './terminal-process'

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn()
}))

describe('native terminal listener lifetime', () => {
  it('keeps subscriptions until actual exit, releases both once and fences late handle operations', () => {
    let data!: (value: string) => void, exit!: (value: { exitCode: number; signal?: number }) => void
    const offData = vi.fn(), offExit = vi.fn(), onData = vi.fn(), onExit = vi.fn()
    const native = {
      pid: 4242, write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(callback => { data = callback; return { dispose: offData } }),
      onExit: vi.fn(callback => { exit = callback; return { dispose: offExit } })
    }
    const terminal = createNodePty({ shellPath: '/fixture-shell', cols: 80, rows: 24, onData, onExit },
      { spawn: vi.fn().mockReturnValue(native) })
    data('before'); terminal.kill()
    expect(offData).not.toHaveBeenCalled(); expect(offExit).not.toHaveBeenCalled(); expect(onExit).not.toHaveBeenCalled()
    data('draining')
    onExit.mockImplementation(() => { expect(offData).toHaveBeenCalledOnce(); expect(offExit).toHaveBeenCalledOnce() })
    exit({ exitCode: 7 }); data('late'); exit({ exitCode: 0 })
    expect(onData.mock.calls).toEqual([['before'], ['draining']])
    expect(onExit).toHaveBeenCalledExactlyOnceWith(4242, 7, undefined)
    expect(offData).toHaveBeenCalledOnce(); expect(offExit).toHaveBeenCalledOnce()
    expect(terminal.write('late input')).toBe(false)
    expect(() => terminal.resize!(90, 30)).toThrow('TERMINAL_PROCESS_EXITED')
    terminal.kill(); expect(native.kill).toHaveBeenCalledOnce()
    expect(native.write).not.toHaveBeenCalled(); expect(native.resize).not.toHaveBeenCalled()
  })

  it('still acknowledges actual close if native subscription disposal throws', () => {
    let exit!: (value: { exitCode: number }) => void
    const onExit = vi.fn(), offExit = vi.fn()
    createNodePty({ shellPath: '/fixture-shell', cols: 80, rows: 24, onData: vi.fn(), onExit }, {
      spawn: vi.fn().mockReturnValue({ pid: 4242,
        onData: () => ({ dispose: () => { throw new Error('already disposed') } }),
        onExit: (callback: typeof exit) => { exit = callback; return { dispose: offExit } }
      })
    })
    exit({ exitCode: 0 })
    expect(offExit).toHaveBeenCalledOnce(); expect(onExit).toHaveBeenCalledOnce()
  })
})

describe('legacy terminal process lifetime', () => {
  afterEach(() => vi.restoreAllMocks())
  it('handles asynchronous spawn/pipe failures and waits for native close after exit', () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn()
    })
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onData = vi.fn(), onExit = vi.fn()
    const terminal = createPythonPty({ shellPath: '/fixture-shell', cols: 80, rows: 24, onData, onExit })
    child.stdout.emit('data', Buffer.from('stdout fixture'))
    child.stderr.emit('data', Buffer.from('stderr fixture'))
    expect(onData).toHaveBeenCalledTimes(2)
    expect(() => child.emit('error', new Error('fixture spawn failure'))).not.toThrow()
    expect(() => child.stdin.emit('error', Object.assign(new Error('fixture pipe gone'), { code: 'EPIPE' }))).not.toThrow()
    child.emit('exit', 1, null)
    expect(onExit).not.toHaveBeenCalled()
    terminal.kill()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    child.emit('close', 1, null)
    expect(onExit).toHaveBeenCalledExactlyOnceWith(4242, 1, null)
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  })
})

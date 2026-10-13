import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'child_process'
import { createPythonPty } from './terminal-process'

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn()
}))

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

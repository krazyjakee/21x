import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { InstallerProcessOwner } from './installer-process.js'
import { nodeWorkerRuntime } from '../node-worker-runtime'

describe('portable CLI installer process ownership', () => {
  const owners: InstallerProcessOwner[] = []
  afterEach(async () => { for (const owner of owners) await owner.close(); owners.length = 0 })
  function owner(spawnClient: typeof spawn = spawn) {
    const value = new InstallerProcessOwner(spawnClient)
    owners.push(value)
    return value
  }
  function fakeChild() {
    const child = new EventEmitter() as ChildProcess
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() }) as unknown as ChildProcess['stdout']
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() }) as unknown as ChildProcess['stderr']
    child.kill = vi.fn(() => true)
    return child
  }

  it('runs an actual owning-runtime fixture, streams output and joins its close', async () => {
    const runtime = nodeWorkerRuntime()
    const env = { PATH: process.env.PATH, ...(runtime.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: runtime.env.ELECTRON_RUN_AS_NODE } : {}) }
    const progress = vi.fn()
    const result = await owner().run(runtime.execPath, ['-e', "process.stdout.write('fixture-out');process.stderr.write('fixture-err')"], progress, 50, { env })
    expect(result).toEqual({ error: null, code: 0, stdout: 'fixture-out', stderr: 'fixture-err' })
    expect(progress).toHaveBeenCalledWith({ stage: 'installing', output: 'fixture-out', percent: 50 })
    expect(progress).toHaveBeenCalledWith({ stage: 'installing', output: 'fixture-err', percent: 50 })
  })

  it('retains an asynchronous spawn error until actual close and preserves that error', async () => {
    const child = fakeChild()
    const value = owner(vi.fn(() => child) as unknown as typeof spawn)
    let settled = false
    const result = value.run('fixture', [], () => {}, 50).then(reply => { settled = true; return reply })
    child.emit('error', new Error('fixture private dependency path'))
    try {
      await Promise.resolve()
      expect(settled).toBe(false)
      await expect(value.close(5)).rejects.toThrow('INSTALLER_PROCESS_SHUTDOWN_INCOMPLETE')
      const retry = value.close()
      child.emit('close', -2)
      expect(await result).toMatchObject({ code: -2, error: new Error('INSTALLER_PROCESS_FAILED') })
      await retry
    } finally { child.emit('close', -2); await result }
  })

  it('joins cancellation of its actual child while an unrelated fixture process remains alive', async () => {
    const runtime = nodeWorkerRuntime()
    const env = { PATH: process.env.PATH, ...(runtime.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: runtime.env.ELECTRON_RUN_AS_NODE } : {}) }
    const args = ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"]
    const unrelated = spawn(runtime.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const unrelatedClosed = once(unrelated, 'close')
    let child!: ChildProcess
    const launch = (command: string, commandArgs: string[], options: SpawnOptions) => {
      child = spawn(command, commandArgs, options)
      return child
    }
    const value = owner(launch as typeof spawn)
    let started!: () => void
    const ready = new Promise<void>(done => { started = done })
    const result = value.run(runtime.execPath, args, () => started(), 50, { env })
    try {
      await Promise.all([ready, once(unrelated.stdout!, 'data')])
      await value.close()
      expect((await result).error).toEqual(new Error('INSTALLER_PROCESS_CANCELLED'))
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      expect(unrelated.kill(0)).toBe(true)
      expect(unrelated.exitCode).toBeNull()
      expect(unrelated.signalCode).toBeNull()
    } finally {
      unrelated.kill()
      await unrelatedClosed
      await value.close()
    }
  })

  it('retains bounded captured tails while forwarding live output and stops late progress', async () => {
    const child = fakeChild()
    const progress = vi.fn()
    const value = owner(vi.fn(() => child) as unknown as typeof spawn)
    const result = value.run('fixture', [], progress, 50)
    child.stdout!.emit('data', 'x'.repeat(300 * 1024))
    child.stderr!.emit('data', 'y'.repeat(300 * 1024))
    expect(progress).toHaveBeenCalledTimes(2)
    value.stop()
    child.stdout!.emit('data', 'tail')
    expect(progress).toHaveBeenCalledTimes(2)
    child.emit('close', 0)
    const reply = await result
    expect(reply.stdout.length).toBe(256 * 1024)
    expect(reply.stdout.endsWith('tail')).toBe(true)
    expect(reply.stderr.length).toBe(256 * 1024)
    expect(reply.error).toEqual(new Error('INSTALLER_PROCESS_CANCELLED'))
  })

  it('owns progress callback failures through child close and does not let them escape the event emitter', async () => {
    const child = fakeChild()
    const value = owner(vi.fn(() => child) as unknown as typeof spawn)
    const result = value.run('fixture', [], () => { throw new Error('fixture-private-value') }, 50)
    expect(() => child.stdout!.emit('data', 'fixture')).not.toThrow()
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('close', 1)
    expect((await result).error).toEqual(new Error('INSTALLER_PROGRESS_FAILED'))
  })

  it('closes admission without spawning another child and validates deadlines before stopping', async () => {
    const launch = vi.fn(() => fakeChild()) as unknown as typeof spawn
    const value = owner(launch)
    await expect(value.close(0)).rejects.toBeInstanceOf(RangeError)
    await value.close()
    expect((await value.run('fixture', [], () => {}, 50)).error).toEqual(new Error('INSTALLER_PROCESS_CLOSED'))
    expect(launch).not.toHaveBeenCalled()
  })

  it('normalizes synchronous spawn failure without allocating a live owner', async () => {
    const value = owner(vi.fn(() => { throw new Error('fixture-private-path') }) as unknown as typeof spawn)
    expect(await value.run('fixture', [], () => {}, 50)).toEqual({ error: new Error('INSTALLER_PROCESS_FAILED'), code: null, stdout: '', stderr: '' })
    await value.close()
  })
})

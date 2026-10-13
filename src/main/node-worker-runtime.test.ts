import { describe, expect, it } from 'vitest'
import { nodeWorkerRuntime } from './node-worker-runtime'
import { fork } from 'node:child_process'
import { join } from 'node:path'

describe('nodeWorkerRuntime', () => {
  it('uses standalone Node on macOS and removes an inherited Electron mode', () => {
    const environment = { PATH: '/usr/local/bin', ELECTRON_RUN_AS_NODE: '1' }
    expect(nodeWorkerRuntime('darwin', '/Applications/20x.app/Contents/MacOS/20x', environment, 'electron'))
      .toEqual({ execPath: 'node', env: { PATH: '/usr/local/bin' } })
    expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it.each(['linux', 'win32'] as const)('keeps the existing worker runtime on %s', (platform) => {
    expect(nodeWorkerRuntime(platform, '/electron', { PATH: '/bin' }, 'electron')).toEqual({
      execPath: '/electron', env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it.each(['darwin', 'linux', 'win32'] as const)('uses the exact bundled standalone executable on %s', platform => {
    const executable = platform === 'win32' ? 'C:\\bundled\\node.exe' : '/bundled/node'
    const environment = { PATH: '/fixture-no-system-node', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1' }
    expect(nodeWorkerRuntime(platform, executable, environment, 'standalone')).toEqual({
      execPath: executable, env: { PATH: '/fixture-no-system-node' }
    })
    expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(environment.electron_run_as_node).toBe('1')
  })

  it.each(['darwin', 'linux', 'win32'] as const)('rejects a PATH-based standalone executable on %s', platform => {
    expect(() => nodeWorkerRuntime(platform, 'node', {}, 'standalone')).toThrow('absolute owning Node executable')
  })

  it.skipIf(Boolean(process.versions.electron))('forks and joins a real worker with system Node hidden and Electron mode removed', async () => {
    const runtime = nodeWorkerRuntime(process.platform, process.execPath, {
      ...process.env, PATH: '', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1'
    })
    const child = fork(join(__dirname, '../../test/fixtures/node-worker-runtime.mjs'), [], {
      execPath: runtime.execPath, execArgv: [], env: runtime.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json'
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const observed = await new Promise<{ message: unknown; exit: number | null }>((resolve, reject) => {
        let message: unknown
        timer = setTimeout(() => reject(new Error('Owned worker deadline exceeded')), 10_000)
        child.once('error', reject)
        child.once('message', value => { message = value })
        child.once('close', code => resolve({ message, exit: code }))
        child.send({ ping: true }, error => { if (error) reject(error) })
      })
      expect(observed).toEqual({ exit: 0, message: {
        nodeVersion: process.version, executable: process.execPath, electron: false,
        electronMode: false, systemNodeHidden: true, pong: true
      } })
      expect(child.connected).toBe(false)
    } finally {
      if (timer) clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('Owned worker did not close after kill')), 3000)
          child.once('close', () => { clearTimeout(deadline); resolve() })
          child.kill('SIGKILL')
        })
      }
    }
  }, 15_000)
})

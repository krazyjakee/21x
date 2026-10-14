import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdirSync, writeFileSync } from 'fs'
import { mkdtemp, mkdir, writeFile, rm, stat, symlink, readFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawn: spawnMock }))

const {
  VOICE_RUNTIME_PACKAGE,
  detectVoiceRuntime,
  installVoiceRuntime,
  isNpmAvailable,
  removeVoiceRuntime,
  runtimeModulePath,
  unsupportedHardwareReason,
  VoiceRuntimeOwner,
} = await import('./voice-runtime-installer')

/**
 * A stand-in for a spawned process. It must be created inside a mock
 * *implementation*, not passed to `mockReturnValueOnce`, so the events fire
 * after the caller has attached its listeners.
 */
function fakeProcess(options: { exitCode?: number; stdout?: string; failToStart?: boolean }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => void
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  setTimeout(() => {
    if (options.failToStart) {
      child.emit('error', new Error('spawn npm ENOENT'))
      child.emit('close', null)
      return
    }
    if (options.stdout) child.stdout.emit('data', Buffer.from(options.stdout))
    child.emit('exit', options.exitCode ?? 0)
    child.emit('close', options.exitCode ?? 0)
  }, 0)
  return child
}

let root: string

beforeEach(async () => {
  spawnMock.mockReset()
  root = await realpath(await mkdtemp(join(tmpdir(), 'voice-runtime-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeInstalledRuntime(version: string): Promise<void> {
  const modulePath = runtimeModulePath(root)
  await mkdir(modulePath, { recursive: true })
  await writeFile(
    join(modulePath, 'package.json'),
    JSON.stringify({ name: VOICE_RUNTIME_PACKAGE, version }),
    'utf8'
  )
}

describe('detectVoiceRuntime', () => {
  it('reports a missing runtime instead of throwing', async () => {
    expect(await detectVoiceRuntime(root)).toMatchObject({
      installed: false,
      version: null,
      modulePath: null,
    })
  })

  it('reports the installed version and the path the worker loads', async () => {
    await writeInstalledRuntime('1.12.0')
    const status = await detectVoiceRuntime(root)
    expect(status.installed).toBe(true)
    expect(status.version).toBe('1.12.0')
    expect(status.modulePath).toBe(runtimeModulePath(root))
  })

  it('treats a damaged manifest as not installed', async () => {
    const modulePath = runtimeModulePath(root)
    await mkdir(modulePath, { recursive: true })
    await writeFile(join(modulePath, 'package.json'), 'not json at all', 'utf8')
    expect((await detectVoiceRuntime(root)).installed).toBe(false)
  })
})

describe('isNpmAvailable', () => {
  it('is false when npm cannot start', async () => {
    spawnMock.mockImplementation(() => fakeProcess({ failToStart: true }))
    expect(await isNpmAvailable()).toBe(false)
  })

  it('is true when npm answers', async () => {
    spawnMock.mockImplementation(() => fakeProcess({ exitCode: 0 }))
    expect(await isNpmAvailable()).toBe(true)
  })
})

describe('installVoiceRuntime', () => {
  it('explains that npm is needed and downloads nothing', async () => {
    spawnMock.mockImplementation(() => fakeProcess({ failToStart: true }))
    const progress = vi.fn()

    await expect(installVoiceRuntime(root, progress)).rejects.toThrow(/npm was not found/i)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'error' }))
    // Only the version probe ran.
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('reports a failed install instead of claiming success', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProcess({ exitCode: 0 })) // npm --version
      .mockImplementationOnce(() => fakeProcess({ exitCode: 1, stdout: 'npm error\n' })) // npm install
    const progress = vi.fn()

    await expect(installVoiceRuntime(root, progress)).rejects.toThrow('VOICE_RUNTIME_INSTALL_FAILED')
    expect((await detectVoiceRuntime(root)).installed).toBe(false)
  })

  it('installs into the application data directory and reports the version', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProcess({ exitCode: 0 }))
      .mockImplementationOnce(() => {
        // Stand in for what npm writes. It must land before the process exits,
        // so this is written synchronously.
        const modulePath = runtimeModulePath(root)
        mkdirSync(modulePath, { recursive: true })
        writeFileSync(
          join(modulePath, 'package.json'),
          JSON.stringify({ name: VOICE_RUNTIME_PACKAGE, version: '1.12.0' })
        )
        return fakeProcess({ exitCode: 0, stdout: 'added 1 package\n' })
      })
    const progress = vi.fn()

    const status = await installVoiceRuntime(root, progress)
    expect(status).toMatchObject({ installed: true, version: '1.12.0' })
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'complete', percent: 100 }))

    // npm runs inside the runtime directory, never inside the app bundle.
    const [, , options] = spawnMock.mock.calls[1]
    expect(options).toMatchObject({ cwd: root })
    // A private manifest keeps npm from walking up into the app directory.
    await expect(stat(join(root, 'package.json'))).resolves.toBeTruthy()
  })
})

describe('portable runtime ownership', () => {
  it('refuses the unpinned installer before npm or filesystem effects', async () => {
    const owner = new VoiceRuntimeOwner({ rootDir: join(root, 'absent'), installation: 'unavailable' })
    const progress = vi.fn()
    await expect(owner.install(progress)).rejects.toThrow('VOICE_RUNTIME_INSTALL_UNAVAILABLE')
    expect(spawnMock).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled()
    await expect(stat(join(root, 'absent'))).rejects.toThrow()
    await owner.close()
  })
  it('reads a bounded genuine package manifest without any subprocess', async () => {
    await writeInstalledRuntime('1.12.0')
    const owner = new VoiceRuntimeOwner({ rootDir: root, installation: 'unavailable' })
    expect(await owner.detect()).toMatchObject({ installed: true, version: '1.12.0' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(() => owner.assertRoot(join(root, 'foreign'))).toThrow('OWNER_MISMATCH')
    await owner.close(); await expect(owner.detect()).rejects.toThrow('CLOSED')
  })
  it('preserves installed and unrelated files when no trusted removal inventory exists', async () => {
    await writeInstalledRuntime('1.12.0'); await writeFile(join(root, 'notes.txt'), 'user notes')
    const owner = new VoiceRuntimeOwner({ rootDir: root, installation: 'unavailable' })
    await expect(owner.remove()).rejects.toThrow('REMOVAL_INVENTORY_UNAVAILABLE')
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('user notes')
    expect((await owner.detect()).installed).toBe(true)
    await owner.close()
  })
  it('refuses linked parents and oversized manifests before decoding them', async () => {
    const external = join(root, 'external'); await mkdir(external)
    const owned = join(root, 'owned'); await mkdir(owned); await symlink(external, join(owned, 'node_modules'), 'dir')
    const owner = new VoiceRuntimeOwner({ rootDir: owned, installation: 'unavailable' })
    await expect(owner.detect()).rejects.toThrow('PATH_UNSAFE'); await owner.close()
    await writeInstalledRuntime('1.12.0'); await writeFile(join(runtimeModulePath(root), 'package.json'), 'x'.repeat(16385))
    const bounded = new VoiceRuntimeOwner({ rootDir: root, installation: 'unavailable' })
    await expect(bounded.detect()).rejects.toThrow('MANIFEST_INVALID'); await bounded.close()
  })
  it('retains a failed spawn until its actual close receipt', async () => {
    const child = new EventEmitter() as ReturnType<typeof fakeProcess>
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn()
    spawnMock.mockReturnValue(child)
    const owner = new VoiceRuntimeOwner({ rootDir: root, installation: 'electron-compatibility' })
    const install = owner.install(() => {}).catch(error => error)
    child.emit('error', new Error('secret path must not be projected'))
    await expect(owner.close(10)).rejects.toThrow('DRAIN_INCOMPLETE')
    expect(owner.inflightCount).toBe(1)
    child.emit('close', null)
    expect((await install).message).toMatch(/npm was not found/)
    await owner.close(); expect(owner.inflightCount).toBe(0)
  })
})

describe('removeVoiceRuntime', () => {
  it('gives the disk space back', async () => {
    await writeInstalledRuntime('1.12.0')
    await removeVoiceRuntime(root)
    expect((await detectVoiceRuntime(root)).installed).toBe(false)
    await expect(stat(root)).rejects.toThrow()
  })
})

/**
 * The runtime ships prebuilt binaries for five targets. Anywhere else, npm
 * would fail deep inside a build step with nothing the user can act on, so
 * the answer comes first and in plain words.
 */
describe('unsupportedHardwareReason', () => {
  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
  ] as const)('accepts %s-%s', (platform, arch) => {
    expect(unsupportedHardwareReason(platform, arch)).toBeNull()
  })

  it.each([
    ['win32', 'arm64', /Windows on arm64/],
    ['win32', 'ia32', /Windows on ia32/],
    ['linux', 'riscv64', /Linux on riscv64/],
    ['freebsd', 'x64', /freebsd on x64/],
  ] as const)('refuses %s-%s and names the supported targets', (platform, arch, expected) => {
    const reason = unsupportedHardwareReason(platform, arch)
    expect(reason).toMatch(expected)
    expect(reason).toMatch(/macOS.*Windows x64.*Linux/)
  })
})

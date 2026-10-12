import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

it('flushes private success metadata before graceful Electron quit without an immediate exit', async () => {
  const source = await readFile(new URL('./electron.cjs', import.meta.url), 'utf8')
  const control = new PassThrough()
  let receipt: ((error?: Error) => void) | undefined
  const app = {
    setName: vi.fn(), setPath: vi.fn(), whenReady: vi.fn(async () => undefined),
    quit: vi.fn(), exit: vi.fn()
  }
  const processFixture = {
    platform: 'linux', stdin: control, on: vi.fn(),
    stdout: { write: vi.fn((_frame: string, callback: (error?: Error) => void) => { receipt = callback; return true }) }
  }
  runInNewContext('(function () {\n' + source + '\n})()', {
    require: (name: string) => {
      if (name === 'electron') return { app, safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' } }
      if (name === 'node:fs') return { fstatSync: () => ({ isFIFO: () => true }) }
      return require(name)
    },
    process: processFixture, __dirname: '/isolated-lifecycle-fixture', Buffer,
    setTimeout: () => ({ unref() {} }), clearTimeout: vi.fn()
  })
  // This empty verification fixture tests completion ordering only. Real OS
  // proof acceptance still requires all six production-format canaries.
  control.end(JSON.stringify({ token: 'a'.repeat(64), operation: 'verify-originals', records: [], legacyBackend: 'gnome-libsecret' }) + '\n')
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(receipt).toBeTypeOf('function')
  expect(app.quit).not.toHaveBeenCalled()
  expect(app.exit).not.toHaveBeenCalled()
  receipt!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(app.quit).toHaveBeenCalledOnce()
  expect(app.exit).not.toHaveBeenCalled()
})

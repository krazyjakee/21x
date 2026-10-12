import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- executable .mjs scanner has no declaration file
import { createInventory, runCli, scanRepository, scanSource, serializeInventory, SOURCE_ROOTS } from './tauri-inventory.mjs'

describe('Tauri source inventory AST scanner', () => {
  it('distinguishes runtime, mixed, side-effect, and type-only Electron imports', () => {
    const result = scanSource('src/main/imports.ts', `
      // import { ipcMain } from 'electron'; ipcMain.handle('comment', () => {})
      const text = "ipcMain.on('string', fn)"
      import type { WebContents } from 'electron'
      import { type BrowserWindow, ipcMain as main } from 'electron'
      import { type IpcRenderer } from 'electron'
      import 'electron'
      export type { Session } from 'electron'
      main.handle('real', () => {})
    `)
    expect(result.electronImports.map((item: { mode: string }) => item.mode))
      .toEqual(['type-only', 'mixed', 'type-only', 'runtime', 'type-only'])
    expect(result.electronImports[1].bindings).toEqual([
      { imported: 'BrowserWindow', local: 'BrowserWindow', typeOnly: true },
      { imported: 'ipcMain', local: 'main', typeOnly: false }
    ])
    expect(result.operations).toHaveLength(1)
    expect(result.operations[0]).toMatchObject({ target: 'ipcMain', method: 'handle', channel: 'real', resolution: 'literal' })
  })

  it('follows namespace, named, local, and destructured aliases without reading comments', () => {
    const result = scanSource('src/preload/aliases.ts', `
      import * as electron from 'electron'
      import { ipcRenderer as renderer } from 'electron'
      import { guardedIpcSend as guarded } from './guarded-ipc-send'
      import type { WebContents as Contents } from 'electron'
      const main = electron.ipcMain
      const { invoke: request } = renderer
      const post = guarded
      main.on('main-event', callback)
      request('request', {})
      renderer.send('send', data)
      renderer.on('event', callback)
      post(win.webContents, 'outbound', data)
      const wc = win.webContents
      wc.send('raw', data)
      function raw(target: Pick<Contents, 'send'> | null) { target?.send('typed', data) }
    `)
    expect(result.operations.map((item: { target: string; method: string; channel: string }) => [item.target, item.method, item.channel])).toEqual([
      ['ipcMain', 'on', 'main-event'], ['ipcRenderer', 'invoke', 'request'],
      ['ipcRenderer', 'send', 'send'], ['ipcRenderer', 'on', 'event'],
      ['guardedIpcSend', 'send', 'outbound'], ['webContents', 'send', 'raw'], ['webContents', 'send', 'typed']
    ])
  })

  it('records computed channels and methods as unresolved without guessing constant values', () => {
    const result = scanSource('src/main/computed.ts', `
      import { ipcMain, ipcRenderer } from 'electron'
      const CHANNEL = 'constant-value'
      ipcMain.handle(CHANNEL, callback)
      ipcRenderer.invoke(\`dynamic:\${id}\`, {})
      ipcRenderer[operation]('literal-channel', {})
      ipcRenderer['send'](\`static-template\`, {})
    `)
    expect(result.operations[0]).toMatchObject({ method: 'handle', channel: null, channelExpression: 'CHANNEL', resolution: 'unresolved' })
    expect(result.operations[1]).toMatchObject({ channel: null, channelExpression: '`dynamic:${id}`', resolution: 'unresolved' })
    expect(result.operations[2]).toMatchObject({ method: null, methodExpression: 'ipcRenderer[operation]', channel: 'literal-channel', resolution: 'unresolved' })
    expect(result.operations[3]).toMatchObject({ method: 'send', channel: 'static-template', resolution: 'literal' })
  })

  it('does not treat shadowed, type-only, or reassigned bindings as imported IPC', () => {
    const result = scanSource('src/main/shadow.ts', `
      import { ipcMain as main } from 'electron'
      import type { ipcRenderer as renderer } from 'electron'
      function local(main: { handle: Function }) { main.handle('shadow', callback) }
      { const main = other; main.on('block-shadow', callback) }
      renderer.invoke('type-only', {})
      let alias = main
      alias = other
      alias.on('reassigned', callback)
      main.handle('actual', callback)
    `)
    expect(result.operations.map((item: { channel: string }) => item.channel)).toEqual(['actual'])
  })

  it('captures require, import-equals, and dynamic Electron imports', () => {
    const result = scanSource('src/main/require.ts', `
      import host = require('electron')
      const { ipcMain: main } = require('electron')
      main.handle('commonjs', callback)
      host.ipcRenderer.send('equals', {})
      await import('electron')
    `)
    expect(result.electronImports.map((item: { syntax: string }) => item.syntax)).toEqual(['import-equals', 'require', 'dynamic-import'])
    expect(result.operations.map((item: { channel: string }) => item.channel)).toEqual(['commonjs', 'equals'])
  })

  it('deduplicates maximal direct API accesses and records JSX webviews only', () => {
    const result = scanSource('src/renderer/src/view.tsx', `
      // <webview />; window.electronAPI.fake()
      type Bridge = typeof window.electronAPI
      window.electronAPI.db.getTasks()
      (window.electronAPI).tasks.start('task')
      window['electronAPI'][section]['read']()
      const root = window.electronAPI
      const view = <><webview src="https://example.test" /><webview></webview><div /></>
    `)
    expect(result.electronAPIConsumers.map((item: { path: (string | null)[] }) => item.path)).toEqual([
      ['db', 'getTasks'], ['tasks', 'start'], [null, 'read'], []
    ])
    expect(result.electronAPIConsumers[2]).toMatchObject({ kind: 'call', resolution: 'unresolved' })
    expect(result.webviews).toHaveLength(2)
  })

  it('produces identical bytes for reordered source inputs and package keys', () => {
    const sources = [
      { file: 'src/main/z.ts', source: `import { ipcMain } from 'electron'; ipcMain.handle('z', fn)` },
      { file: 'src/main/database/schema.ts', source: `const SCHEMA_VERSION = 32` },
      { file: 'src/main/a.ts', source: `import type { WebContents } from 'electron'` }
    ]
    const first = createInventory({ sources, packageJson: { name: '21x', dependencies: { 'node-pty': '^1', 'better-sqlite3': '^13' }, build: { directories: { output: 'dist', buildResources: 'resources' } } } })
    const second = createInventory({ sources: [sources[2], sources[0], sources[1], sources[0]], packageJson: { build: { directories: { buildResources: 'resources', output: 'dist' } }, dependencies: { 'better-sqlite3': '^13', 'node-pty': '^1' }, name: '21x' } })
    expect(serializeInventory(first)).toBe(serializeInventory(second))
    expect(first.database.schemaVersion).toBe(32)
    expect(first.nativeDependencies.map((item: { name: string }) => item.name)).toEqual(['better-sqlite3', 'node-pty'])
    expect(first.summary).toMatchObject({ files: 3, runtimeElectronImports: 1, typeOnlyElectronImports: 1, operations: 1 })
    expect(serializeInventory(first)).not.toMatch(/timestamp|generatedAt/)
  })
})

describe('inventory repository traversal and freshness checks', () => {
  const temporary: string[] = []
  afterEach(() => {
    for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('skips tests, generated directories, declarations, and symlinks; check detects stale output', () => {
    const root = mkdtempSync(join(tmpdir(), '21x-tauri-inventory-'))
    temporary.push(root)
    for (const sourceRoot of SOURCE_ROOTS) mkdirSync(join(root, sourceRoot), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    const source = join(root, 'src/main/index.ts')
    writeFileSync(source, `import { ipcMain } from 'electron'; ipcMain.handle('initial', fn)`)
    writeFileSync(join(root, 'src/main/index.test.ts'), `import 'electron'`)
    writeFileSync(join(root, 'src/main/types.d.ts'), `import 'electron'`)
    mkdirSync(join(root, 'src/main/generated'))
    writeFileSync(join(root, 'src/main/generated/code.ts'), `import 'electron'`)
    if (process.platform !== 'win32') symlinkSync(source, join(root, 'src/main/linked.ts'))
    expect(scanRepository(root).files).toEqual(['src/main/index.ts'])

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(runCli([], root)).toBe(0)
    const output = join(root, 'docs/tauri-migration/inventory.json')
    const initial = readFileSync(output, 'utf8')
    expect(runCli(['--check'], root)).toBe(0)
    writeFileSync(source, `import { ipcMain } from 'electron'; ipcMain.handle('changed', fn)`)
    expect(runCli(['--check'], root)).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('stale'))
    expect(readFileSync(output, 'utf8')).toBe(initial)
    expect(runCli(['--stdout'], root)).toBe(0)
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('runtimeElectronImports'))
    expect(readFileSync(output, 'utf8')).toBe(initial)
  })
})

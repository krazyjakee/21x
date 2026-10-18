import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { reviewTestInventory, scanTestInventory } from './host-neutral-test-policy.mjs'
import { hostNeutralEnvironment } from './host-neutral-runtime.mjs'

const roots: string[] = []
function fixture(files: Record<string, string>, historical: { file: string; reason: string }[] = []) {
  const root = mkdtempSync(join(tmpdir(), '21x-test-cohort-')); roots.push(root)
  for (const [file, source] of Object.entries({ ...files, 'test/electron-transition-tests.json': JSON.stringify({ version: 1, historical, importDenialControls: [] }) })) {
    mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source)
  }
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('reviewed standalone test boundary', () => {
  it('traces actual value dependencies through aliases, reexports, JS-to-TS imports and cycles', () => {
    const root = fixture({
      'src/main/example.test.ts': "import '@shared/a.js'",
      'src/shared/a.ts': "export * from './b'",
      'src/shared/b.ts': "import './a'; export { app } from 'electron'"
    })
    expect(scanTestInventory(root)[0].electronTrace).toEqual(['src/main/example.test.ts', 'src/shared/a.ts', 'src/shared/b.ts', 'electron'])
    expect(() => reviewTestInventory(root)).toThrow('Unreviewed Electron test dependency')
  })

  it('ignores erased type imports but catches literal require, dynamic import and importActual', () => {
    const root = fixture({
      'src/shared/types.test.ts': "import type { App } from 'electron'; import { type WebContents } from 'electron'; export type { BrowserWindow } from 'electron'; const documentation = \"import('electron')\"",
      'src/main/require.test.ts': "require('electron')",
      'src/main/dynamic.test.ts': "void import('electron-updater')",
      'src/main/actual.test.ts': "vi.importActual('@electron/fuses')"
    })
    const rows = scanTestInventory(root)
    expect(rows.find(row => row.file.endsWith('types.test.ts'))?.electronTrace).toBeUndefined()
    expect(rows.filter(row => row.electronTrace).map(row => row.electronTrace?.at(-1)).sort()).toEqual(['@electron/fuses', 'electron', 'electron-updater'])
  })

  it('requires explicit historical reasons and refuses duplicate, stale and obsolete exclusions', () => {
    const row = { file: 'src/main/legacy.test.ts', reason: 'Exercises the retained Electron host adapter' }
    const root = fixture({ [row.file]: "import 'electron'" }, [row])
    expect(reviewTestInventory(root)[0]).toMatchObject({ cohort: 'historical-electron', reason: row.reason })
    const policy = join(root, 'test/electron-transition-tests.json')
    writeFileSync(policy, JSON.stringify({ version: 1, historical: [row, row], importDenialControls: [] }))
    expect(() => reviewTestInventory(root)).toThrow('Duplicate')
    writeFileSync(policy, JSON.stringify({ version: 1, historical: [{ ...row, file: 'src/main/gone.test.ts' }], importDenialControls: [] }))
    expect(() => reviewTestInventory(root)).toThrow('Stale')
    writeFileSync(policy, JSON.stringify({ version: 1, historical: [row], importDenialControls: [] }))
    writeFileSync(join(root, row.file), 'export const portable = true')
    expect(() => reviewTestInventory(root)).toThrow('obsolete Electron test quarantine')
  })

  it('reviews empty value imports/exports and TypeScript/CommonJS literal forms conservatively', () => {
    const root = fixture({
      'src/main/import.test.ts': "import {} from 'electron'",
      'src/main/export.test.ts': "export {} from 'electron'",
      'src/main/equals.test.ts': "import native = require('electron')",
      'src/main/template.test.ts': 'void import(`electron`)',
      'src/main/module.test.ts': "module.require('electron')"
    })
    expect(scanTestInventory(root).every(row => row.electronTrace?.at(-1) === 'electron')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('refuses a linked source tree instead of following an unreviewed graph', () => {
    const root = fixture({ 'src/main/a.test.ts': 'export {}' })
    symlinkSync(join(root, 'src/main'), join(root, 'src/linked'), 'dir')
    expect(() => reviewTestInventory(root)).toThrow('physical source paths')
  })

  it('clears inherited Electron and Node injection variables without discarding ordinary test configuration', () => {
    expect(hostNeutralEnvironment({ PATH: '/fixture', HOME: '/synthetic', ELECTRON_RUN_AS_NODE: '1', Node_Options: '--require=foreign', NODE_PATH: '/foreign', TAURI_SQLITE_MODULE: '/foreign', TAURI_NODE_PTY_MODULE: '/foreign', TAURI_PRODUCTION_TASK_MCP_ENTRY: '/foreign', tauri_standalone_service_proofs: '1', TAURI_HOST_NEUTRAL_RUNNER: 'foreign' })).toEqual({ PATH: '/fixture', HOME: '/synthetic' })
  })

  it('keeps all pre-existing public test commands unchanged', () => {
    const scripts = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts
    expect(scripts['test:run']).toBe('cross-env ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run')
    expect(scripts['test:tauri']).toBe('node scripts/tauri-test.mjs')
    expect(scripts['test:main']).toBe('cross-env ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs --project main')
    expect(scripts['test:renderer']).toBe('cross-env ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs --project renderer')
  })
})

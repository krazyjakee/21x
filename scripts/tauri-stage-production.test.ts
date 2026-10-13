import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectProductionClosure, stageProductionService, validateProductionPins } from './tauri-stage-production.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const pins = { nodeVersion: '22.23.2', nativeDependencies: { 'better-sqlite3': '13.0.3', 'node-pty': '1.1.0' },
  serviceDependencies: { '@paralleldrive/cuid2': '2.3.1' },
  sdkDependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.260', '@anthropic-ai/sdk': '0.123.0', '@opencode-ai/sdk': '1.18.28' } }
function root() { const value = mkdtempSync(join(tmpdir(), '21x-production-stage-')); roots.push(value); return value }

describe('explicit production resource staging', () => {
  it('requires the frozen standalone Node/SQLite/SDK pins instead of adopting repository runtime modules', () => {
    expect(validateProductionPins(pins)).toMatchObject({ 'better-sqlite3': '13.0.3', '@opencode-ai/sdk': '1.18.28' })
    expect(() => validateProductionPins({ ...pins, nodeVersion: '22.0.0' })).toThrow('explicit review')
    expect(() => validateProductionPins({ ...pins, sdkDependencies: { ...pins.sdkDependencies, '@opencode-ai/sdk': 'latest' } })).toThrow('explicit review')
    expect(() => validateProductionPins({ ...pins, serviceDependencies: { ...pins.serviceDependencies, electron: '42.0.0' } })).toThrow('explicit review')
  })
  it('enumerates actual transitive package files and rejects linked package adoption', async () => {
    const resources = root(), modules = join(resources, 'service/node_modules')
    mkdirSync(join(modules, 'package-a/dependency'), { recursive: true }); writeFileSync(join(modules, 'package-a/package.json'), '{}')
    writeFileSync(join(modules, 'package-a/dependency/runtime.js'), 'real-file')
    expect(await collectProductionClosure(resources)).toEqual(['service/node_modules/package-a/dependency/runtime.js', 'service/node_modules/package-a/package.json'])
    symlinkSync(join(modules, 'package-a'), join(modules, 'linked-package'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(collectProductionClosure(resources)).rejects.toThrow('package links')
  })
  it('fails before bundling or writing artifacts when the real native key-store helper is absent', async () => {
    const repository = root(); mkdirSync(join(repository, 'scripts')); writeFileSync(join(repository, 'scripts/tauri-runtime.json'), JSON.stringify(pins))
    mkdirSync(join(repository, 'src-tauri/resources/node'), { recursive: true }); mkdirSync(join(repository, 'src-tauri/resources/service'))
    writeFileSync(join(repository, 'src-tauri/resources/node', process.platform === 'win32' ? 'node.exe' : 'node'), 'controlled-node-boundary')
    await expect(stageProductionService(repository)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

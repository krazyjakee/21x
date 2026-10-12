import { describe, expect, it } from 'vitest'
// @ts-expect-error -- parse-only .mjs generator has no declaration file
import { buildOperationManifest, generateDesktopApi, generateOperationTypes } from './tauri-contracts.mjs'
// @ts-expect-error -- parse-only .mjs scanner has no declaration file
import { createInventory } from './tauri-inventory.mjs'

describe('desktop contract generation', () => {
  it('preserves declared optional arguments/results while dropping the global and removed browser API', () => {
    const output = generateDesktopApi(`import type { BrowserRecordingManifest } from '@shared/browser-recording';
      import type { Task } from './index';
      interface ElectronAPI {
        db: { getTask: (id: string, optional?: number) => Promise<Task | undefined> };
        browser: { record: () => Promise<BrowserRecordingManifest> };
      }
      declare global { interface Window { electronAPI: ElectronAPI } }
    `)
    expect(output).toContain('export interface DesktopApi')
    expect(output).toContain('optional?: number')
    expect(output).toContain('Promise<Task | undefined>')
    expect(output).toContain('../renderer/src/types/index')
    expect(output).not.toMatch(/browser:|BrowserRecordingManifest|declare global|electronAPI:/)
  })

  it('captures the public API path and actual preload transformation rather than inventing wire arguments', () => {
    const preload = `import { ipcRenderer, contextBridge } from 'electron';
      contextBridge.exposeInMainWorld('electronAPI', {
        tasks: { save: (id: string, changes: unknown): Promise<void> => ipcRenderer.invoke('db:updateTask', { id, changes }) },
        onChanged: (callback: (data: unknown) => void) => { ipcRenderer.on('task:updated', callback) },
        browser: { record: () => ipcRenderer.invoke('browser:startRecording', 'panel') }
      })`
    const inventory = createInventory({ sources: [{ file: 'src/preload/index.ts', source: preload }] })
    const manifest = buildOperationManifest(inventory, preload)
    const command = manifest.operations.find((entry: { name: string }) => entry.name === 'db:updateTask')
    expect(command.input.preload[0]).toMatchObject({ apiPath: ['tasks', 'save'], arguments: ['{ id, changes }'] })
    expect(command.input.validation).toContain('required-before-binding')
    expect(manifest.operations.find((entry: { name: string }) => entry.name === 'browser:startRecording')).toMatchObject({ disposition: 'removed-browser', caller: 'none', destination: 'none' })
    const types = generateOperationTypes(manifest)
    expect(types).toContain('Parameters<NonNullable<DesktopApi["tasks"]["save"]>>')
    expect(types).not.toMatch(/"browser:startRecording": \{ apiArguments/)
  })

  it('does not hide dynamic channel forwarding or accept an unowned command family', () => {
    const sources = [{ file: 'src/main/a.ts', source: `import { ipcMain } from 'electron'; ipcMain.handle(channel, fn)` }]
    expect(buildOperationManifest(createInventory({ sources }), '').unresolvedReferences).toHaveLength(1)
    const unknown = createInventory({ sources: [{ file: 'src/main/a.ts', source: `import { ipcMain } from 'electron'; ipcMain.handle('newFamily:grantEverything', fn)` }] })
    expect(() => buildOperationManifest(unknown, '')).toThrow('Unassigned operation family')
  })
})

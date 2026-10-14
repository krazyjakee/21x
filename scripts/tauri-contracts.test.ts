import { describe, expect, it } from 'vitest'
// @ts-expect-error -- parse-only .mjs generator has no declaration file
import { buildOperationManifest, generateDesktopApi, generateOperationTypes, reviewEventForwarding } from './tauri-contracts.mjs'
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
  it('assigns workspace open/reveal admission to the service while requiring exact native callbacks', () => {
    const source = `import { ipcMain } from 'electron'; ipcMain.handle('shell:openPath', fn); ipcMain.handle('shell:showItemInFolder', fn); ipcMain.handle('shell:openExternal', fn);`
    const manifest = buildOperationManifest(createInventory({ sources: [{ file: 'src/main/app.ts', source }] }), '')
    for (const name of ['shell:openPath', 'shell:showItemInFolder']) expect(manifest.operations.find((row: { name: string }) => row.name === name)).toMatchObject({ owner: 'service', nativeCallback: true })
    expect(manifest.operations.find((row: { name: string }) => row.name === 'shell:openExternal')).toMatchObject({ owner: 'native-host' })
  })

  it('attaches finite authoritative source ownership without hiding dynamic AST evidence', () => {
    const source = { file: 'src/main/relay.ts', line: 2, column: 3, target: 'guardedIpcSend', method: 'send', channelExpression: 'channel' }
    const inventory = { operations: [{ ...source, channel: null, resolution: 'unresolved' }] }
    const operations = [{ name: 'task:updated', kind: 'event', disposition: 'retained', owner: 'service', destination: 'trusted-desktop-main' }]
    const policy = { id: 'relay', source, producerOwner: 'task-domain', allowedNames: ['task:updated'], channelOwners: { 'task:updated': 'service' }, destination: 'trusted-desktop-main' }
    const audited = reviewEventForwarding(inventory, operations, { policies: [policy] })
    expect(audited.review.reviewedReferences).toBe(1)
    expect(audited.review.unreviewedReferences).toBe(0)
    expect(audited.references[0].channel).toBeNull()
    expect(audited.references[0].resolution).toBe('unresolved')
    expect(audited.references[0].forwardingReview.allowedNames).toEqual(['task:updated'])
    expect(() => reviewEventForwarding(inventory, operations, { policies: [{ ...policy, allowedNames: ['task:*'], channelOwners: { 'task:*': 'service' } }] })).toThrow()
    expect(() => reviewEventForwarding(inventory, operations, { policies: [{ ...policy, channelOwners: { 'task:updated': 'native-host' } }] })).toThrow()
    expect(() => reviewEventForwarding(inventory, operations, { policies: [{ ...policy, destination: 'remote-webview' }] })).toThrow()
    expect(reviewEventForwarding(inventory, operations, { policies: [{ ...policy, source: { ...source, line: 3 } }] }).review.unreviewedReferences).toBe(1)
  })
})

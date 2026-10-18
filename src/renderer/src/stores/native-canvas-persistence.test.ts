import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'

const project = 'canvas_fixture_project'
const savedCanvas = { viewport: { x: -2, y: 15, zoom: 0.75 }, nextZIndex: 9, panels: [
  { id: 'panel-7', type: 'browser', title: 'Dormant portal', url: 'https://inactive.invalid/?synthetic=canary',
    browserSessionId: 'old-session', webContentsId: 42, streamPort: 65500, x: 30, y: -25, width: 400, height: 300, zIndex: 7 },
  { id: 'panel-8', type: 'webpage', title: 'Dormant page', url: 'javascript:globalThis.__inactive=1', x: 80, y: 95, width: 400, height: 300, zIndex: 8 }
], edges: [{ id: 'edge-5', fromPanelId: 'panel-7', toPanelId: 'panel-8', edgeType: 'browser' }] }
const rectangle = { type: 'rectangle' as const, x: 5, y: 10, width: 150, height: 80, stroke: '#123456', strokeWidth: 2, fill: null, opacity: 1 }
const savedDrawing = { objects: [{ ...rectangle, id: 'figure-4', zIndex: 4 }], nextZIndex: 5 }
const originals = { canvas_state: JSON.stringify(savedCanvas), drawing_state: JSON.stringify(savedDrawing) }
const values = new Map<string, string>(), operations: Array<{ operation: string; payload: Record<string, unknown> }> = []
type Failure = 'good' | 'refused' | 'corrupt' | 'oversize' | 'shape'
let failure: Failure = 'good'
let failedKey: string | null = null
const heldReads: Array<{ key: string; enter(): void; value: Promise<string> }> = []
const readReleases: Array<() => void> = []
function holdNextRead(key: string) {
  let enter!: () => void, resolve!: (value: string) => void
  const entered = new Promise<void>(done => { enter = done }), value = new Promise<string>(done => { resolve = done })
  heldReads.push({ key, enter, value }); readReleases.push(() => resolve(originals[key.startsWith('canvas_state') ? 'canvas_state' : 'drawing_state']))
  return { entered, resolve }
}
let canvas: typeof import('./canvas-store').useCanvasStore
let drawing: typeof import('./drawing-store').useDrawingStore
let host: ReturnType<typeof import('@/lib/native-desktop-host').createNativeDesktopHost>
let release: () => void
const preload = window.electronAPI
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }
const writes = () => operations.filter(row => row.operation === 'settings:set')
beforeAll(async () => {
  vi.stubEnv('VITE_DESKTOP_HOST', 'tauri')
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  const { installDesktopHost } = await import('@/lib/desktop-api')
  const { createNativeDesktopHost } = await import('@/lib/native-desktop-host')
  const native = { core: { invoke: async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'canvas_epoch' }
    const operation = String(args?.operation), payload = args?.payload as Record<string, unknown>
    operations.push({ operation, payload })
    const key = String(payload.key)
    if (operation === 'settings:set') values.set(key, String(payload.value))
    let value: string | undefined | null = operation === 'settings:get' ? values.get(key) ?? null : undefined
    const heldIndex = operation === 'settings:get' ? heldReads.findIndex(row => row.key === key) : -1
    if (heldIndex >= 0) { const held = heldReads.splice(heldIndex, 1)[0]; held.enter(); value = await held.value }
    else if (operation === 'settings:get' && key === failedKey) {
      if (failure === 'refused') throw new Error('Synthetic Source settings refusal')
      if (failure === 'corrupt') value = 'not-json'
      if (failure === 'oversize') value = 'x'.repeat(800_001)
      if (failure === 'shape') value = key.startsWith('canvas_state') ? '{"panels":[],"edges":[],"viewport":null}' : '{"objects":[]}'
    }
    return { engineEpoch: 'canvas_epoch', result: value === undefined ? { defined: false } : { defined: true, value } }
  } }, event: { listen: vi.fn(async () => vi.fn()) } } as unknown as TauriDesktopApi
  host = createNativeDesktopHost(native); release = installDesktopHost(host)
  host.setRehydrator(async () => {}); await host.reconnect()
  ;({ useCanvasStore: canvas } = await import('./canvas-store'))
  ;({ useDrawingStore: drawing } = await import('./drawing-store'))
})
beforeEach(async () => {
  vi.useRealTimers(); failure = 'good'; failedKey = null; values.clear()
  values.set(`canvas_state:${project}`, originals.canvas_state); values.set(`drawing_state:${project}`, originals.drawing_state)
  await host.reconnect(); await settle()
  await canvas.getState().loadCanvas(project); await drawing.getState().loadDrawings(project)
  operations.length = 0
  vi.useFakeTimers()
})
afterEach(async () => { for (const release of readReleases.splice(0)) release(); heldReads.length = 0; await settle(); vi.clearAllTimers(); vi.useRealTimers() })
afterAll(() => { release(); vi.unstubAllEnvs(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: preload }) })

const owners = [
  { name: 'canvas', key: 'canvas_state' as const, load: () => canvas.getState().loadCanvas(project), loaded: () => canvas.getState().isLoaded,
    edit: () => canvas.getState().setViewport({ x: 600 }), unchanged: () => {
      expect(canvas.getState().panels).toEqual(savedCanvas.panels); expect(canvas.getState().edges).toEqual(savedCanvas.edges)
    } },
  { name: 'drawing', key: 'drawing_state' as const, load: () => drawing.getState().loadDrawings(project), loaded: () => drawing.getState().isLoaded,
    edit: () => drawing.getState().addObject(rectangle), unchanged: () => { expect(drawing.getState().objects).toEqual(savedDrawing.objects) } }
]
for (const owner of owners) describe(`actual typed native ${owner.name} persistence`, () => {
  for (const mode of ['refused', 'corrupt', 'oversize', 'shape'] as const) it(`preserves saved data after ${mode} load and a later edit, until an accepted current read`, async () => {
    failedKey = `${owner.key}:${project}`; failure = mode
    await owner.load(); operations.length = 0
    owner.edit(); await vi.advanceTimersByTimeAsync(1100)
    expect(writes()).toEqual([])
    expect(values.get(failedKey)).toBe(originals[owner.key]); expect(owner.loaded()).toBe(false)
    failure = 'good'; operations.length = 0
    await owner.load(); owner.unchanged()
    expect(writes()).toEqual([]); expect(owner.loaded()).toBe(true)
    owner.edit(); await vi.advanceTimersByTimeAsync(1100)
    expect(writes()).toHaveLength(1)
    const saved = JSON.parse(values.get(failedKey)!)
    if (owner.key === 'canvas_state') { expect(saved.panels).toEqual(savedCanvas.panels); expect(saved.edges).toEqual(savedCanvas.edges) }
    else expect(saved.objects[0]).toEqual(savedDrawing.objects[0])
  })
  it('withdraws a scheduled save on same-epoch reconnect and retries only a read on the current connection', async () => {
    owner.edit(); failedKey = `${owner.key}:${project}`; failure = 'refused'
    await host.reconnect(); await settle(); await vi.advanceTimersByTimeAsync(1100)
    expect(writes()).toEqual([]); expect(values.get(failedKey)).toBe(originals[owner.key]); expect(owner.loaded()).toBe(false)
    failure = 'good'; operations.length = 0
    await host.reconnect(); await settle()
    expect(operations.some(row => row.operation === 'settings:get' && row.payload.key === failedKey)).toBe(true)
    expect(writes()).toEqual([]); expect(owner.loaded()).toBe(true); owner.unchanged()
    owner.edit(); await vi.advanceTimersByTimeAsync(1100)
    expect(writes()).toHaveLength(1)
  })
  it('discards a held old-connection read after current read-only recovery without overwriting canonical records', async () => {
    const gate = holdNextRead(`${owner.key}:${project}`), pending = owner.load()
    await gate.entered
    await host.reconnect(); await settle()
    expect(owner.loaded()).toBe(true); owner.unchanged(); expect(writes()).toEqual([])
    gate.resolve(owner.key === 'canvas_state' ? '{"viewport":{"x":0,"y":0,"zoom":1},"panels":[],"edges":[],"nextZIndex":1}' : '{"objects":[],"nextZIndex":1}')
    await pending; await settle(); owner.unchanged(); expect(writes()).toEqual([])
    owner.edit(); await vi.advanceTimersByTimeAsync(1100)
    expect(writes()).toHaveLength(1)
    const saved = JSON.parse(values.get(`${owner.key}:${project}`)!)
    if (owner.key === 'canvas_state') { expect(saved.panels).toEqual(savedCanvas.panels); expect(saved.edges).toEqual(savedCanvas.edges) }
    else expect(saved.objects[0]).toEqual(savedDrawing.objects[0])
  })
})
it('retires document saves and read-only connection retries on pagehide', async () => {
  canvas.getState().setViewport({ x: 900 }); drawing.getState().addObject(rectangle)
  window.dispatchEvent(new Event('pagehide')); operations.length = 0
  await host.reconnect(); await settle()
  await canvas.getState().loadCanvas(project); await drawing.getState().loadDrawings(project)
  await vi.advanceTimersByTimeAsync(1100)
  expect(operations.filter(row => ['settings:get', 'settings:set'].includes(row.operation))).toEqual([])
  expect(values.get(`canvas_state:${project}`)).toBe(originals.canvas_state)
  expect(values.get(`drawing_state:${project}`)).toBe(originals.drawing_state)
})

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import { DESKTOP_OPERATION_MANIFEST } from '@shared/desktop-operations'

const saved = {
  viewport: { x: 12, y: 34, zoom: 0.8 }, nextZIndex: 4,
  panels: [
    { id: 'task-panel', type: 'task', refId: 'task-1', title: 'Task', x: 0, y: 0, width: 300, height: 250, zIndex: 1 },
    { id: 'browser-panel', type: 'browser', title: 'Saved portal', url: 'https://portal.invalid/?secret=canary', x: 400, y: 0, width: 300, height: 250, zIndex: 2, webContentsId: 42, browserSessionId: 'old-session', streamPort: 1234 },
    { id: 'webpage-panel', type: 'webpage', title: 'Saved website', url: 'https://website.invalid/', x: 800, y: 0, width: 300, height: 250, zIndex: 3 }
  ], edges: [{ id: 'edge-1', fromPanelId: 'task-panel', toPanelId: 'browser-panel', edgeType: 'browser' }]
}
let Browser: typeof import('./BrowserPanelContent').BrowserPanelContent
let Webpage: typeof import('./WebPagePanelContent').WebPagePanelContent
let Menu: typeof import('./CanvasContextMenu').CanvasContextMenu
let canvas: typeof import('@/stores/canvas-store').useCanvasStore
let host: ReturnType<typeof import('@/lib/native-desktop-host').createNativeDesktopHost>
let release: () => void
const values = new Map<string, string>(), operations: string[] = []
const legacy = window.electronAPI
beforeAll(async () => {
  vi.stubEnv('VITE_DESKTOP_HOST', 'tauri')
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  const { installDesktopHost } = await import('@/lib/desktop-api')
  const { createNativeDesktopHost } = await import('@/lib/native-desktop-host')
  const native = { core: { invoke: async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1' }
    const operation = String(args?.operation), payload = args?.payload as { key: string; value?: string }
    operations.push(operation)
    if (operation === 'settings:set') values.set(payload.key, payload.value!)
    const value = operation === 'settings:get' ? values.get(payload.key) ?? null : undefined
    return { engineEpoch: 'engine-1', result: value === undefined ? { defined: false } : { defined: true, value } }
  } }, event: { listen: vi.fn(async () => vi.fn()) } } as unknown as TauriDesktopApi
  host = createNativeDesktopHost(native); release = installDesktopHost(host)
  host.setRehydrator(async () => {}); await host.reconnect()
  ;({ BrowserPanelContent: Browser } = await import('./BrowserPanelContent'))
  ;({ WebPagePanelContent: Webpage } = await import('./WebPagePanelContent'))
  ;({ CanvasContextMenu: Menu } = await import('./CanvasContextMenu'))
  ;({ useCanvasStore: canvas } = await import('@/stores/canvas-store'))
})
beforeEach(() => {
  values.clear(); operations.length = 0
  values.set('canvas_state:default', JSON.stringify(saved))
  canvas.setState({ panels: [], edges: [], projectId: 'default', isLoaded: false })
})
afterEach(() => cleanup())
afterAll(() => { release(); vi.unstubAllEnvs(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy }) })
it('renders retired browser/webpage records and retained menu tools without preload, embedding or native control paths', () => {
  const { container } = render(<>
    <Browser panelId="browser-panel" url={saved.panels[1].url} sessionName="old-session" streamPort={1234} />
    <Webpage panelId="webpage-panel" url={saved.panels[2].url} />
    <Menu position={{ clientX: 20, clientY: 20, canvasX: 0, canvasY: 0 }} onClose={vi.fn()} />
  </>)
  expect(screen.getAllByText('Embedded browsing has been retired.')).toHaveLength(2)
  expect(container.querySelector('webview, iframe')).toBeNull()
  expect(container.textContent).not.toContain('canary')
  expect(container.querySelector('[src], a[href]')).toBeNull()
  expect(screen.queryByText('Agent Browser')).toBeNull(); expect(screen.getByText('Terminal')).toBeInTheDocument()
  expect(operations).toEqual([]); expect(host.unavailableCapability).toBeNull()
  const removed = Object.values(DESKTOP_OPERATION_MANIFEST).filter(entry => entry.name.startsWith('browser:'))
  expect(removed.length).toBeGreaterThan(0)
  expect(removed.every(entry => entry.disposition === 'removed-browser' && entry.caller === 'none' && entry.destination === 'none')).toBe(true)
})
it('preserves dormant metadata through typed settings reads/writes while refusing new panels and control edges', async () => {
  await canvas.getState().loadCanvas('default')
  expect(canvas.getState().panels).toEqual(saved.panels); expect(canvas.getState().edges).toEqual(saved.edges)
  expect(operations).not.toContain('settings:set')
  for (const type of ['browser', 'webpage'] as const) {
    expect(canvas.getState().addPanel({ type, title: 'Refused', x: 0, y: 0, width: 100, height: 100 })).toBe('')
  }
  expect(canvas.getState().addEdge('task-panel', 'browser-panel', 'browser')).toBe('')
  expect(canvas.getState().addEdge('task-panel', 'webpage-panel')).toBe('')
  canvas.getState().setViewport({ x: 75 })
  await waitFor(() => expect(operations).toContain('settings:set'), { timeout: 3000 })
  const persisted = JSON.parse(values.get('canvas_state:default')!)
  expect(persisted.panels).toEqual(saved.panels); expect(persisted.edges).toEqual(saved.edges)
  expect(persisted.viewport.x).toBe(75)
  expect(operations.every(operation => ['settings:get', 'settings:set'].includes(operation))).toBe(true)
  expect(host.supports('browser.registerBrokerPanel')).toBe(false)
})

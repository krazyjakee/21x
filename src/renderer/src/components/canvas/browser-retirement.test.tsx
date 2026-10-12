import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { BrowserPanelContent } from './BrowserPanelContent'
import { WebPagePanelContent } from './WebPagePanelContent'
import { CanvasContextMenu } from './CanvasContextMenu'
import { settingsApi } from '@/lib/ipc-client'
import { useCanvasStore } from '@/stores/canvas-store'

vi.mock('@/lib/ipc-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/ipc-client')>(),
  settingsApi: { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined), getAll: vi.fn().mockResolvedValue({}) },
  projectApi: { getAll: vi.fn().mockResolvedValue([]) },
  onTaskDeleted: vi.fn(() => vi.fn()),
  browserRecordingApi: { status: vi.fn(), start: vi.fn(), stop: vi.fn() }
}))

const saved = {
  viewport: { x: 12, y: 34, zoom: 0.8 },
  nextZIndex: 4,
  panels: [
    { id: 'panel-1', type: 'task', refId: 'task-1', title: 'Task', x: 1, y: 2, width: 300, height: 250, zIndex: 1 },
    { id: 'panel-2', type: 'browser', title: 'Saved portal', url: 'https://portal.invalid/?secret=canary', x: 401, y: 2, width: 300, height: 250, zIndex: 2, webContentsId: 42, browserSessionId: 'old-session', streamPort: 1234 },
    { id: 'panel-3', type: 'webpage', title: 'Saved website', url: 'https://website.invalid/', x: 801, y: 2, width: 300, height: 250, zIndex: 3 }
  ],
  edges: [
    { id: 'edge-1', fromPanelId: 'panel-1', toPanelId: 'panel-2', edgeType: 'browser' },
    { id: 'edge-2', fromPanelId: 'panel-1', toPanelId: 'panel-3' }
  ]
}

describe('Tauri browser retirement', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_DESKTOP_HOST', 'tauri')
    vi.clearAllMocks()
    useCanvasStore.setState({ panels: [], edges: [], isLoaded: false, projectId: 'default' })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('mounts saved browser and website panels without embedding URLs or registering a broker', () => {
    const browserApi = { registerBrokerPanel: vi.fn(), unregisterBrokerPanel: vi.fn(), recordingStatus: vi.fn() }
    const prior = window.electronAPI.browser
    Object.assign(window.electronAPI, { browser: browserApi })
    try {
      const { container } = render(<>
        <BrowserPanelContent panelId="panel-2" url={saved.panels[1].url} sessionName="old-session" streamPort={1234} />
        <WebPagePanelContent panelId="panel-3" url={saved.panels[2].url} />
      </>)
      expect(screen.getAllByText('Embedded browsing has been retired.')).toHaveLength(2)
      expect(container.querySelector('webview, iframe')).toBeNull()
      expect(container.textContent).not.toContain('canary')
      expect(browserApi.registerBrokerPanel).not.toHaveBeenCalled()
      expect(browserApi.recordingStatus).not.toHaveBeenCalled()
    } finally {
      Object.assign(window.electronAPI, { browser: prior })
    }
  })

  it('offers retained canvas tools without browser creation', () => {
    render(<CanvasContextMenu position={{ clientX: 20, clientY: 20, canvasX: 0, canvasY: 0 }} onClose={() => {}} />)
    expect(screen.queryByText('Agent Browser')).toBeNull()
    expect(screen.getByText('Terminal')).toBeInTheDocument()
  })

  it('retains dormant records and task edges across repeated project loads and saves', async () => {
    vi.useFakeTimers()
    const original = JSON.stringify(saved)
    const table = new Map([['canvas_state:default', original], ['canvas_state_migrated_to_projects', '1']])
    vi.mocked(settingsApi.get).mockImplementation(async key => table.get(key) ?? null)
    vi.mocked(settingsApi.set).mockImplementation(async (key, value) => { table.set(key, value) })
    for (let repeat = 0; repeat < 3; repeat++) {
      await useCanvasStore.getState().loadCanvas('default')
      expect(useCanvasStore.getState().panels).toEqual(saved.panels)
      expect(useCanvasStore.getState().edges).toEqual(saved.edges)
      useCanvasStore.getState().setViewport({ x: 100 + repeat })
      vi.advanceTimersByTime(1000)
      const persisted = JSON.parse(table.get('canvas_state:default')!)
      expect(persisted.panels).toEqual(saved.panels)
      expect(persisted.edges).toEqual(saved.edges)
      useCanvasStore.setState({ panels: [], edges: [], isLoaded: false })
    }
    // The source fixture remains available for rollback; no transformation deleted records.
    expect(JSON.parse(original)).toEqual(saved)
  })

  it('rejects newly created browser/website panels and browser edges, without broker cleanup', () => {
    const store = useCanvasStore.getState()
    expect(store.addPanel({ type: 'browser', title: 'New', x: 0, y: 0, width: 100, height: 100 })).toBe('')
    expect(store.addPanel({ type: 'webpage', title: 'New', x: 0, y: 0, width: 100, height: 100 })).toBe('')
    expect(useCanvasStore.getState().panels).toEqual([])
    useCanvasStore.setState({ panels: structuredClone(saved.panels) as typeof store.panels, edges: [] })
    expect(store.addEdge('panel-1', 'panel-2', 'browser')).toBe('')
    expect(store.addEdge('panel-1', 'panel-3')).toBe('')
    expect(useCanvasStore.getState().edges).toEqual([])
    const unregister = vi.fn()
    const prior = window.electronAPI.browser
    Object.assign(window.electronAPI, { browser: { unregisterBrokerPanel: unregister } })
    try { store.removePanel('panel-2'); expect(unregister).not.toHaveBeenCalled() }
    finally { Object.assign(window.electronAPI, { browser: prior }) }
  })
})

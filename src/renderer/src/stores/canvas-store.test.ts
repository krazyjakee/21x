import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useCanvasStore,
  MIN_ZOOM,
  MAX_ZOOM,
  calculateSnap,
  SNAP_GAP,
  panViewport,
  clampZoom,
  zoomViewportAtPoint,
  snapGuidesEqual,
} from './canvas-store'
import type { CanvasPanelData } from './canvas-store'
import { settingsApi } from '@/lib/ipc-client'
import { useProjectStore } from './project-store'

// Mock settingsApi to prevent actual IPC calls during tests
vi.mock('@/lib/ipc-client', () => ({
  settingsApi: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue({}),
  },
  projectApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
  onTaskDeleted: vi.fn(() => vi.fn()),
}))

/**
 * A settings table the store can read back from — persistence is the point
 * of these tests, and a restart is "empty the store, load again from here".
 */
function fakeSettings(seed: Record<string, string> = {}): Map<string, string> {
  const table = new Map(Object.entries(seed))
  vi.mocked(settingsApi.get).mockImplementation(async (key) => table.get(key) ?? null)
  vi.mocked(settingsApi.set).mockImplementation(async (key, value) => {
    table.set(key, value)
  })
  return table
}

const savedPanel = (id: string, type: string, refId?: string) =>
  ({ id, type, refId, title: id, x: 0, y: 0, width: 400, height: 300, zIndex: 1 })

const savedCanvas = (panels: unknown[], edges: unknown[] = []) =>
  JSON.stringify({ viewport: { x: 0, y: 0, zoom: 1 }, panels, edges, nextZIndex: panels.length + 1 })

const restart = () =>
  useCanvasStore.setState({ panels: [], edges: [], nextZIndex: 1, isLoaded: false, projectId: 'default' })

describe('canvas-store', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      viewport: { x: 0, y: 0, zoom: 1 },
      panels: [],
      edges: [],
      nextZIndex: 1,
      draggingPanelId: null,
      snapGuides: [],
      connectingFromId: null,
      proximityEdge: null,
      liveDrag: null,
    })
  })

  // ── Persistence ───────────────────────────────────────────

  describe('loadCanvas', () => {
    beforeEach(() => {
      vi.mocked(settingsApi.get).mockReset()
      vi.mocked(settingsApi.set).mockReset()
    })

    afterEach(() => {
      vi.useRealTimers()
      useProjectStore.setState({ currentProjectId: 'default' })
      vi.mocked(settingsApi.get).mockResolvedValue(null)
      vi.mocked(settingsApi.set).mockResolvedValue(undefined)
    })

    it('drops application panels saved by older releases, with their edges', async () => {
      fakeSettings({
        'canvas_state:default': savedCanvas(
          [savedPanel('panel-1', 'task'), savedPanel('panel-2', 'app'), savedPanel('panel-3', 'webpage')],
          [
            { id: 'edge-1', fromPanelId: 'panel-1', toPanelId: 'panel-2' },
            { id: 'edge-2', fromPanelId: 'panel-1', toPanelId: 'panel-3' },
          ]
        ),
      })

      await useCanvasStore.getState().loadCanvas('default')

      const { panels, edges } = useCanvasStore.getState()
      expect(panels.map((p) => p.id)).toEqual(['panel-1', 'panel-3'])
      expect(edges.map((e) => e.id)).toEqual(['edge-2'])
    })

    it('keeps two projects\' canvases — panels, browser panels and their edges — apart across a restart', async () => {
      vi.useFakeTimers()
      const table = fakeSettings()
      const canvas = useCanvasStore.getState()

      await canvas.loadCanvas('p1')
      canvas.addPanel({ type: 'task', refId: 't1', title: 'Task 1', x: 0, y: 0, width: 100, height: 100 })
      vi.advanceTimersByTime(1000)

      await canvas.loadCanvas('p2')
      expect(useCanvasStore.getState().panels).toEqual([])
      // No refId on purpose: a browser edge to a task with one tells the
      // task's agent about it, and no agent is running here.
      const taskId = canvas.addPanel({ type: 'task', title: 'Task 2', x: 0, y: 0, width: 100, height: 100 })
      const browserId = canvas.addPanel({ type: 'browser', title: 'Browser', x: 200, y: 0, width: 100, height: 100 })
      canvas.addEdge(taskId, browserId, 'browser')
      vi.advanceTimersByTime(1000)

      expect(table.has('canvas_state:p1')).toBe(true)
      expect(table.has('canvas_state:p2')).toBe(true)

      restart()
      await useCanvasStore.getState().loadCanvas('p1')
      expect(useCanvasStore.getState().panels.map((p) => p.refId)).toEqual(['t1'])
      expect(useCanvasStore.getState().edges).toEqual([])

      await useCanvasStore.getState().loadCanvas('p2')
      const p2 = useCanvasStore.getState()
      expect(p2.panels.map((p) => p.type)).toEqual(['task', 'browser'])
      expect(p2.edges).toEqual([expect.objectContaining({ fromPanelId: taskId, toPanelId: browserId, edgeType: 'browser' })])
    })

    it('moves the pre-project canvas into Default once, and never again', async () => {
      const table = fakeSettings({ canvas_state: savedCanvas([savedPanel('panel-1', 'task', 'old')]) })

      await useCanvasStore.getState().loadCanvas('default')
      expect(useCanvasStore.getState().panels.map((p) => p.refId)).toEqual(['old'])
      expect(table.get('canvas_state:default')).toBe(table.get('canvas_state'))
      expect(table.get('canvas_state_migrated_to_projects')).toBe('1')

      // The user clears the Default canvas; the old blob must not come back.
      table.set('canvas_state:default', savedCanvas([]))
      restart()
      await useCanvasStore.getState().loadCanvas('default')
      expect(useCanvasStore.getState().panels).toEqual([])

      // Nor does it leak into another project.
      await useCanvasStore.getState().loadCanvas('p1')
      expect(useCanvasStore.getState().panels).toEqual([])
    })

    it('writes a save still pending for the project left behind under that project, never the next', async () => {
      vi.useFakeTimers()
      const table = fakeSettings()
      await useCanvasStore.getState().loadCanvas('p1')
      useCanvasStore.getState().addPanel({ type: 'task', refId: 't1', title: 'Task 1', x: 0, y: 0, width: 100, height: 100 })

      // The project switches while the debounced save is still pending.
      useProjectStore.setState({ currentProjectId: 'p2' })
      expect(useCanvasStore.getState().projectId).toBe('p2')
      vi.advanceTimersByTime(1000)
      await vi.waitFor(() => expect(useCanvasStore.getState().isLoaded).toBe(true))

      expect(JSON.parse(table.get('canvas_state:p1')!).panels.map((p: { refId: string }) => p.refId)).toEqual(['t1'])
      expect(table.has('canvas_state:p2')).toBe(false)
    })

    it('does not write over a project\'s saved canvas while it is still being read', async () => {
      vi.useFakeTimers()
      const saved = savedCanvas([savedPanel('panel-1', 'task', 'kept')])
      const table = fakeSettings({ 'canvas_state:p2': saved })
      let release!: (value: string | null) => void
      vi.mocked(settingsApi.get).mockImplementation((key) =>
        key === 'canvas_state:p2'
          ? new Promise<string | null>((resolve) => { release = resolve })
          : Promise.resolve(table.get(key) ?? null)
      )

      const loading = useCanvasStore.getState().loadCanvas('p2')
      await vi.waitFor(() => expect(release).toBeDefined())
      // An edit lands while the read is in flight — it must not be persisted
      // as the whole canvas, which is still the empty placeholder.
      useCanvasStore.getState().addPanel({ type: 'task', refId: 'early', title: 'Early', x: 0, y: 0, width: 100, height: 100 })
      vi.advanceTimersByTime(1000)
      expect(table.get('canvas_state:p2')).toBe(saved)

      release(saved)
      await loading
      expect(useCanvasStore.getState().panels.map((p) => p.refId)).toEqual(['kept'])
    })

    it('drops a slower load for the project left behind', async () => {
      const table = fakeSettings({
        'canvas_state:p1': savedCanvas([savedPanel('panel-1', 'task', 'one')]),
        'canvas_state:p2': savedCanvas([savedPanel('panel-2', 'task', 'two')]),
      })
      let releaseP1!: (value: string | null) => void
      vi.mocked(settingsApi.get).mockImplementation((key) =>
        key === 'canvas_state:p1'
          ? new Promise<string | null>((resolve) => { releaseP1 = resolve })
          : Promise.resolve(table.get(key) ?? null)
      )

      const first = useCanvasStore.getState().loadCanvas('p1')
      await useCanvasStore.getState().loadCanvas('p2')
      await vi.waitFor(() => expect(releaseP1).toBeDefined())
      releaseP1(table.get('canvas_state:p1')!)
      await first

      const state = useCanvasStore.getState()
      expect(state.projectId).toBe('p2')
      expect(state.panels.map((p) => p.refId)).toEqual(['two'])
    })
  })

  // ── Viewport ──────────────────────────────────────────────

  describe('viewport', () => {
    it('should have a default viewport of (0, 0, 1)', () => {
      const { viewport } = useCanvasStore.getState()
      expect(viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    })

    it('should clamp zoom to MIN_ZOOM', () => {
      useCanvasStore.getState().zoomTo(0.01)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.zoom).toBe(MIN_ZOOM)
    })

    it('should clamp zoom to MAX_ZOOM', () => {
      useCanvasStore.getState().zoomTo(10)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.zoom).toBe(MAX_ZOOM)
    })

    it('should zoom to a specific level', () => {
      useCanvasStore.getState().zoomTo(1.5)
      expect(useCanvasStore.getState().viewport.zoom).toBe(1.5)
    })

    it('should zoom towards a center point', () => {
      useCanvasStore.getState().zoomTo(2, 100, 100)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.zoom).toBe(2)
      expect(viewport.x).toBe(-100)
      expect(viewport.y).toBe(-100)
    })

    it('should reset viewport', () => {
      useCanvasStore.getState().setViewport({ x: 500, y: 300 })
      useCanvasStore.getState().zoomTo(2.5)
      useCanvasStore.getState().resetViewport()
      expect(useCanvasStore.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    })

    it('fitToContent fits the passed content bounds when there are no panels', () => {
      useCanvasStore.getState().fitToContent(800, 600, {
        minX: 1000,
        minY: 1000,
        maxX: 1100,
        maxY: 1060,
      })
      const { viewport } = useCanvasStore.getState()
      // Content 100×60 + 2×60 padding = 220×180 → fits at 100% (capped at 1x)
      expect(viewport.zoom).toBe(1)
      // Content center (1050, 1030) centered in the 800×600 container
      expect(viewport.x).toBe(400 - 1050)
      expect(viewport.y).toBe(300 - 1030)
    })

    it('fitToContent merges content bounds with panels', () => {
      useCanvasStore.getState().addPanel({
        type: 'task',
        title: 'Test Task',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      })
      useCanvasStore.getState().fitToContent(800, 600, {
        minX: 1000,
        minY: 0,
        maxX: 1100,
        maxY: 100,
      })
      const { viewport } = useCanvasStore.getState()
      // Union of panel (0..100) and content (1000..1100) = 0..1100 wide
      // Content center x = 550
      expect(viewport.x).toBeCloseTo(400 - 550 * viewport.zoom)
      expect(viewport.y).toBeCloseTo(300 - 50 * viewport.zoom)
    })
  })

  // ── Panels ────────────────────────────────────────────────

  describe('panels', () => {
    it('should add a panel and return its id', () => {
      const id = useCanvasStore.getState().addPanel({
        type: 'task',
        title: 'Test Task',
        x: 100,
        y: 200,
        width: 400,
        height: 300,
      })
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')

      const { panels } = useCanvasStore.getState()
      expect(panels).toHaveLength(1)
      expect(panels[0].title).toBe('Test Task')
      expect(panels[0].type).toBe('task')
      expect(panels[0].x).toBe(100)
      expect(panels[0].y).toBe(200)
      expect(panels[0].zIndex).toBe(1)
    })

    it('should assign incrementing zIndex to new panels', () => {
      useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addPanel({ type: 'transcript', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      const { panels } = useCanvasStore.getState()
      expect(panels[0].zIndex).toBe(1)
      expect(panels[1].zIndex).toBe(2)
    })

    it('should remove a panel', () => {
      const id = useCanvasStore.getState().addPanel({ type: 'webpage', title: 'Page', x: 0, y: 0, width: 400, height: 300 })
      expect(useCanvasStore.getState().panels).toHaveLength(1)
      useCanvasStore.getState().removePanel(id)
      expect(useCanvasStore.getState().panels).toHaveLength(0)
    })

    it('should remove panels by refId', () => {
      useCanvasStore.getState().addPanel({ type: 'task', refId: 't1', title: 'Task 1', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addPanel({ type: 'task', refId: 't2', title: 'Task 2', x: 100, y: 100, width: 400, height: 300 })
      useCanvasStore.getState().addPanel({ type: 'transcript', refId: 't1', title: 'Transcript 1', x: 200, y: 200, width: 400, height: 300 })
      
      expect(useCanvasStore.getState().panels).toHaveLength(3)
      useCanvasStore.getState().removePanelsByRefId('t1')
      const { panels } = useCanvasStore.getState()
      expect(panels).toHaveLength(1)
      expect(panels[0].refId).toBe('t2')
    })

    it('should update a panel', () => {
      const id = useCanvasStore.getState().addPanel({ type: 'task', title: 'Old', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().updatePanel(id, { title: 'New', x: 50, width: 500 })
      const panel = useCanvasStore.getState().panels[0]
      expect(panel.title).toBe('New')
      expect(panel.x).toBe(50)
      expect(panel.width).toBe(500)
      expect(panel.y).toBe(0)
    })

    it('should bring a panel to front', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      useCanvasStore.getState().bringToFront(id1)
      const panels = useCanvasStore.getState().panels
      const panelA = panels.find((p) => p.id === id1)!
      expect(panelA.zIndex).toBe(3)
    })

    it('should remove associated edges when removing a panel', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      const id3 = useCanvasStore.getState().addPanel({ type: 'task', title: 'C', x: 200, y: 200, width: 400, height: 300 })
      useCanvasStore.getState().addEdge(id1, id2)
      useCanvasStore.getState().addEdge(id2, id3)

      useCanvasStore.getState().removePanel(id2)
      expect(useCanvasStore.getState().panels).toHaveLength(2)
      expect(useCanvasStore.getState().edges).toHaveLength(0) // both edges removed
    })
  })

  // ── Edges ─────────────────────────────────────────────────

  describe('edges', () => {
    it('should add an edge between two panels', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      const edgeId = useCanvasStore.getState().addEdge(id1, id2)
      expect(edgeId).toBeTruthy()
      expect(useCanvasStore.getState().edges).toHaveLength(1)
      expect(useCanvasStore.getState().edges[0].fromPanelId).toBe(id1)
      expect(useCanvasStore.getState().edges[0].toPanelId).toBe(id2)
    })

    it('should not add duplicate edges', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addEdge(id1, id2)
      const dupId = useCanvasStore.getState().addEdge(id1, id2)
      expect(dupId).toBe('')
      expect(useCanvasStore.getState().edges).toHaveLength(1)
    })

    it('should not add reverse duplicate edges', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addEdge(id1, id2)
      const dupId = useCanvasStore.getState().addEdge(id2, id1)
      expect(dupId).toBe('')
      expect(useCanvasStore.getState().edges).toHaveLength(1)
    })

    it('should remove an edge', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      const edgeId = useCanvasStore.getState().addEdge(id1, id2)
      useCanvasStore.getState().removeEdge(edgeId)
      expect(useCanvasStore.getState().edges).toHaveLength(0)
    })
  })

  // ── Drag state ────────────────────────────────────────────

  describe('drag state', () => {
    it('should set dragging panel id', () => {
      useCanvasStore.getState().setDraggingPanelId('panel-1')
      expect(useCanvasStore.getState().draggingPanelId).toBe('panel-1')
    })

    it('should clear dragging panel id', () => {
      useCanvasStore.getState().setDraggingPanelId('panel-1')
      useCanvasStore.getState().setDraggingPanelId(null)
      expect(useCanvasStore.getState().draggingPanelId).toBeNull()
    })

    it('should set snap guides', () => {
      useCanvasStore.getState().setSnapGuides([
        { axis: 'x', position: 100 },
        { axis: 'y', position: 200 },
      ])
      expect(useCanvasStore.getState().snapGuides).toHaveLength(2)
    })
  })

  // ── Connect state ─────────────────────────────────────────

  describe('connect state', () => {
    it('should set connecting from id', () => {
      useCanvasStore.getState().setConnectingFromId('panel-1')
      expect(useCanvasStore.getState().connectingFromId).toBe('panel-1')
    })

    it('should clear connecting from id', () => {
      useCanvasStore.getState().setConnectingFromId('panel-1')
      useCanvasStore.getState().setConnectingFromId(null)
      expect(useCanvasStore.getState().connectingFromId).toBeNull()
    })
  })

  // ── Pure viewport math (shared with the imperative gesture path) ──

  describe('viewport math helpers', () => {
    it('pans without mutating the input viewport', () => {
      const vp = { x: 10, y: 20, zoom: 2 }
      const next = panViewport(vp, 5, -5)
      expect(next).toEqual({ x: 15, y: 15, zoom: 2 })
      expect(vp).toEqual({ x: 10, y: 20, zoom: 2 })
    })

    it('clamps zoom to the supported range', () => {
      expect(clampZoom(100)).toBe(MAX_ZOOM)
      expect(clampZoom(0)).toBe(MIN_ZOOM)
      expect(clampZoom(1.5)).toBe(1.5)
    })

    it('keeps the zoom anchor point fixed on screen', () => {
      const rect = { left: 0, top: 0 } as DOMRect
      const start = { x: 0, y: 0, zoom: 1 }
      const anchorX = 400
      const anchorY = 300
      const canvasX = (anchorX - start.x) / start.zoom
      const canvasY = (anchorY - start.y) / start.zoom

      const next = zoomViewportAtPoint(start, -120, anchorX, anchorY, rect)

      expect(canvasX * next.zoom + next.x).toBeCloseTo(anchorX, 6)
      expect(canvasY * next.zoom + next.y).toBeCloseTo(anchorY, 6)
    })

    it('compares snap guides structurally', () => {
      expect(snapGuidesEqual([], [])).toBe(true)
      expect(
        snapGuidesEqual([{ axis: 'x', position: 10 }], [{ axis: 'x', position: 10 }])
      ).toBe(true)
      expect(
        snapGuidesEqual([{ axis: 'x', position: 10 }], [{ axis: 'y', position: 10 }])
      ).toBe(false)
      expect(snapGuidesEqual([{ axis: 'x', position: 10 }], [])).toBe(false)
    })
  })

  // ── Transient drag state: no-op writes must not change identity ──

  describe('transient drag state bail-outs', () => {
    it('keeps snapGuides identity when the guides are unchanged', () => {
      useCanvasStore.getState().setSnapGuides([{ axis: 'x', position: 40 }])
      const first = useCanvasStore.getState().snapGuides

      useCanvasStore.getState().setSnapGuides([{ axis: 'x', position: 40 }])
      expect(useCanvasStore.getState().snapGuides).toBe(first)

      useCanvasStore.getState().setSnapGuides([{ axis: 'x', position: 41 }])
      expect(useCanvasStore.getState().snapGuides).not.toBe(first)
    })

    it('keeps proximityEdge identity when the same pair is re-detected', () => {
      useCanvasStore.getState().setProximityEdge({ fromId: 'a', toId: 'b' })
      const first = useCanvasStore.getState().proximityEdge

      useCanvasStore.getState().setProximityEdge({ fromId: 'a', toId: 'b' })
      expect(useCanvasStore.getState().proximityEdge).toBe(first)

      useCanvasStore.getState().setProximityEdge(null)
      expect(useCanvasStore.getState().proximityEdge).toBeNull()
    })

    it('keeps liveDrag identity when the panel has not moved', () => {
      useCanvasStore.getState().setLiveDrag({ id: 'p1', x: 10, y: 20 })
      const first = useCanvasStore.getState().liveDrag

      useCanvasStore.getState().setLiveDrag({ id: 'p1', x: 10, y: 20 })
      expect(useCanvasStore.getState().liveDrag).toBe(first)

      useCanvasStore.getState().setLiveDrag({ id: 'p1', x: 11, y: 20 })
      expect(useCanvasStore.getState().liveDrag).not.toBe(first)

      useCanvasStore.getState().setLiveDrag(null)
      expect(useCanvasStore.getState().liveDrag).toBeNull()
    })
  })

  // ── Snap calculation ──────────────────────────────────────

  describe('calculateSnap', () => {
    const makePanel = (x: number, y: number, w = 400, h = 300): CanvasPanelData => ({
      id: `p-${x}-${y}`,
      type: 'task',
      title: 'Test',
      x,
      y,
      width: w,
      height: h,
      zIndex: 1,
    })

    it('should snap left edge to left edge of another panel', () => {
      const otherPanels = [makePanel(100, 0)]
      const result = calculateSnap({ x: 105, y: 500, width: 400, height: 300 }, otherPanels)
      expect(result.x).toBe(100) // snapped to left=100
      expect(result.guides.some((g) => g.axis === 'x')).toBe(true)
    })

    it('should snap right edge to right edge of another panel', () => {
      const otherPanels = [makePanel(100, 0, 400)]
      // other right = 500, dragging right = x + 400 = 505
      const result = calculateSnap({ x: 105, y: 500, width: 400, height: 300 }, otherPanels)
      // left=100 is closer (dist=5), so left snap wins
      expect(result.x).toBe(100)
    })

    it('should snap with gap between adjacent panels', () => {
      const otherPanels = [makePanel(0, 0, 200)]
      // other right = 200, dragging left should snap to 200 + SNAP_GAP
      const result = calculateSnap({ x: 200 + SNAP_GAP + 3, y: 0, width: 400, height: 300 }, otherPanels)
      expect(result.x).toBe(200 + SNAP_GAP)
    })

    it('should not snap when too far away', () => {
      const otherPanels = [makePanel(0, 0)]
      const result = calculateSnap({ x: 1000, y: 1000, width: 400, height: 300 }, otherPanels)
      expect(result.x).toBe(1000)
      expect(result.y).toBe(1000)
      expect(result.guides).toHaveLength(0)
    })

    it('should snap on both axes independently', () => {
      const otherPanels = [makePanel(100, 200)]
      const result = calculateSnap({ x: 105, y: 205, width: 400, height: 300 }, otherPanels)
      expect(result.x).toBe(100)
      expect(result.y).toBe(200)
      expect(result.guides).toHaveLength(2)
    })
  })
})

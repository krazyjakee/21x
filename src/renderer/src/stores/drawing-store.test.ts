import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useDrawingStore } from './drawing-store'
import { settingsApi } from '@/lib/ipc-client'
import { useProjectStore } from './project-store'
import type { DrawingObject } from '@/components/canvas/drawing/types'

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

const makeRect = (over: {
  id?: string
  zIndex?: number
  x?: number
  y?: number
  width?: number
  height?: number
} = {}): DrawingObject => ({
  id: 'figure-1-1',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  stroke: '#1e1e1e',
  strokeWidth: 2,
  fill: null,
  opacity: 1,
  zIndex: 1,
  ...over,
})

/** A figure minus id/zIndex — what addObject receives. */
const toNewFigure = (fig: DrawingObject) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, zIndex: _z, ...rest } = fig
  return rest
}

describe('drawing-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDrawingStore.setState({
      objects: [],
      nextZIndex: 1,
      isLoaded: false,
      activeTool: 'select',
      toolOptions: {
        stroke: '#1e1e1e',
        strokeWidth: 2,
        fill: null,
        fontSize: 18,
        fontFamily: 'sans',
        fontWeight: 400,
      },
      selectedIds: [],
      editingTextId: null,
      liveObject: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with the select tool and no figures', () => {
    const s = useDrawingStore.getState()
    expect(s.activeTool).toBe('select')
    expect(s.objects).toEqual([])
    expect(s.isLoaded).toBe(false)
    expect(s.selectedIds).toEqual([])
    expect(s.liveObject).toBeNull()
  })

  // ── addObject / updateObject / removeObjects ──────────────

  it('addObject assigns a figure id and the next z-index', () => {
    const id = useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    const s = useDrawingStore.getState()
    expect(id).toMatch(/^figure-\d+-\d+$/)
    expect(s.objects).toHaveLength(1)
    expect(s.objects[0].id).toBe(id)
    expect(s.objects[0].zIndex).toBe(1)
    expect(s.nextZIndex).toBe(2)
  })

  it('addObject keeps type-specific fields', () => {
    const id = useDrawingStore.getState().addObject({
      type: 'text',
      x: 5,
      y: 6,
      width: 100,
      height: 40,
      stroke: '#fff',
      strokeWidth: 2,
      fill: null,
      opacity: 1,
      text: 'hi',
      fontSize: 24,
      fontFamily: 'mono',
      fontWeight: 700,
      textAlign: 'center',
    })
    const obj = useDrawingStore.getState().objects.find((o) => o.id === id)
    expect(obj).toMatchObject({ type: 'text', text: 'hi', fontSize: 24 })
  })

  it('updateObject merges updates into the figure', () => {
    const id = useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    useDrawingStore.getState().updateObject(id, { x: 10, fill: 'red' })
    expect(useDrawingStore.getState().objects[0]).toMatchObject({ x: 10, fill: 'red' })
    // Untouched fields remain
    expect(useDrawingStore.getState().objects[0].width).toBe(100)
  })

  it('removeObjects removes figures and prunes the selection', () => {
    const a = useDrawingStore.getState().addObject(toNewFigure(makeRect({ id: undefined })))
    const b = useDrawingStore.getState().addObject(toNewFigure(makeRect({ id: undefined })))
    useDrawingStore.getState().select([a, b])
    useDrawingStore.getState().removeObjects([a])
    const s = useDrawingStore.getState()
    expect(s.objects.map((o) => o.id)).toEqual([b])
    expect(s.selectedIds).toEqual([b])
  })

  it('removeObjects clears editingTextId when the edited figure is removed', () => {
    const a = useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    useDrawingStore.getState().setEditingTextId(a)
    useDrawingStore.getState().removeObjects([a])
    expect(useDrawingStore.getState().editingTextId).toBeNull()
  })

  it('removeObjects is a no-op for an empty id list', () => {
    const a = useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    useDrawingStore.getState().removeObjects([])
    expect(useDrawingStore.getState().objects.map((o) => o.id)).toEqual([a])
  })

  // ── z-order / duplication ─────────────────────────────────

  it('bringToFront assigns the next z-index', () => {
    const a = useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    useDrawingStore.getState().bringToFront(a)
    const s = useDrawingStore.getState()
    expect(s.objects[0].zIndex).toBe(3)
    expect(s.nextZIndex).toBe(4)
  })

  it('duplicateObject copies with an offset and selects the copy', () => {
    const a = useDrawingStore.getState().addObject(toNewFigure(makeRect({ x: 10, y: 20 })))
    useDrawingStore.getState().duplicateObject(a)
    const s = useDrawingStore.getState()
    expect(s.objects).toHaveLength(2)
    const copy = s.objects[1]
    expect(copy.id).not.toBe(a)
    expect(copy).toMatchObject({ x: 30, y: 40 })
    expect(s.selectedIds).toEqual([copy.id])
  })

  it('duplicateObject is a no-op for unknown ids', () => {
    useDrawingStore.getState().duplicateObject('nope')
    expect(useDrawingStore.getState().objects).toHaveLength(0)
  })

  // ── tools / selection / editing ───────────────────────────

  it('setTool switches the tool and cancels creation + text editing', () => {
    useDrawingStore.getState().setLiveObject(makeRect())
    useDrawingStore.getState().setEditingTextId('figure-9-9')
    useDrawingStore.getState().setTool('rectangle')
    const s = useDrawingStore.getState()
    expect(s.activeTool).toBe('rectangle')
    expect(s.liveObject).toBeNull()
    expect(s.editingTextId).toBeNull()
  })

  it('setToolOption updates only the given option', () => {
    useDrawingStore.getState().setToolOption('strokeWidth', 8)
    const opts = useDrawingStore.getState().toolOptions
    expect(opts.strokeWidth).toBe(8)
    expect(opts.stroke).toBe('#1e1e1e')
  })

  it('select / clearSelection manage selectedIds', () => {
    useDrawingStore.getState().select(['a', 'b'])
    expect(useDrawingStore.getState().selectedIds).toEqual(['a', 'b'])
    useDrawingStore.getState().clearSelection()
    expect(useDrawingStore.getState().selectedIds).toEqual([])
  })

  // ── setLiveObject bail-out ────────────────────────────────

  it('setLiveObject bails out on structurally equal objects', () => {
    const listener = vi.fn()
    const unsub = useDrawingStore.subscribe((s) => s.liveObject, listener)
    const fig = makeRect()

    useDrawingStore.getState().setLiveObject(fig)
    expect(listener).toHaveBeenCalledTimes(1)

    // Structurally equal — no store write, no notification.
    useDrawingStore.getState().setLiveObject({ ...fig })
    expect(listener).toHaveBeenCalledTimes(1)

    // Changed — notified again.
    useDrawingStore.getState().setLiveObject({ ...fig, x: 5 })
    expect(listener).toHaveBeenCalledTimes(2)

    unsub()
  })

  // ── persistence ───────────────────────────────────────────

  it('persists objects after the debounce, under the loaded project', () => {
    vi.useFakeTimers()
    useDrawingStore.setState({ isLoaded: true, projectId: 'default' })
    useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    expect(settingsApi.set).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(settingsApi.set).toHaveBeenCalledTimes(1)
    const [key, raw] = vi.mocked(settingsApi.set).mock.calls[0]
    expect(key).toBe('drawing_state:default')
    const data = JSON.parse(String(raw))
    expect(data.objects).toHaveLength(1)
    expect(data.nextZIndex).toBe(2)
  })

  it('debounces rapid changes into a single save', () => {
    vi.useFakeTimers()
    useDrawingStore.setState({ isLoaded: true, projectId: 'default' })
    useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    vi.advanceTimersByTime(1000)
    expect(settingsApi.set).toHaveBeenCalledTimes(1)
    const [, raw] = vi.mocked(settingsApi.set).mock.calls[0]
    expect(JSON.parse(String(raw)).objects).toHaveLength(2)
  })

  it('loadDrawings restores persisted figures and the id counter', async () => {
    vi.mocked(settingsApi.get).mockResolvedValue(
      JSON.stringify({
        objects: [makeRect({ id: 'figure-5-123', zIndex: 3 })],
        nextZIndex: 4,
      })
    )
    await useDrawingStore.getState().loadDrawings()
    const s = useDrawingStore.getState()
    expect(s.isLoaded).toBe(true)
    expect(s.objects).toHaveLength(1)
    expect(s.objects[0].id).toBe('figure-5-123')
    expect(s.nextZIndex).toBe(4)

    // New figures never collide with loaded ids.
    const id = s.addObject(toNewFigure(makeRect()))
    const n = parseInt(id.match(/^figure-(\d+)/)![1], 10)
    expect(n).toBeGreaterThan(5)
  })

  it('loadDrawings marks loaded when nothing is persisted', async () => {
    vi.mocked(settingsApi.get).mockResolvedValue(null)
    await useDrawingStore.getState().loadDrawings()
    const s = useDrawingStore.getState()
    expect(s.isLoaded).toBe(true)
    expect(s.objects).toEqual([])
  })

  it('loadDrawings survives corrupt persisted data', async () => {
    vi.mocked(settingsApi.get).mockResolvedValue('not-json{')
    await useDrawingStore.getState().loadDrawings()
    expect(useDrawingStore.getState().isLoaded).toBe(true)
  })

  // ── per-project persistence ───────────────────────────────

  describe('per project', () => {
    const restart = () =>
      useDrawingStore.setState({ objects: [], nextZIndex: 1, isLoaded: false, projectId: 'default' })

    afterEach(() => {
      useProjectStore.setState({ currentProjectId: 'default' })
      vi.mocked(settingsApi.get).mockResolvedValue(null)
      vi.mocked(settingsApi.set).mockResolvedValue(undefined)
    })

    it('keeps two projects\' drawings apart across a restart', async () => {
      vi.useFakeTimers()
      fakeSettings()
      const drawings = useDrawingStore.getState()

      await drawings.loadDrawings('p1')
      drawings.addObject(toNewFigure(makeRect({ x: 1 })))
      vi.advanceTimersByTime(1000)

      await drawings.loadDrawings('p2')
      expect(useDrawingStore.getState().objects).toEqual([])
      drawings.addObject(toNewFigure(makeRect({ x: 2 })))
      drawings.addObject(toNewFigure(makeRect({ x: 3 })))
      vi.advanceTimersByTime(1000)

      restart()
      await useDrawingStore.getState().loadDrawings('p1')
      expect(useDrawingStore.getState().objects.map((o) => o.x)).toEqual([1])

      await useDrawingStore.getState().loadDrawings('p2')
      expect(useDrawingStore.getState().objects.map((o) => o.x)).toEqual([2, 3])
    })

    it('moves the pre-project drawings into Default once, and never again', async () => {
      const legacy = JSON.stringify({ objects: [makeRect({ id: 'figure-1-1', x: 9 })], nextZIndex: 2 })
      const table = fakeSettings({ drawing_state: legacy })

      await useDrawingStore.getState().loadDrawings('default')
      expect(useDrawingStore.getState().objects.map((o) => o.x)).toEqual([9])
      expect(table.get('drawing_state:default')).toBe(legacy)
      expect(table.get('drawing_state_migrated_to_projects')).toBe('1')

      // The user clears the Default drawings; the old blob must not come back.
      table.set('drawing_state:default', JSON.stringify({ objects: [], nextZIndex: 1 }))
      restart()
      await useDrawingStore.getState().loadDrawings('default')
      expect(useDrawingStore.getState().objects).toEqual([])

      await useDrawingStore.getState().loadDrawings('p1')
      expect(useDrawingStore.getState().objects).toEqual([])
    })

    it('writes a save still pending for the project left behind under that project, never the next', async () => {
      vi.useFakeTimers()
      const table = fakeSettings()
      await useDrawingStore.getState().loadDrawings('p1')
      useDrawingStore.getState().addObject(toNewFigure(makeRect({ x: 1 })))

      // The project switches while the debounced save is still pending.
      useProjectStore.setState({ currentProjectId: 'p2' })
      expect(useDrawingStore.getState().projectId).toBe('p2')
      vi.advanceTimersByTime(1000)
      await vi.waitFor(() => expect(useDrawingStore.getState().isLoaded).toBe(true))

      expect(JSON.parse(table.get('drawing_state:p1')!).objects.map((o: { x: number }) => o.x)).toEqual([1])
      expect(table.has('drawing_state:p2')).toBe(false)
    })

    it('does not write over a project\'s saved drawings while they are still being read', async () => {
      vi.useFakeTimers()
      const saved = JSON.stringify({ objects: [makeRect({ id: 'figure-1-1', x: 7 })], nextZIndex: 2 })
      const table = fakeSettings({ 'drawing_state:p2': saved })
      let release!: (value: string | null) => void
      vi.mocked(settingsApi.get).mockImplementation((key) =>
        key === 'drawing_state:p2'
          ? new Promise<string | null>((resolve) => { release = resolve })
          : Promise.resolve(table.get(key) ?? null)
      )

      const loading = useDrawingStore.getState().loadDrawings('p2')
      await vi.waitFor(() => expect(release).toBeDefined())
      useDrawingStore.getState().addObject(toNewFigure(makeRect({ x: 1 })))
      vi.advanceTimersByTime(1000)
      expect(table.get('drawing_state:p2')).toBe(saved)

      release(saved)
      await loading
      expect(useDrawingStore.getState().objects.map((o) => o.x)).toEqual([7])
    })
  })
})

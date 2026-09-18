import { useCallback, useRef, useState, useEffect, useLayoutEffect, useMemo, type MouseEvent as ReactMouseEvent } from 'react'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import { getLiveViewport } from '@/stores/canvas-live-viewport'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { projectIdOf, useProjectStore } from '@/stores/project-store'
import { DrawingLayer } from './drawing/DrawingLayer'
import { DrawingToolbar } from './drawing/DrawingToolbar'
import { DrawingProperties } from './drawing/DrawingProperties'
import { CanvasPanel } from './CanvasPanel'
import { CanvasConnections } from './CanvasConnections'
import { CanvasContextMenu } from './CanvasContextMenu'
import { CanvasMinimap } from './CanvasMinimap'
import { CanvasHud, StatusBeacons } from './CanvasHud'
import { SnapGuides } from './SnapGuides'
import { containerToCanvas, gridBackgroundStyle, isPanelVisible, viewportTransform } from './canvas-geometry'
import { useStatusHighlights, type StatusHighlight } from './status-beacons'
import { useViewportGestures } from './hooks/useViewportGestures'
import { useCanvasKeyboard } from './hooks/useCanvasKeyboard'

interface ContextMenuState {
  clientX: number
  clientY: number
  canvasX: number
  canvasY: number
}

/**
 * The main canvas screen: wheel/trackpad pan + pinch/Ctrl zoom, drag and
 * space+drag panning, keyboard shortcuts, panels positioned via one CSS
 * transform, context menu, panel connections, snap guides and drawings.
 */
export function InfiniteCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewport = useCanvasStore((s) => s.viewport)
  const panels = useCanvasStore((s) => s.panels)
  const isLoaded = useCanvasStore((s) => s.isLoaded)
  const zoomTo = useCanvasStore((s) => s.zoomTo)
  const resetViewport = useCanvasStore((s) => s.resetViewport)
  const fitToContent = useCanvasStore((s) => s.fitToContent)
  const focusPanel = useCanvasStore((s) => s.focusPanel)
  const addPanel = useCanvasStore((s) => s.addPanel)
  const loadCanvas = useCanvasStore((s) => s.loadCanvas)
  const loadDrawings = useDrawingStore((s) => s.loadDrawings)

  // The drawing HUD stays hidden until the user engages with drawing.
  const drawingTool = useDrawingStore((s) => s.activeTool)
  const drawingSelectedCount = useDrawingStore((s) => s.selectedIds.length)
  const drawingEditingTextId = useDrawingStore((s) => s.editingTextId)
  const drawingUiVisible =
    drawingTool !== 'select' || drawingSelectedCount > 0 || drawingEditingTextId !== null

  // The canvas on screen is the current project's. Both stores also reload on
  // a project switch by themselves; a load already under way for the same
  // project is joined, not repeated.
  const loadedProjectId = useCanvasStore((s) => s.projectId)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  useEffect(() => {
    if (isLoaded && loadedProjectId === currentProjectId) return
    // Figures load in parallel with the canvas (same settings table).
    void loadDrawings(currentProjectId)
    loadCanvas(currentProjectId).then(() => {
      const container = containerRef.current
      const canvas = useCanvasStore.getState()
      // Only the project that was asked for gets fitted.
      if (container && canvas.projectId === currentProjectId && canvas.panels.length > 0) {
        const rect = container.getBoundingClientRect()
        fitToContent(rect.width, rect.height)
      }
    })
  }, [isLoaded, loadedProjectId, currentProjectId, loadCanvas, fitToContent, loadDrawings])

  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const connectingFromId = useCanvasStore((s) => s.connectingFromId)
  const setConnectingFromId = useCanvasStore((s) => s.setConnectingFromId)
  const [mouseCanvasPos, setMouseCanvasPos] = useState<{ x: number; y: number } | null>(null)

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  // Measure before child passive effects run. This prevents the initial
  // zero-size fallback from hydrating every canvas transcript for one frame
  // before off-screen culling becomes active.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      // Bail out when unchanged so dependent memos keep their identity.
      setContainerSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const visiblePanelIds = useMemo(() => {
    const set = new Set<string>()
    for (const p of panels) {
      if (isPanelVisible(p, viewport, containerSize.width, containerSize.height)) set.add(p.id)
    }
    return set
  }, [panels, viewport, containerSize])

  const canvasPendingTaskId = useUIStore((s) => s.canvasPendingTaskId)
  const clearCanvasPendingTask = useUIStore((s) => s.clearCanvasPendingTask)
  const allTasks = useTaskStore((s) => s.tasks)

  const { statusHighlights, dismissHighlight } = useStatusHighlights(allTasks, panels)

  // Consume a task sent here by "Open in Canvas". A task opens on its own
  // project's canvas: when it belongs to another project the app switches
  // there first, and the task waits here until that canvas has loaded.
  useEffect(() => {
    if (!canvasPendingTaskId) return

    const task = allTasks.find((t) => t.id === canvasPendingTaskId)
    if (!task) {
      clearCanvasPendingTask()
      return
    }

    const taskProjectId = projectIdOf(task)
    const projects = useProjectStore.getState()
    if (projects.currentProjectId !== taskProjectId) {
      projects.setCurrentProject(taskProjectId)
      return // the stores reload; this effect runs again once they have
    }
    if (!isLoaded || loadedProjectId !== taskProjectId) return

    // Clear only once acted on, so a project switch cannot lose the task.
    clearCanvasPendingTask()

    // Read from the store directly to avoid a stale closure.
    const { panels: currentPanels, viewport: vp, requestViewCommand } = useCanvasStore.getState()
    if (currentPanels.some((p) => p.type === 'task' && p.refId === canvasPendingTaskId)) {
      // Already here: bring the user to it rather than opening a second copy.
      requestViewCommand({ kind: 'focus_task', taskId: canvasPendingTaskId })
      return
    }

    const rect = containerRef.current?.getBoundingClientRect()
    const center = rect ? containerToCanvas(rect.width / 2, rect.height / 2, vp) : null
    const offset = (currentPanels.length % 5) * 30
    addPanel({
      type: 'task',
      title: task.title,
      refId: task.id,
      x: (center ? center.x - DEFAULT_PANEL_WIDTH / 2 : 0) + offset,
      y: (center ? center.y - DEFAULT_PANEL_HEIGHT / 2 : 0) + offset,
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
    })
  }, [canvasPendingTaskId, isLoaded, loadedProjectId])

  // `fitToContent` and `focusPanel` need the container size, which only this
  // component knows. A caller without an element (an agent tool, a voice
  // command) leaves the intent in the store and it is carried out here.
  const pendingViewCommand = useCanvasStore((s) => s.pendingViewCommand)
  useEffect(() => {
    if (!pendingViewCommand) return
    useCanvasStore.getState().clearViewCommand()

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    switch (pendingViewCommand.kind) {
      case 'fit_all':
        fitToContent(rect.width, rect.height)
        return
      case 'reset':
        resetViewport()
        return
      case 'zoom':
        zoomTo(pendingViewCommand.zoom, rect.width / 2, rect.height / 2)
        return
      case 'focus_task': {
        const target = useCanvasStore
          .getState()
          .panels.find((p) => p.type === 'task' && p.refId === pendingViewCommand.taskId)
        if (target) focusPanel(target.id, rect.width, rect.height)
      }
    }
  }, [pendingViewCommand, fitToContent, resetViewport, zoomTo, focusPanel])

  const {
    transformLayerRef,
    gridRef,
    zoomLabelRef,
    coordsLabelRef,
    beginGesture,
    commitViewport,
    queuePan,
    zoomStep,
  } = useViewportGestures(containerRef, viewport, containerSize, zoomTo)

  /** Client coordinates → canvas coordinates, using the live (mid-gesture) viewport. */
  const clientToCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect()
    return containerToCanvas(clientX - rect.left, clientY - rect.top, getLiveViewport())
  }, [])

  const cancelConnecting = useCallback(() => {
    setConnectingFromId(null)
    setMouseCanvasPos(null)
  }, [setConnectingFromId])

  const handleEscape = useCallback(() => {
    if (useCanvasStore.getState().connectingFromId) cancelConnecting()
    setContextMenu(null)
  }, [cancelConnecting])

  const { spaceHeld, ctrlHeld } = useCanvasKeyboard({
    containerRef,
    zoomStep,
    commitViewport,
    resetViewport,
    onEscape: handleEscape,
  })

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      // Flush a still-pending wheel gesture so anything reading the store
      // viewport below (and on the next interaction) sees the current value.
      commitViewport()

      if (contextMenu) {
        setContextMenu(null)
        return
      }

      const isBackground =
        e.target === containerRef.current || (e.target as HTMLElement).dataset?.canvasBg === 'true'

      if (useCanvasStore.getState().connectingFromId && e.button === 0 && isBackground) {
        cancelConnecting()
        return
      }

      // A drawing tool is active: background mousedowns belong to the drawing
      // layer (figure creation), not to panning. Space+drag and middle-button
      // pan still take precedence.
      const drawing = useDrawingStore.getState()
      if (e.button === 0 && !spaceHeld && drawing.activeTool !== 'select') return

      const isMiddle = e.button === 1
      const isLeftOnCanvas = e.button === 0 && isBackground
      const isSpacePan = e.button === 0 && spaceHeld

      if (isLeftOnCanvas && drawing.selectedIds.length > 0) drawing.clearSelection()

      if (isMiddle || isLeftOnCanvas || isSpacePan) {
        e.preventDefault()
        setIsPanning(true)
        beginGesture()
        panStartRef.current = { x: e.clientX, y: e.clientY }
      }
    },
    [spaceHeld, contextMenu, commitViewport, beginGesture, cancelConnecting]
  )

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent) => {
      // Canvas-space cursor for the in-progress connection line.
      if (connectingFromId && containerRef.current) {
        setMouseCanvasPos(clientToCanvas(e.clientX, e.clientY))
      }

      if (!isPanning) return
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      panStartRef.current = { x: e.clientX, y: e.clientY }
      queuePan(dx, dy)
    },
    [isPanning, queuePan, connectingFromId, clientToCanvas]
  )

  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
    // Gesture end — this is the single store write for the whole pan.
    commitViewport()
  }, [commitViewport])

  const openContextMenu = useCallback(
    (clientX: number, clientY: number) => {
      commitViewport()
      const { x: canvasX, y: canvasY } = clientToCanvas(clientX, clientY)
      setContextMenu({ clientX, clientY, canvasX, canvasY })
    },
    [commitViewport, clientToCanvas]
  )

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      if (containerRef.current) openContextMenu(e.clientX, e.clientY)
    },
    [openContextMenu]
  )

  const handleAddClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      const btn = e.currentTarget.getBoundingClientRect()
      if (containerRef.current) openContextMenu(btn.left, btn.bottom + 4)
    },
    [openContextMenu]
  )

  const handleBeaconJump = useCallback(
    (highlight: StatusHighlight) => {
      focusPanel(highlight.panelId, containerSize.width, containerSize.height)
      dismissHighlight(highlight.id)
    },
    [focusPanel, containerSize, dismissHighlight]
  )

  return (
    <div data-canvas-root="true" className="overflow-hidden bg-[var(--canvas-bg)]" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: isPanning || spaceHeld ? 'grabbing' : 'default' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
      >
        {/* Grid dots live on the static container, not under the transform
            (see gridBackgroundStyle). */}
        <div
          ref={gridRef}
          aria-hidden="true"
          className="absolute inset-0"
          style={{ ...gridBackgroundStyle(viewport), pointerEvents: 'none' }}
        />

        <div
          ref={transformLayerRef}
          data-canvas-transform-layer="true"
          style={{
            transform: viewportTransform(viewport),
            transformOrigin: '0 0',
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 0,
          }}
        >
          <SnapGuides />
          <CanvasConnections mouseCanvasPos={mouseCanvasPos} />
          {/* Figures render above edges, below panels. */}
          <DrawingLayer />
          {panels.map((panel, index) => (
            <CanvasPanel
              key={panel.id}
              panel={panel}
              zoom={viewport.zoom}
              frozen={!visiblePanelIds.has(panel.id)}
              panelIndex={index}
              showIndex={ctrlHeld}
            />
          ))}
        </div>

        <div data-canvas-bg="true" className="absolute inset-0" style={{ zIndex: -1 }} />
      </div>

      <StatusBeacons
        highlights={statusHighlights}
        viewport={viewport}
        containerWidth={containerSize.width}
        containerHeight={containerSize.height}
        onJump={handleBeaconJump}
      />

      <CanvasHud
        viewport={viewport}
        zoomLabelRef={zoomLabelRef}
        coordsLabelRef={coordsLabelRef}
        zoomStep={zoomStep}
        resetViewport={resetViewport}
        onAddClick={handleAddClick}
      />

      <CanvasMinimap containerWidth={containerSize.width} containerHeight={containerSize.height} />

      {drawingUiVisible && <DrawingToolbar />}
      {drawingSelectedCount > 0 && <DrawingProperties />}

      {panels.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
          <div className="text-center">
            <div className="text-muted-foreground/30 text-sm font-medium mb-1">
              Infinite Canvas
            </div>
            <div className="text-muted-foreground/20 text-xs">
              Scroll to pan &middot; Pinch or Ctrl+scroll to zoom &middot;
              Right-click to add tasks &amp; apps
            </div>
          </div>
        </div>
      )}

      {contextMenu && <CanvasContextMenu position={contextMenu} onClose={() => setContextMenu(null)} />}
    </div>
  )
}

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useCanvasStore, panViewport, zoomViewportAtPoint } from '@/stores/canvas-store'
import type { Viewport } from '@/stores/canvas-store'
import { setLiveViewport } from '@/stores/canvas-live-viewport'
import { formatViewportCoords, gridBackgroundStyle, viewportTransform } from '../canvas-geometry'

/**
 * Wheel/trackpad gestures have no "end" event. Commit the viewport to the
 * store this long after the last wheel event.
 */
const WHEEL_IDLE_MS = 150

/**
 * Imperative gesture transforms.
 *
 * During a pan/zoom gesture React does ZERO work: the accumulated deltas are
 * applied straight to the transformed layer's `style.transform` (and to the
 * grid background) inside a single rAF, and the resulting viewport is
 * committed to the zustand store exactly once, when the gesture ends.
 *
 * Writing the viewport to the store per frame re-committed the whole canvas
 * subtree — grid, connection curves, minimap and every panel wrapper — 60–120
 * times a second. Now that cost is paid once per gesture and the frames
 * themselves are compositor-bound.
 *
 * Also owns the wheel listener (zoom + trackpad pan), which must be attached
 * natively because React's onWheel is passive and can't preventDefault.
 */
export function useViewportGestures(
  containerRef: RefObject<HTMLDivElement | null>,
  viewport: Viewport,
  containerSize: { width: number; height: number },
  zoomTo: (zoom: number, centerX?: number, centerY?: number) => void
) {
  const transformLayerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const zoomLabelRef = useRef<HTMLSpanElement>(null)
  const coordsLabelRef = useRef<HTMLSpanElement>(null)

  /** Authoritative viewport while a gesture is in flight. */
  const liveViewportRef = useRef<Viewport>(viewport)
  const gestureActiveRef = useRef(false)
  const viewportDirtyRef = useRef(false)
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pendingPanRef = useRef({ dx: 0, dy: 0 })
  const pendingZoomRef = useRef<{ deltaY: number; clientX: number; clientY: number; rect: DOMRect } | null>(null)
  const viewportRafRef = useRef<number | null>(null)

  const applyViewportToDom = useCallback((vp: Viewport) => {
    const layer = transformLayerRef.current
    if (layer) layer.style.transform = viewportTransform(vp)

    const grid = gridRef.current
    if (grid) {
      const bg = gridBackgroundStyle(vp)
      grid.style.backgroundImage = bg.backgroundImage
      grid.style.backgroundSize = bg.backgroundSize
      grid.style.backgroundPosition = bg.backgroundPosition
    }

    // HUD readouts stay live during the gesture without a React render.
    const zoomLabel = zoomLabelRef.current
    if (zoomLabel) zoomLabel.textContent = `${Math.round(vp.zoom * 100)}%`
    const coordsLabel = coordsLabelRef.current
    if (coordsLabel) coordsLabel.textContent = formatViewportCoords(vp)

    // Imperative subscribers (minimap viewport rectangle).
    setLiveViewport(vp)
  }, [])

  // Store → live viewport sync. Runs for every *programmatic* viewport change
  // (keyboard zoom, Ctrl+0, focusPanel, minimap navigation, fitToContent) and
  // for the single commit at the end of a gesture — a no-op re-apply there.
  // Single sync point, so the ref can never drift from the store.
  useEffect(() => {
    liveViewportRef.current = viewport
    applyViewportToDom(viewport)
  }, [viewport, applyViewportToDom])

  // A re-render triggered mid-gesture by something else (a panel updated, a
  // task status streamed in) repaints the transform from the *store* viewport
  // via JSX and would snap the canvas back a frame. Re-assert the live value
  // after every commit while a gesture is running.
  useLayoutEffect(() => {
    if (gestureActiveRef.current) applyViewportToDom(liveViewportRef.current)
  })

  const beginGesture = useCallback(() => {
    if (gestureActiveRef.current) return
    gestureActiveRef.current = true
    // Promote the layer for the duration of the gesture only — a permanent
    // will-change keeps a dedicated compositor layer (and its memory) alive.
    const layer = transformLayerRef.current
    if (layer) layer.style.willChange = 'transform'
  }, [])

  const flushViewportUpdate = useCallback(() => {
    viewportRafRef.current = null
    let next = liveViewportRef.current

    const pan = pendingPanRef.current
    if (pan.dx !== 0 || pan.dy !== 0) {
      pendingPanRef.current = { dx: 0, dy: 0 }
      next = panViewport(next, pan.dx, pan.dy)
    }
    const zoom = pendingZoomRef.current
    if (zoom) {
      pendingZoomRef.current = null
      next = zoomViewportAtPoint(next, zoom.deltaY, zoom.clientX, zoom.clientY, zoom.rect)
    }

    if (next === liveViewportRef.current) return
    liveViewportRef.current = next
    viewportDirtyRef.current = true
    applyViewportToDom(next)
  }, [applyViewportToDom])

  /** End the gesture and commit the live viewport to the store (once). */
  const commitViewport = useCallback(() => {
    if (wheelIdleTimerRef.current != null) {
      clearTimeout(wheelIdleTimerRef.current)
      wheelIdleTimerRef.current = null
    }
    if (viewportRafRef.current != null) {
      cancelAnimationFrame(viewportRafRef.current)
      flushViewportUpdate()
    }
    gestureActiveRef.current = false
    const layer = transformLayerRef.current
    if (layer) layer.style.willChange = ''

    if (!viewportDirtyRef.current) return
    viewportDirtyRef.current = false
    // Store remains the source of truth at rest (and scheduleSave persists it).
    useCanvasStore.getState().setViewport(liveViewportRef.current)
  }, [flushViewportUpdate])

  const scheduleViewportUpdate = useCallback(() => {
    if (viewportRafRef.current != null) return
    viewportRafRef.current = requestAnimationFrame(flushViewportUpdate)
  }, [flushViewportUpdate])

  /**
   * Step-zoom by `factor` around the center of the visible canvas area.
   * Zooming without an anchor point keeps the top-left corner fixed, which
   * makes the content the user is looking at jump across the screen.
   */
  const zoomStep = useCallback(
    (factor: number) => {
      // Flush any in-flight wheel gesture so we zoom from what's on screen.
      commitViewport()
      const zoom = liveViewportRef.current.zoom * factor
      const { width, height } = containerSize
      if (width > 0 && height > 0) {
        zoomTo(zoom, width / 2, height / 2)
      } else {
        zoomTo(zoom)
      }
    },
    [commitViewport, containerSize, zoomTo]
  )

  const queuePan = useCallback(
    (dx: number, dy: number) => {
      pendingPanRef.current.dx += dx
      pendingPanRef.current.dy += dy
      scheduleViewportUpdate()
    },
    [scheduleViewportUpdate]
  )

  const queueZoom = useCallback(
    (deltaY: number, clientX: number, clientY: number, rect: DOMRect) => {
      const pending = pendingZoomRef.current
      pendingZoomRef.current = { deltaY: (pending?.deltaY ?? 0) + deltaY, clientX, clientY, rect }
      scheduleViewportUpdate()
    },
    [scheduleViewportUpdate]
  )

  useEffect(() => {
    return () => {
      if (viewportRafRef.current != null) cancelAnimationFrame(viewportRafRef.current)
      if (wheelIdleTimerRef.current != null) clearTimeout(wheelIdleTimerRef.current)
    }
  }, [])

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const container = containerRef.current
      if (!container) return

      // Let a scrollable element inside a panel consume the wheel while it can
      // still scroll in that direction. Ctrl/Meta+wheel is always zoom.
      if (!(e.ctrlKey || e.metaKey)) {
        let el = e.target as HTMLElement | null
        while (el && el !== container) {
          if (el.dataset?.canvasPanel === 'true') break
          const style = window.getComputedStyle(el)
          const overflowY = style.overflowY
          const overflowX = style.overflowX
          const isScrollableY =
            (overflowY === 'auto' || overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight
          const isScrollableX =
            (overflowX === 'auto' || overflowX === 'scroll') &&
            el.scrollWidth > el.clientWidth

          if (isScrollableY || isScrollableX) {
            const canScrollDown = isScrollableY && e.deltaY > 0 && el.scrollTop < el.scrollHeight - el.clientHeight - 1
            const canScrollUp = isScrollableY && e.deltaY < 0 && el.scrollTop > 0
            const canScrollRight = isScrollableX && e.deltaX > 0 && el.scrollLeft < el.scrollWidth - el.clientWidth - 1
            const canScrollLeft = isScrollableX && e.deltaX < 0 && el.scrollLeft > 0
            if (canScrollDown || canScrollUp || canScrollRight || canScrollLeft) return
          }
          el = el.parentElement
        }
      }

      e.preventDefault()
      beginGesture()

      if (e.ctrlKey || e.metaKey) {
        queueZoom(e.deltaY, e.clientX, e.clientY, container.getBoundingClientRect())
      } else {
        queuePan(-e.deltaX, -e.deltaY)
      }

      // No "wheel end" event exists — commit once the stream goes quiet.
      if (wheelIdleTimerRef.current != null) clearTimeout(wheelIdleTimerRef.current)
      wheelIdleTimerRef.current = setTimeout(commitViewport, WHEEL_IDLE_MS)
    },
    [containerRef, queuePan, queueZoom, beginGesture, commitViewport]
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [containerRef, handleWheel])

  return {
    transformLayerRef,
    gridRef,
    zoomLabelRef,
    coordsLabelRef,
    beginGesture,
    commitViewport,
    queuePan,
    zoomStep,
  }
}

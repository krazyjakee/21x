import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const MIN_WORKSPACE_PANE_WIDTH = 320
const WORKSPACE_RESIZER_WIDTH = 4
/** Fraction of the workspace body given to the transcript by default. Leaves ~40% for the artifacts/details sidebar. */
const DEFAULT_TRANSCRIPT_WIDTH_FRACTION = 0.6
// v3 key: v2 values could be poisoned by drags performed inside scaled canvas
// panels (screen px persisted as if they were local px), pinning the details
// sidebar at ~70% until re-dragged. Bump to give everyone a clean default.
const TRANSCRIPT_WIDTH_STORAGE_KEY = '20x:task:transcriptWidth:v3'

export function clampTranscriptWidth(width: number, containerWidth: number): number {
  const maximum = Math.max(MIN_WORKSPACE_PANE_WIDTH, containerWidth - MIN_WORKSPACE_PANE_WIDTH - WORKSPACE_RESIZER_WIDTH)
  return Math.min(Math.max(MIN_WORKSPACE_PANE_WIDTH, width), maximum)
}

/** User-persisted transcript width, or null when the default 60/40 split should apply. */
function readStoredTranscriptWidth(): number | null {
  const stored = Number(window.localStorage.getItem(TRANSCRIPT_WIDTH_STORAGE_KEY))
  return Number.isFinite(stored) && stored >= MIN_WORKSPACE_PANE_WIDTH ? stored : null
}

function defaultTranscriptWidth(containerWidth: number): number {
  return clampTranscriptWidth(Math.round(containerWidth * DEFAULT_TRANSCRIPT_WIDTH_FRACTION), containerWidth)
}

/** Transcript/sidebar split for the workspace body; only active while the artifacts sidebar is open. */
export function useResizableTranscript(sidebarOpen: boolean) {
  const workspaceBodyRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)
  const [storedWidth] = useState(readStoredTranscriptWidth)
  const [transcriptWidth, setTranscriptWidth] = useState(() => storedWidth ?? defaultTranscriptWidth(window.innerWidth))
  // Whether the user actively resized the panes. While false, the transcript
  // tracks the default 60/40 split as the workspace resizes.
  const hasCustomTranscriptWidthRef = useRef(storedWidth !== null)

  useLayoutEffect(() => {
    if (!sidebarOpen || !workspaceBodyRef.current) return
    const container = workspaceBodyRef.current
    const applyWidth = () => {
      // offsetWidth is the LAYOUT width in local px. getBoundingClientRect()
      // would return scaled screen px on the canvas, where task panels render
      // under a scale(zoom) transform — mixing the two spaces is what pinned
      // the details sidebar at ~70% regardless of dragging.
      const containerWidth = container.offsetWidth
      if (containerWidth <= 0) return
      setTranscriptWidth((current) => {
        // Once the user drags, their width wins (clamped only, never persisted
        // as a system-side effect).
        if (!hasCustomTranscriptWidthRef.current) return defaultTranscriptWidth(containerWidth)
        return clampTranscriptWidth(current, containerWidth)
      })
    }
    applyWidth()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(applyWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [sidebarOpen])

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    resizingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current || !workspaceBodyRef.current) return
    const container = workspaceBodyRef.current
    // clientX/rect are in screen px and include any ancestor transform scale
    // (canvas zoom); the width style is applied in layout px. Convert the
    // pointer position to local px so the pane tracks the cursor and the
    // clamp operates in the same space as the applied width.
    const rect = container.getBoundingClientRect()
    const layoutWidth = container.offsetWidth
    const scale = rect.width > 0 && layoutWidth > 0 ? rect.width / layoutWidth : 1
    const next = clampTranscriptWidth((event.clientX - rect.left) / scale, layoutWidth)
    hasCustomTranscriptWidthRef.current = true
    setTranscriptWidth(next)
  }, [])

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) return
    resizingRef.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    window.localStorage.setItem(TRANSCRIPT_WIDTH_STORAGE_KEY, String(transcriptWidth))
  }, [transcriptWidth])

  return { workspaceBodyRef, transcriptWidth, handleResizeStart, handleResizeMove, handleResizeEnd }
}

import type { MouseEvent, RefObject } from 'react'
import { Move, ZoomIn, ZoomOut, RotateCcw, Plus } from 'lucide-react'
import type { Viewport } from '@/stores/canvas-store'
import { Button } from '@/components/ui/Button'
import { formatViewportCoords } from './canvas-geometry'
import { DIRECTION_ICONS, getOffscreenBeacon, type StatusHighlight } from './status-beacons'

interface CanvasHudProps {
  viewport: Viewport
  /** Written imperatively by useViewportGestures while a gesture is in flight. */
  zoomLabelRef: RefObject<HTMLSpanElement | null>
  coordsLabelRef: RefObject<HTMLSpanElement | null>
  zoomStep: (factor: number) => void
  resetViewport: () => void
  onAddClick: (e: MouseEvent<HTMLButtonElement>) => void
}

/** Zoom controls (bottom-left), Add button (top-left) and viewport coords (top-right). */
export function CanvasHud({ viewport, zoomLabelRef, coordsLabelRef, zoomStep, resetViewport, onAddClick }: CanvasHudProps) {
  return (
    <>
      <div className="absolute bottom-4 left-4 flex items-center gap-1 bg-[var(--canvas-toolbar)] backdrop-blur-sm border border-border/40 rounded-lg p-1 z-10">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => zoomStep(1 / 1.2)} title="Zoom out">
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span ref={zoomLabelRef} className="text-xs text-muted-foreground w-10 text-center tabular-nums">
          {Math.round(viewport.zoom * 100)}%
        </span>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => zoomStep(1.2)} title="Zoom in">
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <div className="w-px h-4 bg-border/30 mx-0.5" />
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={resetViewport} title="Reset view (Ctrl+0)">
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="absolute top-3 left-3 z-10">
        <Button
          size="sm"
          className="h-8 px-3 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm text-xs gap-1.5"
          onClick={onAddClick}
          title="Add to canvas"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Add</span>
        </Button>
      </div>

      <div className="absolute top-3 right-3 flex items-center gap-2 text-[10px] text-muted-foreground/40 z-10 select-none">
        <Move className="h-3 w-3" />
        <span ref={coordsLabelRef} className="tabular-nums">
          {formatViewportCoords(viewport)}
        </span>
      </div>
    </>
  )
}

interface StatusBeaconsProps {
  highlights: StatusHighlight[]
  viewport: Viewport
  containerWidth: number
  containerHeight: number
  onJump: (highlight: StatusHighlight) => void
}

/** Edge buttons pointing at off-screen panels whose task status just changed. */
export function StatusBeacons({ highlights, viewport, containerWidth, containerHeight, onJump }: StatusBeaconsProps) {
  return highlights.map((highlight) => {
    const beacon = getOffscreenBeacon(highlight, viewport, containerWidth, containerHeight)
    if (!beacon) return null
    const DirectionIcon = DIRECTION_ICONS[beacon.direction]
    return (
      <div
        key={`${highlight.id}-beacon`}
        data-canvas-status-edge-highlight="true"
        data-direction={beacon.direction}
        className="absolute z-10"
        style={beacon.style}
        title={highlight.title}
      >
        <button
          type="button"
          className="canvas-status-jump-popup flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white shadow-lg backdrop-blur-sm"
          onClick={(e) => {
            e.stopPropagation()
            onJump(highlight)
          }}
          title={`Jump to ${highlight.title}`}
        >
          <DirectionIcon className="h-4 w-4" />
        </button>
      </div>
    )
  })
}

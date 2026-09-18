import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  type LucideIcon,
} from 'lucide-react'
import type { CanvasPanelData, Viewport } from '@/stores/canvas-store'
import type { Task, TaskStatus } from '@/types'
import { getCanvasTaskStatusStyle, shouldPulseCanvasTaskStatusTransition } from './canvas-status-style'

const STATUS_HIGHLIGHT_MS = 5_000
const DEFAULT_HIGHLIGHT_RGB = '59,130,246'
// Popup placement keeps clear of the HUD chrome along each edge.
const STATUS_POPUP_EDGE_PAD = 28
const STATUS_POPUP_TOP_SAFE = 70
const STATUS_POPUP_BOTTOM_SAFE = 150
const STATUS_POPUP_LEFT_SAFE = 170
const STATUS_POPUP_RIGHT_SAFE = 220

export interface StatusHighlight {
  id: string
  taskId: string
  panelId: string
  title: string
  rgb: string
  x: number
  y: number
  width: number
  height: number
}

type StatusPopupDirection =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

export const DIRECTION_ICONS: Record<StatusPopupDirection, LucideIcon> = {
  left: ArrowLeft,
  right: ArrowRight,
  top: ArrowUp,
  bottom: ArrowDown,
  'top-left': ArrowUpLeft,
  'top-right': ArrowUpRight,
  'bottom-left': ArrowDownLeft,
  'bottom-right': ArrowDownRight,
}

function getVectorDirection(deltaX: number, deltaY: number): StatusPopupDirection {
  const deadZone = 0.35
  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)

  if (absX > absY * deadZone && absY > absX * deadZone) {
    if (deltaX < 0 && deltaY < 0) return 'top-left'
    if (deltaX > 0 && deltaY < 0) return 'top-right'
    if (deltaX < 0 && deltaY > 0) return 'bottom-left'
    return 'bottom-right'
  }
  if (absX >= absY) return deltaX < 0 ? 'left' : 'right'
  return deltaY < 0 ? 'top' : 'bottom'
}

/** Edge beacon pointing at an off-screen highlighted panel, or null if the panel is on screen. */
export function getOffscreenBeacon(
  highlight: StatusHighlight,
  viewport: Viewport,
  containerWidth: number,
  containerHeight: number
): { style: CSSProperties; direction: StatusPopupDirection } | null {
  if (!containerWidth || !containerHeight) return null

  const left = highlight.x * viewport.zoom + viewport.x
  const top = highlight.y * viewport.zoom + viewport.y
  const width = highlight.width * viewport.zoom
  const height = highlight.height * viewport.zoom
  const centerX = left + width / 2
  const centerY = top + height / 2
  const isVisible = left < containerWidth && left + width > 0 && top < containerHeight && top + height > 0
  if (isVisible) return null

  const safeMinX = Math.min(containerWidth - STATUS_POPUP_EDGE_PAD, Math.max(STATUS_POPUP_EDGE_PAD, STATUS_POPUP_LEFT_SAFE))
  const safeMaxX = Math.max(STATUS_POPUP_EDGE_PAD, containerWidth - STATUS_POPUP_RIGHT_SAFE)
  const safeMinY = Math.min(containerHeight - STATUS_POPUP_EDGE_PAD, Math.max(STATUS_POPUP_EDGE_PAD, STATUS_POPUP_TOP_SAFE))
  const safeMaxY = Math.max(STATUS_POPUP_EDGE_PAD, containerHeight - STATUS_POPUP_BOTTOM_SAFE)
  const leftDistance = Math.abs(centerX)
  const rightDistance = Math.abs(centerX - containerWidth)
  const topDistance = Math.abs(centerY)
  const bottomDistance = Math.abs(centerY - containerHeight)
  const nearest = Math.min(leftDistance, rightDistance, topDistance, bottomDistance)
  const side =
    nearest === leftDistance ? 'left'
      : nearest === rightDistance ? 'right'
        : nearest === topDistance ? 'top'
          : 'bottom'
  const x = side === 'left'
    ? STATUS_POPUP_EDGE_PAD
    : side === 'right'
      ? containerWidth - STATUS_POPUP_EDGE_PAD
      : Math.min(safeMaxX, Math.max(safeMinX, centerX))
  const y = side === 'top'
    ? STATUS_POPUP_EDGE_PAD
    : side === 'bottom'
      ? containerHeight - STATUS_POPUP_EDGE_PAD
      : Math.min(safeMaxY, Math.max(safeMinY, centerY))
  return {
    direction: getVectorDirection(centerX - containerWidth / 2, centerY - containerHeight / 2),
    style: {
      left: x,
      top: y,
      transform: 'translate(-50%, -50%)',
      '--canvas-status-rgb': highlight.rgb,
    } as CSSProperties,
  }
}

/**
 * Tracks task status transitions and emits a short-lived highlight for each
 * task panel whose status change warrants a pulse.
 */
export function useStatusHighlights(tasks: Task[], panels: CanvasPanelData[]) {
  const previousTaskStatusRef = useRef(new Map<string, TaskStatus>())
  const [statusHighlights, setStatusHighlights] = useState<StatusHighlight[]>([])

  useEffect(() => {
    const previousStatuses = previousTaskStatusRef.current
    const taskPanels = new Map<string, CanvasPanelData>()
    for (const panel of panels) {
      if (panel.type === 'task' && panel.refId) taskPanels.set(panel.refId, panel)
    }

    for (const task of tasks) {
      const previous = previousStatuses.get(task.id)
      previousStatuses.set(task.id, task.status)
      if (!shouldPulseCanvasTaskStatusTransition(previous, task.status)) continue

      const panel = taskPanels.get(task.id)
      if (!panel) continue

      const highlight: StatusHighlight = {
        id: `${task.id}-${Date.now()}`,
        taskId: task.id,
        panelId: panel.id,
        title: task.title,
        rgb: getCanvasTaskStatusStyle(task.status)?.rgb ?? DEFAULT_HIGHLIGHT_RGB,
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height,
      }
      setStatusHighlights((current) => [...current.filter((item) => item.taskId !== task.id), highlight])
      window.setTimeout(() => {
        setStatusHighlights((current) => current.filter((item) => item.id !== highlight.id))
      }, STATUS_HIGHLIGHT_MS)
    }
  }, [tasks, panels])

  const dismissHighlight = useCallback((id: string) => {
    setStatusHighlights((current) => current.filter((item) => item.id !== id))
  }, [])

  return { statusHighlights, dismissHighlight }
}

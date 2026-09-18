import { useEffect, useState, type RefObject } from 'react'
import { useCanvasStore } from '@/stores/canvas-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { getLiveViewport } from '@/stores/canvas-live-viewport'
import type { DrawingTool } from '../drawing/types'
import { pasteImageAt } from '../drawing/DrawingLayer'
import { containerToCanvas } from '../canvas-geometry'

/** Drawing tool shortcuts (plain keypresses, guarded by isInputFocused). */
const TOOL_SHORTCUTS: Record<string, DrawingTool> = {
  KeyV: 'select',
  KeyR: 'rectangle',
  KeyO: 'ellipse',
  KeyL: 'line',
  KeyA: 'arrow',
  KeyT: 'text',
  KeyI: 'image',
}

interface CanvasKeyboardOptions {
  containerRef: RefObject<HTMLDivElement | null>
  zoomStep: (factor: number) => void
  commitViewport: () => void
  resetViewport: () => void
  /** Escape: cancel connection drawing and close the context menu. */
  onEscape: () => void
}

/**
 * Window-level canvas shortcuts. Returns the modifier state the canvas renders
 * from: Space (pan cursor / space+drag) and Ctrl (panel index badges).
 */
export function useCanvasKeyboard({
  containerRef,
  zoomStep,
  commitViewport,
  resetViewport,
  onEscape,
}: CanvasKeyboardOptions) {
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [ctrlHeld, setCtrlHeld] = useState(false)
  // Tab-cycling position.
  const [focusedPanelIndex, setFocusedPanelIndex] = useState(-1)

  useEffect(() => {
    const focusPanelAt = (idx: number, panelId: string) => {
      const container = containerRef.current
      if (!container) return
      commitViewport()
      const rect = container.getBoundingClientRect()
      useCanvasStore.getState().focusPanel(panelId, rect.width, rect.height)
      setFocusedPanelIndex(idx)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as Element | null
      const tag = (target as HTMLElement | null)?.tagName?.toLowerCase()
      const isXtermFocused = !!target?.closest?.('.xterm')
      const isInputFocused = tag === 'input' || tag === 'textarea' || (target as HTMLElement | null)?.isContentEditable || isXtermFocused
      const mod = e.ctrlKey || e.metaKey

      // Ctrl only, not Cmd.
      if (e.key === 'Control' && !e.repeat) {
        setCtrlHeld(true)
      }
      // Clear stale ctrlHeld if Ctrl was released while OS had focus
      // (e.g. after Ctrl+Cmd+Shift+3 screenshot, OS swallows the keyup)
      if (!e.ctrlKey && e.key !== 'Control') {
        setCtrlHeld(false)
      }

      if (e.code === 'Space' && !e.repeat && !isInputFocused) {
        setSpaceHeld(true)
      }
      // Keyboard viewport changes go through the store (the source of truth at
      // rest); zoomStep/commitViewport flush any in-flight gesture first.
      if (e.code === 'Equal' && mod && !isInputFocused) {
        e.preventDefault()
        zoomStep(1.2)
      }
      if (e.code === 'Minus' && mod && !isInputFocused) {
        e.preventDefault()
        zoomStep(1 / 1.2)
      }
      if (e.code === 'Digit0' && mod && !isInputFocused) {
        e.preventDefault()
        commitViewport()
        resetViewport()
      }

      // Ctrl/Cmd + 1-9: focus panel by index
      if (mod && !e.shiftKey && !e.altKey && !isInputFocused) {
        const digitMatch = e.code.match(/^Digit([1-9])$/)
        if (digitMatch) {
          const idx = parseInt(digitMatch[1], 10) - 1
          const currentPanels = useCanvasStore.getState().panels
          if (idx < currentPanels.length) {
            e.preventDefault()
            focusPanelAt(idx, currentPanels[idx].id)
          }
        }
      }

      // Ctrl/Cmd + (Shift+)Tab: cycle through panels
      if (e.code === 'Tab' && !isInputFocused && mod) {
        e.preventDefault()
        const currentPanels = useCanvasStore.getState().panels
        if (currentPanels.length === 0) return

        const next = e.shiftKey
          ? (focusedPanelIndex <= 0 ? currentPanels.length - 1 : focusedPanelIndex - 1)
          : (focusedPanelIndex >= currentPanels.length - 1 ? 0 : focusedPanelIndex + 1)

        setFocusedPanelIndex(next)
        focusPanelAt(next, currentPanels[next].id)
      }

      // Text editing handles its own Escape while the contentEditable div is
      // focused, so this deliberately isn't guarded by isInputFocused.
      if (e.code === 'Escape') {
        onEscape()
        const drawing = useDrawingStore.getState()
        if (drawing.liveObject) drawing.setLiveObject(null)
        if (drawing.selectedIds.length > 0) drawing.clearSelection()
      }

      if ((e.code === 'Delete' || e.code === 'Backspace') && !isInputFocused) {
        const drawing = useDrawingStore.getState()
        if (drawing.selectedIds.length > 0) {
          e.preventDefault()
          drawing.removeObjects(drawing.selectedIds)
        }
      }

      // Ctrl/Cmd+V: paste a clipboard image at the viewport center
      // (suppressed while typing or editing a text figure).
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyV' && !isInputFocused) {
        if (useDrawingStore.getState().editingTextId) return
        e.preventDefault()
        const container = containerRef.current
        if (container) {
          commitViewport()
          const rect = container.getBoundingClientRect()
          const center = containerToCanvas(rect.width / 2, rect.height / 2, getLiveViewport())
          void pasteImageAt(center.x, center.y)
        }
      }

      if (!isInputFocused && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        const tool = TOOL_SHORTCUTS[e.code]
        if (tool) {
          e.preventDefault()
          useDrawingStore.getState().setTool(tool)
        }
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
      if (e.key === 'Control') setCtrlHeld(false)
    }
    // Keyups are lost when focus leaves the window (e.g. Ctrl+Tab away).
    const handleBlur = () => {
      setCtrlHeld(false)
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [containerRef, zoomStep, resetViewport, focusedPanelIndex, commitViewport, onEscape])

  return { spaceHeld, ctrlHeld }
}

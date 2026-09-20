import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { AudioLines, Maximize2, Mic, MicOff, Move, PhoneOff, RotateCcw, Square } from 'lucide-react'
import { commanderToolSeverity, isCommanderActionUndoable } from '@shared/commander-tools'
import { callEventIdentity } from '@shared/commander-call'
import type { CallTurn } from '@/lib/commander-call/derive-call-state'
import { callUnavailability, deriveCallState } from '@/lib/commander-call/derive-call-state'
import { activityNow, scheduleActivityDeadline, useActivityClock } from '@/lib/activity/activity-clock'
import { useCommanderActivityStore } from '@/lib/activity/commander-activity-adapter'
import { expandCommanderCall, undoLatestCommanderAction } from '@/lib/commander-call/commander-call-ui'
import { useSpeakingRing } from '@/lib/activity/use-speaking-ring'
import { useVoiceActivity } from '@/lib/activity/voice-activity-adapter'
import { humanizeToolName } from './tool-call-label'
import { ActivityRing } from '@/components/activity/ActivityRing'
import { Button } from '@/components/ui/Button'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { selectSpeechReady, selectVoiceSetupComplete, useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'

const TILE_WIDTH = 280
const TILE_HEIGHT = 120
const TILE_MARGIN = 16
const CORNER_KEY = 'commander-pip-corner'
const CORNERS: PictureInPictureCorner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left']

export type PictureInPictureCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export function snapPictureInPictureCorner(
  centerX: number,
  centerY: number,
  viewportWidth: number,
  viewportHeight: number
): PictureInPictureCorner {
  const vertical = centerY < viewportHeight / 2 ? 'top' : 'bottom'
  const horizontal = centerX < viewportWidth / 2 ? 'left' : 'right'
  return `${vertical}-${horizontal}` as PictureInPictureCorner
}

function readCorner(): PictureInPictureCorner {
  try {
    const value = localStorage.getItem(CORNER_KEY)
    if (value === 'top-left' || value === 'top-right' || value === 'bottom-left' || value === 'bottom-right') return value
  } catch { /* use the default */ }
  return 'bottom-right'
}

function cornerStyle(corner: PictureInPictureCorner): CSSProperties {
  return {
    ...(corner.startsWith('top') ? { top: TILE_MARGIN } : { bottom: TILE_MARGIN }),
    ...(corner.endsWith('left') ? { left: TILE_MARGIN } : { right: TILE_MARGIN })
  }
}

interface ScrollportSize {
  width: number
  height: number
}

/** The visible CSS-pixel scrollport, excluding classic scrollbar gutters. */
export function readPictureInPictureScrollport(): ScrollportSize {
  const root = typeof document === 'undefined' ? null : document.documentElement
  const visual = typeof window === 'undefined' ? null : window.visualViewport
  const widths = [root?.clientWidth, visual?.width, typeof window === 'undefined' ? undefined : window.innerWidth]
    .filter((value): value is number => typeof value === 'number' && value > 0)
  const heights = [root?.clientHeight, visual?.height, typeof window === 'undefined' ? undefined : window.innerHeight]
    .filter((value): value is number => typeof value === 'number' && value > 0)
  return {
    width: widths.length ? Math.min(...widths) : TILE_WIDTH + TILE_MARGIN * 2,
    height: heights.length ? Math.min(...heights) : TILE_HEIGHT + TILE_MARGIN * 2
  }
}

function useScrollportSize(): ScrollportSize {
  const [size, setSize] = useState(readPictureInPictureScrollport)
  useEffect(() => {
    const update = (): void => setSize(readPictureInPictureScrollport())
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (observer) observer.observe(document.documentElement)
    update()
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [])
  return size
}

function displayValue(value: unknown): string {
  if (value === null) return 'None'
  if (typeof value === 'string') return value || 'Empty'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'None'
  return JSON.stringify(value) ?? String(value)
}

function asCallTurn(
  observation: ReturnType<typeof useCommanderActivityStore.getState>['sessions'][string] | undefined
): CallTurn | null {
  if (!observation) return null
  return {
    phase: observation.phase,
    ...(observation.openTools.length > 0
      ? { toolName: observation.openTools[observation.openTools.length - 1].name }
      : {})
  }
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  left: number
  top: number
}

/** App-level in-app PiP. It observes the existing call and never owns media. */
export function CommanderPictureInPicture() {
  const call = useCommanderCallStore()
  const sidebarView = useUIStore((s) => s.sidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const captionsEnabled = useUIStore((s) => s.commanderCaptionsEnabled)
  const recoverable = call.status === 'off' && Boolean(call.error && call.retrySessionId)
  const visible = (call.status !== 'off' || recoverable) && (sidebarView !== 'commander' || activeModal === 'settings')
  const previousView = useRef(sidebarView)
  useEffect(() => {
    const leftCommander = previousView.current === 'commander' && sidebarView !== 'commander'
    if (visible && leftCommander && document.activeElement === document.body) {
      window.setTimeout(() => document.querySelector<HTMLElement>('[data-commander-pip-expand]')?.focus(), 0)
    }
    previousView.current = sidebarView
  }, [visible, sidebarView])
  const callSessionId = call.sessionId ?? call.retrySessionId
  const observation = useCommanderActivityStore((s) => (callSessionId ? s.sessions[callSessionId] : undefined))
  const voiceTarget = useMemo(
    () => (callSessionId ? { kind: 'commander' as const, id: callSessionId } : null),
    [callSessionId]
  )
  const voice = useVoiceActivity(voiceTarget)
  const ring = useRef<HTMLSpanElement>(null)
  useSpeakingRing(ring, visible ? voiceTarget : null)

  const available = useVoiceStore((s) => s.available)
  const permission = useVoiceStore((s) => s.permission)
  const runtimeInstalled = useVoiceStore((s) => s.runtime.installed)
  const setupComplete = useVoiceStore(selectVoiceSetupComplete)
  const speechOutput = useVoiceStore(selectSpeechReady)
  const voiceTurnId = useVoiceStore((s) => s.turnId)
  const voiceState = useVoiceStore((s) => s.state)
  const partial = useVoiceStore((s) => s.partial ?? '')
  const final = useVoiceStore((s) => s.final ?? '')
  const speechText = useVoiceStore((s) => s.speechText ?? '')
  const tick = useActivityClock((s) => s.tick)

  const ownMicrophone = call.status === 'live' && Boolean(call.turnId) && voiceTurnId === call.turnId
  const presentation = useMemo(() => {
    void tick
    return deriveCallState({
      call: {
        status: call.status,
        error: call.error,
        interruptedAt: call.interruptedAt,
        lastEvent: call.lastEvent
      },
      unavailable: callUnavailability({
        bridge: available,
        sessionId: callSessionId,
        permission,
        runtimeInstalled,
        setupComplete
      }),
      mic: { open: ownMicrophone, voiceState, partial },
      speech: voice?.state ?? 'none',
      speechOutput,
      turn: asCallTurn(observation),
      now: activityNow()
    })
  }, [
    tick,
    call.status,
    call.error,
    call.interruptedAt,
    call.lastEvent,
    callSessionId,
    available,
    permission,
    runtimeInstalled,
    setupComplete,
    ownMicrophone,
    voiceState,
    partial,
    voice?.state,
    speechOutput,
    observation
  ])
  useEffect(() => scheduleActivityDeadline(presentation.expiresAt), [presentation.expiresAt])

  const ownedSpeechText = voice?.state === 'speaking' ? speechText.trim() : ''
  const caption = ownedSpeechText || (ownMicrophone ? (partial.trim() || final.trim()) : '')
  const captionOwner = ownedSpeechText ? 'Commander' : caption ? 'You' : null
  const action = presentation.event?.kind === 'action' ? presentation.event : null
  const actionIdentity = action ? callEventIdentity(action) : null
  const [undoing, setUndoing] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const currentActionIdentity = useRef(actionIdentity)
  currentActionIdentity.current = actionIdentity
  useEffect(() => {
    setUndoing(false)
    setUndoError(null)
  }, [actionIdentity])

  const [corner, setCorner] = useState<PictureInPictureCorner>(readCorner)
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null)
  const viewport = useScrollportSize()
  const compact = viewport.width < TILE_WIDTH + TILE_MARGIN * 2 || viewport.height < 240
  const tileWidth = Math.max(1, Math.min(TILE_WIDTH, viewport.width - TILE_MARGIN * 2))
  const tile = useRef<HTMLElement>(null)
  const drag = useRef<DragState | null>(null)

  useEffect(() => {
    setPoint((current) => {
      if (!current) return current
      const rect = tile.current?.getBoundingClientRect()
      const width = rect?.width || tileWidth
      const height = rect?.height || TILE_HEIGHT
      const left = Math.max(TILE_MARGIN, Math.min(viewport.width - width - TILE_MARGIN, current.left))
      const top = Math.max(TILE_MARGIN, Math.min(viewport.height - height - TILE_MARGIN, current.top))
      return left === current.left && top === current.top ? current : { left, top }
    })
  }, [tileWidth, viewport.width, viewport.height])

  const saveCorner = (next: PictureInPictureCorner): void => {
    setPoint(null)
    setCorner(next)
    try { localStorage.setItem(CORNER_KEY, next) } catch { /* placement still works */ }
  }

  const moveCorner = (event?: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event) {
      const vertical = corner.startsWith('top') ? 'top' : 'bottom'
      const horizontal = corner.endsWith('left') ? 'left' : 'right'
      let next: PictureInPictureCorner | null = null
      if (event.key === 'ArrowLeft') next = `${vertical}-left` as PictureInPictureCorner
      else if (event.key === 'ArrowRight') next = `${vertical}-right` as PictureInPictureCorner
      else if (event.key === 'ArrowUp') next = `top-${horizontal}` as PictureInPictureCorner
      else if (event.key === 'ArrowDown') next = `bottom-${horizontal}` as PictureInPictureCorner
      else if (event.key === 'Home') next = 'top-left'
      else if (event.key === 'End') next = 'bottom-right'
      if (!next) return
      event.preventDefault()
      saveCorner(next)
      return
    }
    saveCorner(CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length])
  }

  const dragPoint = (event: ReactPointerEvent): { left: number; top: number } | null => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return null
    const rect = tile.current?.getBoundingClientRect()
    const width = rect?.width || tileWidth
    const height = rect?.height || TILE_HEIGHT
    return {
      left: Math.max(TILE_MARGIN, Math.min(viewport.width - width - TILE_MARGIN, current.left + event.clientX - current.startX)),
      top: Math.max(TILE_MARGIN, Math.min(viewport.height - height - TILE_MARGIN, current.top + event.clientY - current.startY))
    }
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    const rect = tile.current?.getBoundingClientRect()
    if (!rect) return
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPoint({ left: rect.left, top: rect.top })
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const next = dragPoint(event)
    if (next) setPoint(next)
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const next = dragPoint(event)
    if (!next) return
    const snapped = snapPictureInPictureCorner(
      next.left + (tile.current?.getBoundingClientRect().width ?? tileWidth) / 2,
      next.top + (tile.current?.getBoundingClientRect().height ?? TILE_HEIGHT) / 2,
      viewport.width,
      viewport.height
    )
    drag.current = null
    saveCorner(snapped)
  }

  const undo = async (): Promise<void> => {
    const mine = actionIdentity
    if (!mine) return
    setUndoing(true)
    setUndoError(null)
    try {
      await undoLatestCommanderAction()
    } catch (error) {
      if (currentActionIdentity.current === mine) {
        setUndoError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (currentActionIdentity.current === mine) setUndoing(false)
    }
  }

  if (!visible) return null

  const severity = action ? commanderToolSeverity(action.toolName) : 'neutral'
  const toastBelow = compact || (point ? point.top < viewport.height / 2 : corner.startsWith('top'))
  const activity = {
    state: presentation.activity,
    label: presentation.label,
    tone: presentation.tone,
    accent: false,
    expiresAt: presentation.expiresAt
  }

  return (
    <aside
      ref={tile}
      aria-label="Commander picture in picture"
      data-testid="commander-pip"
      data-corner={corner}
      className={`fixed z-[70] box-border rounded-2xl border border-border bg-card/98 shadow-float backdrop-blur ${compact ? 'overflow-y-auto p-2' : 'p-3'}`}
      style={{
        ...(point ? { left: point.left, top: point.top } : cornerStyle(corner)),
        width: tileWidth,
        maxHeight: Math.max(1, viewport.height - TILE_MARGIN * 2)
      }}
    >
      {action && (
        <div
          role={severity === 'destructive' ? 'alert' : 'status'}
          aria-live={severity === 'destructive' ? 'assertive' : 'polite'}
          className={`${compact ? 'relative mb-2 max-h-16 overflow-y-auto p-2' : `absolute inset-x-0 p-3 ${toastBelow ? 'top-full mt-2' : 'bottom-full mb-2'}`} rounded-xl border bg-card shadow-lg ${severity === 'destructive' ? 'border-destructive/40' : severity === 'wide-reaching' ? 'border-amber-500/40' : 'border-border'}`}
          data-testid="commander-action-toast"
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Action taken</p>
              <p className="truncate text-sm font-medium">
                {humanizeToolName(action.toolName)}
                {action.action?.target.name ? ` · ${action.action.target.name}` : ''}
              </p>
            </div>
            {isCommanderActionUndoable(action.toolName) && (
              <Button size="sm" variant="outline" disabled={undoing} onClick={() => void undo()}>
                <RotateCcw className="size-3.5" aria-hidden="true" />
                {undoing ? 'Undoing…' : 'Undo'}
              </Button>
            )}
          </div>
          {action.action?.changes.slice(0, compact ? 1 : 2).map((change) => (
            <p key={change.field} className="mt-1 truncate text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{change.field}</span>: {displayValue(change.before)} <span aria-label="changed to">→</span> {displayValue(change.after)}
            </p>
          ))}
          {undoError && <p role="alert" className="mt-2 text-xs text-destructive">{undoError}</p>}
        </div>
      )}

      {(!compact || (!action && presentation.state !== 'error')) && (
        <>
          <div
            className="flex cursor-move touch-none select-none items-center gap-2"
            aria-label="Drag Commander picture in picture"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            <ActivityRing result={activity} entityKey="commander" region="commander-pip" size={32} levelDriven elementRef={ring}>
              <span className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-primary via-primary/75 to-violet-500">
                <AudioLines className="size-4 text-white" aria-hidden="true" />
              </span>
            </ActivityRing>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">Commander</p>
              <p className="truncate text-xs text-muted-foreground" role="status">{presentation.label}</p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Move Commander picture in picture. Current position: ${corner.replace('-', ' ')}`}
              title="Move to the next corner. Arrow keys choose a side."
              onClick={() => moveCorner()}
              onKeyDown={moveCorner}
            >
              <Move className="size-4" aria-hidden="true" />
            </Button>
          </div>

          <p className="mt-2 h-5 truncate text-xs text-foreground" aria-label={!captionsEnabled ? 'Captions off' : captionOwner && caption ? `${captionOwner}: ${caption}` : 'No current caption'}>
            {!captionsEnabled
              ? <span className="text-muted-foreground">Captions off</span>
              : captionOwner && caption
                ? <><span className="font-semibold text-muted-foreground">{captionOwner}:</span> {caption}</>
                : <span className="text-muted-foreground">Captions will appear here</span>}
          </p>
        </>
      )}

      {presentation.state === 'error' && (
        <div role="alert" className="mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <p className="line-clamp-2">{presentation.detail ?? presentation.label}</p>
        </div>
      )}

      <div className={`${compact ? '' : 'mt-2'} flex min-w-0 flex-wrap items-center gap-1`} role="toolbar" aria-label="Commander picture in picture controls">
        {presentation.controls.retry ? (
          <Button size="sm" variant="outline" onClick={() => void call.retry()}>
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Retry
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            disabled={call.status !== 'live'}
            aria-label={ownMicrophone ? 'Mute microphone' : 'Unmute microphone'}
            aria-pressed={ownMicrophone}
            onClick={() => void call.toggleMicrophone()}
          >
            {ownMicrophone ? <Mic className="size-4" aria-hidden="true" /> : <MicOff className="size-4" aria-hidden="true" />}
          </Button>
        )}
        <Button size="icon" variant="ghost" disabled={!presentation.controls.stop} aria-label="Stop Commander" onClick={() => call.interrupt('stop')}>
          <Square className="size-3.5" aria-hidden="true" />
        </Button>
        <Button data-commander-pip-expand size="icon" variant="ghost" aria-label="Expand Commander call" onClick={expandCommanderCall}>
          <Maximize2 className="size-4" aria-hidden="true" />
        </Button>
        <Button className="ml-auto" size="sm" variant="destructive" aria-label="End Commander call" onClick={() => call.end()}>
          <PhoneOff className="size-4" aria-hidden="true" />
          End
        </Button>
      </div>
    </aside>
  )
}

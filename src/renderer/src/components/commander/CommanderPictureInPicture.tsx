import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { AudioLines, Maximize2, Mic, MicOff, PhoneOff, RotateCcw, Square } from 'lucide-react'
import { commanderToolSeverity, isCommanderActionUndoable } from '@shared/commander-tools'
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
  const visible = call.status !== 'off' && (sidebarView !== 'commander' || activeModal === 'settings')
  const previousView = useRef(sidebarView)
  useEffect(() => {
    const leftCommander = previousView.current === 'commander' && sidebarView !== 'commander'
    if (visible && leftCommander && document.activeElement === document.body) {
      window.setTimeout(() => document.querySelector<HTMLElement>('[data-commander-pip-expand]')?.focus(), 0)
    }
    previousView.current = sidebarView
  }, [visible, sidebarView])
  const callSessionId = call.sessionId
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

  const caption = speechText.trim() || (ownMicrophone ? (partial.trim() || final.trim()) : '')
  const captionOwner = speechText.trim() ? 'Commander' : caption ? 'You' : null
  const action = presentation.event?.kind === 'action' ? presentation.event : null
  const [undoing, setUndoing] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  useEffect(() => {
    setUndoing(false)
    setUndoError(null)
  }, [action?.toolCallId])

  const [corner, setCorner] = useState<PictureInPictureCorner>(readCorner)
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null)
  const tile = useRef<HTMLElement>(null)
  const drag = useRef<DragState | null>(null)

  const dragPoint = (event: ReactPointerEvent): { left: number; top: number } | null => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return null
    return {
      left: Math.max(TILE_MARGIN, Math.min(window.innerWidth - TILE_WIDTH - TILE_MARGIN, current.left + event.clientX - current.startX)),
      top: Math.max(TILE_MARGIN, Math.min(window.innerHeight - TILE_HEIGHT - TILE_MARGIN, current.top + event.clientY - current.startY))
    }
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
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
      next.left + TILE_WIDTH / 2,
      next.top + TILE_HEIGHT / 2,
      window.innerWidth,
      window.innerHeight
    )
    drag.current = null
    setPoint(null)
    setCorner(snapped)
    try { localStorage.setItem(CORNER_KEY, snapped) } catch { /* placement still works */ }
  }

  const undo = async (): Promise<void> => {
    setUndoing(true)
    setUndoError(null)
    try {
      await undoLatestCommanderAction()
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : String(error))
    } finally {
      setUndoing(false)
    }
  }

  if (!visible) return null

  const severity = action ? commanderToolSeverity(action.toolName) : 'neutral'
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
      className="fixed z-[70] w-[280px] rounded-2xl border border-border bg-card/98 p-3 shadow-float backdrop-blur"
      style={point ? { left: point.left, top: point.top } : cornerStyle(corner)}
    >
      {action && (
        <div
          role={severity === 'destructive' ? 'alert' : 'status'}
          aria-live={severity === 'destructive' ? 'assertive' : 'polite'}
          className={`absolute left-0 w-[280px] rounded-xl border bg-card p-3 shadow-lg ${corner.startsWith('top') ? 'top-full mt-2' : 'bottom-full mb-2'} ${severity === 'destructive' ? 'border-destructive/40' : severity === 'wide-reaching' ? 'border-amber-500/40' : 'border-border'}`}
          data-testid="commander-action-toast"
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Action taken</p>
              <p className="truncate text-sm font-medium">{humanizeToolName(action.toolName)}</p>
            </div>
            {isCommanderActionUndoable(action.toolName) && (
              <Button size="sm" variant="outline" disabled={undoing} onClick={() => void undo()}>
                <RotateCcw className="size-3.5" aria-hidden="true" />
                {undoing ? 'Undoing…' : 'Undo'}
              </Button>
            )}
          </div>
          {undoError && <p role="alert" className="mt-2 text-xs text-destructive">{undoError}</p>}
        </div>
      )}

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
      </div>

      <p className="mt-2 h-5 truncate text-xs text-foreground" aria-label={!captionsEnabled ? 'Captions off' : captionOwner && caption ? `${captionOwner}: ${caption}` : 'No current caption'}>
        {!captionsEnabled
          ? <span className="text-muted-foreground">Captions off</span>
          : captionOwner && caption
            ? <><span className="font-semibold text-muted-foreground">{captionOwner}:</span> {caption}</>
            : <span className="text-muted-foreground">Captions will appear here</span>}
      </p>

      <div className="mt-2 flex items-center gap-1" role="toolbar" aria-label="Commander picture in picture controls">
        <Button
          size="icon"
          variant="ghost"
          aria-label={ownMicrophone ? 'Mute microphone' : 'Unmute microphone'}
          aria-pressed={ownMicrophone}
          onClick={() => void call.toggleMicrophone()}
        >
          {ownMicrophone ? <Mic className="size-4" aria-hidden="true" /> : <MicOff className="size-4" aria-hidden="true" />}
        </Button>
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

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  AudioLines,
  Captions,
  ChevronDown,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  PanelRight,
  PhoneOff,
  Settings,
  Shrink,
  Square
} from 'lucide-react'
import type { ActivityResult } from '@/lib/activity/derive-activity'
import { Button } from '@/components/ui/Button'
import { ActivityBadge } from '@/components/activity/ActivityBadge'
import { ActivityRing } from '@/components/activity/ActivityRing'
import { activityNow, scheduleActivityDeadline, useActivityClock } from '@/lib/activity/activity-clock'
import { useCommanderActivityStore } from '@/lib/activity/commander-activity-adapter'
import { useVoiceActivity } from '@/lib/activity/voice-activity-adapter'
import { useSpeakingRing } from '@/lib/activity/use-speaking-ring'
import { callUnavailability, deriveCallState, type CallPresentation, type CallTurn } from '@/lib/commander-call/derive-call-state'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderStore } from '@/stores/commander-store'
import { selectSpeechReady, selectVoiceSetupComplete, useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { MICROPHONE_BUSY_MESSAGE } from './CommanderCallHost'
import { enterCommanderPictureInPicture } from '@/lib/commander-call/commander-call-ui'

export { COMMANDER_VOICE_COMPOSER_KEY } from '@/stores/commander-call-store'
export { MICROPHONE_BUSY_MESSAGE }

/** Why Commander voice cannot start, or may not, in words the user can act on (#83). */
export interface CommanderVoiceReadiness {
  label: string
  problem: string
  /** False when clicking is itself the retry for a failed speech engine. */
  blocking: boolean
}

/** Visible readiness from the real microphone path, not only saved setup. */
export function commanderVoiceReadiness(state: {
  available: boolean
  permission: string
  runtimeInstalled: boolean
  setupComplete: boolean
  engine: { state: string; message?: string }
}): CommanderVoiceReadiness | null {
  if (!state.available) {
    return { label: 'Voice unavailable', problem: 'Voice input is not available in this build of 21x.', blocking: true }
  }
  if (state.permission === 'denied') {
    return {
      label: 'Mic blocked',
      problem: 'Microphone access is blocked. Allow it in the system privacy settings, then try again.',
      blocking: true
    }
  }
  if (!state.runtimeInstalled) {
    return {
      label: 'Voice not installed',
      problem: 'Install the local speech runtime in Settings → Voice so Commander can hear you.',
      blocking: true
    }
  }
  if (state.engine.state === 'error') {
    const reason = state.engine.message?.trim() || 'The speech engine failed to start.'
    return {
      label: 'Voice engine error',
      problem: `${/[.!?…]$/.test(reason) ? reason : `${reason}.`} Click the voice button to try again, or repair it in Settings → Voice.`,
      blocking: false
    }
  }
  if (!state.setupComplete) {
    return {
      label: 'Voice not set up',
      problem: state.engine.message?.trim() || 'Turn on voice input and choose a speech model in Settings → Voice.',
      blocking: true
    }
  }
  return null
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

function activityResult(presentation: CallPresentation): ActivityResult {
  return {
    state: presentation.activity,
    label: presentation.label,
    ...(presentation.detail ? { detail: presentation.detail } : {}),
    tone: presentation.tone,
    accent: false,
    expiresAt: presentation.expiresAt
  }
}

function Meter({ level, muted }: { level: number; muted: boolean }) {
  const safeLevel = muted ? 0 : Math.max(0, Math.min(1, level || 0))
  return (
    <span className="flex h-5 items-end gap-0.5" aria-label={muted ? 'Microphone muted' : `Microphone level ${Math.round(safeLevel * 100)} percent`}>
      {[0.16, 0.38, 0.62, 0.84].map((threshold, index) => (
        <span
          key={threshold}
          aria-hidden="true"
          className={`w-1 rounded-full ${safeLevel >= threshold ? 'bg-primary' : 'bg-muted-foreground/25'}`}
          style={{ height: 5 + index * 3 }}
        />
      ))}
    </span>
  )
}

function CallCaptions({
  enabled,
  ownMicrophone,
  partial,
  final,
  speechText,
  speaking
}: {
  enabled: boolean
  ownMicrophone: boolean
  partial: string
  final: string
  speechText: string
  speaking: boolean
}) {
  if (!enabled) return null
  const userText = ownMicrophone ? (partial.trim() || final.trim()) : ''
  const text = speechText.trim() || userText
  const who = speechText.trim() ? 'Commander' : userText ? 'You' : ''
  const isPartial = Boolean(ownMicrophone && partial.trim() && !speechText.trim())
  return (
    <div
      className="mx-auto min-h-[3.25rem] w-full max-w-3xl rounded-2xl border border-border/70 bg-background/75 px-4 py-2.5 shadow-sm backdrop-blur"
      data-testid="commander-captions"
    >
      {text ? (
        <p className={`line-clamp-2 text-center text-sm leading-5 ${isPartial ? 'italic text-muted-foreground' : 'text-foreground'}`} aria-label={`${who}: ${text}`}>
          <span className="mr-1 font-semibold not-italic text-muted-foreground">{who}:</span>
          {speechText.trim() && speaking ? <mark className="rounded bg-primary/15 px-0.5 text-foreground">{text}</mark> : text}
        </p>
      ) : (
        <p className="text-center text-sm text-muted-foreground/70">Captions will appear here</p>
      )}
    </div>
  )
}

function eventChip(presentation: CallPresentation): string | null {
  if (presentation.event?.kind === 'action') return `Action taken · ${presentation.event.toolName}`
  if (presentation.event?.kind === 'report') return `Report from ${presentation.event.projectId ?? 'a project'}`
  return null
}

export interface CommanderVoiceControlsProps {
  captionsEnabled?: boolean
  onCaptionsEnabledChange?: (enabled: boolean) => void
  panelOpen?: boolean
  onPanelOpenChange?: (open: boolean) => void
}

/**
 * The full Commander call stage. AppLayout's CommanderCallHost still owns all
 * media; this surface only derives presentation and sends store actions.
 */
export function CommanderVoiceControls({
  captionsEnabled: controlledCaptions,
  onCaptionsEnabledChange,
  panelOpen: controlledPanel,
  onPanelOpenChange
}: CommanderVoiceControlsProps = {}) {
  const [localCaptions, setLocalCaptions] = useState(true)
  const [localPanel, setLocalPanel] = useState(true)
  const captionsEnabled = controlledCaptions ?? localCaptions
  const panelOpen = controlledPanel ?? localPanel
  const setCaptionsEnabled = onCaptionsEnabledChange ?? setLocalCaptions
  const setPanelOpen = onPanelOpenChange ?? setLocalPanel

  const selectedSessionId = useCommanderStore((s) => s.selectedSessionId)
  const call = useCommanderCallStore()
  const callSessionId = call.sessionId
  const observation = useCommanderActivityStore((s) => (callSessionId ? s.sessions[callSessionId] : undefined))
  const voiceTarget = useMemo(
    () => (callSessionId ? { kind: 'commander' as const, id: callSessionId } : null),
    [callSessionId]
  )
  const voice = useVoiceActivity(voiceTarget)
  const speakingRing = useRef<HTMLSpanElement>(null)
  useSpeakingRing(speakingRing, voiceTarget)

  const available = useVoiceStore((s) => s.available)
  const permission = useVoiceStore((s) => s.permission)
  const runtime = useVoiceStore((s) => s.runtime)
  const engine = useVoiceStore((s) => s.engine)
  const setupComplete = useVoiceStore(selectVoiceSetupComplete)
  const speechOutput = useVoiceStore(selectSpeechReady)
  const voiceTurnId = useVoiceStore((s) => s.turnId)
  const voiceState = useVoiceStore((s) => s.state)
  const partial = useVoiceStore((s) => s.partial ?? '')
  const final = useVoiceStore((s) => s.final ?? '')
  const level = useVoiceStore((s) => s.level ?? 0)
  const speaking = useVoiceStore((s) => Boolean(s.speaking))
  const speechText = useVoiceStore((s) => s.speechText ?? '')

  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const tick = useActivityClock((s) => s.tick)
  const [localProblem, setLocalProblem] = useState<string | null>(null)
  const setupLabelId = useId()

  const readiness = commanderVoiceReadiness({
    available,
    permission,
    runtimeInstalled: runtime.installed,
    setupComplete,
    engine
  })
  const unavailable = callUnavailability({
    bridge: available,
    sessionId: selectedSessionId,
    permission,
    runtimeInstalled: runtime.installed,
    setupComplete,
    engineMessage: engine.state === 'error' || engine.state === 'model_missing' ? engine.message : undefined
  })

  const presentation = useMemo(() => {
    void tick
    return deriveCallState({
      call: {
        status: call.status,
        error: call.error,
        interruptedAt: call.interruptedAt,
        lastEvent: call.lastEvent
      },
      unavailable,
      mic: {
        open: call.status === 'live' && Boolean(call.turnId) && voiceTurnId === call.turnId,
        voiceState,
        partial
      },
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
    call.turnId,
    unavailable,
    voiceTurnId,
    voiceState,
    partial,
    voice?.state,
    speechOutput,
    observation
  ])

  useEffect(() => scheduleActivityDeadline(presentation.expiresAt), [presentation.expiresAt])

  const openVoiceSettings = useCallback(() => {
    setLocalProblem(null)
    call.dismissError()
    setSettingsTab(SettingsTab.VOICE)
    openSettings()
  }, [call.dismissError, openSettings, setSettingsTab])

  const typeInstead = useCallback(() => {
    setLocalProblem(null)
    call.end()
    setPanelOpen(true)
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the Commander"]')?.focus()
    }, 0)
  }, [call.end, setPanelOpen])

  const toggle = useCallback(() => {
    setLocalProblem(null)
    const sameCall = call.status !== 'off' && call.sessionId === selectedSessionId
    if (sameCall) {
      void call.toggleMicrophone()
      return
    }
    if (readiness?.blocking) {
      setLocalProblem(readiness.problem)
      return
    }
    if (selectedSessionId) void call.start(selectedSessionId)
  }, [call.status, call.sessionId, call.toggleMicrophone, call.start, selectedSessionId, readiness?.blocking, readiness?.problem])

  const sameCall = call.status !== 'off' && call.sessionId === selectedSessionId
  const ownMicrophone = sameCall && Boolean(call.turnId) && voiceTurnId === call.turnId
  const busy = call.status === 'starting' || presentation.state === 'transcribing'
  const setupLabel = readiness?.label ?? null
  const setupProblem = readiness?.problem ?? null
  const visibleProblem = localProblem ?? (presentation.state === 'error' ? presentation.detail ?? presentation.label : null)
  const settingsCanFixError = presentation.state === 'error' && Boolean(
    readiness?.label === 'Voice engine error' ||
    (visibleProblem && visibleProblem !== MICROPHONE_BUSY_MESSAGE && /microphone|speech worker|speech engine|device disconnected/i.test(visibleProblem))
  )
  const result = activityResult(presentation)
  const chip = eventChip(presentation)
  // Half-heard words have one visual owner: the captions strip. The presence
  // status keeps the stable state word so a partial is never repeated.
  const statusText = call.status === 'starting' ? 'Starting voice conversation…' : null

  const toolbarKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-toolbar-item]')]
      .filter((item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true')
    if (controls.length === 0) return
    const current = controls.indexOf(document.activeElement as HTMLElement)
    let next = current
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = controls.length - 1
    else if (event.key === 'ArrowRight') next = current < 0 ? 0 : (current + 1) % controls.length
    else next = current < 0 ? controls.length - 1 : (current - 1 + controls.length) % controls.length
    event.preventDefault()
    controls[next]?.focus()
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col px-4 py-5 sm:px-7"
      aria-label="Commander call stage"
      data-testid="commander-voice-controls"
      data-call-state={presentation.state}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="grid w-full max-w-3xl grid-cols-1 items-center gap-5 sm:grid-cols-[1fr_auto]">
          <div className="relative flex min-h-64 flex-col items-center justify-center rounded-[2rem] border border-border/70 bg-gradient-to-b from-muted/35 to-background px-6 py-8 shadow-sm">
            {chip && (
              <div className="absolute left-4 top-4 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary" data-testid="commander-call-event">
                {chip}
              </div>
            )}
            <ActivityRing
              result={result}
              entityKey="commander"
              region="commander-stage"
              size={64}
              levelDriven
              elementRef={speakingRing}
            >
              <span className="relative grid size-14 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-primary via-primary/75 to-violet-500 shadow-inner">
                <span aria-hidden="true" className="absolute -left-2 top-1 size-8 rounded-full bg-white/20 blur-sm" />
                <span aria-hidden="true" className="absolute -bottom-3 -right-1 size-10 rounded-full bg-black/15 blur-sm" />
                <AudioLines className="relative size-7 text-white" aria-hidden="true" />
              </span>
            </ActivityRing>
            <h2 className="mt-4 text-base font-semibold">Commander</h2>
            <div
              role="status"
              data-testid={sameCall ? 'commander-voice-status' : undefined}
              className="mt-2 flex min-h-6 flex-wrap items-center justify-center gap-2 text-center"
            >
              <ActivityBadge
                result={result}
                entityName="Commander"
                entityKey="commander"
                region="commander-stage-badge"
                allowMotion={false}
              />
              {statusText && <span className="text-xs text-muted-foreground">{statusText}</span>}
              {presentation.textOnly && <span className="text-xs text-muted-foreground">Text only</span>}
            </div>

            {!sameCall && setupLabel && (
              <button
                type="button"
                id={setupLabelId}
                onClick={openVoiceSettings}
                title={`${setupProblem ?? ''} Click to open Settings → Voice.`.trim()}
                className="mt-3 rounded-md px-2 py-1 text-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="commander-voice-setup"
              >
                {setupLabel}
              </button>
            )}
            {!sameCall && !readiness && selectedSessionId && (
              <p className="mt-3 text-xs text-muted-foreground">Start talking when you’re ready.</p>
            )}
          </div>

          <div className="justify-self-end rounded-2xl border border-border/70 bg-card p-3 shadow-sm sm:w-40">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full bg-muted text-sm font-semibold" aria-hidden="true">
                Y
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">You</p>
                <div className="mt-1 flex items-center gap-2">
                  {ownMicrophone ? <Mic className="size-3.5 text-primary" aria-hidden="true" /> : <MicOff className="size-3.5 text-muted-foreground" aria-hidden="true" />}
                  <Meter level={level} muted={!ownMicrophone} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <CallCaptions
        enabled={captionsEnabled}
        ownMicrophone={ownMicrophone}
        partial={partial}
        final={final}
        speechText={speechText}
        speaking={speaking}
      />

      {(visibleProblem || (!sameCall && presentation.state === 'unavailable' && presentation.detail)) && (
        <div role="alert" className="mx-auto mt-3 w-full max-w-3xl rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <p>{visibleProblem ?? presentation.detail}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {presentation.controls.retry && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void call.retry()}>
                Retry
              </Button>
            )}
            {(presentation.controls.typeInstead || localProblem) && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={typeInstead}>
                Type instead
              </Button>
            )}
            {(readiness?.blocking || presentation.controls.fix || settingsCanFixError) && available && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openVoiceSettings} data-testid="commander-voice-fix">
                Open voice settings
              </Button>
            )}
          </div>
        </div>
      )}

      <div
        role="toolbar"
        aria-label="Commander call controls"
        onKeyDown={toolbarKeys}
        className="mx-auto mt-4 flex max-w-full items-center gap-1.5 overflow-x-auto rounded-2xl border border-border bg-card p-2 shadow-md"
      >
        <Button
          data-toolbar-item
          size="sm"
          variant={ownMicrophone ? 'secondary' : 'default'}
          aria-pressed={ownMicrophone}
          aria-label={sameCall ? (ownMicrophone ? 'Mute microphone' : 'Unmute microphone') : 'Turn voice mode on'}
          aria-describedby={!sameCall && setupLabel ? setupLabelId : undefined}
          title={sameCall ? (ownMicrophone ? 'Mute microphone' : 'Unmute microphone') : 'Start talking to the Commander'}
          onClick={toggle}
          data-testid="commander-voice-mode"
        >
          {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : ownMicrophone ? <Mic className="size-4" aria-hidden="true" /> : <MicOff className="size-4" aria-hidden="true" />}
          <span>{sameCall ? (ownMicrophone ? 'Mic on' : 'Mic off') : 'Start talking'}</span>
        </Button>

        <details className="relative">
          <summary
            data-toolbar-item
            aria-label="Microphone options"
            title="Microphone mode and input device"
            className="grid h-8 w-8 cursor-pointer list-none place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 [&::-webkit-details-marker]:hidden"
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </summary>
          <div className="absolute bottom-full left-0 z-30 mb-2 w-56 rounded-xl border border-border bg-popover p-2 text-xs text-popover-foreground shadow-lg">
            <p className="px-2 py-1 font-semibold">Microphone mode</p>
            <label className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <input type="radio" name="commander-mic-mode" checked readOnly /> Push to talk
            </label>
            <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground">
              <input type="radio" name="commander-mic-mode" disabled /> Open mic (coming next)
            </label>
            <div className="my-1 border-t border-border" />
            <p className="px-2 py-1 font-semibold">Input device</p>
            <p className="px-2 py-1 text-muted-foreground">System default</p>
          </div>
        </details>

        <Button
          data-toolbar-item
          size="sm"
          variant="ghost"
          disabled={!presentation.controls.stop}
          aria-label={presentation.controls.stop ? 'Stop Commander' : 'Nothing to stop'}
          title="Stop the current reply"
          onClick={() => call.interrupt('stop')}
          data-testid="commander-voice-stop"
        >
          <Square className="size-3.5" aria-hidden="true" />
          Stop
        </Button>
        <Button
          data-toolbar-item
          size="icon"
          variant="ghost"
          aria-label={captionsEnabled ? 'Turn captions off' : 'Turn captions on'}
          aria-pressed={captionsEnabled}
          title="Captions"
          onClick={() => setCaptionsEnabled(!captionsEnabled)}
        >
          <Captions className="size-4" aria-hidden="true" />
        </Button>
        <Button
          data-toolbar-item
          size="icon"
          variant="ghost"
          aria-label={panelOpen ? 'Close side panel' : 'Open side panel'}
          aria-pressed={panelOpen}
          title="Chat and actions panel"
          onClick={() => setPanelOpen(!panelOpen)}
        >
          {panelOpen ? <PanelRight className="size-4" aria-hidden="true" /> : <MessageSquare className="size-4" aria-hidden="true" />}
        </Button>
        <Button data-toolbar-item size="icon" variant="ghost" aria-label="Open voice settings" title="Voice settings" onClick={openVoiceSettings}>
          <Settings className="size-4" aria-hidden="true" />
        </Button>
        <Button
          data-toolbar-item
          data-commander-pip-toggle
          size="icon"
          variant="ghost"
          disabled={!sameCall}
          aria-label="Switch to picture in picture"
          title="Picture in picture"
          onClick={() => enterCommanderPictureInPicture()}
        >
          <Shrink className="size-4" aria-hidden="true" />
        </Button>
        <span className="mx-0.5 h-6 w-px shrink-0 bg-border" aria-hidden="true" />
        <Button
          data-toolbar-item
          size="sm"
          variant="destructive"
          disabled={!sameCall}
          aria-label="End Commander call"
          onClick={() => call.end()}
        >
          <PhoneOff className="size-4" aria-hidden="true" />
          End
        </Button>
      </div>
    </section>
  )
}

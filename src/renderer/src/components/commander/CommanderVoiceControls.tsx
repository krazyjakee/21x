import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { AudioLines, Loader2, Mic, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { activityNow, scheduleActivityDeadline, useActivityClock } from '@/lib/activity/activity-clock'
import { useCommanderActivityStore } from '@/lib/activity/commander-activity-adapter'
import { useVoiceActivity } from '@/lib/activity/voice-activity-adapter'
import { callUnavailability, deriveCallState, type CallTurn } from '@/lib/commander-call/derive-call-state'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderStore } from '@/stores/commander-store'
import { selectSpeechReady, selectVoiceSetupComplete, useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { MICROPHONE_BUSY_MESSAGE } from './CommanderCallHost'

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

/** View-only controls. AppLayout's CommanderCallHost owns all media. */
export function CommanderVoiceControls() {
  const selectedSessionId = useCommanderStore((s) => s.selectedSessionId)
  const call = useCommanderCallStore()
  const callSessionId = call.sessionId
  const observation = useCommanderActivityStore((s) => (callSessionId ? s.sessions[callSessionId] : undefined))
  const voice = useVoiceActivity(callSessionId ? { kind: 'commander', id: callSessionId } : null)

  const available = useVoiceStore((s) => s.available)
  const permission = useVoiceStore((s) => s.permission)
  const runtime = useVoiceStore((s) => s.runtime)
  const engine = useVoiceStore((s) => s.engine)
  const setupComplete = useVoiceStore(selectVoiceSetupComplete)
  const speechOutput = useVoiceStore(selectSpeechReady)
  const voiceTurnId = useVoiceStore((s) => s.turnId)
  const voiceState = useVoiceStore((s) => s.state)
  const partial = useVoiceStore((s) => s.partial)

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
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the Commander"]')?.focus()
    }, 0)
  }, [call.end])

  const toggle = useCallback(() => {
    setLocalProblem(null)
    const sameCall = call.status !== 'off' && call.sessionId === selectedSessionId
    if (sameCall) {
      call.end()
      return
    }
    if (readiness?.blocking) {
      setLocalProblem(readiness.problem)
      return
    }
    if (selectedSessionId) void call.start(selectedSessionId)
  }, [call.status, call.sessionId, call.end, call.start, selectedSessionId, readiness?.blocking, readiness?.problem])

  if (!selectedSessionId) return null

  const sameCall = call.status !== 'off' && call.sessionId === selectedSessionId
  const busy = call.status === 'starting' || presentation.state === 'transcribing'
  const setupLabel = readiness?.label ?? null
  const setupProblem = readiness?.problem ?? null
  const visibleProblem = localProblem ?? (presentation.state === 'error' ? presentation.detail ?? presentation.label : null)
  const settingsCanFixError = presentation.state === 'error' && Boolean(
    readiness?.label === 'Voice engine error' ||
    (visibleProblem && visibleProblem !== MICROPHONE_BUSY_MESSAGE && /microphone|speech worker|speech engine|device disconnected/i.test(visibleProblem))
  )
  const eventLabel = presentation.event?.kind === 'action'
    ? `Action taken: ${presentation.event.toolName}`
    : presentation.event?.kind === 'report'
      ? 'Report arrived'
      : null

  return (
    <aside
      className="flex w-14 shrink-0 flex-col items-center gap-2 border-l border-border py-3"
      aria-label="Commander voice mode"
      data-testid="commander-voice-controls"
      data-call-state={presentation.state}
    >
      <Button
        size="icon"
        variant={sameCall ? 'default' : 'ghost'}
        aria-pressed={sameCall}
        aria-label={sameCall ? 'Turn voice mode off' : 'Turn voice mode on'}
        aria-describedby={!sameCall && setupLabel ? setupLabelId : undefined}
        title={sameCall ? 'Voice mode is on: replies and reports are read aloud.' : 'Voice mode: talk to the Commander and hear its replies.'}
        onClick={toggle}
        data-testid="commander-voice-mode"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <AudioLines className="size-4" aria-hidden="true" />}
      </Button>

      {!sameCall && setupLabel && (
        <button
          type="button"
          id={setupLabelId}
          onClick={openVoiceSettings}
          title={`${setupProblem ?? ''} Click to open Settings → Voice.`.trim()}
          className="px-1 text-center text-[10px] leading-tight text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="commander-voice-setup"
        >
          {setupLabel}
        </button>
      )}

      {sameCall && presentation.controls.stop && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Stop the reply"
          title="Stop reading and cancel this reply"
          onClick={() => call.interrupt('stop')}
          data-testid="commander-voice-stop"
        >
          <VolumeX className="size-4" aria-hidden="true" />
        </Button>
      )}

      {sameCall && (
        <div
          role="status"
          className="fixed bottom-24 right-20 z-40 flex max-w-sm items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground shadow-md"
          data-testid="commander-voice-status"
        >
          <Mic className={`size-3.5 shrink-0 ${presentation.state === 'listening' ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
          <span>
            {partial.trim() && presentation.state === 'listening'
              ? partial.trim()
              : call.status === 'starting'
                ? 'Starting voice conversation…'
                : presentation.state === 'listening'
                  ? `${presentation.label}…`
                  : presentation.label}
          </span>
          {presentation.textOnly && <span className="text-muted-foreground">Text only</span>}
          {eventLabel && <span className="text-muted-foreground">{eventLabel}</span>}
        </div>
      )}

      {visibleProblem && (
        <div
          role="alert"
          className="fixed bottom-36 right-20 z-40 max-w-sm rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>{visibleProblem}</p>
          <div className="mt-2 flex gap-2">
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
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={openVoiceSettings}
                data-testid="commander-voice-fix"
              >
                Open voice settings
              </Button>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

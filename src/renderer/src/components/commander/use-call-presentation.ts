import { useShallow } from 'zustand/react/shallow'
import { useEffect } from 'react'
import { activityNow, scheduleActivityDeadline, useActivityClock } from '@/lib/activity/activity-clock'
import { useCommanderActivityStore } from '@/lib/activity/commander-activity-adapter'
import { useVoiceActivity } from '@/lib/activity/voice-activity-adapter'
import { voiceCapture } from '@/lib/voice-capture'
import { callUnavailability, deriveCallState } from '@/lib/commander-call/derive-call-state'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderStore } from '@/stores/commander-store'
import { selectSpeechReady, selectVoiceSetupComplete, useVoiceStore } from '@/stores/voice-store'
import { commanderVoiceReadiness } from './CommanderVoiceControls'

export function useCallPresentation() {
  const call = useCommanderCallStore()
  const selected = useCommanderStore(s => s.selectedSessionId)
  const sessionId = call.sessionId ?? selected
  const observation = useCommanderActivityStore(s => sessionId ? s.sessions[sessionId] : undefined)
  const voice = useVoiceActivity(sessionId ? { kind: 'commander', id: sessionId } : null)
  const snapshot = useVoiceStore(useShallow(s => ({ available: s.available, permission: s.permission, runtime: s.runtime, models: s.models,
    engine: s.engine, tts: s.tts, state: s.state, turnId: s.turnId, partial: s.partial })))
  const tick = useActivityClock(s => s.tick)
  const setupComplete = selectVoiceSetupComplete(snapshot)
  const speechOutput = call.status !== 'off' && !!call.sessionId && selectSpeechReady(snapshot) && snapshot.tts?.enabled === true
  const readiness = commanderVoiceReadiness({ available: snapshot.available, permission: snapshot.permission,
    runtimeInstalled: snapshot.runtime.installed, setupComplete, engine: snapshot.engine })
  const unavailable = callUnavailability({ bridge: snapshot.available, sessionId: selected, permission: snapshot.permission,
    runtimeInstalled: snapshot.runtime.installed, setupComplete,
    engineMessage: snapshot.engine.state === 'error' || snapshot.engine.state === 'model_missing' ? snapshot.engine.message : undefined })
  void tick
  const now = activityNow()
  const activePhase = observation && ['thinking', 'working', 'tool'].includes(observation.phase)
  const fresh = !!observation && !observation.unavailable && observation.known !== false && (!activePhase || now - observation.observedAt < 15_000)
  const ownedTurn = call.status === 'live' && !!call.turnId && snapshot.turnId === call.turnId
  const microphoneOpen = ownedTurn && voiceCapture.isCapturing && snapshot.state === 'listening'
  const presentation = deriveCallState({
    call,
    unavailable,
    mic: { open: microphoneOpen, ownedTurn, voiceState: snapshot.state, partial: snapshot.partial },
    speech: voice?.state ?? 'none', speechOutput,
    turn: observation && fresh ? { turnId: observation.turnId, phase: observation.phase, error: observation.error,
      toolName: observation.openTools.at(-1)?.name } : null,
    now
  })
  const expiresAt = activePhase && fresh ? Math.min(presentation.expiresAt ?? Infinity, observation.observedAt + 15_000) : presentation.expiresAt
  useEffect(() => scheduleActivityDeadline(expiresAt), [expiresAt])
  return { call, snapshot, selected, presentation, readiness, observation, speechOutput, fresh, microphoneOpen }
}

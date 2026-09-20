import { useEffect, useLayoutEffect, useRef } from 'react'
import type { CallMedia } from '@shared/commander-call'
import type { CommanderEvent } from '@shared/commander'
import { isCommanderAdminTool } from '@shared/commander-tools'
import { commanderApi, commanderVoiceApi } from '@/lib/ipc-client'
import { activityNow } from '@/lib/activity/activity-clock'
import {
  ensureCommanderActivitySubscription,
  useCommanderActivityStore
} from '@/lib/activity/commander-activity-adapter'
import {
  ensureVoiceAttribution,
  hasVerifiedPlaybackOwnership,
  readVoiceActivitySnapshot,
  useVoiceActivity
} from '@/lib/activity/voice-activity-adapter'
import {
  clearActiveComposer,
  getActiveComposer,
  registerComposer,
  setActiveComposer
} from '@/lib/voice-dictation-target'
import { voicePlayback } from '@/lib/voice-playback'
import {
  bindCommanderCallDriver,
  COMMANDER_VOICE_COMPOSER_KEY,
  emitCallMediaEvent,
  onCallMediaEvent,
  useCommanderCallStore
} from '@/stores/commander-call-store'
import {
  selectSpeechReady,
  selectVoiceReady,
  useVoiceStore
} from '@/stores/voice-store'

export const MICROPHONE_BUSY_MESSAGE =
  'Another microphone is already listening. Stop it before starting Commander voice mode.'

// Main applies routing asynchronously. These values deliberately outlive a
// host instance so a late completion from an unmounted host can only reassert
// the newest host's intent, never its own retired session or null cleanup.
let routingEpoch = 0
let desiredActiveSessionId: string | null = null

async function setActiveSession(nextSessionId: string | null, signal?: AbortSignal): Promise<unknown> {
  desiredActiveSessionId = nextSessionId
  const mine = ++routingEpoch
  const result = await commanderVoiceApi.setActive(nextSessionId)
  if (mine !== routingEpoch || signal?.aborted) await reconcileActiveSession()
  return result
}

async function reconcileActiveSession(): Promise<void> {
  const observedEpoch = routingEpoch
  const desired = desiredActiveSessionId
  await commanderVoiceApi.setActive(desired)
  if (observedEpoch !== routingEpoch) await reconcileActiveSession()
}

// Composer and caption ownership use the AbortSignal as an opaque call lease.
// Session and provider turn ids may both be reused; object identity may not.
let activeMicrophoneLease: AbortSignal | null = null

function ownedMicrophone() {
  const call = useCommanderCallStore.getState()
  const voice = useVoiceStore.getState()
  if (call.status !== 'live' || !call.sessionId || !call.turnId || voice.turnId !== call.turnId) return null
  return { call, voice }
}

function ownedPlayback() {
  const call = useCommanderCallStore.getState()
  if (call.status !== 'live' || !call.sessionId) return null
  const target = { kind: 'commander' as const, id: call.sessionId }
  const snapshot = readVoiceActivitySnapshot()
  if (!hasVerifiedPlaybackOwnership(snapshot, target)) return null
  return { snapshot, voice: useVoiceStore.getState() }
}

/** The live provider-neutral media surface promised by the call contract. */
export const commanderCallMedia: CallMedia = {
  capabilities: {
    partialCaptions: true,
    wordTimings: false,
    speechBargeIn: true,
    streamingTts: true
  },
  inputLevel: () => ownedMicrophone()?.voice.level ?? 0,
  outputLevel: () => (ownedPlayback()?.snapshot.hasQueuedAudio ? voicePlayback.outputLevel : 0),
  get userCaption() {
    const owned = ownedMicrophone()
    return owned ? { partial: owned.voice.partial, final: owned.voice.final } : { partial: '', final: '' }
  },
  get assistantCaption() {
    const owned = ownedPlayback()
    return owned
      ? { text: owned.voice.speechText, speaking: owned.snapshot.hasQueuedAudio }
      : { text: '', speaking: false }
  },
  on: onCallMediaEvent
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function withFullStop(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`
}

/** What the user can do about a microphone that did not open. */
function captureAdvice(message: string): string {
  if (/no microphone/i.test(message)) return `${withFullStop(message)} Connect a microphone, then check it in Settings → Voice.`
  if (/refused|blocked/i.test(message)) return `${withFullStop(message)} Allow microphone access for 21x, then check it in Settings → Voice.`
  if (/in use/i.test(message)) return `${withFullStop(message)} Close the other application, then try again.`
  return message
}

/**
 * Owns the single Commander call for the whole window.
 *
 * This is mounted once by AppLayout. Commander views may come and go without
 * opening a second microphone, duplicating subscriptions, or cleaning up the
 * call. Unmounting the app itself still tears everything down.
 */
export function CommanderCallHost() {
  const hiddenField = useRef<HTMLTextAreaElement>(null)
  const status = useCommanderCallStore((s) => s.status)
  const sessionId = useCommanderCallStore((s) => s.sessionId)
  const callTurnId = useCommanderCallStore((s) => s.turnId)
  const replyInterrupted = useCommanderCallStore((s) => s.replyInterrupted)
  const interrupt = useCommanderCallStore((s) => s.interrupt)
  const mediaLost = useCommanderCallStore((s) => s.mediaLost)
  const sendTranscript = useCommanderCallStore((s) => s.sendTranscript)
  const recordEvent = useCommanderCallStore((s) => s.recordEvent)

  const voiceTurnId = useVoiceStore((s) => s.turnId)
  const partial = useVoiceStore((s) => s.partial)
  const voiceResult = useVoiceStore((s) => s.result)
  const turn = useCommanderActivityStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const voice = useVoiceActivity(sessionId ? { kind: 'commander', id: sessionId } : null)

  useEffect(() => {
    ensureCommanderActivitySubscription()
    ensureVoiceAttribution()
  }, [])

  // The hidden composer is app-level too: final captions keep reaching the
  // same call even when the Commander workspace is not mounted.
  useEffect(() => registerComposer(COMMANDER_VOICE_COMPOSER_KEY, {
    getField: () => hiddenField.current,
    submit: () => {
      const field = hiddenField.current
      const words = field?.value ?? ''
      if (field) field.value = ''
      sendTranscript(words)
    },
    expectsSpokenAnswer: false
  }), [sendTranscript])

  useLayoutEffect(() => {
    return bindCommanderCallDriver({
      setActive: async (nextSessionId, signal) => {
        // Refuse before main changes reply routing. Preparing TTS can take
        // seconds; another microphone keeps its turn and captions throughout.
        if (nextSessionId && useVoiceStore.getState().turnId) {
          throw new Error(MICROPHONE_BUSY_MESSAGE)
        }
        return setActiveSession(nextSessionId, signal)
      },
      openMicrophone: async (signal) => {
        const ensureCurrent = (): void => {
          if (signal.aborted) throw new Error('The voice conversation was cancelled.')
        }
        const refuseForeignTurn = (): void => {
          ensureCurrent()
          const existing = useVoiceStore.getState().turnId
          if (existing) throw new Error(MICROPHONE_BUSY_MESSAGE)
        }

        refuseForeignTurn()
        const actions = useVoiceStore.getState()
        await actions.initializeTts()
        ensureCurrent()
        let current = useVoiceStore.getState()
        if (!current.tts?.enabled || !selectSpeechReady(current)) {
          await current.setTtsEnabled(true)
          ensureCurrent()
          current = useVoiceStore.getState()
        }
        if (!selectSpeechReady(current)) {
          const speech = current.tts?.status
          throw new Error(
            speech?.state === 'loading'
              ? 'The reply voice is still loading. Try voice mode again in a moment.'
              : speech && 'message' in speech
                ? speech.message
                : 'The saved reply voice could not be prepared.'
          )
        }

        if (!selectVoiceReady(current)) {
          await current.setEnabled(true)
          ensureCurrent()
          current = useVoiceStore.getState()
          if (!selectVoiceReady(current)) {
            const engineMessage = current.engine.state === 'error' ? current.engine.message : ''
            throw new Error(current.result?.message || engineMessage || 'Voice input could not be enabled.')
          }
        }

        refuseForeignTurn()
        activeMicrophoneLease = signal
        setActiveComposer(COMMANDER_VOICE_COMPOSER_KEY)
        current.setCaptionOwner(COMMANDER_VOICE_COMPOSER_KEY)
        try {
          const started = await current.startTurn('conversation', { signal })
          ensureCurrent()
          const opened = started ?? useVoiceStore.getState().turnId
          if (!opened) {
            throw new Error(captureAdvice(useVoiceStore.getState().result?.message || 'The microphone could not be started.'))
          }
          return opened
        } catch (err) {
          if (activeMicrophoneLease === signal) {
            activeMicrophoneLease = null
            if (getActiveComposer() === COMMANDER_VOICE_COMPOSER_KEY) clearActiveComposer()
            if (useVoiceStore.getState().captionOwner === COMMANDER_VOICE_COMPOSER_KEY) {
              useVoiceStore.getState().setCaptionOwner(null)
            }
          }
          throw err
        }
      },
      closeMicrophone: (ownedTurnId, signal) => {
        if (!signal || activeMicrophoneLease !== signal) return
        activeMicrophoneLease = null
        const voiceState = useVoiceStore.getState()
        if (ownedTurnId && voiceState.turnId === ownedTurnId) void voiceState.cancel()
        if (getActiveComposer() === COMMANDER_VOICE_COMPOSER_KEY) clearActiveComposer()
        if (voiceState.captionOwner === COMMANDER_VOICE_COMPOSER_KEY) voiceState.setCaptionOwner(null)
      },
      stopPlayback: () => useVoiceStore.getState().stopPlaybackNow(),
      bargeIn: (activeSessionId) => commanderVoiceApi.bargeIn(activeSessionId),
      send: (activeSessionId, text) => commanderVoiceApi.send(activeSessionId, text)
    })
  }, [])

  // Action/report events are observations, not new call states. Keep this
  // subscription beside the lifetime owner so navigation cannot miss them.
  useEffect(() => {
    const tools = new Map<string, string>()
    const keyOf = (event: Extract<CommanderEvent, { type: 'turn_event' }>, id: string): string =>
      `${event.sessionId}:${event.turnId}:${id}`
    const onEvent = (event: CommanderEvent): void => {
      if (event.type === 'turn_event') {
        const inner = event.event
        if (inner.type === 'tool_call_start') {
          tools.set(keyOf(event, inner.id), inner.name)
        } else if (inner.type === 'tool_call_result') {
          const key = keyOf(event, inner.id)
          const toolName = tools.get(key)
          tools.delete(key)
          if (toolName && !inner.isError && isCommanderAdminTool(toolName)) {
            recordEvent({
              kind: 'action',
              at: activityNow(),
              sessionId: event.sessionId,
              turnId: event.turnId,
              toolCallId: inner.id,
              toolName
            })
          }
        } else if (inner.type === 'done') {
          const prefix = `${event.sessionId}:${event.turnId}:`
          for (const key of tools.keys()) if (key.startsWith(prefix)) tools.delete(key)
        }
        return
      }
      if (event.type === 'messages_appended') {
        for (const message of event.messages) {
          if (message.role !== 'report') continue
          recordEvent({
            kind: 'report',
            at: activityNow(),
            sessionId: event.sessionId,
            messageId: message.id,
            projectId: message.project_id
          })
        }
      }
    }
    try {
      return commanderApi.onEvent(onEvent)
    } catch {
      // Browser previews and unit tests may not expose the Commander bridge.
      return undefined
    }
  }, [recordEvent])

  // Provider-neutral speech events reflect verified Commander playback, not a
  // global "synthesis started" flag that might belong to another surface.
  const speaking = voice?.state === 'speaking'
  const wasSpeaking = useRef(false)
  useEffect(() => {
    if (speaking === wasSpeaking.current) return
    wasSpeaking.current = speaking
    emitCallMediaEvent(speaking ? 'speech_start' : 'speech_end')
  }, [speaking])

  // Voice barge-in stops in the same tick. A turn preparing text/tools counts
  // too: the user's new words supersede that reply before the sentence ends.
  const replyActive = speaking || turn?.phase === 'thinking' || turn?.phase === 'working' || turn?.phase === 'tool'
  useEffect(() => {
    if (status !== 'live' || voiceTurnId !== callTurnId || !partial.trim() || !replyActive || replyInterrupted) return
    interrupt('barge_in')
  }, [status, voiceTurnId, callTurnId, partial, replyActive, replyInterrupted, interrupt])

  // A worker failure, timeout, or foreign microphone can close/replace the
  // owned turn without a view being present. Convert that to one retryable call
  // error and clean up the remaining media exactly once.
  useEffect(() => {
    if (status !== 'live' || !callTurnId || voiceTurnId === callTurnId) return
    mediaLost(
      voiceResult?.message
        ? captureAdvice(voiceResult.message)
        : 'The voice conversation ended. Retry to reconnect.'
    )
  }, [status, callTurnId, voiceTurnId, voiceResult?.message, mediaLost])

  // Escape is Stop, not End. The call remains available after the short
  // interrupted presentation and survives navigation as before.
  useEffect(() => {
    if (status !== 'live') return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      interrupt('stop')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [status, interrupt])

  return (
    <textarea
      ref={hiddenField}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
      data-voice-composer={COMMANDER_VOICE_COMPOSER_KEY}
    />
  )
}

export { messageOf }

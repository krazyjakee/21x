import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, Loader2, Mic, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { commanderVoiceApi } from '@/lib/ipc-client'
import { useCommanderStore } from '@/stores/commander-store'

/**
 * Commander voice mode (#64, docs/commander.md "Voice mode").
 *
 * One click opens a hands-free conversation: the microphone stays open, each
 * utterance is sent after a pause, and main speaks the reply as it streams.
 * Talking over a reply is barge-in: playback stops in this tick and the
 * running Commander turn is cancelled before the new utterance is sent.
 *
 * The voice store and the dictation registry are loaded when the control
 * mounts rather than with the Commander view: they subscribe to the voice
 * bridge as they load, and a build or a test without that bridge must still
 * render the Commander.
 */

type VoiceStoreModule = typeof import('@/stores/voice-store')
type DictationModule = typeof import('@/lib/voice-dictation-target')

interface Loaded {
  store: VoiceStoreModule
  dictation: DictationModule
}

/** Private composer used to route pause-delimited conversation segments. */
export const COMMANDER_VOICE_COMPOSER_KEY = 'commander-voice'

export function CommanderVoiceControls() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([import('@/stores/voice-store'), import('@/lib/voice-dictation-target')])
      .then(([store, dictation]) => {
        if (alive) setLoaded({ store, dictation })
      })
      .catch(() => {
        // No voice bridge in this build: the Commander works without voice.
      })
    return () => {
      alive = false
    }
  }, [])

  if (!loaded) return null
  return <VoiceControls store={loaded.store} dictation={loaded.dictation} />
}

function VoiceControls({ store, dictation }: { store: VoiceStoreModule; dictation: DictationModule }) {
  const { useVoiceStore, selectVoiceReady, selectVoiceSetupComplete, selectSpeechReady } = store
  const sessionId = useCommanderStore((s) => s.selectedSessionId)
  const replying = useCommanderStore((s) => (s.selectedSessionId ? Boolean(s.streaming[s.selectedSessionId]) : false))

  const micSetupComplete = useVoiceStore(selectVoiceSetupComplete)
  const turnId = useVoiceStore((s) => s.turnId)
  const voiceState = useVoiceStore((s) => s.state)
  const partial = useVoiceStore((s) => s.partial)
  const speaking = useVoiceStore((s) => s.speaking)
  const permission = useVoiceStore((s) => s.permission)
  const runtime = useVoiceStore((s) => s.runtime)
  const engine = useVoiceStore((s) => s.engine)
  const startTurn = useVoiceStore((s) => s.startTurn)
  const setVoiceEnabled = useVoiceStore((s) => s.setEnabled)
  const initializeTts = useVoiceStore((s) => s.initializeTts)
  const setTtsEnabled = useVoiceStore((s) => s.setTtsEnabled)
  const cancelTurn = useVoiceStore((s) => s.cancel)
  const stopPlaybackNow = useVoiceStore((s) => s.stopPlaybackNow)

  const [voiceMode, setVoiceMode] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The voice turn this control opened, so a sentence from another microphone is never sent here. */
  const ownTurn = useRef<string | null>(null)
  /** Mirrors `ownTurn` so the buttons redraw when this control's turn opens or ends. */
  const [ownTurnId, setOwnTurnIdState] = useState<string | null>(null)
  const setOwnTurn = useCallback((id: string | null) => {
    ownTurn.current = id
    setOwnTurnIdState(id)
  }, [])
  const hiddenField = useRef<HTMLTextAreaElement>(null)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const interruptedReply = useRef(false)

  const sendTranscript = useCallback((text: string) => {
    const sid = sessionRef.current
    const words = text.trim()
    if (!sid || !words) return
    setError(null)
    void commanderVoiceApi.send(sid, words)
      .then(() => {
        // The next reply may be interrupted independently of the previous one.
        interruptedReply.current = false
      })
      .catch((err) => setError(messageOf(err)))
  }, [])

  // Reuse the app's conversation dispatcher. It writes each finished segment
  // into this private composer and calls submit; no words leak into the visible
  // Commander draft or any task composer.
  useEffect(() => {
    return dictation.registerComposer(COMMANDER_VOICE_COMPOSER_KEY, {
      getField: () => hiddenField.current,
      focusOnInsert: false,
      submit: () => {
        const field = hiddenField.current
        const words = field?.value ?? ''
        if (field) field.value = ''
        sendTranscript(words)
      },
      // CommanderVoice already streams this session's reply. The generic
      // task-answer expectation would point at a non-task composer key.
      expectsSpokenAnswer: false,
    })
  }, [dictation, sendTranscript])

  /** Barge-in: silence now, then cancel synthesis and the Commander turn in main. */
  const bargeIn = useCallback(() => {
    interruptedReply.current = true
    stopPlaybackNow()
    const sid = sessionRef.current
    if (sid) void commanderVoiceApi.bargeIn(sid).catch(() => {})
  }, [stopPlaybackNow])

  const listening = Boolean(turnId && ownTurnId === turnId)

  const setupProblem = permission === 'denied'
      ? 'Microphone access is blocked. Allow it in the system privacy settings, then try again.'
      : !runtime.installed
        ? 'Install the local speech runtime in Settings → Voice so Commander can hear you.'
        : !micSetupComplete
          ? ('message' in engine && engine.message) || 'Turn on voice input and choose a speech model in Settings → Voice.'
          : null

  // Turning voice mode on owns the complete loop. There is no second Talk
  // button: opening the mode immediately opens a persistent conversation turn.
  useEffect(() => {
    if (!voiceMode || !sessionId) return undefined
    let closed = false

    const open = async (): Promise<void> => {
      setStarting(true)
      setError(null)
      try {
        await commanderVoiceApi.setActive(sessionId)
        if (closed) return
        // Voice conversation is an explicit request to hear replies. Refresh
        // the persisted speech configuration and prepare it on this click.
        // A null/loading renderer snapshot, or the general read-aloud switch
        // being off, does not mean the saved voice was lost.
        await initializeTts()
        if (closed) return
        let current = useVoiceStore.getState()
        if (!current.tts?.enabled || !selectSpeechReady(current)) {
          await setTtsEnabled(true)
          if (closed) return
          current = useVoiceStore.getState()
        }
        if (!selectSpeechReady(current)) {
          const status = current.tts?.status
          throw new Error(status?.state === 'loading'
            ? 'The reply voice is still loading. Try voice mode again in a moment.'
            : status && 'message' in status
              ? status.message
              : 'The saved reply voice could not be prepared.')
        }
        if (!selectVoiceReady(useVoiceStore.getState())) {
          // Clicking voice mode is itself an explicit microphone action. If
          // recognition is installed but merely switched off, enable it here
          // and let the OS permission prompt appear instead of sending the
          // user through Settings first.
          await setVoiceEnabled(true)
          if (closed) return
          const enabled = useVoiceStore.getState()
          if (!selectVoiceReady(enabled)) {
            throw new Error(enabled.result?.message || 'Voice input could not be enabled.')
          }
        }
        const existing = useVoiceStore.getState().turnId
        if (existing && existing !== ownTurn.current) {
          throw new Error('Another microphone is already listening. Stop it before starting Commander voice mode.')
        }
        dictation.setActiveComposer(COMMANDER_VOICE_COMPOSER_KEY)
        await startTurn('conversation')
        if (closed) return
        const opened = useVoiceStore.getState().turnId
        if (!opened) {
          throw new Error(useVoiceStore.getState().result?.message || 'The microphone could not be started.')
        }
        setOwnTurn(opened)
      } catch (err) {
        if (!closed) {
          setError(messageOf(err))
          setVoiceMode(false)
        }
      } finally {
        if (!closed) setStarting(false)
      }
    }

    void open()
    return () => {
      closed = true
      setStarting(false)
      const owned = ownTurn.current
      if (owned && useVoiceStore.getState().turnId === owned) void cancelTurn()
      setOwnTurn(null)
      if (dictation.getActiveComposer() === COMMANDER_VOICE_COMPOSER_KEY) dictation.clearActiveComposer()
      stopPlaybackNow()
      void commanderVoiceApi.setActive(null).catch(() => {})
    }
  }, [voiceMode, sessionId, startTurn, setVoiceEnabled, initializeTts, setTtsEnabled, cancelTurn, stopPlaybackNow, dictation, useVoiceStore, selectVoiceReady, selectSpeechReady, setOwnTurn])

  const toggleVoiceMode = useCallback(() => {
    if (voiceMode) {
      setVoiceMode(false)
      return
    }
    if (setupProblem) {
      setError(setupProblem)
      return
    }
    setVoiceMode(true)
  }, [voiceMode, setupProblem])

  // Hearing the user during a spoken/streaming reply is immediate barge-in;
  // waiting until the pause-delimited segment is sent would talk over them.
  useEffect(() => {
    if (!voiceMode || !listening || !partial.trim() || (!speaking && !replying) || interruptedReply.current) return
    bargeIn()
  }, [voiceMode, listening, partial, speaking, replying, bargeIn])

  // Escape is Stop: it cancels listening, or stops the reply being read.
  useEffect(() => {
    if (!voiceMode) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setVoiceMode(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [voiceMode])

  // A different microphone taking ownership must not leave this control
  // claiming that it is still listening.
  useEffect(() => {
    if (turnId && ownTurn.current && turnId !== ownTurn.current) setOwnTurn(null)
  }, [turnId, setOwnTurn])

  // A worker failure or the conversation safety timeout can close the turn
  // without a click. Do not leave the mode looking live with a dead mic.
  useEffect(() => {
    if (!voiceMode || starting || !ownTurn.current || turnId) return
    setOwnTurn(null)
    setError(useVoiceStore.getState().result?.message || 'The voice conversation ended. Turn it on to reconnect.')
    setVoiceMode(false)
  }, [voiceMode, starting, turnId, useVoiceStore, setOwnTurn])

  if (!sessionId) return null

  const busy = starting || voiceState === 'transcribing'
  const status = starting
    ? 'Starting voice conversation…'
    : speaking
      ? 'Commander is speaking — start talking to interrupt.'
      : replying
        ? 'Commander is thinking…'
        : partial.trim() || 'Listening…'

  return (
    <aside
      className="flex w-14 shrink-0 flex-col items-center gap-2 border-l border-border py-3"
      aria-label="Commander voice mode"
      data-testid="commander-voice-controls"
    >
      <Button
        size="icon"
        variant={voiceMode ? 'default' : 'ghost'}
        aria-pressed={voiceMode}
        aria-label={voiceMode ? 'Turn voice mode off' : 'Turn voice mode on'}
        title={voiceMode ? 'Voice mode is on: replies and reports are read aloud.' : 'Voice mode: talk to the Commander and hear its replies.'}
        onClick={toggleVoiceMode}
        data-testid="commander-voice-mode"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <AudioLines className="size-4" aria-hidden="true" />}
      </Button>

      {voiceMode && (
        <>
          {(speaking || replying) && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Stop the reply"
              title="Stop reading and cancel this reply"
              onClick={bargeIn}
              data-testid="commander-voice-stop"
            >
              <VolumeX className="size-4" aria-hidden="true" />
            </Button>
          )}

          <div
            role="status"
            className="fixed bottom-24 right-20 z-40 flex max-w-sm items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground shadow-md"
            data-testid="commander-voice-status"
          >
            <Mic className={`size-3.5 shrink-0 ${listening ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
            <span>{status}</span>
          </div>
        </>
      )}
      {error && (
        <div
          role="alert"
          className={`fixed ${voiceMode ? 'bottom-36' : 'bottom-24'} right-20 z-40 max-w-sm rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive`}
        >
          {error}
        </div>
      )}

      <textarea
        ref={hiddenField}
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        data-voice-composer={COMMANDER_VOICE_COMPOSER_KEY}
      />
    </aside>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

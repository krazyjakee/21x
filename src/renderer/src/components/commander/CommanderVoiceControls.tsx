import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, Loader2, Mic, Square, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { commanderVoiceApi, voiceApi } from '@/lib/ipc-client'
import { useCommanderStore } from '@/stores/commander-store'

/**
 * Commander voice mode (#64, docs/commander.md "Voice mode").
 *
 * Push-to-talk: one click opens the microphone, a second click closes it and
 * the final transcript is sent as a Commander user turn. While voice mode is
 * on, main speaks the reply as it streams and every Captain report that
 * lands in this session. Starting a new voice turn, the Stop button and Escape
 * are barge-in: playback stops in this tick, and main cancels the synthesis
 * request (or ElevenLabs connection) and the running Commander turn.
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

/** The composer key the voice turn writes into. The words are sent from main's `dictate` event, not typed. */
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
  const { useVoiceStore, selectVoiceReady, selectSpeechReady } = store
  const sessionId = useCommanderStore((s) => s.selectedSessionId)
  const replying = useCommanderStore((s) => (s.selectedSessionId ? Boolean(s.streaming[s.selectedSessionId]) : false))

  const micReady = useVoiceStore(selectVoiceReady)
  const speechReady = useVoiceStore(selectSpeechReady)
  const turnId = useVoiceStore((s) => s.turnId)
  const voiceState = useVoiceStore((s) => s.state)
  const partial = useVoiceStore((s) => s.partial)
  const speaking = useVoiceStore((s) => s.speaking)
  const startTurn = useVoiceStore((s) => s.startTurn)
  const endTurn = useVoiceStore((s) => s.endTurn)
  const cancelTurn = useVoiceStore((s) => s.cancel)
  const stopPlaybackNow = useVoiceStore((s) => s.stopPlaybackNow)

  const [voiceMode, setVoiceMode] = useState(false)
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

  // Main speaks for the session voice mode is on for, and for no other.
  useEffect(() => {
    if (!voiceMode || !sessionId) return undefined
    void commanderVoiceApi.setActive(sessionId).catch((err) => setError(messageOf(err)))
    return () => {
      // Closing voice mode, switching session or leaving the view stops the
      // reading at once and closes any ElevenLabs connection in main.
      stopPlaybackNow()
      void commanderVoiceApi.setActive(null).catch(() => {})
    }
  }, [voiceMode, sessionId, stopPlaybackNow])

  // The words land in a hidden, read-only field so they are never written
  // into another composer; the sentence itself is sent from `dictate` below.
  useEffect(() => {
    return dictation.registerComposer(COMMANDER_VOICE_COMPOSER_KEY, { getField: () => hiddenField.current })
  }, [dictation])

  useEffect(() => {
    return voiceApi.onDictate(({ turnId: id, text }) => {
      if (!id || id !== ownTurn.current) return
      setOwnTurn(null)
      if (hiddenField.current) hiddenField.current.value = ''
      const sid = sessionRef.current
      const words = text.trim()
      if (!sid || !words) return
      setError(null)
      void commanderVoiceApi.send(sid, words).catch((err) => setError(messageOf(err)))
    })
  }, [setOwnTurn])

  /** Barge-in: silence now, then cancel synthesis and the Commander turn in main. */
  const bargeIn = useCallback(() => {
    stopPlaybackNow()
    const sid = sessionRef.current
    if (sid) void commanderVoiceApi.bargeIn(sid).catch(() => {})
  }, [stopPlaybackNow])

  const listening = Boolean(turnId && ownTurnId === turnId)

  const toggleTalk = useCallback(async () => {
    if (listening) {
      await endTurn()
      return
    }
    if (turnId || !sessionRef.current) return
    setError(null)
    // Starting to talk is barge-in, whatever is playing or still being written.
    bargeIn()
    dictation.setActiveComposer(COMMANDER_VOICE_COMPOSER_KEY)
    await startTurn('dictation')
    const opened = useVoiceStore.getState().turnId
    setOwnTurn(opened)
    if (!opened) dictation.clearActiveComposer()
  }, [listening, turnId, endTurn, bargeIn, dictation, startTurn, useVoiceStore, setOwnTurn])

  // Escape is Stop: it cancels listening, or stops the reply being read.
  useEffect(() => {
    if (!voiceMode) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (listening) {
        setOwnTurn(null)
        dictation.clearActiveComposer()
        void cancelTurn()
        return
      }
      if (speaking || replying) bargeIn()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [voiceMode, listening, speaking, replying, cancelTurn, bargeIn, dictation, setOwnTurn])

  // The turn closing (a click, a pause, main dropping it) does not forget it
  // here: its transcript arrives on `dictate` afterwards and must still be
  // sent. Only a different turn opening elsewhere replaces it.
  useEffect(() => {
    if (turnId && ownTurn.current && turnId !== ownTurn.current) setOwnTurn(null)
  }, [turnId, setOwnTurn])

  if (!sessionId) return null

  const busy = voiceState === 'transcribing'
  const hint = !speechReady
    ? 'No voice is ready to speak replies. Choose one in Settings → Voice.'
    : !micReady
      ? 'Turn on voice input in Settings → Voice to talk to the Commander.'
      : null

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
        onClick={() => setVoiceMode((on) => !on)}
        data-testid="commander-voice-mode"
      >
        <AudioLines className="size-4" aria-hidden="true" />
      </Button>

      {voiceMode && (
        <>
          <Button
            size="icon"
            variant={listening ? 'default' : 'outline'}
            disabled={!micReady || busy || (Boolean(turnId) && !listening)}
            aria-pressed={listening}
            aria-label={listening ? 'Stop talking and send' : 'Talk to the Commander'}
            title={hint ?? (listening ? 'Click to send what you said.' : 'Click to talk. Talking stops the reply being read.')}
            onClick={() => void toggleTalk()}
            data-testid="commander-voice-talk"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : listening ? (
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            ) : (
              <Mic className="size-4" aria-hidden="true" />
            )}
          </Button>

          {(speaking || replying) && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Stop the reply"
              title="Stop reading and cancel the reply (Escape)"
              onClick={bargeIn}
              data-testid="commander-voice-stop"
            >
              <VolumeX className="size-4" aria-hidden="true" />
            </Button>
          )}

          {hint && (
            <span className="sr-only" role="status">
              {hint}
            </span>
          )}
        </>
      )}

      {/* What the microphone is hearing, where the user is looking. */}
      {listening && partial && (
        <div
          className="pointer-events-none fixed bottom-24 right-20 z-40 max-w-sm rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground shadow-md"
          aria-live="polite"
          data-testid="commander-voice-partial"
        >
          {partial}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="fixed bottom-24 right-20 z-40 max-w-sm rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
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

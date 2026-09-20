import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AudioLines, Loader2, Mic, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { commanderVoiceApi } from '@/lib/ipc-client'
import { useCommanderStore } from '@/stores/commander-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'

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

export const MICROPHONE_BUSY_MESSAGE = 'Another microphone is already listening. Stop it before starting Commander voice mode.'

/** Why Commander voice cannot start, or may not, in words the user can act on (#83). */
export interface CommanderVoiceReadiness {
  /** Short, always-visible text under the voice button. */
  label: string
  /** The full reason, shown in the alert and as the label's tooltip. */
  problem: string
  /**
   * True when a click cannot help and only explains. False when the click is
   * itself the retry: a crashed speech engine is reloaded by turning voice on.
   */
  blocking: boolean
}

/**
 * The visible not-ready reason, from the real readiness of the voice path and
 * not only from whether setup was once completed: an installed model whose
 * engine failed is "set up" and still cannot hear anything. A merely
 * switched-off, installed engine is not a problem; one click enables it.
 */
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
      problem: `${withFullStop(reason)} Click the voice button to try again, or repair it in Settings → Voice.`,
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

function withFullStop(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`
}

/** A failure shown in the alert; `fix` adds the "Open voice settings" button. */
interface VoiceProblem {
  message: string
  fix: boolean
}

/** What the user can do about a microphone that did not open. */
function captureAdvice(message: string): string {
  if (/no microphone/i.test(message)) return `${withFullStop(message)} Connect a microphone, then check it in Settings → Voice.`
  if (/refused|blocked/i.test(message)) return `${withFullStop(message)} Allow microphone access for 21x, then check it in Settings → Voice.`
  if (/in use/i.test(message)) return `${withFullStop(message)} Close the other application, then try again.`
  return message
}

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
  const available = useVoiceStore((s) => s.available)
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
  const setCaptionOwner = useVoiceStore((s) => s.setCaptionOwner)
  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)

  const [voiceMode, setVoiceMode] = useState(false)
  const [starting, setStarting] = useState(false)
  /**
   * True from the moment this control asks the store for its turn until it
   * knows the turn's id. The store publishes the id before `startTurn`
   * resolves (the microphone opens in between), and for that gap the turn is
   * already this control's.
   */
  const [claimingTurn, setClaimingTurn] = useState(false)
  const [problem, setProblem] = useState<VoiceProblem | null>(null)
  const setError = useCallback((message: string | null, fix = false) => {
    setProblem(message === null ? null : { message, fix })
  }, [])
  const error = problem?.message ?? null
  /** The voice turn this control opened, so a sentence from another microphone is never sent here. */
  const ownTurn = useRef<string | null>(null)
  /** Mirrors `ownTurn` so the buttons redraw when this control's turn opens or ends. */
  const [ownTurnId, setOwnTurnIdState] = useState<string | null>(null)
  const setOwnTurn = useCallback((id: string | null) => {
    ownTurn.current = id
    setOwnTurnIdState(id)
  }, [])
  const hiddenField = useRef<HTMLTextAreaElement>(null)
  const setupLabelId = useId()
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
  }, [setError])

  // Reuse the app's conversation dispatcher. It writes each finished segment
  // into this private composer and calls submit; no words leak into the visible
  // Commander draft or any task composer.
  useEffect(() => {
    return dictation.registerComposer(COMMANDER_VOICE_COMPOSER_KEY, {
      getField: () => hiddenField.current,
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

  const readiness = commanderVoiceReadiness({
    available,
    permission,
    runtimeInstalled: runtime.installed,
    setupComplete: micSetupComplete,
    engine,
  })
  const setupProblem = readiness?.problem ?? null
  /** A short, always-visible label for the same problem, under the button (#83). */
  const setupLabel = readiness?.label ?? null

  const openVoiceSettings = useCallback(() => {
    setError(null)
    setSettingsTab(SettingsTab.VOICE)
    openSettings()
  }, [openSettings, setSettingsTab, setError])

  // While this control's conversation runs, its status pill is the one place
  // the half-heard words appear; the global voice overlay leaves them out
  // (#83). A turn opened by another microphone keeps the overlay, and its
  // words: ownership follows the turn this control actually owns, never
  // merely the fact that it is starting. While another microphone's turn is
  // live, that turn's captions stay where its user is reading them.
  const ownsCaptions = voiceMode && (!turnId || turnId === ownTurnId || claimingTurn)
  useEffect(() => {
    if (!ownsCaptions) return undefined
    setCaptionOwner(COMMANDER_VOICE_COMPOSER_KEY)
    return () => {
      if (useVoiceStore.getState().captionOwner === COMMANDER_VOICE_COMPOSER_KEY) setCaptionOwner(null)
    }
  }, [ownsCaptions, setCaptionOwner, useVoiceStore])

  // Turning voice mode on owns the complete loop. There is no second Talk
  // button: opening the mode immediately opens a persistent conversation turn.
  useEffect(() => {
    if (!voiceMode || !sessionId) return undefined
    let closed = false

    /** Set once the microphone path is the part that failed, so the alert offers Settings → Voice. */
    let fixable = false
    const refuseForeignTurn = (): void => {
      const existing = useVoiceStore.getState().turnId
      if (existing && existing !== ownTurn.current) throw new Error(MICROPHONE_BUSY_MESSAGE)
    }

    const open = async (): Promise<void> => {
      setStarting(true)
      setError(null)
      try {
        // Before anything slow: preparing the reply voice can take seconds (or
        // never finish), and another microphone must not lose its captions or
        // its turn to a conversation that cannot start anyway.
        refuseForeignTurn()
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
          fixable = true
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
            fixable = true
            const engineMessage = enabled.engine.state === 'error' ? enabled.engine.message : ''
            throw new Error(enabled.result?.message || engineMessage || 'Voice input could not be enabled.')
          }
        }
        // Again: a microphone may have opened while the voices were prepared.
        refuseForeignTurn()
        dictation.setActiveComposer(COMMANDER_VOICE_COMPOSER_KEY)
        setClaimingTurn(true)
        await startTurn('conversation')
        if (closed) return
        const opened = useVoiceStore.getState().turnId
        if (!opened) {
          fixable = true
          throw new Error(captureAdvice(useVoiceStore.getState().result?.message || 'The microphone could not be started.'))
        }
        setOwnTurn(opened)
      } catch (err) {
        if (!closed) {
          setError(messageOf(err), fixable)
          setVoiceMode(false)
        }
      } finally {
        if (!closed) {
          setStarting(false)
          setClaimingTurn(false)
        }
      }
    }

    void open()
    return () => {
      closed = true
      setStarting(false)
      setClaimingTurn(false)
      const owned = ownTurn.current
      if (owned && useVoiceStore.getState().turnId === owned) void cancelTurn()
      setOwnTurn(null)
      if (dictation.getActiveComposer() === COMMANDER_VOICE_COMPOSER_KEY) dictation.clearActiveComposer()
      stopPlaybackNow()
      void commanderVoiceApi.setActive(null).catch(() => {})
    }
  }, [voiceMode, sessionId, startTurn, setVoiceEnabled, initializeTts, setTtsEnabled, cancelTurn, stopPlaybackNow, dictation, useVoiceStore, selectVoiceReady, selectSpeechReady, setOwnTurn, setError])

  const toggleVoiceMode = useCallback(() => {
    if (voiceMode) {
      setVoiceMode(false)
      return
    }
    if (readiness?.blocking) {
      // Settings cannot add voice to a build without it.
      setError(readiness.problem, available)
      return
    }
    // Refused here, before voice mode exists at all: nothing about another
    // microphone's live turn (its captions least of all) may change.
    const existing = useVoiceStore.getState().turnId
    if (existing && existing !== ownTurn.current) {
      setError(MICROPHONE_BUSY_MESSAGE)
      return
    }
    setVoiceMode(true)
  }, [voiceMode, readiness?.blocking, readiness?.problem, available, useVoiceStore, setError])

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
    const failure = useVoiceStore.getState().result?.message
    // A reported failure (the worker crashed, the microphone went away) gets
    // the way to repair it; the quiet safety timeout only needs a new click.
    setError(failure ? captureAdvice(failure) : 'The voice conversation ended. Turn it on to reconnect.', Boolean(failure))
    setVoiceMode(false)
  }, [voiceMode, starting, turnId, useVoiceStore, setOwnTurn, setError])

  if (!sessionId) return null

  const busy = starting || voiceState === 'transcribing'
  const status = starting
    ? 'Starting voice conversation…'
    : speaking
      ? 'Commander is speaking — start talking to interrupt.'
      : replying
        ? 'Commander is thinking…'
        : (listening && partial.trim()) || 'Listening…'

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
        aria-describedby={!voiceMode && setupLabel ? setupLabelId : undefined}
        title={voiceMode ? 'Voice mode is on: replies and reports are read aloud.' : 'Voice mode: talk to the Commander and hear its replies.'}
        onClick={toggleVoiceMode}
        data-testid="commander-voice-mode"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <AudioLines className="size-4" aria-hidden="true" />}
      </Button>

      {!voiceMode && setupLabel && (
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
          <p>{error}</p>
          {!voiceMode && problem?.fix && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 text-xs"
              onClick={openVoiceSettings}
              data-testid="commander-voice-fix"
            >
              Open voice settings
            </Button>
          )}
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

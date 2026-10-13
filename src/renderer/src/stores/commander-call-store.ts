import { create } from 'zustand'
import type { CallEvent, CallMediaEvent } from '@shared/commander-call'
import { activityNow } from '@/lib/activity/activity-clock'

/**
 * The Commander call's lifetime (#84, epic #82 decision D5).
 *
 * One call for the whole window. It is started and ended here, not by a view,
 * so leaving the Commander view does not end it. `CommanderCallHost`, mounted
 * once from AppLayout, binds the media driver (microphone, speech, main's
 * Commander voice bridge) and runs the watchers; views only read this store
 * and call its actions.
 *
 * Main remains the source of truth for turns, speech and the microphone. This
 * store only remembers what the renderer itself decided: that a call is open,
 * on which session, which microphone turn it opened, and when it was stopped.
 * `deriveCallState()` turns that and main's state into what is shown.
 */

export type CommanderMicMode = 'open-mic' | 'push-to-talk'
export type CallStatus = 'off' | 'starting' | 'live'

/** Private composer used by the app-level host for pause-delimited sentences. */
export const COMMANDER_VOICE_COMPOSER_KEY = 'commander-voice'

/**
 * Everything the call does to media. Bound by the host so the store can be
 * tested without a voice bridge, and so there is exactly one set of side
 * effects however many views render the call.
 */
export interface CommanderCallDriver {
  /** Tells main which session to speak for; null closes voice mode. */
  setActive(sessionId: string | null, signal?: AbortSignal): Promise<unknown>
  /**
   * Prepares the reply voice and the microphone and opens one conversation
   * turn. Resolves with its turn id; rejects with a message for the user.
   */
  openMicrophone(signal: AbortSignal, options?: { deviceId?: string }): Promise<string>
  /** Stops capture and lets the recogniser deliver its final tail. */
  isReplyActive?(): boolean
  finishMicrophone?(turnId: string, signal: AbortSignal): Promise<void>
  /** Closes the microphone turn if `turnId` is still the open one. */
  /** Closes only the microphone lease opened with this exact call signal. */
  closeMicrophone(turnId: string | null, signal: AbortSignal | null): void
  /** Silences playback in this tick. */
  stopPlayback(): void
  /** Cancels synthesis and the running Commander turn in main. */
  bargeIn(sessionId: string): Promise<unknown>
  /** Sends a heard sentence as a user turn. */
  send(sessionId: string, text: string): Promise<unknown>
}

export interface CommanderCallState {
  micMode: CommanderMicMode
  muted: boolean
  inputDeviceId: string
  micOpening: boolean
  pttHeld: boolean
  pttFinishing: boolean
  pttDraft: string
  userCaption: string
  setMicMode: (mode: CommanderMicMode) => Promise<void>
  setInputDevice: (id: string) => Promise<void>
  toggleMicrophone: () => Promise<void>
  beginTalk: () => Promise<void>
  finishTalk: () => void
  microphoneFinished: (tail: string) => void
  status: CallStatus
  /** The Commander session the call talks to. */
  sessionId: string | null
  /** The microphone turn this call opened. */
  turnId: string | null
  /** A call-level failure. Cleared by Retry, a new call, or End. */
  error: string | null
  /** The session a failed call was on, so Retry can reopen it. */
  retrySessionId: string | null
  /** A live turn error the user has acknowledged; a new turn has a new id. */
  dismissedTurnErrorId: string | null
  /** Monotonic time of the last interruption. */
  interruptedAt: number | null
  /** The current reply was already interrupted; talking again does not re-cancel it. */
  replyInterrupted: boolean
  lastEvent: CallEvent | null
  /** Wall-clock start of the live call, for "Live 04:12". */
  startedAt: number | null

  start: (sessionId: string) => Promise<void>
  end: () => void
  /** Stop, Esc or talking over a reply. */
  interrupt: (cause?: 'stop' | 'barge_in') => void
  retry: (turnErrorId?: string) => Promise<void>
  dismissError: () => void
  /** A pause-delimited sentence the microphone heard. */
  sendTranscript: (text: string) => void
  /** The microphone turn closed without End (worker failure, timeout, another mic). */
  mediaLost: (message: string) => void
  recordEvent: (event: CallEvent) => void
}

let driver: CommanderCallDriver | null = null
/** Bumped by every start and end, so a slow start cannot revive an ended call. */
let generation = 0
let startController: AbortController | null = null
/** Signal for the starting or live call whose media the store currently owns. */
let mediaSignal: AbortSignal | null = null
let microphoneController: AbortController | null = null
let microphoneGeneration = 0
const finishedMicrophones = new WeakSet<AbortSignal>()
const listeners = new Map<CallMediaEvent, Set<() => void>>()

/** Binds the media driver. Returns an unbind. Only the host calls this. */
export function bindCommanderCallDriver(next: CommanderCallDriver): () => void {
  driver = next
  return () => {
    if (driver !== next) return
    // The host is gone: nothing can run the call any more.
    useCommanderCallStore.getState().end()
    driver = null
  }
}

/** Subscribes to call media events (speech start/end, barge-in, interruption). */
export function onCallMediaEvent(event: CallMediaEvent, listener: () => void): () => void {
  let set = listeners.get(event)
  if (!set) listeners.set(event, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

/** Emits a call media event. The host calls this for speech start/end. */
export function emitCallMediaEvent(event: CallMediaEvent): void {
  for (const listener of listeners.get(event) ?? []) {
    try {
      listener()
    } catch (err) {
      console.error('[commander-call] listener failed:', err)
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const OFF = {
  status: 'off' as CallStatus,
  sessionId: null,
  turnId: null,
  interruptedAt: null,
  replyInterrupted: false,
  startedAt: null,
  micOpening: false, pttHeld: false, pttFinishing: false, pttDraft: '', userCaption: ''
}

export const useCommanderCallStore = create<CommanderCallState>((set, get) => {
  /** Closes everything the call opened. Safe to call twice. */
  const teardown = (): void => {
    microphoneGeneration++
    microphoneController?.abort()
    microphoneController = null
    const { sessionId, turnId, status } = get()
    if (status === 'off' || !driver) return
    const ownedSignal = mediaSignal
    mediaSignal = null
    driver.closeMicrophone(turnId, ownedSignal)
    driver.stopPlayback()
    if (sessionId) {
      // End owns the complete call lifetime: stop any synthesis and cancel the
      // active Commander turn as well as closing the microphone. Chat history
      // is persisted independently and is deliberately left untouched.
      void driver.bargeIn(sessionId).catch(() => {})
      void driver.setActive(null).catch(() => {})
    }
  }

  const suspendMicrophone = (): void => {
    microphoneGeneration++
    const signal = mediaSignal
    const turnId = get().turnId
    set({ turnId: null, micOpening: false, pttHeld: false, pttFinishing: false, pttDraft: '' })
    microphoneController?.abort()
    microphoneController = null
    if (signal) driver?.closeMicrophone(turnId, signal)
    mediaSignal = null
  }
  const resumeMicrophone = async (): Promise<void> => {
    const current = get(), media = driver
    if (current.status !== 'live' || current.turnId || current.micOpening || !media) return
    const callGeneration = generation, mine = ++microphoneGeneration
    const controller = new AbortController()
    microphoneController = controller; mediaSignal = controller.signal
    set({ micOpening: true, error: null })
    try {
      const id = await media.openMicrophone(controller.signal, current.inputDeviceId ? { deviceId: current.inputDeviceId } : undefined)
      if (callGeneration !== generation || mine !== microphoneGeneration) { media.closeMicrophone(id, controller.signal); return }
      set({ turnId: id, micOpening: false })
      if (get().pttFinishing) get().finishTalk()
    } catch (error) {
      if (callGeneration !== generation || mine !== microphoneGeneration) return
      media.closeMicrophone(null, controller.signal)
      mediaSignal = null; microphoneController = null
      set({ micOpening: false, pttHeld: false, pttFinishing: false, pttDraft: '', error: messageOf(error) })
    }
  }

  return {
    ...OFF,
    micMode: 'open-mic', muted: false, inputDeviceId: '',
    setMicMode: async (mode) => {
      if (get().status === 'starting' || mode === get().micMode) return
      suspendMicrophone(); set({ micMode: mode, muted: false })
      if (mode === 'open-mic') await resumeMicrophone()
    },
    setInputDevice: async (id) => {
      if (get().status === 'starting' || id === get().inputDeviceId) return
      suspendMicrophone(); set({ inputDeviceId: id })
      if (get().micMode === 'open-mic' && !get().muted) await resumeMicrophone()
    },
    toggleMicrophone: async () => {
      const muted = !get().muted
      if (muted) suspendMicrophone()
      set({ muted })
      if (!muted && get().micMode === 'open-mic') await resumeMicrophone()
    },
    beginTalk: async () => {
      const current = get()
      if (current.status !== 'live' || current.micMode !== 'push-to-talk' || current.muted || current.pttHeld || current.pttFinishing) return
      set({ pttHeld: true, pttDraft: '', userCaption: '' })
      if (driver?.isReplyActive?.()) get().interrupt('barge_in')
      else { driver?.stopPlayback(); if (current.sessionId) void driver?.bargeIn(current.sessionId).catch(() => {}) }
      await resumeMicrophone()
    },
    finishTalk: () => {
      const current = get()
      if (!current.pttHeld && !current.pttFinishing) return
      set({ pttHeld: false, pttFinishing: true })
      if (!current.turnId || !mediaSignal || !driver?.finishMicrophone) return
      // Each release is sent once; repeated keyup/pointerup cannot end another turn.
      const signal = mediaSignal, id = current.turnId
      if (finishedMicrophones.has(signal)) return
      finishedMicrophones.add(signal)
      void driver.finishMicrophone(id, signal).catch(error => {
        if (mediaSignal === signal && get().turnId === id) get().mediaLost(messageOf(error))
      })
    },
    microphoneFinished: (tail) => {
      const current = get()
      if (current.micMode !== 'push-to-talk' || (!current.pttHeld && !current.pttFinishing)) return
      const text = [current.pttDraft, tail.trim()].filter(Boolean).join(' ')
      const signal = mediaSignal
      set({ turnId: null, pttHeld: false, pttFinishing: false, micOpening: false, pttDraft: '', userCaption: text })
      if (signal) driver?.closeMicrophone(null, signal)
      mediaSignal = null; microphoneController = null
      if (text) get().sendTranscript(text)
    },
    error: null,
    retrySessionId: null,
    dismissedTurnErrorId: null,
    lastEvent: null,

    start: async (sessionId) => {
      const current = get()
      if (current.status !== 'off' && current.sessionId === sessionId) return
      if (current.status !== 'off') get().end()
      if (!driver) {
        set({ error: 'Voice is not available in this build.', retrySessionId: sessionId })
        return
      }
      const mine = ++generation
      startController?.abort()
      const controller = new AbortController()
      startController = controller
      mediaSignal = controller.signal
      const media = driver
      let activated = false
      set({ ...OFF, status: 'starting', sessionId, error: null, retrySessionId: null, dismissedTurnErrorId: null, lastEvent: null })
      try {
        await media.setActive(sessionId, controller.signal)
        activated = true
        if (mine !== generation) return
        const turnId = get().micMode === 'push-to-talk' || get().muted ? null : await media.openMicrophone(controller.signal, get().inputDeviceId ? { deviceId: get().inputDeviceId } : undefined)
        if (mine !== generation) {
          media.closeMicrophone(turnId, controller.signal)
          return
        }
        if (startController === controller) startController = null
        set({ status: 'live', turnId, startedAt: Date.now() })
      } catch (err) {
        if (mine !== generation) return
        // A preflight refusal (another microphone owns capture) changed no
        // media and must not silence or clear that other turn.
        if (activated) teardown()
        else if (mediaSignal === controller.signal) mediaSignal = null
        generation++
        set({ ...OFF, error: messageOf(err), retrySessionId: sessionId })
      }
    },

    end: () => {
      generation++
      startController?.abort()
      startController = null
      teardown()
      mediaSignal = null
      set({ ...OFF, error: null, retrySessionId: null, dismissedTurnErrorId: null, lastEvent: null })
    },

    interrupt: (cause = 'stop') => {
      const { status, sessionId } = get()
      if (status !== 'live' || !sessionId || !driver) return
      set({ interruptedAt: activityNow(), replyInterrupted: true })
      driver.stopPlayback()
      void driver.bargeIn(sessionId).catch(() => {})
      if (cause === 'barge_in') emitCallMediaEvent('barge_in')
      emitCallMediaEvent('interrupted')
    },

    retry: async (turnErrorId) => {
      const { status, retrySessionId, sessionId } = get()
      if (status !== 'off') {
        // A failed send in a live call: the microphone is still open.
        set({ error: null, ...(turnErrorId ? { dismissedTurnErrorId: turnErrorId } : {}) })
        if (!get().turnId && get().micMode === 'open-mic' && !get().muted) await resumeMicrophone()
        return
      }
      const target = retrySessionId ?? sessionId
      set({ error: null })
      if (target) await get().start(target)
    },

    dismissError: () => set({ error: null }),

    sendTranscript: (text) => {
      const { status, sessionId } = get()
      const words = text.trim()
      if (status !== 'live' || !sessionId || !words || !driver) return
      if (get().micMode === 'push-to-talk' && (get().pttHeld || get().pttFinishing)) {
        set({ pttDraft: [get().pttDraft, words].filter(Boolean).join(' '), userCaption: words })
        return
      }
      const mine = generation
      set({ error: null, userCaption: words })
      void driver
        .send(sessionId, words)
        .then(() => {
          // The next reply may be interrupted independently of this one.
          if (mine === generation && get().status === 'live' && get().sessionId === sessionId) {
            set({ replyInterrupted: false })
          }
        })
        .catch((err) => {
          if (mine === generation && get().status === 'live' && get().sessionId === sessionId) {
            set({ error: messageOf(err) })
          }
        })
    },

    mediaLost: (message) => {
      const { status, sessionId } = get()
      if (status !== 'live') return
      generation++
      // The turn is already gone; only speech and main's voice mode remain.
      set({ turnId: null })
      teardown()
      set({ ...OFF, error: message, retrySessionId: sessionId })
    },

    recordEvent: (event) => {
      const { status, sessionId } = get()
      if (status === 'off' || event.sessionId !== sessionId) return
      set({ lastEvent: event })
    }
  }
})

/** Test-only reset. */
export function __resetCommanderCall(): void {
  driver = null
  generation++
  startController?.abort()
  startController = null
  mediaSignal = null
  microphoneController?.abort(); microphoneController = null; microphoneGeneration++
  listeners.clear()
  useCommanderCallStore.setState({ ...OFF, micMode: 'open-mic', muted: false, inputDeviceId: '', error: null, retrySessionId: null, dismissedTurnErrorId: null, lastEvent: null })
}

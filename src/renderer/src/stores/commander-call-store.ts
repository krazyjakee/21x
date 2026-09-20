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
  setActive(sessionId: string | null): Promise<unknown>
  /**
   * Prepares the reply voice and the microphone and opens one conversation
   * turn. Resolves with its turn id; rejects with a message for the user.
   */
  openMicrophone(): Promise<string>
  /** Closes the microphone turn if `turnId` is still the open one. */
  closeMicrophone(turnId: string | null): void
  /** Silences playback in this tick. */
  stopPlayback(): void
  /** Cancels synthesis and the running Commander turn in main. */
  bargeIn(sessionId: string): Promise<unknown>
  /** Sends a heard sentence as a user turn. */
  send(sessionId: string, text: string): Promise<unknown>
}

interface CommanderCallState {
  status: CallStatus
  /** The Commander session the call talks to. */
  sessionId: string | null
  /** The microphone turn this call opened. */
  turnId: string | null
  /** A call-level failure. Cleared by Retry, a new call, or End. */
  error: string | null
  /** The session a failed call was on, so Retry can reopen it. */
  retrySessionId: string | null
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
  retry: () => Promise<void>
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
  startedAt: null
}

export const useCommanderCallStore = create<CommanderCallState>((set, get) => {
  /** Closes everything the call opened. Safe to call twice. */
  const teardown = (): void => {
    const { sessionId, turnId, status } = get()
    if (status === 'off' || !driver) return
    driver.closeMicrophone(turnId)
    driver.stopPlayback()
    if (sessionId) {
      // End owns the complete call lifetime: stop any synthesis and cancel the
      // active Commander turn as well as closing the microphone. Chat history
      // is persisted independently and is deliberately left untouched.
      void driver.bargeIn(sessionId).catch(() => {})
      void driver.setActive(null).catch(() => {})
    }
  }

  return {
    ...OFF,
    error: null,
    retrySessionId: null,
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
      const media = driver
      let activated = false
      set({ ...OFF, status: 'starting', sessionId, error: null, retrySessionId: null, lastEvent: null })
      try {
        await media.setActive(sessionId)
        activated = true
        if (mine !== generation) return
        const turnId = await media.openMicrophone()
        if (mine !== generation) {
          media.closeMicrophone(turnId)
          return
        }
        set({ status: 'live', turnId, startedAt: Date.now() })
      } catch (err) {
        if (mine !== generation) return
        // A preflight refusal (another microphone owns capture) changed no
        // media and must not silence or clear that other turn.
        if (activated) teardown()
        generation++
        set({ ...OFF, error: messageOf(err), retrySessionId: sessionId })
      }
    },

    end: () => {
      generation++
      teardown()
      set({ ...OFF, error: null, retrySessionId: null, lastEvent: null })
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

    retry: async () => {
      const { status, retrySessionId, sessionId } = get()
      if (status !== 'off') {
        // A failed send in a live call: the microphone is still open.
        set({ error: null })
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
      set({ error: null })
      void driver
        .send(sessionId, words)
        .then(() => {
          // The next reply may be interrupted independently of this one.
          if (get().sessionId === sessionId) set({ replyInterrupted: false })
        })
        .catch((err) => {
          if (get().sessionId === sessionId) set({ error: messageOf(err) })
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
  listeners.clear()
  useCommanderCallStore.setState({ ...OFF, error: null, retrySessionId: null, lastEvent: null })
}

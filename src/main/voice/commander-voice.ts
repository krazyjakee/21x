/**
 * Commander voice mode (#64): the main-process glue between the Commander's
 * event stream and the speech service.
 *
 * The renderer opens voice mode on one session. From then on, and until it is
 * closed, this bridge:
 *
 * - speaks each reply as it streams — every finished sentence is handed to
 *   the selected engine the moment it exists, and the tail is flushed when the
 *   turn ends, so a short reply is never left in a buffer;
 * - never reads a Captain report aloud as written (#107). A report that is
 *   relayed starts a Commander turn, and that turn's plain-language summary
 *   is what is spoken. A report that gets no turn (no provider, or a stored
 *   briefing) is announced in one line that points to the chat;
 * - on barge-in stops playback, cancels the synthesis request or connection,
 *   and cancels the Commander turn, so the cancelled reply is neither heard
 *   later nor written further.
 *
 * It uses the speech service's streaming passage with the `conversation`
 * source: opening voice mode was the request to be spoken to, so neither the
 * automatic "read answers" switch nor a voice-turn expectation is needed. The
 * passage is keyed by `commander:<sessionId>` in place of a task id.
 *
 * Nothing here decides which engine speaks. The service does, from settings.
 */

import type { CommanderEvent, CommanderMessage } from '../../shared/commander'
import type { VoiceSpeechRequest } from '../../shared/voice-tts'
import type { VoiceAnswerPart } from './voice-speech-service'

/** The part of the Commander service this bridge uses. */
export interface CommanderVoiceCommander {
  onEvent(listener: (event: CommanderEvent) => void): () => void
  cancel(sessionId: string): boolean
  activeTurnId(sessionId: string): string | null
  sendUserMessage(sessionId: string, text: string, origin?: 'typed' | 'voice'): { turnId: string; message: CommanderMessage }
}

/** The part of the speech service this bridge uses. */
export interface CommanderVoiceSpeech {
  beginStreamingAnswer(taskId: string, parts: VoiceAnswerPart[] | undefined, source: 'conversation'): Promise<boolean>
  pushStreamingAnswer(taskId: string, parts: VoiceAnswerPart[], final?: boolean): void
  endStreamingAnswer(taskId: string): void
  speak(request: VoiceSpeechRequest): Promise<boolean>
  interrupt(): void
  stop(reason?: 'cancelled'): void
  readonly streamingTaskId: string | null
  readonly currentTaskId: string | null
}

export interface CommanderVoiceOptions {
  commander: CommanderVoiceCommander
  speech: CommanderVoiceSpeech
  /** Names the project a report came from, for the spoken lead-in. */
  resolveProjectName?: (projectId: string) => string | null | undefined
  /** How long `send` waits for a cancelled turn to end before giving up. */
  cancelTimeoutMs?: number
}

/** The passage key for a session, in place of a task id. */
export function commanderVoiceKey(sessionId: string): string {
  return `commander:${sessionId}`
}

/**
 * What is said for a report that no summary turn will speak for. The report
 * itself is never read out: it is technical, and it is in the chat.
 */
export function spokenReport(projectName: string | null | undefined): string {
  const from = projectName?.trim() ? `Report from ${projectName.trim()}` : 'A report arrived'
  return `${from}; details in the chat.`
}

interface TurnState {
  sessionId: string
  turnId: string
  key: string
  /** Every message of the reply, in order: text runs and any report read between them. */
  parts: VoiceAnswerPart[]
  /** The text run still being written, or null after a tool call or a report. */
  textPart: VoiceAnswerPart | null
  runs: number
  /** Resolves once the passage is open (or refused). Deltas wait for it. */
  began: Promise<boolean>
  /** Barge-in or a close. Nothing more of this turn is spoken. */
  dead: boolean
}

const DEFAULT_CANCEL_TIMEOUT_MS = 4000

export class CommanderVoice {
  private activeSessionId: string | null = null
  private readonly turns = new Map<string, TurnState>()
  /** Report cues waiting to see whether a summary turn starts for them, per session. */
  private readonly pendingCues = new Map<string, string[]>()
  private readonly unsubscribe: () => void

  constructor(private readonly options: CommanderVoiceOptions) {
    this.unsubscribe = options.commander.onEvent((event) => {
      try {
        this.handleEvent(event)
      } catch (err) {
        // Speech must never disturb the Commander stream.
        console.error('[voice] commander voice mode failed:', err)
      }
    })
  }

  dispose(): void {
    this.setActiveSession(null)
    this.unsubscribe()
  }

  get activeSession(): string | null {
    return this.activeSessionId
  }

  /**
   * Opens voice mode on a session, or closes it with null.
   *
   * Closing stops whatever of that session is being read. Reports for a
   * session that is not the active one are never spoken.
   */
  setActiveSession(sessionId: string | null): void {
    const previous = this.activeSessionId
    if (previous === sessionId) return
    this.activeSessionId = sessionId
    if (previous) this.silenceSession(previous)
  }

  /**
   * Barge-in: the user started to speak, or pressed stop, on this session.
   *
   * Playback stops, the synthesis request or connection is cancelled, and the
   * Commander turn is cancelled, in that order. `interrupt` rather than `stop`
   * so the rest of the interrupted reply is remembered as silenced and cannot
   * be read again by a later push.
   */
  bargeIn(sessionId: string): { cancelled: boolean } {
    this.pendingCues.delete(sessionId)
    const key = commanderVoiceKey(sessionId)
    for (const turn of this.turns.values()) {
      if (turn.sessionId === sessionId) turn.dead = true
    }
    if (this.options.speech.streamingTaskId === key || this.options.speech.currentTaskId === key) {
      this.options.speech.interrupt()
    }
    return { cancelled: this.options.commander.cancel(sessionId) }
  }

  /**
   * Sends a final transcript as a user turn.
   *
   * A reply may still be running — barge-in cancels it, but the cancel lands
   * a moment later — so a running turn is cancelled and waited for first.
   * Voice mode is opened on the session if it was not, since a spoken
   * sentence expects a spoken reply.
   */
  async send(sessionId: string, text: string): Promise<{ turnId: string; message: CommanderMessage }> {
    const content = String(text ?? '').trim()
    if (!content) throw new Error('Nothing was heard.')
    if (this.activeSessionId !== sessionId) this.setActiveSession(sessionId)

    const running = this.options.commander.activeTurnId(sessionId)
    if (running) {
      this.bargeIn(sessionId)
      await this.awaitTurnEnd(sessionId, running)
    }
    // A transcript is not typed text: it cannot back a merge grant (#137).
    return this.options.commander.sendUserMessage(sessionId, content, 'voice')
  }

  // ── Events ────────────────────────────────────────────────

  handleEvent(event: CommanderEvent): void {
    switch (event.type) {
      case 'turn_started':
        this.onTurnStarted(event.sessionId, event.turnId)
        return
      case 'turn_event':
        this.onTurnEvent(event.sessionId, event.turnId, event.event)
        return
      case 'messages_appended':
        for (const message of event.messages) {
          if (message.role === 'report') this.onReport(event.sessionId, message)
        }
        return
      default:
        return
    }
  }

  private onTurnStarted(sessionId: string, turnId: string): void {
    // A turn that starts right after a report is its summary: that is spoken
    // in place of the cue.
    this.pendingCues.delete(sessionId)
    if (sessionId !== this.activeSessionId) return
    const key = commanderVoiceKey(sessionId)
    // A passage still reading the previous reply or a report is replaced: a
    // new turn is the user moving on.
    if (this.options.speech.streamingTaskId === key) this.options.speech.stop('cancelled')
    const turn: TurnState = {
      sessionId,
      turnId,
      key,
      parts: [],
      textPart: null,
      runs: 0,
      began: Promise.resolve(false),
      dead: false,
    }
    turn.began = this.options.speech
      .beginStreamingAnswer(key, undefined, 'conversation')
      .catch((err) => {
        console.error('[voice] could not open the Commander passage:', err)
        return false
      })
    this.turns.set(turnId, turn)
  }

  private onTurnEvent(sessionId: string, turnId: string, inner: Extract<CommanderEvent, { type: 'turn_event' }>['event']): void {
    const turn = this.turns.get(turnId)
    if (!turn || turn.sessionId !== sessionId) return
    if (turn.dead) {
      if (inner.type === 'done' || inner.type === 'error') this.turns.delete(turnId)
      return
    }
    switch (inner.type) {
      case 'text_delta': {
        if (!inner.text) return
        if (!turn.textPart) {
          turn.runs += 1
          turn.textPart = { partId: `${turnId}:${turn.runs}`, content: '' }
          turn.parts.push(turn.textPart)
        }
        turn.textPart.content += inner.text
        this.push(turn, false)
        return
      }
      case 'tool_call_start':
      case 'tool_call_result':
        // Whatever the model says after a tool call is a new message, and the
        // one before it is finished — so its closing sentence is released.
        // `final` releases the tail of every part so far; it does not end the
        // passage (`endStreamingAnswer` does), and the next run is a new part.
        if (turn.textPart) {
          turn.textPart = null
          this.push(turn, true)
        }
        return
      case 'done':
      case 'error':
        this.turns.delete(turnId)
        void turn.began.then((opened) => {
          if (!opened || turn.dead) return
          this.options.speech.pushStreamingAnswer(turn.key, turn.parts, true)
          this.options.speech.endStreamingAnswer(turn.key)
        })
        return
      default:
        return
    }
  }

  private push(turn: TurnState, final: boolean): void {
    void turn.began.then((opened) => {
      if (!opened || turn.dead) return
      this.options.speech.pushStreamingAnswer(turn.key, turn.parts, final)
    })
  }

  /**
   * A Captain report in the active session. Its content is not spoken: when
   * the Commander relays it, the relay turn starts in the same tick (see
   * CommanderService.deliverReport) and its summary is read like any reply.
   * The one-line cue is spoken only when no such turn follows.
   */
  private onReport(sessionId: string, message: CommanderMessage): void {
    if (sessionId !== this.activeSessionId) return
    const text = spokenReport(message.project_id ? this.options.resolveProjectName?.(message.project_id) : null)
    const key = commanderVoiceKey(sessionId)

    const open = [...this.turns.values()].find((t) => t.sessionId === sessionId && !t.dead)
    if (open) {
      // An append-only report can arrive during a reply without a relay turn.
      // Normal deliverReport calls defer this event until the reply ends.
      open.parts.push({ partId: `report:${message.id}`, content: text })
      open.textPart = null
      this.push(open, true)
      return
    }
    const cues = this.pendingCues.get(sessionId)
    if (cues) {
      cues.push(text)
      return
    }
    this.pendingCues.set(sessionId, [text])
    queueMicrotask(() => {
      const waiting = this.pendingCues.get(sessionId)
      this.pendingCues.delete(sessionId)
      if (!waiting || sessionId !== this.activeSessionId) return
      void this.options.speech
        .speak({ text: waiting.join(' '), source: 'conversation', taskId: key })
        .catch((err) => console.error('[voice] speaking the report cue failed:', err))
    })
  }

  // ── Internals ─────────────────────────────────────────────

  private silenceSession(sessionId: string): void {
    const key = commanderVoiceKey(sessionId)
    this.pendingCues.delete(sessionId)
    for (const [turnId, turn] of this.turns) {
      if (turn.sessionId === sessionId) {
        turn.dead = true
        this.turns.delete(turnId)
      }
    }
    if (this.options.speech.streamingTaskId === key || this.options.speech.currentTaskId === key) {
      this.options.speech.interrupt()
    }
  }

  private awaitTurnEnd(sessionId: string, turnId: string): Promise<void> {
    if (this.options.commander.activeTurnId(sessionId) !== turnId) return Promise.resolve()
    return new Promise((resolve) => {
      const timeout = this.options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS
      const settle = (): void => {
        clearTimeout(timer)
        off()
        resolve()
      }
      const off = this.options.commander.onEvent((event) => {
        if (event.type === 'turn_event' && event.turnId === turnId && event.event.type === 'done') settle()
      })
      const timer = setTimeout(settle, timeout)
      timer.unref?.()
      // The turn may have ended between the check and the subscription.
      if (this.options.commander.activeTurnId(sessionId) !== turnId) settle()
    })
  }
}

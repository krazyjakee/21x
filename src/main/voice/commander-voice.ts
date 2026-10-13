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
 * - keeps arriving Captain reports silent (#88), including decisions and
 *   blockers. They remain visible in their request thread or quiet inbox;
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
import { commanderVoiceKey } from '../../shared/commander-call'
import type { VoiceSpeechRequest } from '../../shared/voice-tts'
import type { VoiceAnswerPart } from './voice-speech-service'
import { COMMANDER_TECHNICAL_DETAILS, splitCommanderReport } from '../../shared/commander-report'
import { parseCommanderAction } from '../../shared/commander-action'

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

/** The passage key for a session, in place of a task id (shared with the renderer's call store). */
export { commanderVoiceKey }

/**
 * Plain-language formatting for an explicitly requested report reading.
 * Arriving reports never invoke this helper or start speech (#88).
 */
export function spokenReport(projectName: string | null | undefined, content?: string): string {
  const from = projectName?.trim() ? `Report from ${projectName.trim()}` : 'A report arrived'
  if (content?.includes(COMMANDER_TECHNICAL_DETAILS)) {
    // Structured reports already contain the communication contract. Keep
    // their audit section out of an explicitly requested reading.
    const explanation = splitCommanderReport(content).content
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+|\b(?:commit(?:\s+(?:hash|sha))?|(?:head[_ ]?)?sha)\s*[:=]?\s*[0-9a-f]{7,40}\b|\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\bPR\s*#\s*\d+\b/gi, '')
      .replace(/[*#`]/g, '')
      .replace(/\n+/g, '. ')
    return `${from}. ${explanation}`
  }
  return `${from}; details in the chat.`
}

/** Facts from a validated executed mutation, never from hosted assistant claims. */
export function spokenCommanderAction(tool: string, content: string, isError: boolean): string | null {
  const action = parseCommanderAction(tool, content, isError)
  if (!action || !action.changes.length) return null
  const name = action.target.name
  const kind = action.target.kind === 'repo' ? 'repository' : action.target.kind
  const archived = action.changes.find((change) => change.field === 'archived')
  if ((tool === 'archive_project' || tool === 'restore_project') && typeof archived?.after === 'boolean') {
    return `${archived.after ? 'Archived' : 'Restored'} project “${name}”.`
  }
  const paused = action.changes.find((change) => change.field === 'all_projects_paused')
  if (tool === 'pause_all_projects' && typeof paused?.after === 'boolean') return `${paused.after ? 'Paused' : 'Resumed'} new agent work across all projects.`
  if (tool.startsWith('create_') || tool.startsWith('add_')) return `Created ${kind} “${name}”.`
  if (tool.startsWith('remove_')) return `Removed ${kind} “${name}”.`
  if (tool === 'promote_skill') return `Made skill “${name}” available to every project.`
  if (tool === 'move_skill') return action.target.projectName
    ? `Moved skill “${name}” to project “${action.target.projectName}”.`
    : `Moved skill “${name}” to its selected project.`
  const labels: Record<string, string> = {
    description: 'description', content: 'instructions', preferred_model: 'preferred model',
    default_branch: 'default branch', git_provider: 'repository provider', git_org: 'repository owner',
    captain_agent_id: 'Captain assignment', default_agent_id: 'default agent assignment',
    project_id: 'project assignment', is_deleted: 'availability'
  }
  const value = (input: unknown): string | null => {
    if (input === null) return 'not set'
    if (typeof input === 'boolean') return input ? 'on' : 'off'
    if (typeof input === 'number') return String(input)
    if (typeof input === 'string' && input.length <= 120) return input ? `“${input}”` : 'empty'
    return null
  }
  return action.changes.map((change) => {
    if (change.field === 'name' && typeof change.before === 'string' && typeof change.after === 'string') {
      return `Renamed ${kind} from “${change.before}” to “${change.after}”.`
    }
    const label = labels[change.field] ?? change.field.replace(/_/g, ' ')
    // Assignment IDs and long prose belong to card details, not speech.
    const before = change.field.endsWith('_id') ? null : value(change.before)
    const after = change.field.endsWith('_id') ? null : value(change.after)
    return before !== null && after !== null
      ? `Changed ${label} for ${kind} “${name}” from ${before} to ${after}.`
      : `Changed ${label} for ${kind} “${name}”. Details are in the action card.`
  }).join(' ')
}

interface TurnState {
  sessionId: string
  turnId: string
  key: string
  /** Every text run of the user's requested reply, in order. */
  parts: VoiceAnswerPart[]
  /** The text run still being written, or null after a tool call. */
  textPart: VoiceAnswerPart | null
  runs: number
  /** Resolves once the passage is open (or refused). Deltas wait for it. */
  began: Promise<boolean>
  /** Barge-in or a close. Nothing more of this turn is spoken. */
  dead: boolean
  /** One factual announcement per actual tool result in this turn. */
  announcedActions: Set<string>
}

const DEFAULT_CANCEL_TIMEOUT_MS = 4000

export class CommanderVoice {
  private activeSessionId: string | null = null
  private readonly turns = new Map<string, TurnState>()
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
        // Reports are quiet updates even during an active call or reply.
        return
      default:
        return
    }
  }

  private onTurnStarted(sessionId: string, turnId: string): void {
    if (sessionId !== this.activeSessionId) return
    const key = commanderVoiceKey(sessionId)
    // A passage still reading the previous reply is replaced: a
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
      announcedActions: new Set(),
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
        if (inner.type === 'tool_call_result' && !turn.announcedActions.has(inner.id)) {
          const fact = spokenCommanderAction(inner.name, inner.content, inner.isError)
          if (fact) {
            turn.announcedActions.add(inner.id)
            turn.parts.push({ partId: `action:${turnId}:${inner.id}`, content: fact })
            this.push(turn, true)
          }
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

  // ── Internals ─────────────────────────────────────────────

  private silenceSession(sessionId: string): void {
    const key = commanderVoiceKey(sessionId)
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

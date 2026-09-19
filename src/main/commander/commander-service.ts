import type { ChatMessage } from '../../shared/chat'
import type { CommanderEvent, CommanderMessage, CommanderSession } from '../../shared/commander'
import { ChatRuntime, type ChatTurnHandle, type ChatTurnResult } from '../chat/chat-runtime'
import { imagesUnsupportedMessage, type ChatProvider, type ChatProviderRequest } from '../chat/providers/types'
import { validateChatImageInputs } from '../../shared/chat-images'
import type { ChatToolDefinition } from '../chat/tools'
import { normalizeTitle, type CommanderStore } from './commander-store'
import { buildContext, DEFAULT_CONTEXT_BUDGET, planFold, transcriptForSummary, type ContextBudget } from './context'
import { COMMANDER_SUMMARY_PROMPT, COMMANDER_SYSTEM_PROMPT, COMMANDER_TITLE_PROMPT, reportRelayNote, withSummary } from './prompts'
import { guardReportAsks, MAX_REPORT_ASKS_WITHOUT_USER_TURN } from './report-tools'

/**
 * Runs Commander chat turns over persisted sessions (docs/commander.md).
 *
 * `sendUserMessage` stores the user's message, builds the model context from
 * the session (rolling summary + newest turns within a budget), runs one
 * ChatRuntime turn and streams its events, then stores what the model and its
 * tools added. After the turn it names an untitled session and folds turns
 * that no longer fit the budget into the summary, so the next turn starts
 * without waiting on either.
 *
 * Extension points:
 * - The Commander's tools (project-tools.ts) are supplied through `getTools`,
 *   built per turn so a confirmation can be checked against the user message.
 * - #62 delivers Captain reports through `deliverReport`: the report is
 *   stored (unread until the session is read) and, when the session is the
 *   one open in the Commander view (`setActiveSession`), a turn is started so
 *   the Commander relays it. A turn started by a report can only call
 *   `ask_captain` within the session's report-ask budget until the user
 *   speaks again (report-tools.ts).
 */

export interface CommanderToolContext {
  sessionId: string
  /** The user message that immediately precedes this turn's tool calls; empty for a report-triggered turn. */
  userMessage: string
  /** The stored id of that message (#137: merge grants bind to it); absent for a report-triggered turn. */
  userMessageId?: string
  /** What started the turn: the user, or a report being relayed (#62). */
  trigger: 'user' | 'report'
}

export interface CommanderServiceOptions {
  store: CommanderStore
  /** Throws when no provider can be built (for example, no API key). */
  createProvider: () => ChatProvider
  emit: (event: CommanderEvent) => void
  runtime?: ChatRuntime
  getTools?: (context: CommanderToolContext) => ChatToolDefinition[]
  systemPrompt?: string
  budget?: Partial<ContextBudget>
  maxToolCalls?: number
  /** Timeout for the title and summary one-shot calls. */
  oneShotTimeoutMs?: number
  /** `ask_captain` calls report-triggered turns may make per session before a user turn resets the count (#62). */
  maxReportAsks?: number
}

export interface SendResult {
  turnId: string
  message: CommanderMessage
  /** Resolves after the turn's messages are stored and the title and summary work is done. Never rejects. */
  done: Promise<void>
}

export interface AppendReportInput {
  sessionId: string
  content: string
  projectId?: string | null
  correlationId?: string | null
}

export interface DeliverReportInput extends AppendReportInput {
  /** Shown to the model when it relays ("Project X says …"); the id is the fallback. */
  projectName?: string | null
}

export interface DeliverReportResult {
  message: CommanderMessage
  /** True when the session is open in the view and a relay turn started (or will, after the running one). */
  relayed: boolean
}

interface TurnStart {
  trigger: 'user' | 'report'
  userMessage: string
  userMessageId?: string
  /** Extra system text for the turn (the relay note of a report-triggered turn). */
  systemNote?: string
}

interface PreparedTurn {
  context: ReturnType<typeof buildContext>
  system: string
  tools: ChatToolDefinition[]
}

const MAX_USER_MESSAGE_CHARS = 100_000
const FALLBACK_TITLE_WORDS = 6
const MAX_TITLE_CHARS = 60
const DEFAULT_ONE_SHOT_TIMEOUT_MS = 20_000

/** First words of the user's message, used when the model cannot name the session. */
export function fallbackTitle(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length === 0) return 'New session'
  let title = words.slice(0, FALLBACK_TITLE_WORDS).join(' ')
  const truncated = words.length > FALLBACK_TITLE_WORDS || title.length > MAX_TITLE_CHARS
  if (title.length > MAX_TITLE_CHARS) title = title.slice(0, MAX_TITLE_CHARS).trimEnd()
  return truncated ? `${title}…` : title
}

/** Cleans a model-written title; empty when unusable. */
export function cleanGeneratedTitle(raw: string): string {
  const firstLine = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const title = firstLine
    .replace(/^(title\s*:\s*)/i, '')
    .replace(/^["'`*#\s]+|["'`*\s]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .trim()
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…` : title
}

/**
 * The `project_id` and `correlation_id` a successful tool result carries
 * (`ask_captain` does), so the stored tool row can be matched to the
 * report that answers it (#62). Anything that is not such an object tags nothing.
 */
export function toolResultTags(content: string, isError: boolean): { projectId?: string; correlationId?: string } {
  if (isError || !content.startsWith('{')) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const record = parsed as { project_id?: unknown; correlation_id?: unknown }
  return {
    ...(typeof record.project_id === 'string' && record.project_id ? { projectId: record.project_id } : {}),
    ...(typeof record.correlation_id === 'string' && record.correlation_id ? { correlationId: record.correlation_id } : {})
  }
}

/** One non-streaming-to-anyone model call; returns the text. */
export async function completeText(provider: ChatProvider, request: Omit<ChatProviderRequest, 'tools' | 'toolChoice'>, signal: AbortSignal): Promise<string> {
  let text = ''
  for await (const event of provider.stream({ ...request, tools: [], toolChoice: 'none' }, signal)) {
    if (event.type === 'text_delta') text += event.text
  }
  return text
}

export class CommanderService {
  private readonly store: CommanderStore
  private readonly runtime: ChatRuntime
  private readonly budget: ContextBudget
  private readonly active = new Map<string, ChatTurnHandle>()
  private readonly folding = new Set<string>()
  private readonly naming = new Set<string>()
  /** The session open in the Commander view, as the renderer reports it (#62). */
  private activeSessionId: string | null = null
  /** Reports that arrived during a turn; relayed together once that turn ends. */
  private readonly pendingRelay = new Map<string, { messageIds: string[]; projectName: string | null }>()
  /** `ask_captain` calls made by report-triggered turns since the user last spoke, per session. */
  private readonly reportAsks = new Map<string, number>()

  constructor(private readonly options: CommanderServiceOptions) {
    this.store = options.store
    this.runtime = options.runtime ?? new ChatRuntime()
    this.budget = { ...DEFAULT_CONTEXT_BUDGET, ...options.budget }
  }

  /** Main-process observers of the event stream (#64 voice mode). Additive; the renderer path is `options.emit`. */
  private readonly listeners = new Set<(event: CommanderEvent) => void>()

  /** Subscribes a main-process observer to every event the renderer receives. Returns the unsubscribe. */
  onEvent(listener: (event: CommanderEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: CommanderEvent): void {
    try {
      this.options.emit(event)
    } catch (err) {
      console.error('[Commander] emit failed:', err)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[Commander] event listener failed:', err)
      }
    }
  }

  private emitSession(sessionId: string): CommanderSession | null {
    const session = this.store.getSession(sessionId)
    if (session) this.emit({ type: 'session_updated', session })
    return session
  }

  activeTurnId(sessionId: string): string | null {
    return this.active.get(sessionId)?.turnId ?? null
  }

  activeSessions(): Array<{ sessionId: string; turnId: string }> {
    return [...this.active.entries()].map(([sessionId, handle]) => ({ sessionId, turnId: handle.turnId }))
  }

  // ── The open session (#62) ──────────────────────────────────

  /** The renderer says which session the Commander view shows; null when the view is closed. */
  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessionId === sessionId
  }

  /**
   * Images are validated before storage. Only typed text can back a merge
   * grant; voice-origin messages never provide a userMessageId to tools.
   */
  sendUserMessage(sessionId: string, text: string, origin: 'typed' | 'voice' = 'typed', images?: unknown): SendResult {
    const content = typeof text === 'string' ? text.trim() : ''
    const attached = validateChatImageInputs(images)
    if (!content && attached.length === 0) throw new Error('Message is empty')
    if (content.length > MAX_USER_MESSAGE_CHARS) throw new Error('Message is too long')
    if (!this.store.getSession(sessionId)) throw new Error(`Commander session not found: ${sessionId}`)
    if (this.active.has(sessionId)) throw new Error('The Commander is still answering in this session')

    // Built before anything is stored, so a missing key rejects cleanly.
    const provider = this.options.createProvider()
    if (attached.length > 0 && provider.supportsImages !== true) throw new Error(imagesUnsupportedMessage(provider))

    let prepared!: PreparedTurn
    let session: CommanderSession | null = null
    const message = this.store.appendMessage(sessionId, {
      role: 'user',
      content,
      ...(attached.length > 0 ? { images: attached.map(({ name, mimeType, data }) => ({ name, mimeType, data })) } : {})
    }, (pendingMessage) => {
      prepared = this.prepareTurn(sessionId, provider, { trigger: 'user', userMessage: content, userMessageId: origin === 'typed' ? pendingMessage.id : undefined })
      session = this.store.markRead(sessionId)
    })
    this.emit({ type: 'messages_appended', sessionId, messages: [message] })
    // Sending is reading: the user is looking at this session.
    if (session) this.emit({ type: 'session_updated', session })
    // A user turn resets the report-ask budget (#62).
    this.reportAsks.delete(sessionId)

    const { turnId, done } = this.startTurn(sessionId, provider, { trigger: 'user', userMessage: content, userMessageId: origin === 'typed' ? message.id : undefined }, prepared)
    return { turnId, message, done }
  }

  /** Prepare synchronously inside the user-message transaction, before accepting the draft. */
  private prepareTurn(sessionId: string, provider: ChatProvider, start: TurnStart): PreparedTurn {
    const context = buildContext(this.store.listMessages(sessionId), this.budget,
      provider.supportsImages === true ? (id) => this.store.getMessageImages(id) : undefined)
    let system = withSummary(this.options.systemPrompt ?? COMMANDER_SYSTEM_PROMPT, context.summary)
    if (start.systemNote) system = `${system}\n\n${start.systemNote}`
    let tools = this.options.getTools?.({ sessionId, userMessage: start.userMessage, userMessageId: start.userMessageId, trigger: start.trigger }) ?? []
    if (start.trigger === 'report') {
      const max = this.options.maxReportAsks ?? MAX_REPORT_ASKS_WITHOUT_USER_TURN
      tools = guardReportAsks(tools, {
        remaining: () => max - (this.reportAsks.get(sessionId) ?? 0),
        consume: () => this.reportAsks.set(sessionId, (this.reportAsks.get(sessionId) ?? 0) + 1)
      })
    }

    return { context, system, tools }
  }

  /** One model turn over the session as stored right now. The caller has checked that no turn is running. */
  private startTurn(sessionId: string, provider: ChatProvider, start: TurnStart, prepared?: PreparedTurn): { turnId: string; done: Promise<void> } {
    const { context, system, tools } = prepared ?? this.prepareTurn(sessionId, provider, start)
    let turnId = ''
    const handle = this.runtime.startTurn(
      { provider, messages: context.messages, system, tools, maxToolCalls: this.options.maxToolCalls },
      (event) => {
        // `done` is re-emitted after the turn's messages are stored.
        if (event.type === 'done') return
        this.emit({ type: 'turn_event', sessionId, turnId, event })
      }
    )
    turnId = handle.turnId
    this.active.set(sessionId, handle)
    this.emit({ type: 'turn_started', sessionId, turnId })

    const done = handle.done
      .then((result) => this.finishTurn(sessionId, context.messages.length, result))
      .catch((err) => {
        console.error('[Commander] turn bookkeeping failed:', err)
        // The renderer must still leave its streaming state.
        const message = err instanceof Error ? err.message : String(err)
        this.emit({ type: 'turn_event', sessionId, turnId, event: { type: 'error', message: `Could not save the reply: ${message}` } })
        this.emit({ type: 'turn_event', sessionId, turnId, event: { type: 'done', stopReason: 'error' } })
      })
      .finally(() => {
        if (this.active.get(sessionId) === handle) this.active.delete(sessionId)
      })
      .then(() => this.afterTurn(sessionId, provider))
      .catch((err) => console.error('[Commander] post-turn work failed:', err))
      .then(() => this.relayPending(sessionId))
      .catch((err) => console.error('[Commander] report relay failed:', err))

    return { turnId, done }
  }

  private finishTurn(sessionId: string, inputCount: number, result: ChatTurnResult): void {
    const added = result.messages.slice(inputCount)
    const stored: CommanderMessage[] = []
    for (const m of added) {
      const persisted = this.persistChatMessage(sessionId, m)
      if (persisted) stored.push(persisted)
    }
    if (stored.length > 0) this.emit({ type: 'messages_appended', sessionId, messages: stored })
    this.emitSession(sessionId)
    if (this.active.get(sessionId)?.turnId === result.turnId) this.active.delete(sessionId)
    this.emit({ type: 'turn_event', sessionId, turnId: result.turnId, event: { type: 'done', stopReason: result.stopReason } })
  }

  private persistChatMessage(sessionId: string, message: ChatMessage): CommanderMessage | null {
    if (message.role === 'assistant') {
      if (!message.content && !message.toolCalls?.length) return null
      return this.store.appendMessage(sessionId, { role: 'assistant', content: message.content, toolCalls: message.toolCalls ?? null })
    }
    if (message.role === 'tool') {
      const isError = message.isError === true
      return this.store.appendMessage(sessionId, {
        role: 'tool',
        content: message.content,
        toolCallId: message.toolCallId,
        toolName: message.name,
        isError,
        ...toolResultTags(message.content, isError)
      })
    }
    // The runtime never adds user messages; ignore defensively.
    return null
  }

  private async afterTurn(sessionId: string, provider: ChatProvider): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) return
    if (!session.title) await this.generateTitle(sessionId, provider)
    await this.foldHistory(sessionId, provider)
  }

  cancel(sessionId: string): boolean {
    const handle = this.active.get(sessionId)
    if (!handle) return false
    handle.cancel()
    return true
  }

  cancelAll(): void {
    for (const handle of this.active.values()) handle.cancel()
  }

  /**
   * Names an untitled session from its first exchange with a cheap one-shot
   * call; falls back to the first words of the first user message. Never
   * overwrites a title set meanwhile (for example, a rename).
   */
  async generateTitle(sessionId: string, provider?: ChatProvider): Promise<string | null> {
    if (this.naming.has(sessionId)) return null
    this.naming.add(sessionId)
    try {
      const messages = this.store.listMessages(sessionId)
      const firstUser = messages.find((m) => m.role === 'user')
      if (!firstUser) return null
      const firstReply = messages.find((m) => m.role === 'assistant' && m.content.trim() && m.created_at > firstUser.created_at)

      let title = ''
      if (firstReply) {
        try {
          const model = provider ?? this.options.createProvider()
          const raw = await completeText(
            model,
            {
              system: COMMANDER_TITLE_PROMPT,
              messages: [{ role: 'user', content: `User: ${firstUser.content.slice(0, 2000) || '[shared an image]'}\n\nCommander: ${firstReply.content.slice(0, 2000)}` }],
              maxTokens: 32
            },
            AbortSignal.timeout(this.options.oneShotTimeoutMs ?? DEFAULT_ONE_SHOT_TIMEOUT_MS)
          )
          title = cleanGeneratedTitle(raw)
        } catch (err) {
          console.warn('[Commander] title generation failed, using fallback:', err instanceof Error ? err.message : err)
        }
      }
      if (!title) title = fallbackTitle(firstUser.content || (firstUser.images?.length ? 'Shared an image' : ''))

      // A rename while the model was thinking wins.
      if (this.store.getSession(sessionId)?.title) return null
      this.store.renameSession(sessionId, normalizeTitle(title))
      this.emitSession(sessionId)
      return title
    } finally {
      this.naming.delete(sessionId)
    }
  }

  /**
   * Folds turns that no longer fit the context budget into a new rolling
   * summary. On failure nothing is stored; the next turn simply trims.
   */
  async foldHistory(sessionId: string, provider?: ChatProvider): Promise<CommanderMessage | null> {
    if (this.folding.has(sessionId)) return null
    this.folding.add(sessionId)
    try {
      const plan = planFold(this.store.listMessages(sessionId), this.budget)
      if (!plan) return null
      const excerpt = transcriptForSummary(plan.toFold)
      const prompt = plan.previousSummary
        ? `Previous summary:\n${plan.previousSummary}\n\nNew conversation to fold in:\n${excerpt}`
        : `Conversation to summarise:\n${excerpt}`
      let summary: string
      try {
        const model = provider ?? this.options.createProvider()
        summary = (await completeText(
          model,
          { system: COMMANDER_SUMMARY_PROMPT, messages: [{ role: 'user', content: prompt }], maxTokens: 800 },
          AbortSignal.timeout(this.options.oneShotTimeoutMs ?? DEFAULT_ONE_SHOT_TIMEOUT_MS)
        )).trim()
      } catch (err) {
        console.warn('[Commander] summary generation failed:', err instanceof Error ? err.message : err)
        return null
      }
      if (!summary) return null
      if (!this.store.getSession(sessionId)) return null
      const stored = this.store.appendMessage(sessionId, { role: 'summary', content: summary, correlationId: plan.lastFoldedId })
      this.emit({ type: 'messages_appended', sessionId, messages: [stored] })
      return stored
    } finally {
      this.folding.delete(sessionId)
    }
  }

  /**
   * Stores a Captain report for a session. It counts as unread until the
   * session is read, and the model sees it on the next turn.
   */
  appendReport(input: AppendReportInput, emit = true): CommanderMessage {
    const content = input.content?.trim()
    if (!content) throw new Error('Report is empty')
    const message = this.store.appendMessage(input.sessionId, {
      role: 'report',
      content,
      projectId: input.projectId ?? null,
      correlationId: input.correlationId ?? null
    })
    if (emit) {
      this.emit({ type: 'messages_appended', sessionId: input.sessionId, messages: [message] })
    }
    this.emitSession(input.sessionId)
    return message
  }

  // ── Report delivery (#62) ───────────────────────────────────

  /**
   * Stores a report and, when its session is the one open in the view, gives
   * the Commander a turn to relay it. A session that is not open only gets
   * the unread report (the list badge). If the open session is mid-turn, the
   * relay waits for that turn to end. Storing never depends on the relay:
   * with no provider (no API key) the report is still there, unread.
   */
  deliverReport(input: DeliverReportInput): DeliverReportResult {
    const waitsForCurrentTurn = this.isSessionActive(input.sessionId) && this.active.has(input.sessionId)
    const message = this.appendReport(input, !waitsForCurrentTurn)
    if (!this.isSessionActive(input.sessionId)) return { message, relayed: false }
    if (waitsForCurrentTurn) {
      const pending = this.pendingRelay.get(input.sessionId)
      if (pending) {
        pending.messageIds.push(message.id)
        pending.projectName = input.projectName ?? pending.projectName
      } else {
        this.pendingRelay.set(input.sessionId, { messageIds: [message.id], projectName: input.projectName ?? null })
      }
      return { message, relayed: true }
    }
    return { message, relayed: this.relayReport(input.sessionId, input.projectName ?? null) }
  }

  private relayReport(sessionId: string, projectName: string | null): boolean {
    let provider: ChatProvider
    try {
      provider = this.options.createProvider()
    } catch (err) {
      console.warn('[Commander] Report stored but not relayed:', err instanceof Error ? err.message : err)
      return false
    }
    if (!this.store.getSession(sessionId)) return false
    this.startTurn(sessionId, provider, {
      trigger: 'report',
      userMessage: '',
      systemNote: reportRelayNote(projectName ? `"${projectName}"` : 'a project')
    })
    return true
  }

  /** After a turn: relays a report that arrived during it, if the session is still open and idle. */
  private relayPending(sessionId: string): void {
    const pending = this.pendingRelay.get(sessionId)
    if (!pending) return
    this.pendingRelay.delete(sessionId)
    const messages = pending.messageIds
      .map((id) => this.store.moveMessageToEnd(id))
      .filter((message): message is CommanderMessage => message !== null)
    if (messages.length > 0) {
      this.emit({ type: 'messages_appended', sessionId, messages })
      this.emitSession(sessionId)
    }
    if (!this.isSessionActive(sessionId) || this.active.has(sessionId)) return
    this.relayReport(sessionId, pending.projectName)
  }
}

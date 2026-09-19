import type { CommanderEvent, CommanderMessage, CommanderSession } from '../../shared/commander'
import { COMMANDER_AGENT_SETTING } from '../../shared/commander'
import { buildSystemMessage, computeDeliveryId, SYSTEM_MESSAGE_MARKER, SystemMessageOrigin } from '../../shared/system-authority'
import type { AgentRecord, TranscriptPartInput, TranscriptPartRecord } from '../database/types'
import { normalizeTitle, type CommanderStore } from './commander-store'
import { reportRelayNote } from './prompts'
import { guardReportAsks, MAX_REPORT_ASKS_WITHOUT_USER_TURN } from './report-tools'
import { runTool, validateTools, type ChatToolDefinition, type ChatToolResult } from './tools'

/**
 * Runs Commander chat sessions (docs/commander.md).
 *
 * A Commander session is an ordinary agent session. Its conversation lives on
 * a hidden `role = 'commander'` task row whose id is the session id, and it
 * goes through AgentManager like every task and every Captain: the same
 * adapters, auth, streaming, transcript store, approvals, stop and voice. The
 * renderer talks to it through the normal agent-session calls. This service
 * only owns what is particular to the Commander:
 *
 * - the session list around those rows (titles, archive, unread reports);
 * - the Commander's tools, served to its agent over MCP (commander-mcp.ts),
 *   with the context the confirmation check needs read from the transcript;
 * - Captain reports (#62): stored as unread, and handed to the agent as an
 *   automated message when the session is open in the Commander view (at
 *   once, or when the agent next goes idle);
 * - the agent every session runs on (the `commander_agent_id` setting).
 */

export interface CommanderToolContext {
  sessionId: string
  /** The user's newest message in the session; empty when the newest input was a relayed report. */
  userMessage: string
  /** What the agent is answering: the user, or a report being relayed (#62). */
  trigger: 'user' | 'report'
}

/** The slice of AgentManager the service drives; tests stub it. */
export interface CommanderAgentsPort {
  findSessionByTaskId(taskId: string): { sessionId: string; session: { agentId: string; status: string } } | undefined
  sendMessage(sessionId: string, message: string, taskId?: string, agentId?: string): Promise<unknown>
  stopByTaskId(taskId: string): Promise<unknown>
  addExternalListener(fn: (channel: string, data: unknown) => void): void
}

/** The slice of DatabaseManager the service reads; tests stub it. */
export interface CommanderDbPort {
  getSetting(key: string): string | undefined
  getAgents(): AgentRecord[]
  getTranscriptParts(taskId: string): TranscriptPartRecord[]
  upsertTranscriptParts(taskId: string, parts: TranscriptPartInput[]): unknown
}

export interface CommanderServiceOptions {
  store: CommanderStore
  db: CommanderDbPort
  agents: CommanderAgentsPort
  emit: (event: CommanderEvent) => void
  getTools?: (context: CommanderToolContext) => ChatToolDefinition[]
  /** `ask_captain` calls a report-triggered answer may make per session before the user speaks again (#62). */
  maxReportAsks?: number
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
  /** True when the session is open in the view, so the report is handed to its agent (now, or once it is idle). */
  relayed: boolean
}

const FALLBACK_TITLE_WORDS = 6
const MAX_TITLE_CHARS = 60

/** First words of the user's message: the session's title until the user renames it. */
export function fallbackTitle(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length === 0) return 'New session'
  let title = words.slice(0, FALLBACK_TITLE_WORDS).join(' ')
  const truncated = words.length > FALLBACK_TITLE_WORDS || title.length > MAX_TITLE_CHARS
  if (title.length > MAX_TITLE_CHARS) title = title.slice(0, MAX_TITLE_CHARS).trimEnd()
  return truncated ? `${title}…` : title
}

/**
 * The `project_id` and `correlation_id` a successful tool result carries
 * (`ask_captain` does), so the delegation can be stored and the report that
 * answers it routed back (#62). Anything that is not such an object tags nothing.
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

/** A user-role transcript part the Commander's agent was sent. */
interface UserInput {
  partId: string
  content: string
  automated: boolean
}

function userInputs(parts: Array<Pick<TranscriptPartRecord, 'partId' | 'role' | 'content' | 'partType'>>): UserInput[] {
  return parts
    .filter((part) => part.role === 'user' && (!part.partType || part.partType === 'text'))
    .map((part) => ({
      partId: part.partId,
      content: part.content ?? '',
      automated: (part.content ?? '').trimStart().startsWith(SYSTEM_MESSAGE_MARKER)
    }))
}

/**
 * What the agent is answering right now, read from the stored transcript. The
 * user's message is persisted before the prompt reaches the agent, so a tool
 * call always sees the message that caused it.
 */
export function turnContextFromTranscript(sessionId: string, parts: TranscriptPartRecord[]): CommanderToolContext & { userAnchor: string } {
  const inputs = userInputs(parts)
  const latest = inputs[inputs.length - 1]
  const lastHuman = [...inputs].reverse().find((input) => !input.automated)
  return {
    sessionId,
    userMessage: latest && !latest.automated ? latest.content.trim() : '',
    trigger: latest?.automated ? 'report' : 'user',
    userAnchor: lastHuman?.partId ?? ''
  }
}

export class CommanderService {
  private readonly store: CommanderStore
  /** The session open in the Commander view, as the renderer reports it (#62). */
  private activeSessionId: string | null = null
  /** Sessions with reports waiting for their busy agent to go idle. */
  private readonly pendingRelay = new Set<string>()
  /** `ask_captain` calls made in answer to reports since the user last spoke, per session. */
  private readonly reportAsks = new Map<string, { anchor: string; count: number }>()
  private readonly listeners = new Set<(event: CommanderEvent) => void>()

  constructor(private readonly options: CommanderServiceOptions) {
    this.store = options.store
    options.agents.addExternalListener((channel, data) => {
      try {
        this.onAgentEvent(channel, data)
      } catch (err) {
        console.error('[Commander] agent event handling failed:', err)
      }
    })
  }

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

  private emitSession(session: CommanderSession | null): CommanderSession | null {
    if (session) this.emit({ type: 'session_updated', session })
    return session
  }

  // ── Sessions ────────────────────────────────────────────────

  /**
   * The agent Commander sessions run on: the one chosen in the Commander
   * view, else the default agent, else the first. Null with no agents at all.
   */
  agentId(): string | null {
    const agents = this.options.db.getAgents()
    const chosen = this.options.db.getSetting(COMMANDER_AGENT_SETTING)
    if (chosen && agents.some((agent) => agent.id === chosen)) return chosen
    return (agents.find((agent) => agent.is_default) ?? agents[0])?.id ?? null
  }

  /**
   * Makes sure the session has its task row, so the renderer can start or
   * resume its agent. A session from the old chat runtime gets its history
   * copied into the transcript, so the conversation still reads as one.
   */
  prepareSession(sessionId: string): { taskId: string; agentId: string | null } {
    const { created } = this.store.ensureTask(sessionId)
    if (created) this.copyEarlierHistory(sessionId)
    return { taskId: sessionId, agentId: this.agentId() }
  }

  private copyEarlierHistory(sessionId: string): void {
    const parts: TranscriptPartInput[] = this.store
      .listMessages(sessionId)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
      .map((m) => ({ id: `commander-history-${m.id}`, role: m.role, content: m.content, partType: 'text', receivedAt: m.created_at }))
    if (parts.length > 0) this.options.db.upsertTranscriptParts(sessionId, parts)
  }

  /** Archiving a session stops its agent; the conversation stays resumable. */
  setArchived(sessionId: string, archived: boolean): CommanderSession | null {
    if (archived) {
      void this.options.agents.stopByTaskId(sessionId).catch((err) => {
        console.warn(`[Commander] Could not stop the agent of archived session ${sessionId}:`, err)
      })
    }
    return this.emitSession(this.store.setArchived(sessionId, archived))
  }

  /** The renderer says which session the Commander view shows; null when the view is closed. */
  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId
    // Reports that arrived while the session was not open are handed over now.
    if (sessionId && this.store.getSession(sessionId)) this.relayReports(sessionId)
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessionId === sessionId
  }

  // ── Tools (served over MCP) ─────────────────────────────────

  private toolsFor(sessionId: string): { tools: ChatToolDefinition[]; context: CommanderToolContext } {
    const { userAnchor, ...context } = turnContextFromTranscript(sessionId, this.options.db.getTranscriptParts(sessionId))
    let tools = this.options.getTools?.(context) ?? []
    if (context.trigger === 'report') {
      const max = this.options.maxReportAsks ?? MAX_REPORT_ASKS_WITHOUT_USER_TURN
      // The budget resets when the user speaks: a new human message is a new anchor.
      const current = this.reportAsks.get(sessionId)
      const budget = current && current.anchor === userAnchor ? current : { anchor: userAnchor, count: 0 }
      this.reportAsks.set(sessionId, budget)
      tools = guardReportAsks(tools, {
        remaining: () => max - budget.count,
        consume: () => {
          budget.count += 1
        }
      })
    }
    return { tools, context }
  }

  /** The tools the session's agent may call. Unknown sessions get none. */
  listTools(sessionId: string): ChatToolDefinition[] {
    if (!this.store.getSession(sessionId)) return []
    return [...validateTools(this.toolsFor(sessionId).tools).values()]
  }

  /**
   * Runs one tool call from the session's agent. A successful `ask_captain`
   * is stored as a delegation, so the Captain's report comes back here (#62).
   */
  async callTool(sessionId: string, name: string, input: Record<string, unknown>, toolCallId: string, signal: AbortSignal): Promise<ChatToolResult> {
    if (!this.store.getSession(sessionId)) return { content: `Commander session not found: ${sessionId}`, isError: true }
    const byName = validateTools(this.toolsFor(sessionId).tools)
    const result = await runTool(byName.get(name), name, input, { signal, toolCallId })
    const isError = result.isError === true
    const tags = toolResultTags(result.content, isError)
    if (tags.correlationId) {
      try {
        const message = this.store.appendMessage(sessionId, {
          role: 'tool',
          content: result.content,
          toolCallId,
          toolName: name,
          isError,
          ...tags
        })
        this.emit({ type: 'messages_appended', sessionId, messages: [message] })
      } catch (err) {
        console.error('[Commander] Could not record the delegation:', err)
      }
    }
    return result
  }

  // ── Reports (#62) ───────────────────────────────────────────

  /**
   * Stores a Captain report for a session. It counts as unread until the
   * session is read, and is handed to the agent when the session is open.
   */
  appendReport(input: AppendReportInput): CommanderMessage {
    const content = input.content?.trim()
    if (!content) throw new Error('Report is empty')
    const message = this.store.appendMessage(input.sessionId, {
      role: 'report',
      content,
      projectId: input.projectId ?? null,
      correlationId: input.correlationId ?? null
    })
    this.emit({ type: 'messages_appended', sessionId: input.sessionId, messages: [message] })
    this.emitSession(this.store.getSession(input.sessionId))
    return message
  }

  /**
   * Stores a report and, when its session is the one open in the view, hands
   * it to the session's agent so the Commander relays it. A session that is
   * not open only gets the unread report (the list badge); it is handed over
   * when the user opens it. Storing never depends on the agent.
   */
  deliverReport(input: DeliverReportInput): DeliverReportResult {
    const message = this.appendReport(input)
    if (!this.isSessionActive(input.sessionId)) return { message, relayed: false }
    return { message, relayed: this.relayReports(input.sessionId, input.projectName ?? null) }
  }

  /**
   * Hands every report the agent has not seen to it, as one automated
   * message. A busy agent gets them when it next goes idle, so a report never
   * interrupts an answer. Returns false when nothing could be scheduled.
   */
  relayReports(sessionId: string, projectName: string | null = null): boolean {
    const reports = this.store.reportsToRelay(sessionId)
    if (reports.length === 0) return false
    const agentId = this.agentId()
    if (!agentId) {
      console.warn('[Commander] Report stored but not relayed: no agent is configured')
      return false
    }
    const live = this.options.agents.findSessionByTaskId(sessionId)
    if (live && live.session.status !== 'idle' && live.session.status !== 'error') {
      this.pendingRelay.add(sessionId)
      return true
    }
    this.pendingRelay.delete(sessionId)
    this.prepareSession(sessionId)
    this.store.markRelayed(sessionId, reports[reports.length - 1].created_at)
    const text = buildReportRelayMessage(sessionId, reports, projectName)
    this.options.agents
      .sendMessage(live?.sessionId ?? '', text, sessionId, live?.session.agentId ?? agentId)
      .catch((err) => console.error(`[Commander] Could not relay reports to session ${sessionId}:`, err))
    return true
  }

  private onAgentEvent(channel: string, data: unknown): void {
    if (channel === 'agent:status') {
      const event = data as { taskId?: string; status?: string }
      if (!event?.taskId || event.status !== 'idle') return
      const session = this.store.getSession(event.taskId)
      if (!session) return
      this.emitSession(this.store.touch(session.id))
      if (this.pendingRelay.has(session.id) && this.isSessionActive(session.id)) this.relayReports(session.id)
      return
    }
    if (channel === 'transcript:changed') {
      const event = data as { taskId?: string; parts?: TranscriptPartRecord[] }
      if (!event?.taskId || !event.parts?.some((part) => part.role === 'user')) return
      const session = this.store.getSession(event.taskId)
      if (!session) return
      const said = userInputs(event.parts).find((input) => !input.automated && input.content.trim())
      if (!said) return
      // The user spoke: the session moves up, and an untitled one is named.
      if (!session.title) this.store.renameSession(session.id, normalizeTitle(fallbackTitle(said.content)))
      this.emitSession(this.store.touch(session.id))
    }
  }
}

/** The automated message that hands reports to the Commander's agent. */
export function buildReportRelayMessage(sessionId: string, reports: CommanderMessage[], projectName: string | null): string {
  const findings = reports
    .map((report) => {
      const tag = report.correlation_id ? ` (correlation_id ${report.correlation_id})` : ''
      return `Report from project ${report.project_id ?? 'unknown'}${tag}:\n${report.content}`
    })
    .join('\n\n')
  const label = projectName ? `project "${projectName}"` : reports.length > 1 ? 'your projects' : 'a project'
  return buildSystemMessage(
    {
      origin: SystemMessageOrigin.CaptainReport,
      taskId: sessionId,
      deliveryId: computeDeliveryId(sessionId, reports.map((report) => report.id).join(',')),
      generatedAt: new Date().toISOString()
    },
    reports.length > 1 ? `${reports.length} Captain reports arrived.` : 'A Captain report arrived.',
    findings,
    reportRelayNote(label)
  )
}

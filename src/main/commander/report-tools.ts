import type { ChatToolDefinition, ChatToolResult } from './tools'
import { setCommanderEscalationHandler, type EscalationEvent } from '../escalation'
import type { CommanderService } from './commander-service'
import type { CommanderStore } from './commander-store'
import { setCaptainReportHandler, type CaptainReportHandler, type ReportRoutedBy } from './report-inbox'

/**
 * Captain reports into Commander sessions (#62; docs/commander.md).
 *
 * Routing rules, in order:
 * 1. A report quoting a `correlation_id` goes to the session whose
 *    `ask_captain` tool row carries that id ({@link CommanderStore.findDelegation}),
 *    unless that session is archived.
 * 2. Otherwise (no id, an unknown id, or an archived origin) it goes to the
 *    most recently active session, which is where the user is working.
 * 3. With no session at all, one titled {@link REPORT_INBOX_TITLE} is created
 *    for it, and later unprompted reports land there by rule 2.
 *
 * The report keeps its project tag and correlation id whichever rule applied,
 * so it can always be traced back. Delivery itself (store, unread, relay when
 * the session is open) is {@link CommanderService.deliverReport}.
 *
 * Loop protection: a turn started by a report may call `ask_captain` only
 * while the session's budget lasts ({@link MAX_REPORT_ASKS_WITHOUT_USER_TURN}
 * calls since the user last spoke); {@link guardReportAsks} enforces it in
 * the tool, not the prompt.
 */

export const MAX_REPORT_ASKS_WITHOUT_USER_TURN = 3
export const REPORT_INBOX_TITLE = 'Project reports'

export type ReportRoutingStore = Pick<CommanderStore, 'findDelegation' | 'getSession' | 'listSessions' | 'createSession'>

export interface ReportRoute {
  sessionId: string
  routedBy: ReportRoutedBy
}

export function resolveReportSession(store: ReportRoutingStore, correlationId?: string | null): ReportRoute {
  const id = correlationId?.trim()
  if (id) {
    const delegation = store.findDelegation(id)
    const origin = delegation ? store.getSession(delegation.sessionId) : null
    if (origin && !origin.archived) return { sessionId: origin.id, routedBy: 'correlation' }
  }
  const [latest] = store.listSessions()
  if (latest) return { sessionId: latest.id, routedBy: 'latest' }
  return { sessionId: store.createSession(REPORT_INBOX_TITLE).id, routedBy: 'inbox' }
}

// ── Loop protection ───────────────────────────────────────────

export interface ReportAskBudget {
  /** How many `ask_captain` calls report-triggered turns may still make before a user turn resets it. */
  remaining: () => number
  consume: () => void
}

function loopGuardResult(): ChatToolResult {
  return {
    content: JSON.stringify({
      status: 'loop_guard',
      message:
        `You have already delegated ${MAX_REPORT_ASKS_WITHOUT_USER_TURN} times in reaction to reports without the user saying anything. ` +
        'Do not delegate again: relay the report to the user and wait for their reply.'
    }),
    isError: true
  }
}

/** The same tools, with `ask_captain` refused once the session's report-ask budget is spent. */
export function guardReportAsks(tools: ChatToolDefinition[], budget: ReportAskBudget): ChatToolDefinition[] {
  return tools.map((tool) => {
    if (tool.name !== 'ask_captain') return tool
    return {
      ...tool,
      handler: async (input, context) => {
        if (budget.remaining() <= 0) return loopGuardResult()
        budget.consume()
        return tool.handler(input, context)
      }
    }
  })
}

// ── Escalations as reports ────────────────────────────────────

/** The report text for an escalation event, or null when the event is not one the Commander relays (only `tell_commander` outcomes are). */
export function escalationReportText(event: EscalationEvent): string | null {
  if (event.level !== 'tell_commander' || event.outcome !== 'performed') return null
  return `Escalation notice (policy: act, then tell the Commander): the Captain did this on its own — ${event.summary}.`
}

// ── Wiring ────────────────────────────────────────────────────

export interface CommanderReportBridgeOptions {
  service: Pick<CommanderService, 'deliverReport'>
  store: ReportRoutingStore
  /** The project a report names; unknown projects are refused. */
  getProject: (projectId: string) => { id: string; name: string } | null | undefined
}

/** The handler behind `report_to_commander`: routes, stores and relays one report. */
export function createCaptainReportHandler(options: CommanderReportBridgeOptions): CaptainReportHandler {
  return (report) => {
    const project = options.getProject(report.projectId)
    if (!project) return { delivered: false, detail: `Project not found: ${report.projectId}` }
    const route = resolveReportSession(options.store, report.correlationId)
    const { relayed } = options.service.deliverReport({
      sessionId: route.sessionId,
      content: report.message,
      projectId: project.id,
      projectName: project.name,
      correlationId: report.correlationId?.trim() || null
    })
    return { delivered: true, sessionId: route.sessionId, routedBy: route.routedBy, relayed }
  }
}

/**
 * Installs the report handler for the Task API route and turns
 * `tell_commander` escalations (#66) into unprompted, project-tagged
 * reports. Returns the uninstaller.
 */
export function installCommanderReportBridge(options: CommanderReportBridgeOptions): () => void {
  const handler = createCaptainReportHandler(options)
  setCaptainReportHandler(handler)
  setCommanderEscalationHandler((event) => {
    const text = escalationReportText(event)
    if (!text) return
    const delivery = handler({ projectId: event.projectId, message: text, correlationId: null, source: 'escalation' })
    if (!delivery.delivered) console.warn(`[Commander] Escalation for project ${event.projectId} not delivered: ${delivery.detail}`)
  })
  return () => {
    setCaptainReportHandler(null)
    setCommanderEscalationHandler(null)
  }
}

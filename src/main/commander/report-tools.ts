import type { ChatToolDefinition, ChatToolResult } from '../chat/tools'
import { setCommanderEscalationHandler, type EscalationEvent } from '../escalation'
import type { CommanderService } from './commander-service'
import type { CommanderStore } from './commander-store'
import { setCaptainReportHandler, type CaptainReportHandler, type ReportRoutedBy } from './report-inbox'
import { createHash } from 'crypto'
import type { DeliveryRecord, DeliveryStore } from '../sessions/delivery-store'

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

export function resolveReportSession(store: ReportRoutingStore, correlationId?: string | null, preferredSessionId?: string | null): ReportRoute {
  if (preferredSessionId) {
    const preferred = store.getSession(preferredSessionId)
    if (preferred) return { sessionId: preferred.id, routedBy: 'correlation' }
  }
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
  // #137: a merge made under the user's merge grant, and a merge blocked on a person outside 21x.
  if (event.outcome === 'merged_under_grant') {
    const source = event.authorizationContext?.grant_source === 'commander'
      ? ' The grant came from the user’s verified Commander relay.'
      : event.authorizationContext?.grant_source === 'project_chat'
        ? ' The grant came from the user’s verified project-chat instruction.'
        : ''
    return `Merge notice: the Captain merged under the user's merge grant${event.grantId ? ` ${event.grantId}` : ''} (policy context: ${event.level}) — ${event.summary}.${source} The user can revoke the grant in 20x.`
  }
  if (event.outcome === 'needs_user') {
    return `Blocked on an external approval: ${event.summary}`
  }
  if (event.level !== 'tell_commander' || event.outcome !== 'performed') return null
  return `Escalation notice (policy: act, then tell the Commander): the Captain did this on its own — ${event.summary}.`
}

// ── Wiring ────────────────────────────────────────────────────

export interface CommanderReportBridgeOptions {
  service: Pick<CommanderService, 'deliverReport'>
  store: ReportRoutingStore
  /** The project a report names; unknown projects are refused. */
  getProject: (projectId: string) => { id: string; name: string } | null | undefined
  deliveries: DeliveryStore
}

/** The handler behind `report_to_commander`: routes, stores and relays one report. */
export function createCaptainReportHandler(options: CommanderReportBridgeOptions): CaptainReportHandler {
  return (report) => {
    const project = options.getProject(report.projectId)
    if (!project) return { delivered: false, detail: `Project not found: ${report.projectId}` }
    const correlationId = report.correlationId?.trim() || null
    const request = correlationId ? options.deliveries.getCaptainRequest(correlationId) : null
    if (request && request.projectId !== project.id) {
      return { delivered: false, detail: 'The correlation belongs to another project.' }
    }
    const late = request?.state === 'timed_out' || request?.state === 'failed'
    // A correlated request has one terminal application-visible report even
    // if a reconnect gives the transport attempt a different delivery id.
    const baseKey = correlationId
      ? `captain-report:${project.id}:${correlationId}:${late ? 'late' : 'terminal'}`
      : report.deliveryId?.trim()
        || `captain-report:${project.id}:${createHash('sha256').update(report.message).digest('hex')}`
    const initialRoute = resolveReportSession(options.store, correlationId, request?.sourceSessionId)
    const { record } = options.deliveries.enqueue({
      idempotencyKey: baseKey,
      kind: 'captain_report',
      sourceSessionId: initialRoute.sessionId,
      projectId: project.id,
      correlationId,
      payload: late ? `Late report after the request ${request?.state === 'failed' ? 'failed' : 'timed out'}: ${report.message}` : report.message
    })
    const route = resolveReportSession(options.store, correlationId, record.sourceSessionId)
    // Persist the chosen destination and final content before inserting the inbox
    // effect, so a crash cannot reroute the retry to a newer conversation.
    options.deliveries.bindReport(record.id, route.sessionId, record.payload)
    const durable = options.deliveries.get(record.id)!
    const { relayed } = options.service.deliverReport({
      sessionId: route.sessionId,
      content: durable.payload,
      projectId: project.id,
      projectName: project.name,
      correlationId,
      deliveryId: record.id
    })
    return { delivered: true, sessionId: route.sessionId, routedBy: route.routedBy, relayed }
  }
}

/**
 * Installs the report handler for the Task API route and turns
 * `tell_commander` escalations (#66) into unprompted, project-tagged
 * reports. Returns the uninstaller.
 */
export function recoverCaptainReports(options: CommanderReportBridgeOptions): void {
  let records: DeliveryRecord[]
  try { records = options.deliveries.listRecoverable('captain_report') }
  catch (error) {
    console.warn('[Commander] Report recovery will retry when storage is available:', error)
    return
  }
  for (const record of records) {
    try {
      if (!record.projectId) continue
      const project = options.getProject(record.projectId)
      if (!project) continue
      const route = resolveReportSession(options.store, record.correlationId, record.sourceSessionId)
      options.deliveries.bindReport(record.id, route.sessionId, record.payload)
      options.service.deliverReport({ sessionId: route.sessionId, content: record.payload,
        projectId: project.id, projectName: project.name, correlationId: record.correlationId, deliveryId: record.id })
    } catch (error) {
      console.warn('[Commander] Report remains durable for retry:', error)
    }
  }
}

export function installCommanderReportBridge(options: CommanderReportBridgeOptions): () => void {
  const handler = createCaptainReportHandler(options)
  setCaptainReportHandler(handler)
  recoverCaptainReports(options)
  const timer = setInterval(() => recoverCaptainReports(options), 30_000)
  timer.unref?.()
  setCommanderEscalationHandler((event) => {
    const text = escalationReportText(event)
    if (!text) return
    const delivery = handler({ projectId: event.projectId, message: text, correlationId: null, source: 'escalation' })
    if (!delivery.delivered) console.warn(`[Commander] Escalation for project ${event.projectId} not delivered: ${delivery.detail}`)
  })
  return () => {
    clearInterval(timer)
    setCaptainReportHandler(null)
    setCommanderEscalationHandler(null)
  }
}

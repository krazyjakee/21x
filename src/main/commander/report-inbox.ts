/**
 * The seam between a Captain's `report_to_commander` call and the
 * Commander (#62; docs/commander.md).
 *
 * The Task API route (task-api/task-routes.ts) runs under the same import
 * graph as the stdio MCP entry, so it cannot reach the Commander service
 * directly. It calls {@link deliverCaptainReport}; the main process
 * installs a handler with {@link setCaptainReportHandler} when the
 * Commander IPC is registered (commander/report-tools.ts builds it). Until
 * then a report is refused with a plain message the Captain can read.
 */

/** `captain_action`: a notice the app writes after a Captain merged a PR or wrote a GitHub issue. */
export type CaptainReportSource = 'captain' | 'captain_action'

export interface CaptainReport {
  projectId: string
  message: string
  /** The `correlation_id` the Captain quoted from an `ask_captain` relay; null when unprompted. */
  correlationId?: string | null
  source: CaptainReportSource
  /** Stable transport retry key. Correlated reports derive one when omitted. */
  deliveryId?: string | null
}

/** How the report found its session: by the correlation id, the most recent session, or an inbox created for it. */
export type ReportRoutedBy = 'correlation' | 'latest' | 'inbox'

export type ReportDelivery =
  | { delivered: true; sessionId: string; routedBy: ReportRoutedBy; relayed: boolean }
  | { delivered: false; detail: string }

export type CaptainReportHandler = (report: CaptainReport) => ReportDelivery

let handler: CaptainReportHandler | null = null

export function setCaptainReportHandler(next: CaptainReportHandler | null): void {
  handler = next
}

/** Hands a report to the Commander; never throws. */
export function deliverCaptainReport(report: CaptainReport): ReportDelivery {
  if (!handler) return { delivered: false, detail: 'The Commander is not available right now; the report was not delivered.' }
  try {
    return handler(report)
  } catch (error) {
    console.error('[Commander] Report delivery failed:', error)
    return { delivered: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

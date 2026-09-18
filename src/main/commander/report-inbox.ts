/**
 * The seam between a Mastermind's `report_to_commander` call and the
 * Commander (#62; docs/commander.md).
 *
 * The Task API route (task-api/task-routes.ts) runs under the same import
 * graph as the stdio MCP entry, so it cannot reach the Commander service
 * directly. It calls {@link deliverMastermindReport}; the main process
 * installs a handler with {@link setMastermindReportHandler} when the
 * Commander IPC is registered (commander/report-tools.ts builds it). Until
 * then a report is refused with a plain message the Mastermind can read.
 */

export type MastermindReportSource = 'mastermind' | 'escalation'

export interface MastermindReport {
  projectId: string
  message: string
  /** The `correlation_id` the Mastermind quoted from an `ask_mastermind` relay; null when unprompted. */
  correlationId?: string | null
  source: MastermindReportSource
}

/** How the report found its session: by the correlation id, the most recent session, or an inbox created for it. */
export type ReportRoutedBy = 'correlation' | 'latest' | 'inbox'

export type ReportDelivery =
  | { delivered: true; sessionId: string; routedBy: ReportRoutedBy; relayed: boolean }
  | { delivered: false; detail: string }

export type MastermindReportHandler = (report: MastermindReport) => ReportDelivery

let handler: MastermindReportHandler | null = null

export function setMastermindReportHandler(next: MastermindReportHandler | null): void {
  handler = next
}

/** Hands a report to the Commander; never throws. */
export function deliverMastermindReport(report: MastermindReport): ReportDelivery {
  if (!handler) return { delivered: false, detail: 'The Commander is not available right now; the report was not delivered.' }
  try {
    return handler(report)
  } catch (error) {
    console.error('[Commander] Report delivery failed:', error)
    return { delivered: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

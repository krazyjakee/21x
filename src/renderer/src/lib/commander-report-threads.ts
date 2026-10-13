import type { CommanderMessage } from '@shared/commander'

/** Match durable reports to their actual delegation result, never the newest turn. */
export function commanderReportThreads(messages: CommanderMessage[]): Map<string, CommanderMessage[]> {
  const owners = new Map<string, string>()
  for (const message of messages) for (const call of message.tool_calls ?? []) owners.set(call.id, message.id)
  const correlations = new Map<string, string>()
  for (const message of messages) if (message.role === 'tool' && message.correlation_id && message.tool_call_id) {
    const owner = owners.get(message.tool_call_id)
    if (owner) correlations.set(message.correlation_id, owner)
  }
  const threads = new Map<string, CommanderMessage[]>()
  for (const report of messages) {
    const owner = report.role === 'report' && report.correlation_id ? correlations.get(report.correlation_id) : undefined
    if (owner) threads.set(owner, [...(threads.get(owner) ?? []), report])
  }
  return threads
}

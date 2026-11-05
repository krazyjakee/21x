import { isCommanderAdminTool } from '@shared/commander-tools'
import { pairToolResults, toolRunKey } from '@/lib/commander-tool-runs'
import { liveToolResult, useCommanderStore } from '@/stores/commander-store'
import { ActionCard } from './ActionCard'

/** Only actual stored tool results establish that an action was executed. */
export function CommanderActions() {
  const sessionId = useCommanderStore(s => s.selectedSessionId)
  const messages = useCommanderStore(s => sessionId ? s.messages[sessionId] : undefined) ?? []
  const streaming = useCommanderStore(s => sessionId ? s.streaming[sessionId] : undefined)
  const results = pairToolResults(messages)
  let requestedBy: typeof messages[number] | undefined
  const stored = messages.flatMap(message => {
    if (message.role === 'user') requestedBy = message
    const request = requestedBy
    return (message.tool_calls ?? []).flatMap((call, index) => {
      const result = results.get(toolRunKey(message.id, index))
      return isCommanderAdminTool(call.name) && result ? [{ call, result, requestedBy: request }] : []
    })
  })
  // A managed turn stores its steps as they run, so a reloaded history can already hold one.
  const saved = new Set(stored.map(action => action.result.content))
  const live = sessionId && streaming ? streaming.toolCalls.flatMap(call =>
    isCommanderAdminTool(call.name) && call.result !== undefined && !saved.has(call.result)
      ? [{ call, result: liveToolResult(sessionId, streaming.turnId, call), requestedBy }] : []) : []
  const actions = [...stored, ...live].sort((a, b) => b.result.created_at - a.result.created_at)
  return <section className="min-h-0 flex-1 overflow-y-auto p-4" aria-label="Commander actions">
    {actions.length === 0 ? <p className="text-sm leading-relaxed text-muted-foreground">Executed changes will appear here. Read-only requests and delegations stay in Chat.</p> :
      <ol className="space-y-3">{actions.map(({ call, result, requestedBy: request }) => <li key={result.id}><ActionCard call={call} result={result} requestedBy={request} /></li>)}</ol>}
  </section>
}

import { isCommanderAdminTool } from '@shared/commander-tools'
import { useCommanderStore } from '@/stores/commander-store'
import { ActionCard } from './ActionCard'

/** Only actual stored tool results establish that an action was executed. */
export function CommanderActions() {
  const sessionId = useCommanderStore(s => s.selectedSessionId)
  const messages = useCommanderStore(s => sessionId ? s.messages[sessionId] : undefined) ?? []
  const results = new Map(messages.filter(m => m.role === 'tool' && m.tool_call_id).map(m => [m.tool_call_id, m]))
  let requestedBy: typeof messages[number] | undefined
  const actions = messages.flatMap(message => {
    if (message.role === 'user') requestedBy = message
    const request = requestedBy
    return (message.tool_calls ?? []).flatMap(call => {
      const result = results.get(call.id)
      return isCommanderAdminTool(call.name) && result ? [{ call, result, requestedBy: request }] : []
    })
  }).sort((a, b) => b.result.created_at - a.result.created_at)
  return <section className="min-h-0 flex-1 overflow-y-auto p-4" aria-label="Commander actions">
    {actions.length === 0 ? <p className="text-sm leading-relaxed text-muted-foreground">Executed changes will appear here. Read-only requests and delegations stay in Chat.</p> :
      <ol className="space-y-3">{actions.map(({ call, result, requestedBy: request }) => <li key={call.id}><ActionCard call={call} result={result} requestedBy={request} /></li>)}</ol>}
  </section>
}

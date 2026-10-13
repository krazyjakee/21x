import { useState } from 'react'
import { AlertTriangle, Check, ExternalLink, Undo2, Wrench } from 'lucide-react'
import type { CommanderAction } from '@shared/commander-action'
import type { CommanderMessage } from '@shared/commander'
import { commanderActionSeverity, parseCommanderAction } from '@shared/commander-action'
import { Button } from '@/components/ui/Button'
import { useCommanderStore } from '@/stores/commander-store'
import { useUIStore } from '@/stores/ui-store'
import { useSkillStore } from '@/stores/skill-store'
import { formatToolResult, toolCallLabel } from './tool-call-label'

type CommanderToolCall = NonNullable<CommanderMessage['tool_calls']>[number]

function valueText(value: unknown): string {
  if (value === undefined) return 'Not set'
  if (value === null) return 'None'
  return typeof value === 'string' ? value || '(empty)' : JSON.stringify(value) ?? 'Not set'
}

export function ActionCard({ call, result, requestedBy, compact = false }: {
  call: CommanderToolCall; result: CommanderMessage; requestedBy?: CommanderMessage; compact?: boolean
}) {
  let failed = result.is_error
  try { const payload = JSON.parse(result.content); failed ||= payload?.status === 'error' || payload?.ok === false } catch { /* Legacy plain text remains evidence. */ }
  const action = parseCommanderAction(call.name, result.content, failed)
  const StatusIcon = failed ? AlertTriangle : !action ? Wrench : action.severity === 'neutral' ? Check : AlertTriangle
  const severity = action?.severity ?? commanderActionSeverity(call.name)
  const undoing = useCommanderStore(s => action?.undoId ? s.undoingActions.includes(action.undoId) : false)
  const undone = useCommanderStore(s => action?.undoId ? s.undoneActions.includes(action.undoId) : false)
  const [error, setError] = useState('')
  const openTarget = (target: CommanderAction['target']) => {
    const ui = useUIStore.getState()
    if (target.kind === 'skill') { useSkillStore.getState().selectSkill(target.id); ui.setSidebarView('skills') }
    else if (target.kind === 'all-projects') ui.setSidebarView('overview')
    else ui.openProjectEditor(target.kind === 'project' ? target.id : target.projectId ?? target.id)
  }
  const label = toolCallLabel(call.name, call.input)
  return <article className={`commander-action-card commander-action-${severity}`} data-testid="commander-action-card" data-action-severity={severity} data-tool-call-id={call.id}>
    <header className="flex flex-wrap items-center gap-2 text-sm font-medium">
      <StatusIcon className="size-icon-sm shrink-0" aria-hidden="true" />
      <span>{failed ? 'Action failed' : action ? 'Action taken' : 'Action result'}{severity !== 'neutral' && ` · ${severity === 'destructive' ? 'Destructive' : 'Wide-reaching'}`}</span>
      <time className="ml-auto text-xs font-normal text-muted-foreground" dateTime={new Date(result.created_at).toISOString()}>{new Date(result.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    </header>
    <p className="mt-2 break-words text-base font-medium">{action ? `${toolCallLabel(call.name, {})} · ${action.target.name}` : label}</p>
    {!compact && action && <dl className="mt-2 space-y-1 text-sm leading-relaxed">{action.changes.map((change, index) => <div key={index} className="break-words"><dt className="inline font-medium">{change.field}: </dt><dd className="inline"><span>{valueText(change.before)}</span><span aria-label="changes to"> → </span><span>{valueText(change.after)}</span></dd></div>)}</dl>}
    {!compact && requestedBy?.input_mode === 'voice' && <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">Heard: “{requestedBy.content}”</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {action?.undoId ? <Button size="sm" variant="outline" disabled={undoing || undone} onClick={() => { setError(''); void useCommanderStore.getState().undoAction(result.session_id, action.undoId!).catch(reason => setError(reason instanceof Error ? reason.message : 'The action could not be undone.')) }}><Undo2 className="size-icon-sm" aria-hidden="true" />{undone ? 'Undone' : undoing ? 'Undoing…' : 'Undo'}</Button> : <span className="text-xs text-muted-foreground">Can't be undone here</span>}
      {action && <Button size="sm" variant="ghost" onClick={() => openTarget(action.target)}><ExternalLink className="size-icon-sm" aria-hidden="true" />Open {action.target.kind === 'repo' || action.target.kind === 'resource' ? 'project' : action.target.kind === 'all-projects' ? 'projects' : action.target.kind}</Button>}
    </div>
    {error && <p role="alert" className="mt-2 text-sm leading-relaxed text-destructive">{error}</p>}
    {!compact && <details className="mt-3"><summary className="cursor-pointer text-sm text-muted-foreground">Show tool details</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">{formatToolResult(result.content)}</pre></details>}
  </article>
}

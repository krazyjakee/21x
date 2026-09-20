import { useId, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, RotateCcw } from 'lucide-react'
import { commanderToolSeverity, isCommanderActionUndoable } from '@shared/commander-tools'
import { Button } from '@/components/ui/Button'
import { commanderApi } from '@/lib/ipc-client'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useSkillStore } from '@/stores/skill-store'
import { useUIStore } from '@/stores/ui-store'
import { formatToolResult, humanizeToolName, toolCallLabel } from './tool-call-label'
import type { CommanderActionItem } from './commander-actions'

function displayValue(value: unknown): string {
  let text: string
  if (value === null) text = 'None'
  else if (typeof value === 'string') text = value || 'Empty'
  else if (typeof value === 'boolean') text = value ? 'Yes' : 'No'
  else if (Array.isArray(value)) text = value.length ? value.join(', ') : 'None'
  else text = JSON.stringify(value)
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

function actionTitle(item: CommanderActionItem): string {
  const target = item.action?.target
  if (!target) return toolCallLabel(item.call.name, item.call.input)
  const quoted = `“${target.name}”`
  switch (item.call.name) {
    case 'pause_all_projects':
      return item.action?.changes.find((change) => change.field === 'paused')?.after ? 'Paused all projects' : 'Resumed all projects'
    case 'create_project': return `Created project ${quoted}`
    case 'update_project': return `Updated project ${quoted}`
    case 'archive_project': return `Archived project ${quoted}`
    case 'restore_project': return `Restored project ${quoted}`
    case 'add_project_repo': return `Added repository ${quoted}`
    case 'update_project_repo': return `Updated repository ${quoted}`
    case 'remove_project_repo': return `Removed repository ${quoted}`
    case 'reorder_project_repos': return `Reordered repositories in ${quoted}`
    case 'add_project_resource': return `Added resource ${quoted}`
    case 'update_project_resource': return `Updated resource ${quoted}`
    case 'remove_project_resource': return `Removed resource ${quoted}`
    case 'reorder_project_resources': return `Reordered resources in ${quoted}`
    case 'create_skill': return `Created skill ${quoted}`
    case 'update_skill': return `Updated skill ${quoted}`
    case 'remove_skill': return `Removed skill ${quoted}`
    case 'promote_skill': return `Promoted skill ${quoted}`
    case 'move_skill': return `Moved skill ${quoted}`
    default: return `${humanizeToolName(item.call.name)} · ${target.name}`
  }
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

export function ActionCard({ item }: { item: CommanderActionItem }) {
  const detailId = useId()
  const [expanded, setExpanded] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [locallyUndone, setLocallyUndone] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const severity = commanderToolSeverity(item.call.name)
  const destructive = severity === 'destructive'
  const wide = severity === 'wide-reaching'
  const undone = item.undone || locallyUndone
  const undoable = Boolean(item.action) && isCommanderActionUndoable(item.call.name)
  const target = item.action?.target
  const canOpen = Boolean(target) && target?.kind !== 'all_projects' && item.call.name !== 'remove_skill'

  const openTarget = () => {
    if (!target) return
    if (target.kind === 'skill') {
      useSkillStore.getState().selectSkill(target.id)
      useUIStore.getState().setSidebarView('skills')
      return
    }
    const projectId = target.kind === 'project' ? target.id : target.project_id
    if (projectId) useUIStore.getState().openProjectEditor(projectId)
  }

  const undo = async () => {
    setUndoing(true)
    setUndoError(null)
    try {
      await commanderApi.undoAction(item.result.session_id, item.call.id)
      setLocallyUndone(true)
      void useProjectStore.getState().fetchProjects()
      void useSkillStore.getState().fetchSkills()
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : String(error))
    } finally {
      setUndoing(false)
    }
  }

  const Icon = destructive || wide ? AlertTriangle : Check
  return (
    <article
      data-testid="commander-action-card"
      data-severity={severity}
      role={destructive ? 'alert' : 'status'}
      aria-live={destructive ? 'assertive' : 'polite'}
      className={cn(
        'w-full rounded-xl border px-3 py-2.5 text-left',
        destructive && 'border-destructive/40 bg-destructive/10',
        wide && 'border-amber-500/40 bg-amber-500/10',
        severity === 'neutral' && 'border-border bg-muted/40'
      )}
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className={cn('size-3.5', destructive && 'text-destructive', wide && 'text-amber-600 dark:text-amber-400')} aria-hidden="true" />
        <span>Action taken · {severity}</span>
        <time className="ml-auto normal-case tabular-nums" dateTime={new Date(item.result.created_at).toISOString()}>{formatTime(item.result.created_at)}</time>
      </div>
      <p className="mt-1 text-sm font-medium text-foreground">{actionTitle(item)}</p>
      {item.action?.changes.map((change) => (
        <div key={change.field} className="mt-1 grid grid-cols-[minmax(4rem,auto)_1fr] gap-2 text-xs">
          <span className="text-muted-foreground">{change.field}</span>
          <span className="min-w-0 break-words text-foreground">
            {displayValue(change.before)} <span aria-label="changed to">→</span> {displayValue(change.after)}
          </span>
        </div>
      ))}
      {item.request?.input_mode === 'voice' && (
        <p className="mt-2 text-xs text-muted-foreground">Heard: “{item.request.content}”</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {undoable ? (
          <Button size="sm" variant="outline" disabled={undone || undoing} onClick={() => void undo()}>
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {undone ? 'Undone' : undoing ? 'Undoing…' : 'Undo'}
          </Button>
        ) : (
          <span className="px-1 text-xs text-muted-foreground">Can’t be undone here</span>
        )}
        {canOpen && (
          <Button size="sm" variant="ghost" onClick={openTarget}>
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Open target
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
          Tool details
        </Button>
      </div>
      {undoError && <p role="alert" className="mt-2 text-xs text-destructive">{undoError}</p>}
      {expanded && (
        <pre id={detailId} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/70 p-2 font-mono text-[11px]">
          {formatToolResult(item.result.content)}
        </pre>
      )}
    </article>
  )
}

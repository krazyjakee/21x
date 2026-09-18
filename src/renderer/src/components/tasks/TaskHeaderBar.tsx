import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, Check, ChevronDown, ExternalLink, FolderOpen, Layers, Menu, MoreHorizontal, Pencil, Play, RotateCcw, Sparkles, Terminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AnthropicLogo, OpenAILogo, OpenCodeLogo, PiLogo } from '@/components/icons/AgentLogos'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskStatusBadge } from './TaskStatusBadge'
import { CodingAgentType, TASK_STATUSES, TaskStatus } from '@/types'
import type { Agent, Task } from '@/types'
import { MENU_ITEM_CLASS, MENU_PANEL_CLASS } from '@shared/menu-styles'

export enum TaskPrimaryAction {
  START = 'start',
  RESUME = 'resume',
  RESTART = 'restart',
  TRIAGE = 'triage',
  COMPLETE = 'complete'
}

const ACTION_META = {
  [TaskPrimaryAction.START]: { label: 'Start', icon: Play },
  [TaskPrimaryAction.RESUME]: { label: 'Resume', icon: Play },
  [TaskPrimaryAction.RESTART]: { label: 'Restart', icon: RotateCcw },
  [TaskPrimaryAction.TRIAGE]: { label: 'Triage', icon: Sparkles },
  [TaskPrimaryAction.COMPLETE]: { label: 'Complete', icon: Check }
}

function getHarnessLogo(agent?: Agent | null): React.FC<{ className?: string }> {
  switch (agent?.config?.coding_agent) {
    case CodingAgentType.CLAUDE_CODE:
      return AnthropicLogo
    case CodingAgentType.OPENCODE:
      return OpenCodeLogo
    case CodingAgentType.CODEX:
      return OpenAILogo
    case CodingAgentType.CURSOR:
      return Terminal
    case CodingAgentType.PI:
      return PiLogo
    default:
      return Bot
  }
}

interface TaskHeaderBarProps {
  task: Task
  agent?: Agent | null
  agents?: Agent[]
  onAssignAgent?: (agentId: string | null) => void | Promise<void>
  action?: TaskPrimaryAction | null
  onAction?: () => void
  onComplete?: () => void
  onStatusChange?: (status: TaskStatus) => void | Promise<void>
  onBack?: () => void
  onRename: (title: string) => void | Promise<void>
  detailsOpen: boolean
  showDetailsToggle: boolean
  onToggleDetails: () => void
  onEdit: () => void
  onSnooze?: () => void
  onOpenCanvas?: () => void
  onOpenFolder?: () => void
  onOpenFullView?: () => void
  onDelete: () => void
}

export function TaskHeaderBar({
  task,
  agent,
  agents,
  onAssignAgent,
  action,
  onAction,
  onComplete,
  onStatusChange,
  onBack,
  onRename,
  detailsOpen,
  showDetailsToggle,
  onToggleDetails,
  onEdit,
  onSnooze,
  onOpenCanvas,
  onOpenFolder,
  onOpenFullView,
  onDelete
}: TaskHeaderBarProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [menuOpen, setMenuOpen] = useState(false)

  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const statusMenuRef = useRef<HTMLDivElement>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => setTitle(task.title), [task.title])
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuOpen])
  useEffect(() => {
    if (!statusMenuOpen) return
    const close = (event: PointerEvent) => {
      if (!statusMenuRef.current?.contains(event.target as Node)) setStatusMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [statusMenuOpen])
  useEffect(() => {
    if (!agentMenuOpen) return
    const close = (event: PointerEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node)) setAgentMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [agentMenuOpen])

  const commitTitle = async () => {
    const next = title.trim()
    setEditing(false)
    if (!next || next === task.title) {
      setTitle(task.title)
      return
    }
    await onRename(next)
  }

  const actionMeta = action ? ACTION_META[action] : null
  const ActionIcon = actionMeta?.icon
  const HarnessIcon = getHarnessLogo(agent)
  const showStandaloneComplete = task.status !== TaskStatus.Completed
    && !!onComplete
    && (action !== TaskPrimaryAction.COMPLETE || !onAction)

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 bg-background px-3">
      {onBack && (
        <Button variant="ghost" size="icon" onClick={onBack} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitTitle()
              if (event.key === 'Escape') { setTitle(task.title); setEditing(false) }
            }}
            className="h-8 w-full max-w-xl rounded-md border border-primary/50 bg-card px-2 text-sm font-medium outline-none"
            aria-label="Task title"
          />
        ) : (
          <button onClick={() => setEditing(true)} className="group flex max-w-full items-center gap-1.5 text-left">
            <span className="truncate text-sm font-semibold text-foreground">{task.title}</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
      </div>
      <div ref={statusMenuRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setStatusMenuOpen((open) => !open)}
          className="group inline-flex items-center gap-0.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          aria-label="Change task status"
          aria-haspopup="menu"
          aria-expanded={statusMenuOpen}
        >
          <TaskStatusBadge status={task.status} />
          <ChevronDown className="h-3 w-3 text-muted-foreground transition-colors group-hover:text-foreground" />
        </button>
        {statusMenuOpen && (
          <div role="menu" aria-label="Task status" className={`${MENU_PANEL_CLASS} right-0`}>
            {TASK_STATUSES.map((status) => (
              <button
                key={status.value}
                type="button"
                role="menuitemradio"
                aria-checked={task.status === status.value}
                onClick={() => {
                  setStatusMenuOpen(false)
                  if (task.status !== status.value) void onStatusChange?.(status.value)
                }}
                className={`${MENU_ITEM_CLASS} hover:bg-accent`}
              >
                <span>{status.label}</span>
                {task.status === status.value && <Check className="h-3.5 w-3.5 text-primary" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <TaskPriorityBadge priority={task.priority} />
        {onAssignAgent && agents ? (
          <div ref={agentMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setAgentMenuOpen((open) => !open)}
              className="group inline-flex max-w-36 items-center gap-1.5 rounded-full border border-border/50 bg-card px-2 py-1 text-[11px] text-muted-foreground outline-none hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              aria-label="Change agent"
              aria-haspopup="menu"
              aria-expanded={agentMenuOpen}
              data-testid="header-agent-trigger"
            >
              <HarnessIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{agent?.name || 'Unassigned'}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            </button>
            {agentMenuOpen && (
              <div role="menu" aria-label="Agent" className={`${MENU_PANEL_CLASS} right-0`}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!task.agent_id}
                  onClick={() => {
                    setAgentMenuOpen(false)
                    if (task.agent_id) void onAssignAgent(null)
                  }}
                  className={`${MENU_ITEM_CLASS} hover:bg-accent`}
                  data-testid="header-agent-option-unassigned"
                >
                  <span>Unassigned</span>
                  {!task.agent_id && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
                {agents.map((a) => {
                  const AgentLogo = getHarnessLogo(a)
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={task.agent_id === a.id}
                      onClick={() => {
                        setAgentMenuOpen(false)
                        if (task.agent_id !== a.id) void onAssignAgent(a.id)
                      }}
                      className={`${MENU_ITEM_CLASS} hover:bg-accent`}
                      data-testid={`header-agent-option-${a.id}`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <AgentLogo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{a.name}</span>
                      </span>
                      {task.agent_id === a.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <span className="hidden items-center gap-1.5 rounded-full border border-border/50 bg-card px-2 py-1 text-[11px] text-muted-foreground lg:inline-flex">
            <HarnessIcon className="h-3 w-3" />
            <span className="truncate">{agent?.name || 'Unassigned'}</span>
          </span>
        )}
      </div>
      {actionMeta && onAction && (
        <Button size="sm" onClick={onAction} className="h-8 gap-1.5 px-3" data-testid={`header-cta-${action}`}>
          {ActionIcon && <ActionIcon className="h-3.5 w-3.5" />}
          {actionMeta.label}
        </Button>
      )}
      {showStandaloneComplete && (
        <Button
          variant={actionMeta && onAction ? 'outline' : 'default'}
          size="sm"
          onClick={onComplete}
          className="h-8 gap-1.5 px-3"
          data-testid="header-cta-complete"
        >
          <Check className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Complete</span>
        </Button>
      )}
      {showDetailsToggle && (
        <Button variant={detailsOpen ? 'secondary' : 'ghost'} size="sm" onClick={onToggleDetails} className="h-8 gap-1.5">
          <Menu className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Details</span>
        </Button>
      )}
      <div ref={menuRef} className="relative">
        <Button variant="ghost" size="icon" onClick={() => setMenuOpen((open) => !open)} aria-label="Task actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
        {menuOpen && (
          <div className="absolute right-0 top-9 z-50 w-44 overflow-hidden rounded-lg border border-border/50 bg-popover p-1 shadow-xl">
            {[
              { label: 'Edit task', icon: Pencil, action: onEdit },
              { label: 'Snooze', icon: ChevronDown, action: onSnooze },
              { label: 'Open in canvas', icon: Layers, action: onOpenCanvas },
              { label: 'Open folder', icon: FolderOpen, action: onOpenFolder },
              { label: 'Open full task view', icon: ExternalLink, action: onOpenFullView }
            ].filter((item) => item.action).map((item) => (
              <button key={item.label} onClick={() => { setMenuOpen(false); item.action?.() }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground hover:bg-accent">
                <item.icon className="h-3.5 w-3.5 text-muted-foreground" />{item.label}
              </button>
            ))}
            <div className="my-1 border-t border-border/50" />
            <button onClick={() => { setMenuOpen(false); onDelete() }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-destructive hover:bg-destructive/10">
              <Trash2 className="h-3.5 w-3.5" />Delete task
            </button>
          </div>
        )}
      </div>
    </header>
  )
}

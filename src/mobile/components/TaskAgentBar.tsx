import { useEffect, useRef, useState } from 'react'
import type { Task } from '../stores/task-store'
import type { Agent } from '../stores/agent-store'
import { MENU_ITEM_CLASS, MENU_PANEL_CLASS } from '@shared/menu-styles'
import { taskStatusDotClass } from '@shared/task-status-styles'

/** Top-bar agent switcher, mirroring desktop TaskHeaderBar so the agent can be changed without opening Details. */
export function TaskAgentBar({ task, agents, assignedAgentName, onAssignAgent }: {
  task: Task
  agents: Agent[]
  assignedAgentName?: string
  onAssignAgent: (agentId: string | null) => void
}) {
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const agentMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!agentMenuOpen) return
    const close = (event: PointerEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node)) setAgentMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [agentMenuOpen])

  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border/50">
      <span className="text-xs text-muted-foreground shrink-0">Agent</span>
      <div ref={agentMenuRef} className="relative">
        <button
          type="button"
          onClick={() => setAgentMenuOpen((o) => !o)}
          className="inline-flex max-w-40 items-center gap-1.5 rounded-full border border-border/50 bg-card px-2.5 py-1 text-xs text-muted-foreground"
          aria-label="Change agent"
          aria-haspopup="menu"
          aria-expanded={agentMenuOpen}
          data-testid="mobile-header-agent-trigger"
        >
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
          <span className="truncate">{assignedAgentName || 'Unassigned'}</span>
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        {agentMenuOpen && (
          <div role="menu" aria-label="Agent" className={`${MENU_PANEL_CLASS} left-0`}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!task.agent_id}
              onClick={() => { setAgentMenuOpen(false); if (task.agent_id) onAssignAgent(null) }}
              className={`${MENU_ITEM_CLASS} active:bg-accent`}
              data-testid="mobile-header-agent-option-unassigned"
            >
              <span>Unassigned</span>
              {!task.agent_id && <svg className="h-3.5 w-3.5 text-primary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>}
            </button>
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={task.agent_id === a.id}
                onClick={() => { setAgentMenuOpen(false); if (task.agent_id !== a.id) onAssignAgent(a.id) }}
                className={`${MENU_ITEM_CLASS} active:bg-accent`}
                data-testid={`mobile-header-agent-option-${a.id}`}
              >
                <span className="truncate">{a.name}</span>
                {task.agent_id === a.id && <svg className="h-3.5 w-3.5 text-primary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="ml-auto text-[11px] text-muted-foreground flex items-center gap-1">
        <span className={`h-1.5 w-1.5 rounded-full ${taskStatusDotClass(task.status)}`} />
        {task.status}
      </span>
    </div>
  )
}

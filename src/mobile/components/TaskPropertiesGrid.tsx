import { useMemo } from 'react'
import { TaskStatus } from '@shared/constants'
import { getAgentConfigIssue } from '@shared/agent-utils'
import { Badge } from './Badge'
import { useTaskStore, type Task } from '../stores/task-store'
import { useAgentStore, SessionStatus, type Agent, type TaskSession } from '../stores/agent-store'
import { formatDate } from '@/lib/utils'
import { cn, isOverdue, formatRelativeDate, formatRelativeFuture } from '../lib/utils'
import type { Route } from '../App'

export interface SessionActions {
  canTriage: boolean
  canStart: boolean
  canResume: boolean
  canStop: boolean
  onTriage: () => void
  onStart: () => void
  onResume: () => void
  onStop: () => void
}

export function TaskPropertiesGrid({ task, agents, session, isAssignedAgent, unconfiguredAgent, actions, onAssignAgent, onNavigate }: {
  task: Task
  agents: Agent[]
  session?: TaskSession
  isAssignedAgent: boolean
  unconfiguredAgent: Agent | null
  actions: SessionActions
  onAssignAgent: (agentId: string | null) => void
  onNavigate: (route: Route) => void
}) {
  const updateTask = useTaskStore((s) => s.updateTask)
  const skills = useAgentStore((s) => s.skills)
  const agentSkills = useMemo(
    () => (task.agent_id ? skills.filter((s) => !s.agent_id || s.agent_id === task.agent_id) : []),
    [skills, task.agent_id]
  )
  const { canTriage, canStart, canResume, canStop, onTriage, onStart, onResume, onStop } = actions

  return (
    <div className="px-4 py-4 border-b border-border">
      <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-3 text-sm">
        <span className="text-muted-foreground flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
          Agent
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={task.agent_id || ''}
            onChange={(e) => onAssignAgent(e.target.value || null)}
            className="bg-transparent border border-border rounded px-2 py-1 text-sm cursor-pointer text-foreground min-w-0"
          >
            <option value="">No agent assigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {canTriage && (
            <button onClick={onTriage} className="inline-flex items-center gap-1.5 border border-border bg-transparent text-foreground hover:bg-accent h-7 rounded-md px-3 text-xs font-medium shrink-0">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
              </svg>
              Triage
            </button>
          )}
          {canStart && (
            <button onClick={onStart} className="inline-flex items-center gap-1.5 border border-border bg-transparent text-foreground hover:bg-accent h-7 rounded-md px-3 text-xs font-medium shrink-0">
              Start
            </button>
          )}
          {canResume && (
            <button onClick={onResume} className="inline-flex items-center gap-1.5 border border-border bg-transparent text-foreground hover:bg-accent h-7 rounded-md px-3 text-xs font-medium shrink-0">
              Resume
            </button>
          )}
          {canStop && (
            <button onClick={onStop} className="inline-flex items-center gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90 h-7 rounded-md px-3 text-xs font-medium shrink-0">
              Stop
            </button>
          )}
          {session && (
            <span className={cn(
              'text-xs flex items-center gap-1.5 ml-auto',
              session.status === SessionStatus.WORKING && 'text-green-400',
              session.status === SessionStatus.ERROR && 'text-red-400',
              session.status === SessionStatus.WAITING_APPROVAL && 'text-yellow-400',
              session.status === SessionStatus.IDLE && 'text-muted-foreground'
            )}>
              {session.status === SessionStatus.WORKING && (
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              )}
              {session.status === SessionStatus.WORKING && 'Working'}
              {session.status === SessionStatus.IDLE && 'Idle'}
              {session.status === SessionStatus.ERROR && '● Error'}
              {session.status === SessionStatus.WAITING_APPROVAL && '● Waiting'}
            </span>
          )}
          {unconfiguredAgent && task.status !== TaskStatus.Completed && (
            <div
              data-testid="agent-config-warning"
              className="w-full mt-1 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
            >
              <svg className="h-3.5 w-3.5 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" x2="12" y1="8" y2="12" />
                <line x1="12" x2="12.01" y1="16" y2="16" />
              </svg>
              <p className="flex-1 leading-snug">
                {isAssignedAgent
                  ? `${getAgentConfigIssue(unconfiguredAgent) || 'Agent is not fully configured'}. Start is disabled — edit this agent on desktop to continue.`
                  : `The default agent "${unconfiguredAgent.name}" is not fully configured (${(getAgentConfigIssue(unconfiguredAgent) || 'missing settings').toLowerCase()}). Triage is disabled — edit the agent on desktop to continue.`}
              </p>
            </div>
          )}
        </div>

        <span className="text-muted-foreground flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
          Repos
        </span>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {task.repos.map((repo) => (
              <span key={repo} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium pr-1">
                {repo.split('/').pop()}
                <button
                  onClick={() => updateTask(task.id, { repos: task.repos.filter((r) => r !== repo) })}
                  className="rounded-full hover:bg-foreground/10 p-0.5"
                >
                  <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                  </svg>
                </button>
              </span>
            ))}
            <button
              onClick={() => onNavigate({ page: 'repos', taskId: task.id })}
              className="inline-flex items-center gap-1 h-6 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14"/><path d="M12 5v14"/>
              </svg>
              Add
            </button>
          </div>
        </div>

        {task.agent_id && (
          <>
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
              Skills
            </span>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {task.skill_ids === null ? (
                  <span className="text-xs text-muted-foreground">Using agent defaults</span>
                ) : (
                  <>
                    {task.skill_ids.map((skillId) => {
                      const skill = agentSkills.find((s) => s.id === skillId)
                      if (!skill) return null
                      return (
                        <span key={skillId} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium pr-1">
                          {skill.name}
                          <button
                            onClick={() => updateTask(task.id, { skill_ids: task.skill_ids!.filter((id) => id !== skillId) })}
                            className="rounded-full hover:bg-foreground/10 p-0.5"
                          >
                            <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                            </svg>
                          </button>
                        </span>
                      )
                    })}
                  </>
                )}
                <button
                  onClick={() => onNavigate({ page: 'skills', taskId: task.id })}
                  className="inline-flex items-center gap-1 h-6 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14"/><path d="M12 5v14"/>
                  </svg>
                  {task.skill_ids === null ? 'Customize' : 'Add'}
                </button>
                {task.skill_ids !== null && (
                  <button
                    onClick={() => updateTask(task.id, { skill_ids: null })}
                    className="text-xs text-muted-foreground active:opacity-60"
                  >
                    Reset to defaults
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Auto flags apply only to recurring templates, not their instances */}
        {task.is_recurring && !task.recurrence_parent_id && task.agent_id && (
          <>
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Auto-start
            </span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={task.auto_start_agent}
                onChange={(e) => updateTask(task.id, { auto_start_agent: e.target.checked })}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm">Auto-start agent on new instances</span>
            </label>
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
              Auto-complete
            </span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={task.auto_complete_without_review}
                onChange={(e) => updateTask(task.id, { auto_complete_without_review: e.target.checked })}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm">Auto-complete without review</span>
            </label>
          </>
        )}

        {task.due_date && (
          <>
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></svg>
              Due
            </span>
            <span className={isOverdue(task.due_date) ? 'text-red-400' : 'text-foreground'}>
              {formatDate(task.due_date)}
            </span>
          </>
        )}

        <span className="text-muted-foreground flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>
          Labels
        </span>
        <div className="flex flex-wrap gap-1">
          {task.labels.length > 0 ? (
            task.labels.map((l) => (
              <Badge key={l} variant="blue">{l}</Badge>
            ))
          ) : (
            <span className="text-muted-foreground text-xs">None</span>
          )}
        </div>

        <span className="text-muted-foreground flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Updated
        </span>
        <span className="text-foreground">{formatRelativeDate(task.updated_at)}</span>

        {(task.status === TaskStatus.ReadyForReview || task.heartbeat_enabled) && (
          <>
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className={`h-3.5 w-3.5 ${task.heartbeat_enabled ? 'text-rose-500' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
              </svg>
              Heartbeat
            </span>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Badge variant={task.heartbeat_enabled ? 'green' : 'default'}>
                  {task.heartbeat_enabled ? 'On' : 'Off'}
                </Badge>
                {task.heartbeat_enabled && task.heartbeat_next_check_at && (
                  <span className="text-[10px] text-muted-foreground/60">
                    next {formatRelativeFuture(task.heartbeat_next_check_at)}
                  </span>
                )}
                <button
                  onClick={async () => {
                    await updateTask(task.id, { heartbeat_enabled: !task.heartbeat_enabled })
                  }}
                  className="text-xs text-primary active:opacity-60 ml-auto"
                >
                  {task.heartbeat_enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { Switch } from '@/components/ui/Switch'
import { concurrencyApi } from '@/lib/ipc-client'
import { formatRelativeDate } from '@shared/date-format'
import type { AgentConcurrencyState, ConcurrencyAuditEntry, ProjectConcurrencyState } from '@shared/concurrency'

interface ConcurrencySectionProps {
  projectId: string
}

const SOURCE_LABELS: Record<AgentConcurrencyState['source'], string> = {
  captain: 'set by the Captain',
  pinned: 'pinned by you',
  cap: 'Captain control off'
}

const ACTOR_LABELS: Record<ConcurrencyAuditEntry['actor'], string> = { captain: 'Captain', user: 'You', system: '21x' }

function describeEntry(entry: ConcurrencyAuditEntry, agentName: (id: string) => string): string {
  const agent = agentName(entry.agent_id)
  switch (entry.kind) {
    case 'level':
      return `${agent}: ${entry.previous_level ?? '?'} → ${entry.level}`
    case 'pin':
      return `${agent}: pinned at ${entry.level}`
    case 'unpin':
      return `${agent}: unpinned (now ${entry.level})`
    case 'control_on':
      return 'Captain control on'
    case 'control_off':
      return 'Captain control off'
  }
}

/**
 * Project editor → Concurrency (#150). Shows each agent's hard cap and this
 * project's working level, and lets the user switch Captain control or pin
 * a level. Changes apply at once and are audited; they are not part of the
 * editor's draft (the Captain may move levels while the dialog is open).
 */
export function ConcurrencySection({ projectId }: ConcurrencySectionProps) {
  const [state, setState] = useState<ProjectConcurrencyState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    concurrencyApi.getState(projectId).then(setState).catch(() => setState(null))
  }, [projectId])

  useEffect(() => {
    reload()
    return concurrencyApi.onChanged((event) => {
      if (event.projectId === projectId) reload()
    })
  }, [projectId, reload])

  const apply = async (call: Promise<{ success: true } | { error: string }>) => {
    const result = await call
    setError('error' in result ? result.error : null)
    reload()
  }

  if (!state) return null
  const agentName = (id: string) => state.agents.find((a) => a.agentId === id)?.agentName ?? (id ? 'An agent' : '')

  return (
    <section className="space-y-3" aria-label="Concurrency">
      <div>
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Concurrency</h3>
        <p className="text-xs text-muted-foreground">
          Each agent has a hard cap you set in its settings; it bounds the agent across every project. Within it, this project’s Captain sets a
          working level. The level starts at 1. The Captain raises it for work that can run in parallel, and lowers it for serial steps and shared
          files. It is lowered automatically when the machine is short of memory or CPU. Lowering never stops running work. Changes apply at once.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={state.captainControl}
          onCheckedChange={(checked) => void apply(concurrencyApi.setCaptainControl(projectId, checked))}
          aria-label="Captain controls concurrency"
        />
        <span>Captain controls concurrency</span>
        <span className="text-xs text-muted-foreground">— off: every agent runs up to its hard cap here</span>
      </label>
      {state.pressure?.underPressure && (
        <p className="text-xs text-amber-500">The machine is under resource pressure ({state.pressure.reasons.join(', ')}). The levels will not be raised.</p>
      )}
      {state.agents.length === 0 ? (
        <p className="text-xs text-muted-foreground">No agent has work in this project yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="font-normal">Agent</th>
              <th className="font-normal">Hard cap</th>
              <th className="font-normal">Level here</th>
              <th className="font-normal">Running</th>
              <th className="font-normal">Queued</th>
              <th className="font-normal">Pin</th>
            </tr>
          </thead>
          <tbody>
            {state.agents.map((agent) => (
              <tr key={agent.agentId} className="border-t border-border/50">
                <td className="py-1.5 pr-2">{agent.agentName}</td>
                <td className="pr-2">{agent.cap}</td>
                <td className="pr-2" title={`Suggested: ${agent.recommendation.level} (${agent.recommendation.why})`}>
                  {agent.level} <span className="text-xs text-muted-foreground">{SOURCE_LABELS[agent.source]}</span>
                </td>
                <td className="pr-2" title={`${agent.runningTotal} across all projects`}>{agent.runningInProject}</td>
                <td className="pr-2">{agent.queuedInProject}</td>
                <td>
                  <select
                    className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
                    value={agent.source === 'pinned' ? String(agent.level) : ''}
                    onChange={(e) => void apply(concurrencyApi.pin(projectId, agent.agentId, e.target.value === '' ? null : Number(e.target.value)))}
                    aria-label={`Pin the level of ${agent.agentName}`}
                  >
                    <option value="">Not pinned</option>
                    {Array.from({ length: agent.cap }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {state.recentChanges.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Recent changes</p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {state.recentChanges.map((entry) => (
              <li key={entry.id}>
                <span className="text-foreground">{describeEntry(entry, agentName)}</span>
                {' · '}{ACTOR_LABELS[entry.actor]}{' · '}{entry.reason}{' · '}{formatRelativeDate(entry.created_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

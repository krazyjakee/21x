import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/AlertDialog'
import { agentApi } from '@/lib/ipc-client'
import { useAgentStore } from '@/stores/agent-store'
import { describeAgentDeletion, isAgentDeletionRefusal, type AgentDeletionImpact } from '@shared/agent-deletion'
import type { Agent } from '@/types'

type Phase = 'loading' | 'confirm' | 'deleting' | 'done'

function Lines({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  )
}

/**
 * Says what deleting an agent will stop and leave unassigned, deletes on
 * confirmation, then says what really happened. The list comes from the
 * service on both hosts, so what is shown is what the delete acts on.
 */
export function AgentDeleteDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const deleteAgent = useAgentStore((state) => state.deleteAgent)
  const [phase, setPhase] = useState<Phase>('loading')
  const [impact, setImpact] = useState<AgentDeletionImpact | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(() => {
    setPhase('loading')
    setProblem(null)
    agentApi.deletionImpact(agent.id).then((next) => {
      if (!mounted.current) return
      if (!next) { onClose(); return }
      setImpact(next)
      setPhase('confirm')
    }).catch(() => {
      if (!mounted.current) return
      setImpact(null)
      setProblem('What this agent is doing could not be read, so nothing was deleted. Try again.')
      setPhase('confirm')
    })
  }, [agent.id, onClose])

  useEffect(() => { load() }, [load])

  const confirm = async (): Promise<void> => {
    setPhase('deleting')
    setProblem(null)
    const result = await deleteAgent(agent.id)
    if (!mounted.current) return
    if (isAgentDeletionRefusal(result)) { setProblem(result.refused); setPhase('confirm'); return }
    if (typeof result !== 'object') { onClose(); return }
    const { stops, changes } = describeAgentDeletion(result)
    if (stops.length === 0 && changes.length === 0) { onClose(); return }
    setImpact(result)
    setPhase('done')
  }

  const { stops, changes } = impact ? describeAgentDeletion(impact) : { stops: [], changes: [] }
  const done = phase === 'done'
  const busy = phase === 'loading' || phase === 'deleting'

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && phase !== 'deleting') onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{done ? `“${agent.name}” was deleted` : `Delete “${agent.name}”?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {phase === 'loading' && 'Checking what this agent is doing…'}
            {phase === 'deleting' && (stops.length > 0 ? 'Stopping this agent’s work and deleting it…' : 'Deleting…')}
            {phase === 'confirm' && impact && (stops.length === 0
              ? 'Nothing is running on this agent. Other agents are not affected.'
              : 'Other agents keep running. Only this agent’s own work stops.')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {phase !== 'loading' && (
          <div className="space-y-3" data-testid="agent-delete-impact">
            <Lines title={done ? 'Stopped' : 'This will stop'} lines={stops} />
            <Lines title={done ? 'What changed' : 'This will change'} lines={changes} />
          </div>
        )}
        {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
        <AlertDialogFooter>
          {done ? (
            <AlertDialogAction onClick={onClose}>Done</AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel disabled={phase === 'deleting'} onClick={onClose}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={(event) => { event.preventDefault(); if (impact) void confirm(); else load() }}
              >
                {!impact ? 'Try again' : stops.length > 0 ? 'Stop and delete' : 'Delete agent'}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

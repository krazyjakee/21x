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
import { describeAgentDeletion, isAgentDeletionRefusal, type AgentDeletionImpact, type PluginUninstallResult } from '@shared/agent-deletion'

type Phase = 'loading' | 'confirm' | 'deleting' | 'done'

const workOf = (impacts: AgentDeletionImpact[]): string => JSON.stringify(impacts.map((impact) => [impact.running, impact.queued]))

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

/** With several agents each line says whose it is. */
function describeAll(impacts: AgentDeletionImpact[]): { stops: string[]; changes: string[] } {
  const named = impacts.map((impact) => {
    const lines = describeAgentDeletion(impact)
    const prefix = (line: string) => (impacts.length > 1 ? `${impact.agent_name}: ${line}` : line)
    return { stops: lines.stops.map(prefix), changes: lines.changes.map(prefix) }
  })
  return { stops: named.flatMap((lines) => lines.stops), changes: named.flatMap((lines) => lines.changes) }
}

export interface DeletionDialogProps {
  /** A new subject is a new dialog: nothing else restarts the load. */
  subjectId: string
  title: string
  doneTitle: string
  idleText: string
  runningText: string
  actionLabel: string
  stopLabel: string
  /** Null when the subject has already gone. */
  readImpacts: () => Promise<AgentDeletionImpact[] | null>
  remove: () => Promise<PluginUninstallResult>
  onClose: () => void
}

/**
 * Says what removing an agent, or a plugin's agents, will stop and leave
 * unassigned, acts on confirmation, then says what really happened. What it
 * shows comes from the service on both hosts.
 */
export function DeletionDialog(props: DeletionDialogProps) {
  const { subjectId, title, doneTitle, idleText, runningText, actionLabel, stopLabel } = props
  const [phase, setPhase] = useState<Phase>('loading')
  const [impacts, setImpacts] = useState<AgentDeletionImpact[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const mounted = useRef(true)
  // Parents pass new functions on every render. Reading them through a ref means
  // a re-render can never restart the load and undo a receipt or a refusal.
  const latest = useRef(props)
  latest.current = props
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const unreadable = useCallback(() => {
    setImpacts(null)
    setProblem('What this would stop could not be read, so nothing was deleted. Try again.')
    setPhase('confirm')
  }, [])

  const load = useCallback(() => {
    setPhase('loading')
    setProblem(null)
    latest.current.readImpacts().then((next) => {
      if (!mounted.current) return
      if (!next) { latest.current.onClose(); return }
      setImpacts(next)
      setPhase('confirm')
    }).catch(() => { if (mounted.current) unreadable() })
  }, [unreadable])

  useEffect(() => { load() }, [load, subjectId])

  const confirm = async (shown: AgentDeletionImpact[]): Promise<void> => {
    setPhase('deleting')
    setProblem(null)
    // The list may be minutes old. New work must be seen before it is stopped.
    const current = await latest.current.readImpacts().catch(() => undefined)
    if (!mounted.current) return
    if (current === undefined) { unreadable(); return }
    if (current === null) { latest.current.onClose(); return }
    if (workOf(current) !== workOf(shown)) {
      setImpacts(current)
      setProblem('This work has changed since the list was read. Check it and confirm again.')
      setPhase('confirm')
      return
    }
    const result = await latest.current.remove()
    if (!mounted.current) return
    if (isAgentDeletionRefusal(result)) { setProblem(result.refused); setPhase('confirm'); return }
    if (!Array.isArray(result)) { latest.current.onClose(); return }
    const { stops, changes } = describeAll(result)
    if (stops.length === 0 && changes.length === 0) { latest.current.onClose(); return }
    setImpacts(result)
    setPhase('done')
  }

  const { stops, changes } = impacts ? describeAll(impacts) : { stops: [], changes: [] }
  const done = phase === 'done'
  const busy = phase === 'loading' || phase === 'deleting'

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && phase !== 'deleting') latest.current.onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{done ? doneTitle : title}</AlertDialogTitle>
          <AlertDialogDescription>
            {phase === 'loading' && 'Checking what is running…'}
            {phase === 'deleting' && (stops.length > 0 ? 'Stopping that work and removing it…' : 'Removing…')}
            {phase === 'confirm' && impacts && (stops.length === 0 ? idleText : runningText)}
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
            <AlertDialogAction onClick={() => latest.current.onClose()}>Done</AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel disabled={phase === 'deleting'} onClick={() => latest.current.onClose()}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={(event) => { event.preventDefault(); if (impacts) void confirm(impacts); else load() }}
              >
                {!impacts ? 'Try again' : stops.length > 0 ? stopLabel : actionLabel}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

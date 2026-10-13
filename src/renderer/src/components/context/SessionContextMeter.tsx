import { AlertTriangle, Gauge } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { SessionContextScope, SessionContextSnapshot } from '@shared/session-context'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/Dialog'
import { useSessionContext } from '@/hooks/use-session-context'
import { agentSessionApi, commanderApi } from '@/lib/ipc-client'
import { ContextDivider } from './ContextDivider'
import { RolloverPolicySettings } from './RolloverPolicySettings'

export function contextReading(usage: SessionContextSnapshot['usage'] | undefined) {
  const tokens = usage?.source !== 'unknown' && usage?.tokens != null && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null
  const capacity = usage?.contextWindow != null && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null
  const estimated = tokens !== null && usage?.source === 'estimated'
  const prefix = estimated ? '≈' : ''
  const percent = tokens !== null && capacity !== null ? tokens / capacity * 100 : null
  const value = tokens === null ? 'unknown' : percent !== null ? `${prefix}${Math.round(percent)}%` : `${prefix}${tokens.toLocaleString()} tokens`
  const description = tokens === null ? 'Context usage unknown' : `${estimated ? 'Estimated' : 'Reported'} context: ${prefix}${tokens.toLocaleString()} tokens${capacity !== null ? ` of ${capacity.toLocaleString()} (${prefix}${Math.round(percent!)}%)` : '; context limit unknown'}`
  return { tokens, capacity, percent, estimated, value, description }
}
const reasons = { context: 'Context threshold reached', compactions: 'Compaction threshold reached', wakeups: 'Wakeup threshold reached', turns: 'Turn threshold reached', age: 'Context age threshold reached' } as const
const states: Record<string, string> = { open: 'Open', active: 'Active', running: 'Active', idle: 'Idle', closed: 'Closed', interrupted: 'Interrupted', recovered: 'Recovered', crashed: 'Recovery needed', pending: 'Pending', unknown: 'Unknown' }

export function SessionContextMeter({ scope, compact = false }: { scope: SessionContextScope; compact?: boolean }) {
  const { snapshot, loading, error, reload, savePolicy } = useSessionContext(scope)
  const reading = contextReading(snapshot?.usage)
  const label = scope.kind === 'commander' ? 'Commander context' : 'Captain context'
  const warnings = snapshot?.warnings ?? []
  const pressure = snapshot?.reasons ?? []
  const pendingContinuation = !!snapshot?.handoff && snapshot.handoff.state !== 'completed'
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const stopRequest = useRef(0)
  useEffect(() => {
    stopRequest.current++; setStopping(false); setStopError('')
    return () => { stopRequest.current++ }
  }, [scope.kind, scope.ownerId])
  const stopContinuation = async () => {
    if (stopping || !pendingContinuation) return
    const request = ++stopRequest.current
    setStopping(true); setStopError('')
    try {
      const stopped = scope.kind === 'commander' ? (await commanderApi.cancel(scope.ownerId)).cancelled : (await agentSessionApi.stopByTaskId(scope.ownerId)).success
      if (request !== stopRequest.current) return
      if (!stopped) setStopError('Context continuation could not be stopped. Refresh to check its status.')
    } catch {
      if (request === stopRequest.current) setStopError('Context continuation could not be stopped. Try again.')
    } finally {
      if (request === stopRequest.current) { setStopping(false); reload() }
    }
  }
  const descriptionId = useId()
  const compactValue = reading.tokens !== null && reading.percent === null ? `${reading.estimated ? '≈' : ''}${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(reading.tokens)}` : reading.value
  return <Dialog><DialogTrigger asChild><Button size="sm" variant="ghost" className="shrink-0" aria-label={`${label}: ${error ? 'unavailable' : reading.value}${warnings.length || pressure.length || pendingContinuation ? ', warnings available' : ''}`} title={error ?? reading.description} data-testid="session-context-trigger"><Gauge className="size-icon-sm" aria-hidden="true" /><span>{compact ? compactValue : `Context ${reading.value}`}</span>{(error || warnings.length > 0 || pressure.length > 0 || pendingContinuation) && <AlertTriangle className="size-icon-sm" aria-hidden="true" />}</Button></DialogTrigger>
    <DialogContent className="ui-scale max-h-[90vh] overflow-y-auto" aria-describedby={descriptionId}><DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription id={descriptionId}>Current context and conversation continuation settings. Estimates use ≈. Unknown values remain unknown.</DialogDescription></DialogHeader>
      <div className="min-w-0 space-y-4 p-6">
        <div className="space-y-2"><p className="text-base font-medium" data-testid="context-usage-description">{reading.description}</p>
          {reading.tokens !== null && reading.capacity !== null && <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={reading.capacity} aria-valuenow={Math.min(reading.tokens, reading.capacity)} aria-valuetext={reading.description} className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary" style={{ width: `${Math.min(reading.percent!, 100)}%` }} /></div>}
          {reading.estimated && <p className="text-sm text-muted-foreground">Estimated from model context. Reported context is unavailable.</p>}
          {reading.tokens !== null && reading.capacity === null && <p className="text-sm text-muted-foreground">No context limit is known for this model; no percentage is inferred.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button size="sm" variant="outline" disabled={loading} onClick={reload}>{loading ? 'Refreshing…' : 'Refresh context'}</Button>
        </div>
        {pendingContinuation && <section aria-label="Pending context continuation" className="space-y-2 rounded-md border border-border p-3"><p className="text-sm leading-relaxed">Context continuation is pending. Your conversation history is retained.</p><Button size="sm" variant="outline" disabled={stopping} onClick={() => { void stopContinuation() }}>{stopping ? 'Stopping…' : 'Stop context continuation'}</Button></section>}
        {stopError && <p role="alert" className="text-sm leading-relaxed text-destructive">{stopError}</p>}
        {!!(warnings.length || pressure.length) && <section aria-label="Context warnings" className="space-y-2"><h3 className="text-sm font-medium">Warnings</h3>{[...new Set([...warnings, ...pressure.map(reason => reasons[reason])])].map(warning => <p key={warning} className="flex items-start gap-2 rounded-md border border-border bg-secondary px-2 py-1 text-sm leading-relaxed"><AlertTriangle className="size-icon-sm mt-0.5 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{warning}</span></p>)}</section>}
        {snapshot?.generation && <div className="text-sm"><p className="font-medium">Current generation · {states[snapshot.generation.state] ?? 'Status unknown'}</p><p className="mt-1 text-muted-foreground">{snapshot.counters.compactions} compactions · {snapshot.counters.wakeups} wakeups · {snapshot.counters.turns} turns · {Math.floor(snapshot.counters.ageMs / 86_400_000)} days</p><details className="mt-2"><summary className="cursor-pointer text-muted-foreground">Generation details</summary><dl className="mt-2 space-y-1 break-words"><dt>Generation</dt><dd>{snapshot.generation.key}</dd><dt>Engine</dt><dd>{snapshot.generation.engine === 'chat' ? 'Chat' : 'Agent backend'}</dd><dt>Model</dt><dd>{snapshot.usage.model ?? 'Unknown'}</dd><dt>Last context observation</dt><dd>{snapshot.usage.observedAt === null ? 'Unknown' : new Date(snapshot.usage.observedAt).toLocaleString()}</dd></dl></details></div>}
        {!!snapshot?.summaries.length && <section aria-label="Context summaries"><h3 className="text-sm font-medium">Retained context summaries</h3>{snapshot.summaries.map(summary => <ContextDivider key={summary.id} kind={summary.kind === 'summary' ? 'compaction' : summary.kind} title={summary.kind === 'summary' ? 'Context compacted' : summary.kind === 'rollover' ? 'Generation handoff' : 'Recovery'} summary={summary.content} source={summary.source} />)}</section>}
        <details aria-label="Conversation continuation settings"><summary className="cursor-pointer text-sm font-medium">Conversation continuation settings</summary><div className="mt-3">{snapshot ? <RolloverPolicySettings policy={snapshot.policy} onSave={savePolicy} /> : <p className="text-sm text-muted-foreground">Refresh context data to load the current conversation continuation settings.</p>}</div></details>
      </div>
    </DialogContent>
  </Dialog>
}

import { randomUUID } from 'node:crypto'
import { ACTIVITY_STALE_MS, type CommanderActivitySnapshot } from '../../shared/activity'
import type { CommanderEvent } from '../../shared/commander'

interface Source extends Omit<CommanderActivitySnapshot, 'ageMs'> { observedAt: number }

/** Source observations only: no reads of transcript text or cached UI state. */
export class CommanderActivityObservations {
  readonly epoch = randomUUID()
  private sequence = 0
  private readonly sessions = new Map<string, Source>()
  constructor(private readonly now: () => number = () => performance.now()) {}

  record(event: CommanderEvent): CommanderActivitySnapshot | undefined {
    if (event.type !== 'turn_started' && event.type !== 'turn_event') return undefined
    const previous = this.sessions.get(event.sessionId)
    if (event.type === 'turn_event' && previous?.turnId !== event.turnId) return undefined
    if (event.type === 'turn_event' && (previous?.phase === 'idle'
      || (previous?.phase === 'error' && event.event.type !== 'done'))) return undefined
    const source: Source = event.type === 'turn_started'
      ? { epoch: this.epoch, sequence: 0, turnId: event.turnId, phase: 'thinking', openTools: [], hasText: false, observedAt: this.now() }
      : { ...previous!, openTools: [...previous!.openTools] }
    if (event.type === 'turn_event') {
      const inner = event.event
      if (inner.type === 'text_delta') { source.hasText = true; source.phase = source.openTools.length ? 'tool' : 'working' }
      else if (inner.type === 'tool_call_start') {
        if (!source.openTools.some(t => t.id === inner.id)) source.openTools.push({ id: inner.id, name: inner.name })
        source.phase = 'tool'
      } else if (inner.type === 'tool_call_result') {
        source.openTools = source.openTools.filter(t => t.id !== inner.id)
        source.phase = source.openTools.length ? 'tool' : source.hasText ? 'working' : 'thinking'
      } else if (inner.type === 'error') { source.phase = 'error'; source.reason = inner.message; source.outcome = 'failed'; source.openTools = [] }
      else if (inner.type === 'done') {
        source.phase = inner.stopReason === 'error' ? 'error' : 'idle'
        source.outcome = inner.stopReason === 'error' ? 'failed' : inner.stopReason === 'cancelled' ? 'stopped' : 'finished'
        source.openTools = []
      } else return undefined
    }
    source.sequence = ++this.sequence
    source.observedAt = this.now()
    this.remember(event.sessionId, source)
    return this.snapshot(source)
  }

  read(sessionId: string, activeTurnId: string | null, closed = false): CommanderActivitySnapshot {
    const previous = this.sessions.get(sessionId)
    if (closed || (activeTurnId !== null && previous?.turnId !== activeTurnId)) {
      return { epoch: this.epoch, sequence: ++this.sequence, turnId: activeTurnId, phase: 'unknown', ageMs: 0, openTools: [], hasText: false }
    }
    if (activeTurnId || previous?.phase === 'error') {
      const snapshot = this.snapshot(previous!)
      return snapshot.ageMs >= ACTIVITY_STALE_MS ? { ...snapshot, phase: 'unknown' } : snapshot
    }
    // Confirming no owned runtime is an authoritative idle read. It does not
    // replay a terminal outcome or infer completion from persisted messages.
    const source: Source = { epoch: this.epoch, sequence: ++this.sequence, turnId: previous?.turnId ?? null,
      phase: 'idle', observedAt: this.now(), openTools: [], hasText: previous?.hasText ?? false }
    this.remember(sessionId, source)
    return this.snapshot(source)
  }

  private snapshot(source: Source): CommanderActivitySnapshot {
    const { observedAt, ...snapshot } = source
    return { ...snapshot, openTools: [...source.openTools], ageMs: Math.max(0, this.now() - observedAt) }
  }
  private remember(sessionId: string, source: Source): void {
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, source)
    if (this.sessions.size > 500) this.sessions.delete(this.sessions.keys().next().value!)
  }
}

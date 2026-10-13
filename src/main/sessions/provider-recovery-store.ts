import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { PROVIDER_MAX_RETRIES, providerRetryDelay, type ProviderFailure } from '../agent-manager/provider-failure'

export interface ProviderRecovery {
  taskId: string
  intentId: string
  sessionId: string
  agentId: string
  workspaceDir?: string
  prompt: string
  state: 'sending' | 'accepted' | 'retrying' | 'dispatching' | 'failed' | 'cancelled' | 'completed'
  generation: number
  attempt: number
  nextRetryAt: number | null
  cause: string | null
  failureKind: ProviderFailure['kind'] | null
  delivery: ProviderFailure['delivery']
  mode: 'continuation' | 'poll'
  remainingAgentIds: string[]
  attemptedAgentIds: string[]
  selectedFallback: string | null
}

/** One continuation owner per task. Persist before send/dispatch so a crash
 * during unknown acceptance is never mistaken for a safe backoff deadline. */
export class ProviderRecoveryStore {
  private readonly memory = new Map<string, ProviderRecovery>()
  constructor(private readonly source: { db: Database.Database }, private readonly now: () => number = Date.now) {}
  private get persistent(): boolean { return Boolean(this.source.db?.prepare) }
  get(taskId: string): ProviderRecovery | null {
    if (!this.persistent) return this.memory.get(taskId) ?? null
    const row = this.source.db.prepare('SELECT record FROM agent_provider_recovery WHERE task_id = ?').get(taskId) as { record: string } | undefined
    return row ? JSON.parse(row.record) as ProviderRecovery : null
  }
  list(states: ProviderRecovery['state'][] = ['sending', 'accepted', 'retrying', 'dispatching']): ProviderRecovery[] {
    if (!states.length) return []
    if (!this.persistent) return [...this.memory.values()].filter((row) => states.includes(row.state))
    return (this.source.db.prepare(`SELECT record FROM agent_provider_recovery WHERE state IN (${states.map(() => '?').join(',')})`).all(...states) as { record: string }[]).map((row) => JSON.parse(row.record) as ProviderRecovery)
  }
  /** Admission needs ownership, never the full prompt payload. */
  owners(): Array<{ taskId: string; agentId: string }> {
    if (!this.persistent) return this.list(['retrying', 'dispatching']).map(({ taskId, agentId }) => ({ taskId, agentId }))
    return this.source.db.prepare(`SELECT task_id AS taskId, json_extract(record, '$.agentId') AS agentId
      FROM agent_provider_recovery WHERE state IN ('retrying', 'dispatching')`).all() as Array<{ taskId: string; agentId: string }>
  }
  private put(row: ProviderRecovery): ProviderRecovery {
    if (!this.persistent) this.memory.set(row.taskId, row)
    else this.source.db.prepare('INSERT INTO agent_provider_recovery (task_id, state, next_retry_at, record) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET state = excluded.state, next_retry_at = excluded.next_retry_at, record = excluded.record')
      .run(row.taskId, row.state, row.nextRetryAt, JSON.stringify(row))
    return row
  }
  begin(input: Pick<ProviderRecovery, 'taskId' | 'sessionId' | 'agentId' | 'workspaceDir' | 'prompt' | 'remainingAgentIds' | 'attemptedAgentIds'>): ProviderRecovery {
    const previous = this.get(input.taskId)
    return this.put({ ...input, intentId: randomUUID(), state: 'sending', generation: (previous?.generation ?? 0) + 1,
      attempt: 0, nextRetryAt: null, cause: null, failureKind: null, delivery: 'unknown', mode: 'continuation', selectedFallback: null })
  }
  change(row: ProviderRecovery, patch: Partial<ProviderRecovery>): ProviderRecovery | null {
    const current = this.get(row.taskId)
    if (!current || current.intentId !== row.intentId || current.generation !== row.generation) return null
    const next = { ...current, ...patch, generation: current.generation + 1 }
    if (['failed', 'cancelled', 'completed'].includes(next.state)) next.prompt = ''
    return this.put(next)
  }
  schedule(row: ProviderRecovery, failure: ProviderFailure, mode: ProviderRecovery['mode'] = 'continuation'): ProviderRecovery | null {
    const attempt = row.attempt + 1
    return this.change(row, { state: 'retrying', attempt,
      nextRetryAt: this.now() + (failure.kind === 'exhausted' || attempt > PROVIDER_MAX_RETRIES ? 0 : providerRetryDelay(row.intentId, attempt)),
      cause: failure.message, failureKind: failure.kind, delivery: failure.delivery, mode })
  }
  cancel(taskId: string): void {
    const row = this.get(taskId)
    if (row) this.change(row, { state: 'cancelled', nextRetryAt: null })
  }
}

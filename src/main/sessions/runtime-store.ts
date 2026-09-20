import type Database from 'better-sqlite3'
import type { CaptainRuntimePhase, CaptainRuntimeState } from '../../shared/captain-runtime'

interface RuntimeRow {
  owner_id: string
  project_id: string
  generation: number
  agent_id: string
  candidate_agent_id: string | null
  last_good_agent_id: string | null
  session_id: string | null
  phase: CaptainRuntimePhase
  deadline_at: number | null
  last_probe_at: number | null
  probe_ok: number | null
  attempt_count: number
  error_code: string | null
  error_detail: string | null
  created_at: number
  updated_at: number
}

function runtime(row: RuntimeRow): CaptainRuntimeState {
  return {
    ownerId: row.owner_id,
    projectId: row.project_id,
    generation: row.generation,
    agentId: row.agent_id,
    candidateAgentId: row.candidate_agent_id,
    lastGoodAgentId: row.last_good_agent_id,
    sessionId: row.session_id,
    phase: row.phase,
    deadlineAt: row.deadline_at,
    lastProbeAt: row.last_probe_at,
    probeOk: row.probe_ok === null ? null : row.probe_ok === 1,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class CaptainRuntimeStore {
  /** Structural DB doubles used by focused AgentManager unit tests have no
   * SQLite handle. Production always uses the table; this map keeps those
   * tests concerned with unrelated session behavior isolated. */
  private readonly memory = new Map<string, CaptainRuntimeState>()

  constructor(private readonly source: { db: Database.Database }, private readonly now: () => number = Date.now) {}

  private get persistent(): boolean {
    return Boolean(this.source.db && typeof this.source.db.prepare === 'function')
  }

  get(ownerId: string): CaptainRuntimeState | null {
    if (!this.persistent) return this.memory.get(ownerId) ?? null
    const row = this.source.db.prepare('SELECT * FROM managed_agent_runtimes WHERE owner_id = ?').get(ownerId) as RuntimeRow | undefined
    return row ? runtime(row) : null
  }

  getByProject(projectId: string): CaptainRuntimeState | null {
    if (!this.persistent) return this.list().filter((row) => row.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    const row = this.source.db.prepare('SELECT * FROM managed_agent_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1').get(projectId) as RuntimeRow | undefined
    return row ? runtime(row) : null
  }

  list(): CaptainRuntimeState[] {
    if (!this.persistent) return [...this.memory.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    return (this.source.db.prepare('SELECT * FROM managed_agent_runtimes ORDER BY updated_at ASC').all() as RuntimeRow[]).map(runtime)
  }

  begin(input: {
    ownerId: string
    projectId: string
    agentId: string
    lastGoodAgentId?: string | null
    deadlineAt: number
    retry?: boolean
  }): CaptainRuntimeState {
    const previous = this.get(input.ownerId)
    const ts = this.now()
    const generation = (previous?.generation ?? 0) + 1
    const attemptCount = (previous?.attemptCount ?? 0) + 1
    const phase: CaptainRuntimePhase = input.retry ? 'retrying' : 'starting_server'
    if (!this.persistent) {
      const value: CaptainRuntimeState = {
        ownerId: input.ownerId,
        projectId: input.projectId,
        generation,
        agentId: input.agentId,
        candidateAgentId: input.agentId,
        lastGoodAgentId: input.lastGoodAgentId ?? previous?.lastGoodAgentId ?? null,
        sessionId: null,
        phase,
        deadlineAt: input.deadlineAt,
        lastProbeAt: null,
        probeOk: null,
        attemptCount,
        errorCode: null,
        errorDetail: null,
        createdAt: previous?.createdAt ?? ts,
        updatedAt: ts
      }
      this.memory.set(input.ownerId, value)
      return value
    }
    this.source.db.prepare(`
      INSERT INTO managed_agent_runtimes
        (owner_id, project_id, generation, agent_id, candidate_agent_id, last_good_agent_id,
         session_id, phase, deadline_at, last_probe_at, probe_ok, attempt_count,
         error_code, error_detail, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        project_id = excluded.project_id,
        generation = excluded.generation,
        agent_id = excluded.agent_id,
        candidate_agent_id = excluded.candidate_agent_id,
        last_good_agent_id = excluded.last_good_agent_id,
        session_id = NULL,
        phase = excluded.phase,
        deadline_at = excluded.deadline_at,
        last_probe_at = NULL,
        probe_ok = NULL,
        attempt_count = excluded.attempt_count,
        error_code = NULL,
        error_detail = NULL,
        updated_at = excluded.updated_at
    `).run(
      input.ownerId,
      input.projectId,
      generation,
      input.agentId,
      input.agentId,
      input.lastGoodAgentId ?? previous?.lastGoodAgentId ?? null,
      phase,
      input.deadlineAt,
      attemptCount,
      previous?.createdAt ?? ts,
      ts
    )
    return this.get(input.ownerId)!
  }

  transition(
    ownerId: string,
    generation: number,
    phase: CaptainRuntimePhase,
    patch: Partial<Pick<CaptainRuntimeState, 'sessionId' | 'deadlineAt' | 'lastProbeAt' | 'probeOk' | 'errorCode' | 'errorDetail' | 'agentId' | 'candidateAgentId' | 'lastGoodAgentId'>> = {}
  ): CaptainRuntimeState | null {
    const current = this.get(ownerId)
    if (!current || current.generation !== generation) return null
    if (!this.persistent) {
      const updated = { ...current, ...patch, phase, updatedAt: this.now() }
      this.memory.set(ownerId, updated)
      return updated
    }
    const value = <K extends keyof typeof patch>(key: K, fallback: unknown): unknown =>
      Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : fallback
    const result = this.source.db.prepare(`
      UPDATE managed_agent_runtimes SET
        phase = ?, session_id = ?, deadline_at = ?, last_probe_at = ?, probe_ok = ?,
        error_code = ?, error_detail = ?, agent_id = ?, candidate_agent_id = ?,
        last_good_agent_id = ?, updated_at = ?
      WHERE owner_id = ? AND generation = ?
    `).run(
      phase,
      value('sessionId', current.sessionId),
      value('deadlineAt', current.deadlineAt),
      value('lastProbeAt', current.lastProbeAt),
      value('probeOk', current.probeOk) === null ? null : value('probeOk', current.probeOk) ? 1 : 0,
      value('errorCode', current.errorCode),
      value('errorDetail', current.errorDetail),
      value('agentId', current.agentId),
      value('candidateAgentId', current.candidateAgentId),
      value('lastGoodAgentId', current.lastGoodAgentId),
      this.now(),
      ownerId,
      generation
    )
    return result.changes ? this.get(ownerId) : null
  }

  expireStale(now = this.now(), interrupted = false): CaptainRuntimeState[] {
    const stale = this.list().filter((row) =>
      ['starting_server', 'starting_session', 'verifying', 'retrying', 'recovering'].includes(row.phase)
      && (interrupted || (row.deadlineAt !== null && row.deadlineAt <= now))
    )
    for (const row of stale) {
      this.transition(row.ownerId, row.generation, 'timed_out', {
        errorCode: 'STARTUP_TIMEOUT',
        errorDetail: 'The previous start did not finish before its persisted deadline.',
        probeOk: false,
        lastProbeAt: now,
        deadlineAt: null
      })
    }
    return stale.map((row) => this.get(row.ownerId)!).filter(Boolean)
  }
}

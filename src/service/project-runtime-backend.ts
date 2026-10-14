import { join } from 'node:path'
import { AgentManager, type ProjectRuntimeReadStore, type ProjectRuntimeMutationStore } from '../main/agent-manager-core'
import type { DatabaseManager } from '../main/database/manager'
import { WorkspaceFileOwner, WorkspaceFileError } from '../main/workspace-file-owner'
import { buildProjectStatus, readProjectStatusHistory } from '../main/project-status'
import { buildProjectOverview } from '../main/project-overview'
import { CAPTAIN_MEMORY_FILE, CAPTAIN_MEMORY_MAX_CHARS } from '../main/agent-manager/captain-context'
import { captainTerminology } from '../shared/captain-compat'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { PROJECT_RUNTIME_CODECS, PROJECT_RUNTIME_OPERATIONS, PROJECT_RUNTIME_LIMITS, type ProjectRuntimeCodec, type ProjectRuntimeOperation } from '../shared/project-runtime-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { TaskWorkspaceScopeReader } from './task-workspace-scope'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface ProjectRuntimeOwners { database: DatabaseManager; manager: AgentManager; files: WorkspaceFileOwner; workspaceRoot: string }
export interface ProjectRuntimeBackendOptions extends ProjectRuntimeOwners {
  engineEpoch: string
  assertAvailable(): void
  assertProjectRuntimeOwners(owners: ProjectRuntimeOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageGlobalConfiguration(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
}
const mutation = (op: ProjectRuntimeOperation): boolean => op === 'projectLimits:pauseAll' || op === 'concurrency:setCaptainControl' || op === 'concurrency:pin'
type Row = Record<string, unknown>

/** Bounded adapters reuse the actual database/status/manager algorithms. They
 * select only projection fields, never full tasks or decrypted agent config. */
export class ProjectRuntimeBackend {
  readonly registry: DesktopOperationRegistry
  private readonly owners: ProjectRuntimeOwners
  private closing = false
  private mutationBusy = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly options: ProjectRuntimeBackendOptions) {
    this.owners = Object.freeze({ database: options.database, manager: options.manager, files: options.files, workspaceRoot: options.workspaceRoot })
    if (!(options.manager instanceof AgentManager) || !(options.files instanceof WorkspaceFileOwner)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of PROJECT_RUNTIME_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid project runtime shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(PROJECT_RUNTIME_OPERATIONS.map(operation => [operation, { validatePayload: (v: unknown) => { try { return isJsonValue(v) && PROJECT_RUNTIME_CODECS[operation].validateArguments(PROJECT_RUNTIME_CODECS[operation].decodeArguments(v)) } catch { return false } }, validateResult: PROJECT_RUNTIME_CODECS[operation].validateWireResult, handle: (v: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, v, caller, signal) }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || !this.owners.database.db.open) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertProjectRuntimeOwners(this.owners); this.owners.files.assertOwners(this.owners.workspaceRoot)
  }
  private authorized(caller: DesktopCallerContext, signal?: AbortSignal): void {
    this.available(signal)
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !caller.webviewId || !caller.origin || !this.options.isTrustedDesktop(caller)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private async execute<K extends ProjectRuntimeOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal): Promise<DesktopCommandMap[K]['result']> {
    this.authorized(caller, signal)
    const { database: database, manager, files, workspaceRoot } = this.owners, db = database.db
    const receipts: Array<{ read: () => unknown; value: string }> = []
    const usedProjects = new Map<string, Set<'read' | 'write'>>(), usedAgents = new Map<string, Set<'read' | 'write'>>(), usedTasks = new Set<string>()
    const retainGrant = (map: Map<string, Set<'read' | 'write'>>, id: string, access: 'read' | 'write'): void => { const accesses = map.get(id) ?? new Set<'read' | 'write'>(); accesses.add(access); map.set(id, accesses) }
    const check = (): void => this.authorized(caller, signal)
    const projectGrant = (id: unknown, access: 'read' | 'write' = 'read'): string => { check(); if (!isDatabaseId(id) || !this.options.canAccessProject(id, caller, access)) throw new ServiceProtocolError('INVALID_REQUEST'); if (!usedProjects.has(id) && usedProjects.size >= PROJECT_RUNTIME_LIMITS.projects) throw new ServiceProtocolError('FRAME_TOO_LARGE'); retainGrant(usedProjects, id, access); return id }
    const taskGrant = (id: unknown): string => { check(); if (!isDatabaseId(id) || !this.options.canAccessTask(id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST'); if (!usedTasks.has(id) && usedTasks.size >= PROJECT_RUNTIME_LIMITS.tasks) throw new ServiceProtocolError('FRAME_TOO_LARGE'); usedTasks.add(id); return id }
    const agentGrant = (id: unknown, access: 'read' | 'write' = 'read'): string => { check(); if (!isDatabaseId(id) || !this.options.canAccessAgent(id, caller, access)) throw new ServiceProtocolError('INVALID_REQUEST'); if (!usedAgents.has(id) && usedAgents.size >= PROJECT_RUNTIME_LIMITS.agents) throw new ServiceProtocolError('FRAME_TOO_LARGE'); retainGrant(usedAgents, id, access); return id }
    const capture = <T>(read: () => T): T => { check(); const result = read(); receipts.push({ read, value: JSON.stringify(result) }); return result }
    const rows = (sql: string, params: unknown[], columns: string[], cap: number, bytes: number = PROJECT_RUNTIME_LIMITS.configBytes): Row[] => {
      const read = (): Row[] => {
        check()
        const lengths = columns.map(key => `COALESCE(length(CAST(${key} AS BLOB)),0)`)
        const stats = db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(MAX(${lengths.join(',')}${columns.length === 1 ? ',0' : ''})),0) AS bytes,COALESCE(SUM(${lengths.join('+')}),0) AS total FROM (${sql})`).get(...params) as { count: number; bytes: number; total: number }
        if (stats.count > cap || stats.bytes > bytes || stats.total >= PROJECT_RUNTIME_LIMITS.resultBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
        return db.prepare(sql).all(...params) as Row[]
      }
      return capture(read)
    }
    const setting = (key: string): string | undefined => {
      const value = rows('SELECT value FROM settings WHERE key=?', [key], ['value'], 1, 4096)[0]?.value
      if (value !== undefined && typeof value !== 'string') throw new ServiceProtocolError('INVALID_REQUEST')
      return value === undefined ? undefined : value as string
    }
    const project = (id: string): ReturnType<DatabaseManager['getProject']> => {
      projectGrant(id)
      const row = rows('SELECT id,name,description,settings,default_agent_id,captain_agent_id,archived,sort_order FROM projects WHERE id=?', [id], ['id', 'name', 'description', 'settings', 'default_agent_id', 'captain_agent_id', 'archived', 'sort_order'], 1)[0]
      if (!row) throw new ServiceProtocolError('INVALID_REQUEST')
      let settings: unknown
      try { settings = JSON.parse(row.settings as string) } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
      if (!isRecord(settings) || typeof row.name !== 'string' || typeof row.description !== 'string' || ![0, 1].includes(row.archived as number) || !Number.isSafeInteger(row.sort_order) || Number(row.sort_order) < 0) throw new ServiceProtocolError('INVALID_REQUEST')
      for (const key of ['default_agent_id', 'captain_agent_id']) if (row[key] !== null) agentGrant(row[key])
      if (isRecord(settings.concurrency)) for (const key of ['levels', 'pinned']) {
        const map = settings.concurrency[key]
        if (map !== undefined && (!isRecord(map) || Object.keys(map).length > PROJECT_RUNTIME_LIMITS.agents)) throw new ServiceProtocolError('FRAME_TOO_LARGE')
        if (isRecord(map)) for (const id of Object.keys(map)) agentGrant(id)
      }
      return { ...row, settings, archived: row.archived === 1 } as unknown as ReturnType<DatabaseManager['getProject']>
    }
    const projectIds = (all = false): string[] => rows(`SELECT id FROM projects${all ? '' : ' WHERE archived=0'} ORDER BY sort_order,created_at`, [], ['id'], PROJECT_RUNTIME_LIMITS.projects, 128).map(row => projectGrant(row.id))
    const tasks = (where: string, params: unknown[]): ReturnType<DatabaseManager['getTasks']> => rows(`SELECT id,project_id,status,role,group_id,agent_id,parent_task_id,next_subtask_ids,auto_start_agent,auto_complete_without_review,updated_at,session_id FROM tasks ${where}`, params, ['id', 'project_id', 'status', 'role', 'group_id', 'agent_id', 'parent_task_id', 'next_subtask_ids', 'auto_start_agent', 'auto_complete_without_review', 'updated_at', 'session_id'], PROJECT_RUNTIME_LIMITS.tasks).map(row => {
      taskGrant(row.id); projectGrant(row.project_id)
      if (row.agent_id !== null) agentGrant(row.agent_id)
      if (!['task', 'captain', 'task_group'].includes(row.role as string) || typeof row.status !== 'string' || typeof row.updated_at !== 'string') throw new ServiceProtocolError('INVALID_REQUEST')
      let next: unknown
      try { next = JSON.parse(row.next_subtask_ids as string) } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
      if (!Array.isArray(next) || next.length > PROJECT_RUNTIME_LIMITS.tasks || next.some(id => !isDatabaseId(id))) throw new ServiceProtocolError('INVALID_REQUEST')
      return { ...row, next_subtask_ids: next, auto_start_agent: row.auto_start_agent === 1, auto_complete_without_review: row.auto_complete_without_review === 1 } as unknown as ReturnType<DatabaseManager['getTasks']>[number]
    })
    const agent = (id: string): ReturnType<DatabaseManager['getAgent']> => {
      agentGrant(id)
      // Preflight the ciphertext-bearing config before SQLite JSON extraction;
      // only the actual hard-cap inputs cross into the projection adapter.
      const source = rows('SELECT id,name,length(CAST(config AS BLOB)) AS bytes FROM agents WHERE id=?', [id], ['id', 'name'], 1, 1024)[0]
      if (!source) return undefined
      if (Number(source.bytes) > PROJECT_RUNTIME_LIMITS.configBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      const valid = rows('SELECT json_valid(config) AS valid FROM agents WHERE id=?', [id], ['valid'], 1, 1)[0]
      if (valid?.valid !== 1 || typeof source.name !== 'string') throw new ServiceProtocolError('INVALID_REQUEST')
      const config = rows("SELECT json_extract(config,'$.concurrency_cap') AS concurrency_cap,json_extract(config,'$.max_parallel_sessions') AS max_parallel_sessions FROM agents WHERE id=?", [id], ['concurrency_cap', 'max_parallel_sessions'], 1, 128)[0] ?? {}
      return { id, name: source.name, config } as unknown as ReturnType<DatabaseManager['getAgent']>
    }
    const audit = (id: string, limit: number): ReturnType<DatabaseManager['listConcurrencyAudit']> => {
      projectGrant(id)
      const values = rows('SELECT id,project_id,agent_id,kind,previous_level,level,cap,actor,reason,created_at FROM concurrency_audit WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?', [id, limit], ['id', 'project_id', 'agent_id', 'kind', 'actor', 'reason', 'created_at'], 20, 4096)
      for (const row of values) if (row.agent_id !== '') agentGrant(row.agent_id)
      return values as unknown as ReturnType<DatabaseManager['listConcurrencyAudit']>
    }
    const store: ProjectRuntimeReadStore = {
      getProject: project, getTask: id => tasks('WHERE id=?', [id])[0], getTasks: filters => { if (!filters?.projectId) throw new ServiceProtocolError('INVALID_REQUEST'); projectGrant(filters.projectId); return tasks(`WHERE project_id=?${filters.includeCoordinators ? '' : " AND role NOT IN ('captain','task_group')"} ORDER BY created_at DESC`, [filters.projectId]) }, getSubtasks: id => { taskGrant(id); return tasks('WHERE parent_task_id=? ORDER BY sort_order,created_at', [id]) }, getAgent: agent, getSetting: setting,
      setSetting: () => { throw new ServiceProtocolError('INVALID_REQUEST') }, listConcurrencyAudit: audit
    }
    const recheck = (): void => {
      check()
      for (const [id, accesses] of usedProjects) for (const access of accesses) if (!this.options.canAccessProject(id, caller, access)) throw new ServiceProtocolError('INVALID_REQUEST')
      for (const [id, accesses] of usedAgents) for (const access of accesses) if (!this.options.canAccessAgent(id, caller, access)) throw new ServiceProtocolError('INVALID_REQUEST')
      for (const id of usedTasks) if (!this.options.canAccessTask(id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
      for (const receipt of receipts) if (JSON.stringify(receipt.read()) !== receipt.value) throw new ServiceProtocolError('INVALID_REQUEST')
    }
    const global = (access: 'read' | 'write'): void => { check(); if (!this.options.canManageGlobalConfiguration(caller, access)) throw new ServiceProtocolError('INVALID_REQUEST'); for (const id of projectIds(true)) projectGrant(id, access) }
    const scoped = (): void => {
      if (operation === 'project:getAllStatuses' || operation === 'projectLimits:isAllPaused' || operation === 'projectLimits:pauseAll') global(operation === 'projectLimits:pauseAll' ? 'write' : 'read')
      else { projectGrant(args[0], mutation(operation) ? 'write' : 'read'); project(args[0] as string); if (operation === 'concurrency:pin') { agentGrant(args[1], 'write'); if (!agent(args[1] as string)) throw new ServiceProtocolError('INVALID_REQUEST') } }
    }
    // Global grants cover archived projects too; queue metadata is bounded
    // before the actual queue owner materializes its durable records.
    scoped()
    if (['project:getStatus', 'project:getAllStatuses', 'projectLimits:getState', 'projectLimits:pauseAll', 'concurrency:getState'].includes(operation)) {
      const queueColumns = ['id', 'task_id', 'project_id', 'agent_id', 'workspace_dir', 'skip_initial_prompt', 'priority', 'fifo_seq', 'dependency_reason', 'admission_reason', 'state', 'retry_count', 'next_retry_at', 'generation', 'lease_owner', 'lease_expires_at', 'session_id', 'recovery_cause', 'recovery_action', 'recovery_result', 'last_error', 'created_at', 'queued_at', 'claimed_at', 'started_at', 'acknowledged_at', 'updated_at']
      const queued = rows(`SELECT ${queueColumns.join(',')} FROM agent_start_queue WHERE state IN ('queued','retrying','claimed','starting')`, [], queueColumns, PROJECT_RUNTIME_LIMITS.queue, 8192)
      for (const row of queued) {
        taskGrant(row.task_id); projectGrant(row.project_id); agentGrant(row.agent_id)
        if (!['agent_limit', 'global_limit', 'recovery', 'dependency', 'agent_unavailable', 'project_limit', 'project_daily_cap', 'project_paused', 'global_pause', 'concurrency_level', 'file_overlap'].includes(row.admission_reason as string)) throw new ServiceProtocolError('INVALID_REQUEST')
        for (const key of ['created_at', 'queued_at', 'updated_at', 'next_retry_at', 'lease_expires_at', 'claimed_at', 'started_at', 'acknowledged_at']) if (row[key] !== null && (!Number.isSafeInteger(row[key]) || Math.abs(Number(row[key])) > 8640000000000000)) throw new ServiceProtocolError('INVALID_REQUEST')
      }
      const queue = manager.getStartQueue()
      if (queue.length > PROJECT_RUNTIME_LIMITS.queue) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    }
    const limitState = (id: string): ReturnType<AgentManager['getProjectLimitState']> => {
      const state = manager.getProjectLimitState(id, store)
      return { ...state, queued: state.queued.map(q => ({ taskId: q.taskId, agentId: q.agentId, reason: q.reason, queuedAt: q.queuedAt, position: q.position })) }
    }
    const agents = { getStartQueue: () => { check(); return manager.getStartQueue() }, findSessionByTaskId: (id: string) => { taskGrant(id); return manager.findSessionByTaskId(id, store) }, getSessionStatus: (id: string) => { check(); return manager.getSessionStatus(id) }, getProjectLimitState: limitState }
    const statusStore = { getProjectStatus: (id: string, live?: Parameters<DatabaseManager['getProjectStatus']>[1]) => {
      projectGrant(id); tasks('WHERE project_id=?', [id])
      rows('SELECT summary,top_blockers,updated_at FROM project_status WHERE project_id=?', [id], ['summary', 'top_blockers', 'updated_at'], 1, 8192)
      return database.getProjectStatus(id, live)
    }, getTasks: store.getTasks }
    let result: unknown
    try {
      switch (operation) {
        case 'project:getStatus': result = buildProjectStatus(statusStore, agents, args[0] as string); break
        case 'project:getAllStatuses': result = buildProjectOverview({ ...statusStore, getProjects: () => projectIds().map(id => project(id)!) }, agents); break
        case 'project:getStatusHistory': {
          const id = args[0] as string
          result = readProjectStatusHistory({ listProjectStatusJournal: (projectId, options) => {
            projectGrant(projectId)
            const boundary = options.before, params = boundary ? [projectId, boundary.created_at, boundary.created_at, boundary.id, options.limit + 1] : [projectId, options.limit + 1]
            rows(`SELECT id,project_id,summary,completed,blockers,decisions,next_steps,source,correlation_id,created_at FROM project_status_journal WHERE project_id=?${boundary ? ' AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, params, ['id', 'project_id', 'summary', 'completed', 'blockers', 'decisions', 'next_steps', 'source', 'correlation_id', 'created_at'], 21, 16384)
            return database.listProjectStatusJournal(projectId, options)
          } }, id, (args[1] ?? {}) as { limit?: number; cursor?: string | null }, { summaryChars: 2000, listItems: 16, itemChars: 200, totalChars: 40000 }); break
        }
        case 'project:getCaptainMemory': {
          const id = args[0] as string, captains = rows("SELECT id FROM tasks WHERE project_id=? AND role='captain'", [id], ['id'], 1, 128)
          if (!captains.length) { result = null; break }
          const taskId = taskGrant(captains[0]!.id), scopeReader = new TaskWorkspaceScopeReader({ database, assertAvailable: check, canAccessTask: (...v) => this.options.canAccessTask(...v), canAccessProject: (...v) => this.options.canAccessProject(...v) })
          capture(() => scopeReader.capture(taskId, caller))
          const path = join(workspaceRoot, taskId, CAPTAIN_MEMORY_FILE), memory = await files.readTextPrefix(taskId, path, PROJECT_RUNTIME_LIMITS.memoryBytes, { beforeEffect: () => { scoped(); recheck() }, signal })
          const content = captainTerminology(memory?.content.trim() ?? ''), truncated = memory?.truncated === true || content.length > CAPTAIN_MEMORY_MAX_CHARS
          let prefix = content.slice(0, CAPTAIN_MEMORY_MAX_CHARS)
          if (/[\ud800-\udbff]$/.test(prefix)) prefix = prefix.slice(0, -1)
          result = { path, content: prefix, truncated }; break
        }
        case 'projectLimits:getState': result = limitState(args[0] as string); break
        case 'projectLimits:isAllPaused': setting('all_projects_paused'); result = manager.isAllProjectsPaused(); break
        case 'projectLimits:pauseAll': recheck(); scoped(); manager.pauseAllProjects(args[0] as boolean); receipts.length = 0; result = manager.isAllProjectsPaused(); break
        case 'concurrency:getState': result = manager.getConcurrencyState(args[0] as string, 20, store); break
        case 'concurrency:setCaptainControl': case 'concurrency:pin': {
          const id = args[0] as string
          const writes: ProjectRuntimeMutationStore = { getProject: project, getAgent: agent, getProjects: () => projectIds().map(value => project(value)!), getAgents: () => { throw new ServiceProtocolError('INVALID_REQUEST') }, updateProject: (projectId, updates) => { recheck(); scoped(); const value = database.updateProject(projectId, updates); receipts.length = 0; return value }, appendConcurrencyAudit: data => { scoped(); return database.appendConcurrencyAudit(data) }, appendProjectStatusJournal: (...v) => { scoped(); return database.appendProjectStatusJournal(...v) } }
          recheck(); scoped(); result = manager.setUserConcurrency(id, operation === 'concurrency:pin' ? { agentId: args[1] as string, pinnedLevel: args[2] as number | null } : { captainControl: args[1] as boolean }, undefined, writes); break
        }
      }
      scoped(); recheck()
      const codec = PROJECT_RUNTIME_CODECS[operation] as ProjectRuntimeCodec<K>, encoded = codec.encodeResult(result)
      return codec.decodeResult(encoded.defined ? encoded.value : undefined)
    } catch (error) {
      check()
      if (error instanceof ServiceProtocolError) throw error
      if (error instanceof WorkspaceFileError) {
        if (error.code === 'WORKSPACE_CANCELLED') throw new ServiceProtocolError('CANCELLED')
        if (error.code === 'WORKSPACE_BUSY') throw new ServiceProtocolError('BACKPRESSURE')
        if (['WORKSPACE_PATH_REFUSED', 'WORKSPACE_PATH_CHANGED'].includes(error.code)) throw new ServiceProtocolError('INVALID_REQUEST')
      }
      throw new ServiceProtocolError('INTERNAL_ERROR')
    }
  }
  private bind<K extends ProjectRuntimeOperation>(operation: K): void {
    const codec = PROJECT_RUNTIME_CODECS[operation] as ProjectRuntimeCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: v => codec.decodeArguments(structuredClone(v)), validateArguments: codec.validateArguments, authorize: (_args, caller) => { this.authorized(caller); return true }, invoke: (args, caller, signal) => {
      if (this.flights.size >= PROJECT_RUNTIME_LIMITS.requests || mutation(operation) && this.mutationBusy) throw new ServiceProtocolError('BACKPRESSURE')
      if (mutation(operation)) this.mutationBusy = true
      const controller = new AbortController(), abort = (): void => controller.abort(); this.controllers.add(controller); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      const work = this.execute(operation, args, Object.freeze({ ...caller }), controller.signal).finally(() => { this.controllers.delete(controller); signal.removeEventListener('abort', abort); if (mutation(operation)) this.mutationBusy = false })
      this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work
    }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}

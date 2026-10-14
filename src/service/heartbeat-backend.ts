import type { DatabaseManager } from '../main/database/manager'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentManager } from '../main/agent-manager-core'
import { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import { HeartbeatFileOwner } from '../main/heartbeat-file-owner'
import { HEARTBEAT_CODECS, HEARTBEAT_OPERATIONS, HEARTBEAT_LIMITS, type HeartbeatOperation } from '../shared/heartbeat-codecs'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { projectTaskLifecycleTask } from '../shared/task-lifecycle-codecs'
import { isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import { TaskWorkspaceScopeReader } from './task-workspace-scope'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
export interface HeartbeatTaskAuthority {
  database: DatabaseManager
  manager: AgentManager
  assertAvailable(): void
  canAccessTask(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSkill(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessSecret(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessMcpServer(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessSource?(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessConnector?(id: string, caller: DesktopCallerContext, access: 'read'): boolean
}
export interface HeartbeatBackendOptions extends HeartbeatTaskAuthority {
  heartbeat: HeartbeatSchedulerCore
  files: HeartbeatFileOwner
  workspaceRoot: string
  engineEpoch: string
  assertHeartbeatOwners(owners: Pick<HeartbeatBackendOptions, 'database' | 'manager' | 'heartbeat' | 'files' | 'workspaceRoot'>): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
}
function invalid(): never { throw new ServiceProtocolError('INVALID_REQUEST') }
type Table = 'tasks' | 'projects' | 'agents' | 'skills' | 'secrets' | 'mcp_servers' | 'oauth_tokens' | 'task_sources' | 'connector_instances' | 'project_resources' | 'project_repos' | 'settings' | 'heartbeat_logs'
const scopeBudgets = new AsyncLocalStorage<{ bytes: number; seen: Set<string> }>()
/** Byte lengths are inspected by SQLite before JSON, ciphertext or TaskRecord
 * getters are materialized. This is also used by the immutable system guard. */
function budget(database: DatabaseManager, table: Table, where: string, args: unknown[], limit = 1): void {
  const aggregate = scopeBudgets.getStore(), key = `${table}:${where}:${JSON.stringify(args)}:${limit}`
  if (aggregate?.seen.has(key)) return
  aggregate?.seen.add(key)
  const fields = database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  const lengths = fields.map(field => `COALESCE(length(CAST("${field.name.replaceAll('"', '""')}" AS BLOB)),0)`).join('+')
  if (!lengths) invalid()
  const rows = database.db.prepare(`SELECT ${lengths} AS bytes FROM ${table} WHERE ${where}${table === 'heartbeat_logs' ? ' ORDER BY created_at DESC' : ''} LIMIT ${limit}`).all(...args) as Array<{ bytes: number }>
  let total = 0
  for (const row of rows) { if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > HEARTBEAT_LIMITS.storedBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE'); total += row.bytes }
  if (total > HEARTBEAT_LIMITS.storedBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
  if (aggregate) { aggregate.bytes += total; if (aggregate.bytes > HEARTBEAT_LIMITS.storedBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE') }
}
function ids(value: unknown): string[] {
  let parsed: unknown
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value } catch { invalid() }
  if (!Array.isArray(parsed) || parsed.length > 128 || parsed.some(item => !isDatabaseId(item))) invalid()
  return parsed as string[]
}
function project(options: HeartbeatTaskAuthority, id: string, caller: DesktopCallerContext, access: Access): void {
  if (!isDatabaseId(id) || !options.canAccessProject(id, caller, access)) invalid()
  budget(options.database, 'projects', 'id=?', [id])
  if (!options.database.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) invalid()
}
function capture(options: HeartbeatTaskAuthority, taskId: string, caller: DesktopCallerContext, access: Access, runtime: boolean): string | null {
  return scopeBudgets.run({ bytes: 0, seen: new Set() }, () => captureWithinBudget(options, taskId, caller, access, runtime))
}
function captureWithinBudget(options: HeartbeatTaskAuthority, taskId: string, caller: DesktopCallerContext, access: Access, runtime: boolean): string | null {
  options.assertAvailable()
  if (!isDatabaseId(taskId) || !options.database.db.open || !options.canAccessTask(taskId, caller, access)) invalid()
  budget(options.database, 'tasks', 'id=?', [taskId])
  const task = options.database.db.prepare('SELECT id,project_id,role,group_id,parent_task_id,agent_id,source_id,skill_ids FROM tasks WHERE id=?').get(taskId) as { id: string; project_id: string; role: string; group_id: string | null; parent_task_id: string | null; agent_id: string | null; source_id: string | null; skill_ids: string | null } | undefined
  if (!task) return null
  // The literal workspace scope includes execution anchors/current/former
  // members. It never aliases a member's heartbeat file to the anchor.
  const workspace = new TaskWorkspaceScopeReader(options).capture(taskId, caller)
  for (const row of workspace.tasks) budget(options.database, 'tasks', 'id=?', [row.id])
  project(options, task.project_id, caller, access)
  if (access === 'write' && (task.role !== 'task' || task.group_id !== null)) invalid()
  if (runtime) {
    const repositories = workspace.repositories as Array<{ org: string; name: string }>, requested = JSON.parse(workspace.task.repos) as string[]
    if (requested.some(repo => !repositories.some(saved => `${saved.org}/${saved.name}` === repo))) invalid()
  }
  const refs: unknown[] = [task, { ...workspace, task: { ...workspace.task, session_id: null }, tasks: workspace.tasks.map(row => ({ ...row, session_id: null })) }]
  const loaded = new Set<string>()
  for (const member of workspace.tasks) {
    if (member.agent_id !== null && !options.canAccessAgent(member.agent_id, caller, 'read')) invalid()
    if (member.id === taskId) continue
    const binding = options.database.db.prepare('SELECT id,source_id FROM tasks WHERE id=?').get(member.id) as { id: string; source_id: string | null } | undefined
    if (!binding) invalid(); refs.push(binding)
    if (binding.source_id !== null) {
      if (!isDatabaseId(binding.source_id) || !options.canAccessSource?.(binding.source_id, caller, 'read')) invalid()
      budget(options.database, 'task_sources', 'id=?', [binding.source_id])
      const source = options.database.db.prepare('SELECT id,project_id,mcp_server_id FROM task_sources WHERE id=?').get(binding.source_id) as { project_id: string; mcp_server_id: string | null } | undefined
      if (!source) invalid(); project(options, source.project_id, caller, 'read')
      if (source.mcp_server_id !== null && (!isDatabaseId(source.mcp_server_id) || !options.canAccessMcpServer(source.mcp_server_id, caller, 'read'))) invalid()
      refs.push(source)
    }
  }
  if (task.parent_task_id !== null) {
    if (!isDatabaseId(task.parent_task_id) || !options.canAccessTask(task.parent_task_id, caller, 'read')) invalid()
    budget(options.database, 'tasks', 'id=?', [task.parent_task_id])
    const parent = options.database.db.prepare('SELECT id,project_id,role,group_id FROM tasks WHERE id=?').get(task.parent_task_id) as { project_id: string } | undefined
    if (!parent || parent.project_id !== task.project_id) invalid(); project(options, parent.project_id, caller, 'read'); refs.push(parent)
  }
  const skill = (id: string): void => {
    if (!isDatabaseId(id) || !options.canAccessSkill(id, caller, 'read')) invalid()
    if (loaded.has(`skill:${id}`)) return
    loaded.add(`skill:${id}`)
    budget(options.database, 'skills', 'id=?', [id])
    const row = options.database.db.prepare('SELECT id,project_id,is_deleted,content,version FROM skills WHERE id=?').get(id) as { project_id: string | null; is_deleted: number } | undefined
    if (!row || row.is_deleted || row.project_id !== null && row.project_id !== task.project_id) invalid(); refs.push(row)
  }
  for (const id of ids(task.skill_ids ?? '[]')) skill(id)
  if (task.source_id !== null) {
    if (!isDatabaseId(task.source_id) || !options.canAccessSource?.(task.source_id, caller, 'read')) invalid()
    budget(options.database, 'task_sources', 'id=?', [task.source_id])
    const source = options.database.db.prepare('SELECT id,project_id,plugin_id,mcp_server_id,config,enabled FROM task_sources WHERE id=?').get(task.source_id) as { project_id: string; mcp_server_id: string | null; plugin_id: string; config: string } | undefined
    if (!source) invalid(); project(options, source.project_id, caller, 'read'); refs.push(source)
    if (source.mcp_server_id !== null && (!isDatabaseId(source.mcp_server_id) || !options.canAccessMcpServer(source.mcp_server_id, caller, 'read'))) invalid()
    if (source.mcp_server_id !== null) {
      budget(options.database, 'mcp_servers', 'id=?', [source.mcp_server_id]); budget(options.database, 'oauth_tokens', 'mcp_server_id=?', [source.mcp_server_id], 65)
      const server = options.database.db.prepare('SELECT id,type,command,args,url,headers,environment,tools,oauth_metadata FROM mcp_servers WHERE id=?').get(source.mcp_server_id)
      if (!server) invalid(); refs.push(server); loaded.add(`mcp:${source.mcp_server_id}`)
    }
    if (source.plugin_id === 'connector-bridge') {
      let config: unknown; try { config = JSON.parse(source.config) } catch { invalid() }
      if (!isRecord(config) || !isDatabaseId(config.connector_instance_id) || !options.canAccessConnector?.(config.connector_instance_id, caller, 'read')) invalid()
      budget(options.database, 'connector_instances', 'id=?', [config.connector_instance_id])
      const connector = options.database.db.prepare('SELECT id,piece_name,enabled FROM connector_instances WHERE id=?').get(config.connector_instance_id) as { enabled: number; piece_name: string } | undefined
      if (!connector || connector.enabled !== 1 || connector.piece_name !== config.piece_name) invalid(); refs.push(connector)
    }
  }
  if (!runtime) {
    if (task.agent_id !== null && (!isDatabaseId(task.agent_id) || !options.canAccessAgent(task.agent_id, caller, 'read'))) invalid()
    return JSON.stringify(refs)
  }
  const selected = task.agent_id ?? (options.database.db.prepare('SELECT id FROM agents ORDER BY is_default DESC,created_at ASC,id ASC LIMIT 1').get() as { id: string } | undefined)?.id
  const visited = new Set<string>()
  const agent = (id: string): void => {
    if (!isDatabaseId(id) || visited.size >= 64 || !options.canAccessAgent(id, caller, 'write')) invalid()
    if (visited.has(id)) return; visited.add(id)
    budget(options.database, 'agents', 'id=?', [id])
    const row = options.database.db.prepare('SELECT id,server_url,config FROM agents WHERE id=?').get(id) as { config: string } | undefined
    if (!row) invalid(); refs.push(row)
    let config: unknown; try { config = JSON.parse(row.config) } catch { invalid() }
    if (!isRecord(config)) invalid()
    for (const id of ids(config.skill_ids ?? [])) skill(id)
    for (const id of ids(config.secret_ids ?? [])) {
      if (!options.canAccessSecret(id, caller, 'read')) invalid(); budget(options.database, 'secrets', 'id=?', [id])
      if (loaded.has(`secret:${id}`)) continue
      loaded.add(`secret:${id}`)
      // Exact selected ciphertext is compared privately, without decryption or
      // public projection; a credential rotation invalidates stale monitoring.
      const secret = options.database.db.prepare('SELECT id,env_var_name,updated_at,hex(value) AS ciphertext FROM secrets WHERE id=?').get(id)
      if (!secret) invalid(); refs.push(secret)
    }
    const servers = config.mcp_servers ?? []
    if (!Array.isArray(servers) || servers.length > 128) invalid()
    for (const entry of servers) {
      const id = typeof entry === 'string' ? entry : isRecord(entry) ? entry.serverId : undefined
      if (!isDatabaseId(id) || !options.canAccessMcpServer(id, caller, 'read')) invalid()
      if (loaded.has(`mcp:${id}`)) continue
      loaded.add(`mcp:${id}`)
      budget(options.database, 'mcp_servers', 'id=?', [id]); budget(options.database, 'oauth_tokens', 'mcp_server_id=?', [id], 65)
      const row = options.database.db.prepare('SELECT id,type,command,args,url,headers,environment,tools,oauth_metadata FROM mcp_servers WHERE id=?').get(id)
      if (!row) invalid(); refs.push(row)
    }
    for (const id of ids(config.fallback_agent_ids ?? [])) agent(id)
  }
  if (selected) agent(selected)
  budget(options.database, 'project_resources', 'project_id=?', [task.project_id], 129)
  const resources = options.database.db.prepare('SELECT id,label,url,notes FROM project_resources WHERE project_id=? ORDER BY id LIMIT 129').all(task.project_id)
  if (resources.length > 128) invalid(); refs.push(resources, selected ?? null)
  return JSON.stringify(refs)
}

/** A trusted immutable application callback can use this before periodic or
 * accepted monitoring effects. It borrows no RPC backend/request lifetime. */
export function assertHeartbeatTaskEffects(options: HeartbeatTaskAuthority, taskId: string, caller: DesktopCallerContext): void {
  captureHeartbeatTaskEffects(options, taskId, caller)
}
export function captureHeartbeatTaskEffects(options: HeartbeatTaskAuthority, taskId: string, caller: DesktopCallerContext): string {
  const snapshot = capture(options, taskId, caller, 'write', true)
  if (snapshot === null) invalid()
  return snapshot
}

export class HeartbeatBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly requests = new Set<AbortController>()
  constructor(private readonly options: HeartbeatBackendOptions) {
    this.available()
    if (!(options.heartbeat instanceof HeartbeatSchedulerCore) || !(options.files instanceof HeartbeatFileOwner) || typeof options.manager.withHeartbeatRequestGuard !== 'function') throw new ServiceProtocolError('DISCONNECTED')
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of HEARTBEAT_OPERATIONS) this.bind(operation)
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertHeartbeatOwners(this.options)
    this.options.heartbeat.assertOwners(this.options); this.options.files.assertOwners(this.options.workspaceRoot)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true; for (const request of this.requests) request.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid heartbeat backend shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { while (this.flights.size) await Promise.allSettled([...this.flights]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(HEARTBEAT_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && HEARTBEAT_CODECS[operation].validateArguments(HEARTBEAT_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: HEARTBEAT_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal),
    }]))
  }
  private bind(operation: HeartbeatOperation): void {
    const codec = HEARTBEAT_CODECS[operation], read = ['heartbeat:getLogs', 'heartbeat:getStatus', 'heartbeat:readFile'].includes(operation)
    this.registry.bindCommand(operation, {
      decodeRequest: codec.decodeArguments, validateArguments: codec.validateArguments,
      authorize: (args, caller) => {
        this.available(); const captured = capture(this.options, args[0] as string, caller, read ? 'read' : 'write', !read)
        if (captured !== null && ['heartbeat:enable', 'heartbeat:disable', 'heartbeat:updateInterval'].includes(operation)) projectTaskLifecycleTask(this.options.database.getTask(args[0] as string))
        return true
      },
      validateResult: codec.validateResult, encodeResult: codec.encodeResult,
      invoke: (args, caller, signal) => {
        const taskId = args[0] as string
        const initial = capture(this.options, taskId, caller, read ? 'read' : 'write', !read)
        const request = new AbortController(); this.requests.add(request)
        const cancel = (): void => request.abort(); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
        const current = (): void => {
          this.available(request.signal)
          if (caller.engineEpoch !== this.options.engineEpoch || !this.options.isTrustedDesktop(caller) || caller.principal !== 'trusted-desktop-main') invalid()
          if (capture(this.options, taskId, caller, read ? 'read' : 'write', !read) !== initial) invalid()
        }
        const raw = this.options.heartbeat.withRequestGuard(() => this.options.manager.withHeartbeatRequestGuard(async () => {
          current()
          const db = this.options.database, scheduler = this.options.heartbeat
          if (read) {
            if (operation === 'heartbeat:getLogs') {
              const limit = (args[1] as number | undefined) ?? 20
              budget(db, 'heartbeat_logs', 'task_id=?', [taskId], limit)
              const result = db.getHeartbeatLogs(taskId, limit); current(); return result
            }
            if (operation === 'heartbeat:readFile') { if (initial === null) return null; const result = scheduler.readHeartbeatFile(taskId); current(); return result }
            if (initial === null) return null
            const task = db.getTask(taskId)!; const hasHeartbeatFile = scheduler.hasHeartbeatFile(taskId); current()
            return { enabled: task.heartbeat_enabled, intervalMinutes: task.heartbeat_interval_minutes, lastCheckAt: task.heartbeat_last_check_at, nextCheckAt: task.heartbeat_next_check_at, hasHeartbeatFile }
          }
          if (initial === null) invalid()
          if (operation === 'heartbeat:runNow') return await scheduler.runNow(taskId)
          return await this.options.manager.runTaskLifecycleMutation([taskId], async () => {
            current()
            if (operation === 'heartbeat:writeFile') { scheduler.writeHeartbeatFile(taskId, args[1] as string); current(); return true }
            if (operation === 'heartbeat:disable') scheduler.disableHeartbeat(taskId)
            else scheduler.enableHeartbeat(taskId, args[1] as number | undefined)
            current(); const task = db.getTask(taskId); return task === undefined ? undefined : projectTaskLifecycleTask(task)
          })
        }, current, request.signal), current, request.signal)
        this.flights.add(raw)
        void raw.finally(() => { this.flights.delete(raw); this.requests.delete(request); signal.removeEventListener('abort', cancel) }).catch(() => {})
        return raw as never
      },
    })
  }
}

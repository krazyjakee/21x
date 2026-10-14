import type { DatabaseManager } from '../main/database/manager'
import type { AgentManager } from '../main/agent-manager-core'
import type { SyncManager } from '../main/sync-manager'
import type { PluginRegistry } from '../main/plugins/registry'
import type { OAuthManager } from '../main/oauth/oauth-manager'
import { TaskGroupService } from '../main/task-groups/service'
import { TASK_GROUP_CODECS, TASK_GROUP_OPERATIONS, TASK_GROUP_LIMITS, type TaskGroupCodec, type TaskGroupOperation } from '../shared/task-group-codecs'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { getTaskCompletionAction } from '../shared/task-completion'
import type { CreateTaskGroupData, TaskGroupReviewData } from '../shared/task-groups'
import { isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
type OwnerSet = Pick<TaskGroupBackendOptions, 'database' | 'groups' | 'manager' | 'sync' | 'plugins' | 'oauth'>
export interface TaskGroupBackendOptions {
  database: DatabaseManager
  groups: TaskGroupService
  manager: AgentManager
  sync: SyncManager
  plugins: PluginRegistry
  oauth: OAuthManager
  engineEpoch: string
  assertAvailable(): void
  assertTaskGroupOwners(owners: OwnerSet): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSkill(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessSecret(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessMcpServer(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessConnector(id: string, caller: DesktopCallerContext, access: Access): boolean
  canUseSourcePlugin(id: string, caller: DesktopCallerContext, operation: 'plugin:executeAction'): boolean
}
type Table = 'tasks' | 'task_groups' | 'task_group_memberships' | 'projects' | 'agents' | 'skills' | 'secrets' | 'oauth_tokens' | 'connector_instances' | 'mcp_servers' | 'task_sources' | 'project_repos' | 'project_resources'
interface Budget { bytes: number; seen: Set<string> }
interface TaskBinding { id: string; project_id: string; role: string; agent_id: string | null; source_id: string | null; external_id: string | null; repos: string; skill_ids: string | null; parent_task_id: string | null; group_id: string | null }
interface GroupBinding { id: string; project_id: string; agent_id: string; execution_task_id: string; state: string; task_ids: string[]; former_task_ids: string[] }
interface Scope { tasks: Map<string, string>; grants: Map<string, Access>; resources: Map<string, string>; groups: GroupBinding[]; selectedAgent?: string }
function invalid(): never { throw new ServiceProtocolError('INVALID_REQUEST') }

/** Nine finite controls borrow the actual group/session/source owners. Each
 * nested effect shares current caller guards, never a synthetic CRUD writer. */
export class TaskGroupBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly requests = new Set<AbortController>()
  constructor(private readonly options: TaskGroupBackendOptions) {
    this.available()
    if (!(options.groups instanceof TaskGroupService) || typeof options.manager.withTaskGroupRequestGuard !== 'function') throw new ServiceProtocolError('DISCONNECTED')
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of TASK_GROUP_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true; for (const request of this.requests) request.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid task-group backend shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { while (this.flights.size) await Promise.allSettled([...this.flights]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(TASK_GROUP_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && TASK_GROUP_CODECS[operation].validateArguments(TASK_GROUP_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: TASK_GROUP_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal),
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertTaskGroupOwners(this.options)
    this.options.groups.assertOwners({ database: this.options.database, manager: this.options.manager, sync: this.options.sync })
    this.options.sync.assertOwners(this.options.database, this.options.plugins, this.options.oauth)
  }
  private retain<T>(raw: Promise<T>): Promise<T> {
    this.flights.add(raw); void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw)); return raw
  }
  /** Scalar lengths precede getters, JSON.parse, ciphertext materialization or
   * potentially huge legacy rows; stored bytes are untouched on refusal. */
  private budget(budget: Budget, table: Table, where: string, parameters: unknown[], limit = 1): void {
    const key = `${table}:${where}:${JSON.stringify(parameters)}`
    if (budget.seen.has(key)) return
    budget.seen.add(key)
    const fields = this.options.database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    const sum = fields.map(field => `COALESCE(length(CAST("${field.name.replaceAll('"', '""')}" AS BLOB)),0)`).join('+')
    const rows = this.options.database.db.prepare(`SELECT ${sum} AS bytes FROM ${table} WHERE ${where} LIMIT ${limit}`).all(...parameters) as Array<{ bytes: number }>
    if (table === 'oauth_tokens' && rows.length >= 65) throw new ServiceProtocolError('INVALID_RESULT')
    for (const row of rows) {
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > TASK_GROUP_LIMITS.storedBytes) throw new ServiceProtocolError('INVALID_RESULT')
      budget.bytes += row.bytes
    }
    if (budget.bytes > TASK_GROUP_LIMITS.storedBytes) throw new ServiceProtocolError('INVALID_RESULT')
  }
  private strings(value: string | null, max = 128): string[] {
    let parsed: unknown
    try { parsed = value === null ? [] : JSON.parse(value) } catch { invalid() }
    if (!Array.isArray(parsed) || parsed.length > max || parsed.some(item => typeof item !== 'string' || !item || Buffer.byteLength(item) > 512 || /[\u0000-\u001f\u007f]/.test(item))) return invalid()
    return parsed
  }
  private project(id: string, caller: DesktopCallerContext, access: Access, budget: Budget): void {
    if (!isDatabaseId(id) || !this.options.canAccessProject(id, caller, access)) invalid()
    this.budget(budget, 'projects', 'id=?', [id])
    if (!this.options.database.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) invalid()
  }
  private skill(id: string, projectId: string, caller: DesktopCallerContext, budget: Budget, scope: Scope): void {
    if (!isDatabaseId(id) || !this.options.canAccessSkill(id, caller, 'read')) invalid()
    this.budget(budget, 'skills', 'id=?', [id])
    const row = this.options.database.db.prepare('SELECT id,project_id,is_deleted,content,version FROM skills WHERE id=?').get(id) as { project_id: string | null; is_deleted: number } | undefined
    if (!row || row.is_deleted || row.project_id !== null && row.project_id !== projectId) invalid()
    scope.resources.set(`skill:${id}`, JSON.stringify(row))
  }
  private task(id: string, caller: DesktopCallerContext, access: Access, budget: Budget, scope: Scope, required = true): TaskBinding | null {
    if (!isDatabaseId(id) || !this.options.canAccessTask(id, caller, access)) invalid()
    if (!scope.grants.has(id) || access === 'write') scope.grants.set(id, access)
    this.budget(budget, 'tasks', 'id=?', [id])
    const row = this.options.database.db.prepare('SELECT id,project_id,role,agent_id,source_id,external_id,repos,skill_ids,parent_task_id,group_id FROM tasks WHERE id=?').get(id) as TaskBinding | undefined
    if (!row) { if (required) invalid(); return null }
    this.project(row.project_id, caller, access, budget)
    if (!['task', 'captain', 'task_group'].includes(row.role) || row.agent_id !== null && !isDatabaseId(row.agent_id) || row.source_id !== null && !isDatabaseId(row.source_id) || row.parent_task_id !== null && !isDatabaseId(row.parent_task_id) || row.group_id !== null && !isDatabaseId(row.group_id) || row.external_id !== null && (typeof row.external_id !== 'string' || row.external_id.length > 512)) invalid()
    scope.tasks.set(id, JSON.stringify({ ...row, group_id: null }))
    for (const skill of this.strings(row.skill_ids)) this.skill(skill, row.project_id, caller, budget, scope)
    if (row.agent_id && !this.options.canAccessAgent(row.agent_id, caller, access)) invalid()
    if (row.source_id) {
      if (!this.options.canAccessSource(row.source_id, caller, 'read')) invalid()
      const source = this.options.database.db.prepare(`SELECT
        CASE WHEN length(CAST(project_id AS BLOB))<=128 THEN project_id ELSE NULL END AS project_id,
        CASE WHEN mcp_server_id IS NULL OR length(CAST(mcp_server_id AS BLOB))<=128 THEN mcp_server_id ELSE '' END AS mcp_server_id
        FROM task_sources WHERE id=?`).get(row.source_id) as { project_id: string; mcp_server_id: string | null } | undefined
      if (!source) invalid()
      this.project(source.project_id, caller, 'read', budget)
      if (source.mcp_server_id !== null && (!isDatabaseId(source.mcp_server_id) || !this.options.canAccessMcpServer(source.mcp_server_id, caller, 'read'))) invalid()
      scope.resources.set(`source-ref:${row.source_id}`, JSON.stringify(source))
    }
    const repos = this.strings(row.repos)
    this.budget(budget, 'project_repos', 'project_id=?', [row.project_id], 129)
    const available = this.options.database.db.prepare('SELECT id,provider,org,name,default_branch FROM project_repos WHERE project_id=? ORDER BY id LIMIT 129').all(row.project_id) as Array<{ org: string; name: string }>
    if (available.length > 128 || access === 'write' && repos.some(repo => !available.some(item => `${item.org}/${item.name}` === repo))) invalid()
    scope.resources.set(`repos:${row.project_id}`, JSON.stringify(available))
    return row
  }
  private agent(id: string, projectId: string, caller: DesktopCallerContext, access: Access, runtime: boolean, budget: Budget, scope: Scope, seen = new Set<string>()): void {
    if (seen.has(id)) return
    if (!isDatabaseId(id) || seen.size >= 64 || !this.options.canAccessAgent(id, caller, access)) invalid()
    seen.add(id); this.budget(budget, 'agents', 'id=?', [id])
    const row = this.options.database.db.prepare('SELECT id,server_url,config FROM agents WHERE id=?').get(id) as { config: string } | undefined
    if (!row) invalid()
    if (!runtime) return
    scope.resources.set(`agent:${id}`, JSON.stringify(row))
    let config: unknown
    try { config = JSON.parse(row.config) } catch { invalid() }
    if (!isRecord(config)) invalid()
    for (const skill of this.strings(JSON.stringify(config.skill_ids ?? []))) this.skill(skill, projectId, caller, budget, scope)
    for (const secret of this.strings(JSON.stringify(config.secret_ids ?? []))) {
      if (!isDatabaseId(secret) || !this.options.canAccessSecret(secret, caller, 'read') || !this.options.database.db.prepare('SELECT 1 FROM secrets WHERE id=?').get(secret)) invalid()
      this.budget(budget, 'secrets', 'id=?', [secret])
    }
    const servers = config.mcp_servers ?? []
    if (!Array.isArray(servers) || servers.length > 128) invalid()
    for (const entry of servers) {
      const server = typeof entry === 'string' ? entry : isRecord(entry) ? entry.serverId : undefined
      if (!isDatabaseId(server) || !this.options.canAccessMcpServer(server, caller, 'read')) invalid()
      this.budget(budget, 'mcp_servers', 'id=?', [server])
      this.budget(budget, 'oauth_tokens', 'mcp_server_id=?', [server], 65)
      const stored = this.options.database.db.prepare('SELECT id,type,command,args,url,headers,environment,oauth_metadata,tools FROM mcp_servers WHERE id=?').get(server)
      if (!stored) invalid(); scope.resources.set(`mcp:${server}`, JSON.stringify(stored))
    }
    for (const fallback of this.strings(JSON.stringify(config.fallback_agent_ids ?? []))) this.agent(fallback, projectId, caller, access, true, budget, scope, seen)
    this.budget(budget, 'project_resources', 'project_id=?', [projectId], 129)
    const resources = this.options.database.db.prepare('SELECT id,label,url,notes FROM project_resources WHERE project_id=? ORDER BY id LIMIT 129').all(projectId)
    if (resources.length > 128) invalid(); scope.resources.set(`resources:${projectId}`, JSON.stringify(resources))
  }
  private source(task: TaskBinding, caller: DesktopCallerContext, budget: Budget, scope: Scope): void {
    if (!task.source_id || !task.external_id || !this.options.canAccessSource(task.source_id, caller, 'write')) invalid()
    this.budget(budget, 'task_sources', 'id=?', [task.source_id])
    const row = this.options.database.db.prepare('SELECT id,project_id,plugin_id,mcp_server_id,config,list_tool,list_tool_args,update_tool,update_tool_args,enabled FROM task_sources WHERE id=?').get(task.source_id) as { project_id: string; plugin_id: string; mcp_server_id: string | null; config: string } | undefined
    if (!row || !this.options.canUseSourcePlugin(row.plugin_id, caller, 'plugin:executeAction')) invalid()
    this.project(row.project_id, caller, 'write', budget)
    if (row.mcp_server_id && (!isDatabaseId(row.mcp_server_id) || !this.options.canAccessMcpServer(row.mcp_server_id, caller, 'read'))) invalid()
    this.budget(budget, 'oauth_tokens', 'source_id=?', [task.source_id], 65)
    if (row.mcp_server_id) {
      this.budget(budget, 'mcp_servers', 'id=?', [row.mcp_server_id])
      this.budget(budget, 'oauth_tokens', 'mcp_server_id=?', [row.mcp_server_id], 65)
      const mcp = this.options.database.db.prepare('SELECT id,type,command,args,url,headers,environment,oauth_metadata,tools FROM mcp_servers WHERE id=?').get(row.mcp_server_id)
      if (!mcp) invalid(); scope.resources.set(`mcp:${row.mcp_server_id}`, JSON.stringify(mcp))
    }
    let config: unknown
    try { config = JSON.parse(row.config) } catch { invalid() }
    if (!isRecord(config)) invalid()
    if (row.plugin_id === 'connector-bridge') {
      if (!isDatabaseId(config.connector_instance_id) || !this.options.canAccessConnector(config.connector_instance_id, caller, 'write')) invalid()
      this.budget(budget, 'connector_instances', 'id=?', [config.connector_instance_id])
      const connector = this.options.database.db.prepare('SELECT piece_name,piece_version,enabled,config,auth_type FROM connector_instances WHERE id=?').get(config.connector_instance_id) as { piece_name: string; enabled: number } | undefined
      if (!connector || connector.enabled !== 1 || connector.piece_name !== config.piece_name) invalid()
      scope.resources.set(`connector:${config.connector_instance_id}`, JSON.stringify(connector))
    }
    const plugin = this.options.plugins.get(row.plugin_id)
    if (!plugin) invalid()
    // Borrow only this authorized source's real decoded config for its actual
    // capability metadata; credentials never enter public group projections.
    const saved = this.options.database.getTaskSource(task.source_id)
    const output = this.options.database.db.prepare('SELECT output_fields FROM tasks WHERE id=?').get(task.id) as { output_fields: string }
    let fields: unknown
    try { fields = JSON.parse(output.output_fields) } catch { invalid() }
    if (!Array.isArray(fields) || fields.length > 128 || !saved) invalid()
    const action = getTaskCompletionAction(fields), actions = plugin.getActions(saved.config)
    if (!Array.isArray(actions) || actions.length > 64 || !actions.some(item => item.id === action && !item.requiresInput)) invalid()
    scope.resources.set(`source:${task.source_id}`, JSON.stringify(row))
  }
  private group(id: string, caller: DesktopCallerContext, access: Access, runtime: boolean, budget: Budget, scope: Scope): GroupBinding {
    if (!isDatabaseId(id)) invalid()
    this.budget(budget, 'task_groups', 'id=?', [id])
    this.budget(budget, 'task_group_memberships', 'group_id=?', [id], 129)
    const row = this.options.database.db.prepare('SELECT id,project_id,agent_id,execution_task_id,state FROM task_groups WHERE id=?').get(id) as Omit<GroupBinding, 'task_ids' | 'former_task_ids'> | undefined
    if (!row || !['active', 'dissolved'].includes(row.state)) invalid()
    this.project(row.project_id, caller, access, budget)
    const memberships = this.options.database.db.prepare('SELECT id,task_id,position,left_at FROM task_group_memberships WHERE group_id=? ORDER BY position,joined_at,id LIMIT 129').all(id) as Array<{ id: string; task_id: string; position: number; left_at: string | null }>
    if (memberships.length > 128 || memberships.some(item => !isDatabaseId(item.id) || !isDatabaseId(item.task_id) || !Number.isSafeInteger(item.position) || item.position < 0)) invalid()
    const current = memberships.filter(item => item.left_at === null).map(item => item.task_id)
    if (current.length > 10 || new Set(current).size !== current.length) invalid()
    const former = [...new Set(memberships.filter(item => item.left_at !== null && !current.includes(item.task_id)).map(item => item.task_id))]
    const anchor = this.task(row.execution_task_id, caller, access, budget, scope)
    if (!anchor || anchor.role !== 'task_group' || anchor.project_id !== row.project_id || anchor.agent_id !== row.agent_id || anchor.group_id !== row.id) invalid()
    for (const member of current) { const task = this.task(member, caller, access, budget, scope); if (!task || task.role !== 'task' || task.project_id !== row.project_id || task.group_id !== row.id) invalid() }
    for (const member of former) { const task = this.task(member, caller, 'read', budget, scope, false); if (task && task.project_id !== row.project_id) invalid() }
    this.agent(row.agent_id, row.project_id, caller, access, runtime, budget, scope)
    const group = { ...row, task_ids: current, former_task_ids: former }; scope.groups.push(group); return group
  }
  private scope(operation: TaskGroupOperation, args: readonly unknown[], caller: DesktopCallerContext): Scope {
    const access: Access = ['taskGroups:list', 'taskGroups:get', 'taskGroups:history'].includes(operation) ? 'read' : 'write'
    const runtime = operation === 'taskGroups:move' && args[1] === 'agent_working' || operation === 'taskGroups:review' && (args[0] as TaskGroupReviewData).action === 'send_back'
    const scope: Scope = { tasks: new Map(), grants: new Map(), resources: new Map(), groups: [] }, budget: Budget = { bytes: 0, seen: new Set() }, db = this.options.database.db
    if (operation === 'taskGroups:create') {
      const data = args[0] as CreateTaskGroupData, tasks = data.task_ids.map(id => this.task(id, caller, 'write', budget, scope)!)
      if (tasks.some(task => task.project_id !== tasks[0].project_id || task.role !== 'task')) invalid()
      this.budget(budget, 'projects', 'id=?', [tasks[0].project_id])
      const project = db.prepare('SELECT default_agent_id FROM projects WHERE id=?').get(tasks[0].project_id) as { default_agent_id: string | null }
      const setting = db.prepare("SELECT CASE WHEN length(CAST(value AS BLOB))<=128 THEN value ELSE NULL END AS value FROM settings WHERE key='default_agent_id'").get() as { value: string } | undefined
      const selected = data.agent_id ?? tasks[0].agent_id ?? project.default_agent_id ?? setting?.value ?? (db.prepare('SELECT id FROM agents ORDER BY is_default DESC,created_at ASC LIMIT 1').get() as { id: string } | undefined)?.id
      if (!selected) invalid(); this.agent(selected, tasks[0].project_id, caller, 'write', false, budget, scope); scope.selectedAgent = selected
      const estimate = db.prepare(`SELECT COALESCE(SUM(length(CAST(title AS BLOB))+length(CAST(description AS BLOB))),0)+COALESCE(MAX(length(CAST(repos AS BLOB))+length(CAST(skill_ids AS BLOB))),0)+10000 AS bytes FROM tasks WHERE id IN (${data.task_ids.map(() => '?').join(',')})`).get(...data.task_ids) as { bytes: number }
      if (budget.bytes + estimate.bytes > TASK_GROUP_LIMITS.storedBytes) throw new ServiceProtocolError('INVALID_RESULT')
      return scope
    }
    if (operation === 'taskGroups:list' || operation === 'taskGroups:history') {
      const requested = args[0] as string
      if (operation === 'taskGroups:list') this.project(requested, caller, 'read', budget)
      else this.task(requested, caller, 'read', budget, scope)
      const where = operation === 'taskGroups:list' ? `project_id=? ${args[1] ? '' : "AND state='active'"}` : 'execution_task_id=? OR id IN (SELECT group_id FROM task_group_memberships WHERE task_id=?)'
      const params = operation === 'taskGroups:list' ? [requested] : [requested, requested]
      this.budget(budget, 'task_groups', where, params, 257)
      const rows = db.prepare(`SELECT id FROM task_groups WHERE ${where} ORDER BY created_at,id LIMIT 257`).all(...params) as Array<{ id: string }>
      if (rows.length > 256) throw new ServiceProtocolError('INVALID_RESULT')
      for (const row of rows) this.group(row.id, caller, 'read', false, budget, scope)
      return scope
    }
    const review = operation === 'taskGroups:review' ? args[0] as TaskGroupReviewData : null
    const group = this.group(review?.group_id ?? args[0] as string, caller, access, runtime, budget, scope)
    if (operation === 'taskGroups:add') {
      for (const id of args[1] as string[]) this.task(id, caller, 'write', budget, scope)
      const additions = (args[1] as string[]).filter(id => !group.task_ids.includes(id))
      if (additions.length) {
        const delta = db.prepare(`SELECT COALESCE(SUM(length(CAST(title AS BLOB))+length(CAST(description AS BLOB))+COALESCE(length(CAST(skill_ids AS BLOB)),0)),0)+1024 AS bytes FROM tasks WHERE id IN (${additions.map(() => '?').join(',')})`).get(...additions) as { bytes: number }
        if (budget.bytes + delta.bytes > TASK_GROUP_LIMITS.storedBytes) throw new ServiceProtocolError('INVALID_RESULT')
      }
    }
    if (operation === 'taskGroups:remove') this.task(args[1] as string, caller, 'write', budget, scope)
    if (review?.task_ids) for (const id of review.task_ids) if (!group.task_ids.includes(id)) invalid()
    if (operation === 'taskGroups:move' && args[1] === 'completed' || review?.action === 'approve' && review.complete_at_source !== false) {
      for (const id of review?.task_ids ?? group.task_ids) {
        const task = this.task(id, caller, 'write', budget, scope)!
        const status = db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: string }
        if (task.source_id && status.status !== 'completed') this.source(task, caller, budget, scope)
      }
    }
    return scope
  }
  private consistent(initial: Scope, current: Scope, operation: TaskGroupOperation, args: readonly unknown[], caller: DesktopCallerContext): void {
    for (const [id, access] of initial.grants) {
      if (!this.options.canAccessTask(id, caller, access)) invalid()
      const task = initial.tasks.get(id)
      if (task) {
        const row = JSON.parse(task) as TaskBinding
        if (!this.options.canAccessProject(row.project_id, caller, access) || row.agent_id && !this.options.canAccessAgent(row.agent_id, caller, access)) invalid()
      }
    }
    for (const [id, value] of initial.tasks) {
      if (current.tasks.get(id) === value) continue
      const group = initial.groups.find(group => group.execution_task_id === id), found = group && current.groups.find(item => item.id === group.id)
      if (!group || !found || !['taskGroups:add', 'taskGroups:remove'].includes(operation) || !found.task_ids.length) invalid()
      const original = JSON.parse(value) as TaskBinding, changed = JSON.parse(current.tasks.get(id) ?? 'null') as TaskBinding | null
      if (!changed || JSON.stringify({ ...original, skill_ids: null }) !== JSON.stringify({ ...changed, skill_ids: null })) invalid()
      const expected = [...new Set(found.task_ids.flatMap(taskId => this.strings((JSON.parse(current.tasks.get(taskId)!) as TaskBinding).skill_ids)))].sort()
      if (JSON.stringify(expected) !== JSON.stringify([...new Set(this.strings(changed.skill_ids))].sort())) invalid()
    }
    // Completed members no longer require a new source effect, but accepted
    // source effects keep their original exact authority until the call drains.
    const sourceBudget: Budget = { bytes: 0, seen: new Set() }
    for (const [key] of initial.resources) if (key.startsWith('source:') && !current.resources.has(key)) {
      const task = [...initial.tasks.values()].map(value => JSON.parse(value) as TaskBinding).find(task => `source:${task.source_id}` === key)
      if (!task) invalid(); this.source(task, caller, sourceBudget, current)
    }
    for (const [id, value] of initial.resources) if (current.resources.get(id) !== value) invalid()
    if (initial.selectedAgent !== current.selectedAgent) invalid()
    for (const group of initial.groups) {
      const found = current.groups.find(item => item.id === group.id)
      if (!found || found.execution_task_id !== group.execution_task_id || found.agent_id !== group.agent_id || found.project_id !== group.project_id) invalid()
      let next = group.task_ids
      if (operation === 'taskGroups:add') next = [...next, ...args[1] as string[]]
      if (operation === 'taskGroups:remove') next = next.filter(id => id !== args[1])
      if (operation === 'taskGroups:dissolve') next = []
      const same = (a: string[], b: string[]) => [...a].sort().join('\0') === [...b].sort().join('\0')
      if (!same(found.task_ids, group.task_ids) && !same(found.task_ids, next)) invalid()
    }
  }
  private async effect(operation: TaskGroupOperation, args: readonly unknown[], initial: Scope): Promise<unknown> {
    const groups = this.options.groups
    switch (operation) {
      case 'taskGroups:list': return groups.list(args[0] as string, args[1] as boolean | undefined)
      case 'taskGroups:get': return groups.get(args[0] as string)
      case 'taskGroups:history': return groups.history(args[0] as string)
      case 'taskGroups:create': return groups.create({ ...args[0] as CreateTaskGroupData, agent_id: initial.selectedAgent })
      case 'taskGroups:add': return groups.add(args[0] as string, args[1] as string[])
      case 'taskGroups:remove': return groups.remove(args[0] as string, args[1] as string)
      case 'taskGroups:dissolve': return groups.dissolve(args[0] as string)
      case 'taskGroups:move': return groups.move(args[0] as string, args[1] as string)
      case 'taskGroups:review': return groups.review(args[0] as TaskGroupReviewData)
    }
  }
  private bind<K extends TaskGroupOperation>(operation: K): void {
    const codec = TASK_GROUP_CODECS[operation] as TaskGroupCodec<K>
    const scoped = (args: readonly unknown[], caller: DesktopCallerContext) => this.options.database.db.transaction(() => this.scope(operation, args, caller))()
    this.registry.bindCommand(operation, { decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); scoped(args, caller); return true },
      invoke: (args, caller, signal) => {
        if (this.flights.size >= 16) throw new ServiceProtocolError('BACKPRESSURE')
        const controller = new AbortController(), cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
        this.requests.add(controller)
        const raw = (async () => {
          try {
            this.available(controller.signal); const initial = scoped(args, caller)
            const beforeEffect = () => { this.available(controller.signal); this.consistent(initial, scoped(args, caller), operation, args, caller) }
            const result = await this.options.manager.withTaskGroupRequestGuard(() => this.options.groups.withRequestGuard(() => this.effect(operation, args, initial), beforeEffect, controller.signal), beforeEffect, controller.signal)
            beforeEffect()
            if (operation === 'taskGroups:create') {
              if (!isRecord(result) || !isDatabaseId(result.id)) invalid()
              const finalScope: Scope = { tasks: new Map(), grants: new Map(), resources: new Map(), groups: [] }
              const group = this.group(result.id, caller, 'write', false, { bytes: 0, seen: new Set() }, finalScope)
              if (group.agent_id !== initial.selectedAgent || JSON.stringify([...group.task_ids].sort()) !== JSON.stringify([...(args[0] as CreateTaskGroupData).task_ids].sort())) invalid()
            }
            const wire = codec.encodeResult(result); return codec.decodeResult(wire.defined ? wire.value : undefined)
          } catch (cause) {
            this.available(controller.signal)
            if (cause instanceof ServiceProtocolError) throw cause
            throw new ServiceProtocolError('INVALID_REQUEST')
          } finally { signal.removeEventListener('abort', cancel); this.requests.delete(controller) }
        })()
        return this.retain(raw)
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}

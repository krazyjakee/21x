import type { DatabaseManager } from '../main/database/manager'
import { ClaudePluginManager } from '../main/claude-plugin-manager'
import type { AgentManager } from '../main/agent-manager-core'
import { SourceMutationBusyError, type SyncManager } from '../main/sync-manager'
import type { MarketplaceSourceRecord, ClaudePluginSource, ClaudePluginManifest, CreateSkillData, CreateAgentData, CreateMcpServerData } from '../main/database/types'
import { isMcpData } from '../shared/mcp-codecs'
import type { PluginResourcePlan } from '../main/claude-plugins/resources'
import { pluginSkills, pluginMcpServers, pluginAgents } from '../main/claude-plugins/resources'
import { CLAUDE_PLUGIN_CODECS, CLAUDE_PLUGIN_OPERATIONS, CLAUDE_PLUGIN_LIMITS, pluginName, type ClaudePluginCodec, type ClaudePluginOperation } from '../shared/claude-plugin-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
interface ResourceIds { agentIds: string[]; mcpServerIds: string[]; skillIds: string[] }
export interface ClaudePluginOwners { database: DatabaseManager; manager: ClaudePluginManager; agents: AgentManager; sync: SyncManager }
export interface ClaudePluginBackendOptions extends ClaudePluginOwners {
  engineEpoch: string
  /** Actual production owner may compose Chat/Commander/provider/scheduler fences. */
  runPluginMutation?<T>(resources: ResourceIds, mutation: () => T | Promise<T>): Promise<T>
  assertAvailable(): void
  assertPluginOwners(owners: ClaudePluginOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageConfiguration(caller: DesktopCallerContext, access: Access): boolean
  canAccessMarketplace(id: string, caller: DesktopCallerContext, access: Access | 'delete'): boolean
  canCreateMarketplace(data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }, caller: DesktopCallerContext): boolean
  canAccessPluginName(name: string, marketplaceId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessPlugin(id: string, caller: DesktopCallerContext, access: Access | 'delete'): boolean
  canUsePluginAddress(address: string, caller: DesktopCallerContext): boolean
  canUseMarketplaceSource(source: MarketplaceSourceRecord, caller: DesktopCallerContext): boolean
  canUsePluginSource(source: ClaudePluginSource | string, marketplace: MarketplaceSourceRecord, pluginRoot: string | undefined, caller: DesktopCallerContext): boolean
  canAccessSkill(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessMcpServer(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
  canManageGlobalSkills(caller: DesktopCallerContext, access: Access): boolean
  canCreateGlobalSkill(data: CreateSkillData, caller: DesktopCallerContext): boolean
  canCreateAgent(data: CreateAgentData, caller: DesktopCallerContext): boolean
  canCreateMcpServer(data: CreateMcpServerData, caller: DesktopCallerContext): boolean
  emit(operation: 'tasks:refresh', payload: JsonValue): void
  onFatalEvent(error: ServiceProtocolError): void
}
const reservedEnvironment = /^(?:PATH|HOME|SHELL|BASH_ENV|ENV|IFS|CDPATH|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|ELECTRON_.*|TASK_API_.*|TASK_MCP_.*|21X_.*|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|CODEX_HOME|CODEX_CONFIG_HOME|PI_CODING_AGENT_DIR|CLAUDE_CONFIG_DIR)$/i

/** Finite production controls on the actual shared plugin/lifecycle owners.
 * Resource plans are private trusted callbacks, never renderer permissions. */
export class ClaudePluginBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private failed = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly sourceReads = new Map<string, Set<Promise<unknown>>>()
  private readonly changingSources = new Set<string>()
  private readonly changingNames = new Set<string>()
  constructor(private readonly options: ClaudePluginBackendOptions) {
    this.available()
    if (!(options.manager instanceof ClaudePluginManager) || typeof options.manager.getCatalogEntry !== 'function' || typeof options.agents.runPluginConfigurationMutation !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.registry.bindEvent('tasks:refresh', { validatePayload: value => isJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0, encodePayload: () => ({}) })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true }
  /** Root stops manager/network owners concurrently. Failed drain retains raw
   * acquisition, DB/credential/provider and private filesystem ownership. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid plugin backend shutdown deadline')
    this.shutdown()
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(CLAUDE_PLUGIN_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && CLAUDE_PLUGIN_CODECS[operation].validateArguments(CLAUDE_PLUGIN_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: CLAUDE_PLUGIN_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || this.failed) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertPluginOwners(this.options); this.options.manager.assertSource(this.options.database)
  }
  private retain<T>(work: Promise<T>): Promise<T> { this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work }
  private global(caller: DesktopCallerContext, access: Access): boolean { return !!caller.webviewId && !!caller.origin && this.options.canManageConfiguration(caller, 'read') && this.options.canManageConfiguration(caller, access) }
  /** Literal tables/columns only; inspect lengths before legacy JSON getters. */
  private rows(table: string, fields: string[], maximum: number, fieldBytes: number, totalBytes: number): void {
    const sums = fields.map(field => `COALESCE(length(CAST(${field} AS BLOB)),0)`)
    const stats = this.options.database.db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(MAX(${sums.join(',')})),0) AS field, COALESCE(SUM(${sums.join('+')}),0) AS bytes FROM ${table}`).get() as { count: number; field: number; bytes: number }
    if (stats.count > maximum || stats.field > fieldBytes || stats.bytes > totalBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
  }
  private preflight(): void {
    this.rows('marketplace_sources', ['id', 'name', 'source_type', 'source_url', 'metadata', 'created_at', 'updated_at'], CLAUDE_PLUGIN_LIMITS.rows, 128 * 1024, 2 * 1024 * 1024)
    this.rows('installed_plugins', ['id', 'name', 'marketplace_id', 'manifest', 'source', 'scope', 'version', 'installed_at', 'updated_at'], CLAUDE_PLUGIN_LIMITS.rows, 1024 * 1024, 8 * 1024 * 1024)
  }
  private resourcePreflight(): void {
    this.rows('skills', ['id', 'name', 'description', 'content', 'tags', 'project_id'], 512, 1024 * 1024, 16 * 1024 * 1024)
    this.rows('mcp_servers', ['id', 'name', 'command', 'args', 'headers', 'environment', 'tools', 'oauth_metadata', 'url'], 256, 256 * 1024, 8 * 1024 * 1024)
    this.rows('agents', ['id', 'name', 'server_url', 'config'], 256, 1024 * 1024, 16 * 1024 * 1024)
  }
  private marketplace(id: string): MarketplaceSourceRecord | undefined { this.preflight(); return this.options.database.getMarketplaceSource(id) }
  private marketplaceAllowed(id: string, caller: DesktopCallerContext, access: Access | 'delete', transport = false): boolean {
    if (!this.global(caller, access === 'read' ? 'read' : 'write') || !this.options.canAccessMarketplace(id, caller, 'read') || !this.options.canAccessMarketplace(id, caller, access)) return false
    const source = this.marketplace(id)
    return !!source && (!transport || this.options.canUseMarketplaceSource(source, caller))
  }
  private resources(name: string, caller: DesktopCallerContext, access: Access) {
    this.resourcePreflight()
    const db = this.options.database, skills = pluginSkills(db, name), servers = pluginMcpServers(db, name), agents = pluginAgents(db, name)
    const namespaces = db.getInstalledPlugins().filter(plugin => plugin.name === name || plugin.name.startsWith(name + ':') || name.startsWith(plugin.name + ':'))
    if (namespaces.length > 1 || servers.some(server => server.source !== 'plugin') || db.getSkills().some(skill => skill.name.startsWith(name + ':') && !skills.some(owned => owned.id === skill.id)) || [skills, servers, agents].some(rows => new Set(rows.map(row => row.name)).size !== rows.length)) throw new ServiceProtocolError('INVALID_REQUEST')
    if ([skills, servers, agents].some(rows => rows.length > (access === 'write' ? 128 : CLAUDE_PLUGIN_LIMITS.resources))) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    if (skills.some(skill => !this.options.canAccessSkill(skill.id, caller, access) || (skill.project_id ? !this.options.canAccessProject(skill.project_id, caller, access) : !this.options.canManageGlobalSkills(caller, access))) || servers.some(server => !this.options.canAccessMcpServer(server.id, caller, access)) || agents.some(agent => !this.options.canAccessAgent(agent.id, caller, access))) throw new ServiceProtocolError('INVALID_REQUEST')
    const ids: ResourceIds = { agentIds: agents.map(row => row.id), mcpServerIds: servers.map(row => row.id), skillIds: skills.map(row => row.id) }
    const affected = this.options.agents.getPluginConfigurationAffectedAgents(ids)
    if (affected.length > 256 || affected.some(id => !this.options.canAccessAgent(id, caller, access) || this.options.agents.getAgentConfigurationProjectIds(id).some(project => !this.options.canAccessProject(project, caller, access)))) throw new ServiceProtocolError('INVALID_REQUEST')
    const allAgents = db.getAgents(), referencing = allAgents.filter(agent => ids.agentIds.includes(agent.id) || agent.config.skill_ids?.some(id => ids.skillIds.includes(id)) || agent.config.mcp_servers?.some(entry => ids.mcpServerIds.includes(typeof entry === 'string' ? entry : entry.serverId)) || agent.config.fallback_agent_ids?.some(id => ids.agentIds.includes(id)))
    if (referencing.some(agent => !this.options.canAccessAgent(agent.id, caller, access))) throw new ServiceProtocolError('INVALID_REQUEST')
    const sourceWhere = ids.mcpServerIds.map(() => '?').join(',')
    if (ids.mcpServerIds.length) {
      const stats = db.db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(MAX(length(CAST(id AS BLOB)),length(CAST(project_id AS BLOB)),length(CAST(config AS BLOB)),length(CAST(enabled AS BLOB)))),0) AS field,
        COALESCE(SUM(length(CAST(config AS BLOB))),0) AS bytes FROM task_sources WHERE mcp_server_id IN (${sourceWhere})`).get(...ids.mcpServerIds) as { count: number; field: number; bytes: number }
      if (stats.count > 128 || stats.field > 128 * 1024 || stats.bytes > 2 * 1024 * 1024) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    }
    const sources = ids.mcpServerIds.length ? db.db.prepare(`SELECT id,project_id,mcp_server_id,config,enabled FROM task_sources WHERE mcp_server_id IN (${sourceWhere}) ORDER BY id LIMIT 129`).all(...ids.mcpServerIds) as Array<{ id: string; project_id: string; mcp_server_id: string; config: string; enabled: number }> : []
    if (sources.length > 128 || sources.some(source => !source.id || !source.project_id || source.id.length > 128 || source.project_id.length > 128 || source.config.length > 128 * 1024 || !this.options.canAccessSource(source.id, caller, access) || !this.options.canAccessProject(source.project_id, caller, access))) throw new ServiceProtocolError('INVALID_REQUEST')
    const sourceIds = sources.map(source => source.id), taskAgentIds = [...new Set([...ids.agentIds, ...affected, ...referencing.map(agent => agent.id)])]
    const clauses: string[] = [], params: string[] = []
    if (taskAgentIds.length) { clauses.push(`agent_id IN (${taskAgentIds.map(() => '?').join(',')})`); params.push(...taskAgentIds) }
    if (sourceIds.length) { clauses.push(`source_id IN (${sourceIds.map(() => '?').join(',')})`); params.push(...sourceIds) }
    if (ids.skillIds.length) { clauses.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(skill_ids) THEN skill_ids ELSE '[]' END) WHERE value IN (${ids.skillIds.map(() => '?').join(',')}))`); params.push(...ids.skillIds) }
    if (clauses.length) {
      const stats = db.db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(MAX(length(CAST(id AS BLOB)),length(CAST(project_id AS BLOB)),COALESCE(length(CAST(agent_id AS BLOB)),0),COALESCE(length(CAST(source_id AS BLOB)),0),COALESCE(length(CAST(skill_ids AS BLOB)),0),COALESCE(length(CAST(role AS BLOB)),0),COALESCE(length(CAST(group_id AS BLOB)),0))),0) AS field,
        COALESCE(SUM(COALESCE(length(CAST(skill_ids AS BLOB)),0)),0) AS bytes FROM tasks WHERE ${clauses.join(' OR ')}`).get(...params) as { count: number; field: number; bytes: number }
      if (stats.count > 512 || stats.field > 128 * 1024 || stats.bytes > 4 * 1024 * 1024) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    }
    const tasks = clauses.length ? db.db.prepare(`SELECT id,project_id,agent_id,source_id,COALESCE(skill_ids,'[]') AS skill_ids,role,group_id FROM tasks WHERE ${clauses.join(' OR ')} ORDER BY id LIMIT 513`).all(...params) as Array<{ id: string; project_id: string; agent_id: string | null; source_id: string | null; skill_ids: string; role: string | null; group_id: string | null }> : []
    if (tasks.length > 512 || tasks.some(task => !task.id || !task.project_id || task.id.length > 128 || task.project_id.length > 128 || task.skill_ids.length > 128 * 1024 || !this.options.canAccessTask(task.id, caller, access) || !this.options.canAccessProject(task.project_id, caller, access))) throw new ServiceProtocolError('INVALID_REQUEST')
    const projects = ids.agentIds.length ? db.db.prepare(`SELECT id,captain_agent_id,default_agent_id FROM projects WHERE captain_agent_id IN (${ids.agentIds.map(() => '?').join(',')}) OR default_agent_id IN (${ids.agentIds.map(() => '?').join(',')}) ORDER BY id LIMIT 129`).all(...ids.agentIds, ...ids.agentIds) as Array<{ id: string; captain_agent_id: string | null; default_agent_id: string | null }> : []
    if (projects.length > 128 || projects.some(project => !this.options.canAccessProject(project.id, caller, access))) throw new ServiceProtocolError('INVALID_REQUEST')
    return { ids, skills, servers, agents, affected, referencing, sources, tasks, projects }
  }
  private plugin(id: string) { this.preflight(); return this.options.database.getInstalledPlugin(id) }
  private pluginAllowed(id: string, caller: DesktopCallerContext, access: Access | 'delete'): boolean {
    if (!this.global(caller, access === 'read' ? 'read' : 'write') || !this.options.canAccessPlugin(id, caller, 'read') || !this.options.canAccessPlugin(id, caller, access)) return false
    const plugin = this.plugin(id)
    if (!plugin || !pluginName(plugin.name) || !this.marketplaceAllowed(plugin.marketplace_id, caller, access === 'read' ? 'read' : 'write') || !this.options.canAccessPluginName(plugin.name, plugin.marketplace_id, caller, access === 'read' ? 'read' : 'write')) return false
    this.resources(plugin.name, caller, access === 'read' ? 'read' : 'write')
    return true
  }
  private committed(): void {
    try { this.options.emit('tasks:refresh', this.registry.encodeEvent('tasks:refresh', {}, { principal: 'service', engineEpoch: this.options.engineEpoch })) }
    catch { this.failed = true; this.options.onFatalEvent(new ServiceProtocolError('DISCONNECTED')); throw new ServiceProtocolError('DISCONNECTED') }
  }
  private trackSource<T>(id: string, work: Promise<T>): Promise<T> {
    const set = this.sourceReads.get(id) ?? new Set<Promise<unknown>>(); this.sourceReads.set(id, set); set.add(work)
    void work.then(() => { set.delete(work); if (!set.size) this.sourceReads.delete(id) }, () => { set.delete(work); if (!set.size) this.sourceReads.delete(id) })
    return work
  }
  private async sourceLease<T>(sources: Array<{ id: string }>, beforeEffect: () => void, effect: () => T | Promise<T>): Promise<T> {
    const run = (index: number): Promise<T> => { beforeEffect(); return index === sources.length ? Promise.resolve().then(() => { beforeEffect(); return effect() }) : this.options.sync.runSourceMutation(sources[index].id, () => run(index + 1)) }
    return run(0)
  }
  private async mutation<T>(name: string, caller: DesktopCallerContext, signal: AbortSignal, authorize: () => boolean, effect: (beforeEffect: () => void) => Promise<T> | T): Promise<T> {
    if (this.changingNames.has(name)) throw new ServiceProtocolError('BACKPRESSURE')
    this.changingNames.add(name)
    let accepted = false
    try {
      const initial = this.resources(name, caller, 'write'), snapshot = JSON.stringify(initial)
      const beforeEffect = (): void => { this.available(signal); if (!authorize() || JSON.stringify(this.resources(name, caller, 'write')) !== snapshot) throw new ServiceProtocolError('INVALID_REQUEST') }
      const run = async (): Promise<T> => { beforeEffect(); const result = await effect(beforeEffect); accepted = true; return result }
      return await this.sourceLease(initial.sources, beforeEffect, () => this.options.runPluginMutation ? this.options.runPluginMutation(initial.ids, run) : this.options.agents.runPluginConfigurationMutation(initial.ids, run))
    } catch (error) { if (error instanceof SourceMutationBusyError) throw new ServiceProtocolError('BACKPRESSURE'); throw error }
    finally { this.changingNames.delete(name); if (accepted) this.committed() }
  }
  private planAllowed(plan: PluginResourcePlan, caller: DesktopCallerContext, name: string): void {
    if ([plan.skills, plan.mcpServers, plan.agents].some(rows => rows.length > 128 || new Set(rows.map(row => row.name)).size !== rows.length) || new TextEncoder().encode(JSON.stringify(plan)).length > 8 * 1024 * 1024) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    CLAUDE_PLUGIN_CODECS['claudePlugin:getPluginResources'].encodeResult({ skills: plan.skills.map(skill => ({ id: 'planned', name: skill.name, description: skill.description ?? '' })), mcpServers: plan.mcpServers.map(server => ({ id: 'planned', name: server.name, command: '', args: [] })), agents: plan.agents.map(agent => ({ id: 'planned', name: agent.name, description: '' })), commands: [] })
    if (plan.skills.some(skill => !skill.name.startsWith(name + ':') || !Array.isArray(skill.tags) || !skill.tags.includes('plugin') || !skill.tags.includes(name) || skill.project_id != null || !this.options.canManageGlobalSkills(caller, 'write') || !this.options.canCreateGlobalSkill(skill, caller)) ||
      plan.mcpServers.some(server => !server.name.startsWith(name + ':') || server.source !== 'plugin' || !isMcpData(Object.fromEntries(Object.entries(server).filter(([key, value]) => value !== undefined && ['name', 'type', 'command', 'args', 'url', 'headers', 'environment'].includes(key))), true) || Object.keys(server.environment ?? {}).some(name => reservedEnvironment.test(name)) || !this.options.canCreateMcpServer(server, caller)) || plan.agents.some(agent => !agent.name.startsWith(name + ':') || agent.is_default === true || Object.keys(agent.config ?? {}).some(key => !['system_prompt', 'model', 'skill_ids', 'mcp_servers'].includes(key)) || !this.options.canCreateAgent(agent, caller))) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private bind<K extends ClaudePluginOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>, read = false): void {
    const codec = CLAUDE_PLUGIN_CODECS[operation] as ClaudePluginCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) }, invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal); if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        let result: unknown
        try { result = await effect(args, caller, signal) } catch (error) { if (signal.aborted) throw new ServiceProtocolError('CANCELLED'); throw error }
        this.available(signal); if (read && !authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const projected = codec.encodeResult(result); return codec.decodeResult(projected.defined ? projected.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private bindCommands(): void {
    const { manager, database: db } = this.options
    this.bind('claudePlugin:getMarketplaceSources', (_args, caller) => this.global(caller, 'read'), (_args, caller) => { this.preflight(); return manager.getMarketplaceSources().filter(source => this.marketplaceAllowed(source.id, caller, 'read')) }, true)
    this.bind('claudePlugin:addMarketplaceSource', ([data], caller) => this.global(caller, 'write') && this.options.canCreateMarketplace(data, caller), ([data], caller, signal) => {
      this.preflight(); this.available(signal)
      if (!this.options.canCreateMarketplace(data, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const count = db.db.prepare('SELECT COUNT(*) AS count FROM marketplace_sources').get() as { count: number }
      if (count.count >= CLAUDE_PLUGIN_LIMITS.rows) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      const result = db.db.transaction(() => { const created = manager.addMarketplaceSource(data); CLAUDE_PLUGIN_CODECS['claudePlugin:addMarketplaceSource'].encodeResult(created); return created })()
      this.committed(); return result
    })
    this.bind('claudePlugin:removeMarketplaceSource', ([id], caller) => this.marketplaceAllowed(id, caller, 'delete') && !db.db.prepare('SELECT 1 FROM installed_plugins WHERE marketplace_id=? LIMIT 1').get(id), async ([id], caller, signal) => {
      if (this.changingSources.has(id)) throw new ServiceProtocolError('BACKPRESSURE')
      this.changingSources.add(id)
      const source = JSON.stringify(this.marketplace(id))
      try {
        await Promise.allSettled([...(this.sourceReads.get(id) ?? [])]); this.available(signal)
        if (!this.marketplaceAllowed(id, caller, 'delete') || JSON.stringify(this.marketplace(id)) !== source || db.db.prepare('SELECT 1 FROM installed_plugins WHERE marketplace_id=? LIMIT 1').get(id)) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = manager.removeMarketplaceSource(id); if (result) this.committed(); return result
      } finally { this.changingSources.delete(id) }
    })
    const fetchCatalog = (id: string, caller: DesktopCallerContext, signal: AbortSignal) => {
      if (this.changingSources.has(id)) throw new ServiceProtocolError('BACKPRESSURE')
      const snapshot = JSON.stringify(this.marketplace(id))
      return this.trackSource(id, manager.fetchMarketplaceCatalog(id, { signal, beforeRequest: address => { this.available(signal); if (!this.options.canUsePluginAddress(address, caller)) throw new ServiceProtocolError('INVALID_REQUEST') }, beforeCatalog: source => {
        this.available(signal)
        if (!this.marketplaceAllowed(id, caller, 'read', true) || JSON.stringify(source) !== snapshot || JSON.stringify(this.marketplace(id)) !== snapshot) throw new ServiceProtocolError('INVALID_REQUEST')
      } }))
    }
    this.bind('claudePlugin:fetchCatalog', ([id], caller) => this.marketplaceAllowed(id, caller, 'read', true), async ([id], caller, signal) => {
      const catalog = await fetchCatalog(id, caller, signal)
      return catalog ? { ...catalog, plugins: catalog.plugins.filter(entry => this.options.canAccessPluginName(entry.name, id, caller, 'read')) } : null
    }, true)
    this.bind('claudePlugin:discoverPlugins', (_args, caller) => this.global(caller, 'read'), async ([query], caller, signal) => {
      this.preflight(); this.resourcePreflight()
      const sources = manager.getMarketplaceSources().filter(source => this.marketplaceAllowed(source.id, caller, 'read', true) && !this.changingSources.has(source.id)), snapshots = new Map(sources.map(source => [source.id, JSON.stringify(source)]))
      const work = manager.discoverPlugins(query, { sourceIds: sources.map(source => source.id), signal, beforeRequest: address => { this.available(signal); if (!this.options.canUsePluginAddress(address, caller)) throw new ServiceProtocolError('INVALID_REQUEST') }, beforeCatalog: source => { this.available(signal); if (!snapshots.has(source.id) || !this.marketplaceAllowed(source.id, caller, 'read', true) || JSON.stringify(source) !== snapshots.get(source.id) || JSON.stringify(this.marketplace(source.id)) !== snapshots.get(source.id)) throw new ServiceProtocolError('INVALID_REQUEST') } })
      for (const source of sources) this.trackSource(source.id, work)
      const discovered = await work
      return discovered.filter(plugin => this.options.canAccessPluginName(plugin.name, plugin.marketplace_id, caller, 'read') && this.marketplaceAllowed(plugin.marketplace_id, caller, 'read') && (!plugin.installed_plugin_id || this.pluginAllowed(plugin.installed_plugin_id, caller, 'read')))
    }, true)
    this.bind('claudePlugin:getInstalledPlugins', (_args, caller) => this.global(caller, 'read'), (_args, caller) => { this.preflight(); return manager.getInstalledPlugins().filter(plugin => this.pluginAllowed(plugin.id, caller, 'read')) }, true)
    this.bind('claudePlugin:installPlugin', ([name, marketplace], caller) => this.marketplaceAllowed(marketplace, caller, 'write', true) && this.options.canAccessPluginName(name, marketplace, caller, 'write'), ([name, marketplace, scope], caller, signal) => {
      const selection = manager.getCatalogEntry(name, marketplace)
      if (!selection || !this.options.canUsePluginSource(selection.entry.source, selection.marketplace, selection.pluginRoot, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const selected = JSON.stringify(selection), initial = this.resources(name, caller, 'write')
      if (initial.ids.agentIds.length || initial.ids.mcpServerIds.length || initial.ids.skillIds.length || db.getInstalledPlugins().some(plugin => plugin.name === name)) throw new ServiceProtocolError('INVALID_REQUEST')
      const authorize = () => this.marketplaceAllowed(marketplace, caller, 'write', true) && this.options.canAccessPluginName(name, marketplace, caller, 'write') && JSON.stringify(manager.getCatalogEntry(name, marketplace)) === selected && this.options.canUsePluginSource(selection.entry.source, selection.marketplace, selection.pluginRoot, caller)
      return this.trackSource(marketplace, this.mutation(name, caller, signal, authorize, beforeEffect => {
        const validatePlan = (plan: PluginResourcePlan, manifest?: ClaudePluginManifest): void => {
          beforeEffect(); this.planAllowed(plan, caller, name)
          if (!manifest) throw new ServiceProtocolError('INVALID_RESULT')
          CLAUDE_PLUGIN_CODECS['claudePlugin:installPlugin'].encodeResult({ id: 'planned', name, marketplace_id: marketplace, manifest, source: typeof selection.entry.source === 'string' ? { path: selection.entry.source } : selection.entry.source, scope: scope ?? 'user', enabled: true, version: selection.entry.version ?? '1.0.0', installed_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
        }
        return manager.installPlugin(name, marketplace, scope, { signal, beforeRequest: address => { beforeEffect(); if (!this.options.canUsePluginAddress(address, caller)) throw new ServiceProtocolError('INVALID_REQUEST') }, beforeDownload: (entry, source, root) => { beforeEffect(); if (JSON.stringify({ entry, marketplace: source, ...(root === undefined ? {} : { pluginRoot: root }) }) !== selected) throw new ServiceProtocolError('INVALID_REQUEST') }, beforePublish: validatePlan, beforeMaterialize: validatePlan })
      }))
    })
    this.bind('claudePlugin:uninstallPlugin', ([id], caller) => this.pluginAllowed(id, caller, 'delete') && this.uninstallAllowed(id, caller), ([id], caller, signal) => {
      const plugin = this.plugin(id)!
      return this.mutation(plugin.name, caller, signal, () => this.pluginAllowed(id, caller, 'delete') && this.uninstallAllowed(id, caller), beforeEffect => { beforeEffect(); return manager.uninstallPlugin(id) })
    })
    for (const operation of ['claudePlugin:enablePlugin', 'claudePlugin:disablePlugin'] as const) this.bind(operation, ([id], caller) => this.pluginAllowed(id, caller, 'write'), ([id], caller, signal) => {
      const plugin = this.plugin(id)!
      return this.mutation(plugin.name, caller, signal, () => this.pluginAllowed(id, caller, 'write'), beforeEffect => { beforeEffect(); return operation === 'claudePlugin:enablePlugin' ? manager.enablePlugin(id) : manager.disablePlugin(id) })
    })
    this.bind('claudePlugin:getPluginResources', ([id], caller) => this.pluginAllowed(id, caller, 'read'), ([id]) => manager.getPluginResources(id), true)
  }
  private uninstallAllowed(id: string, caller: DesktopCallerContext): boolean {
    const plugin = this.plugin(id)
    if (!plugin) return false
    const state = this.resources(plugin.name, caller, 'write')
    if (state.sources.length || state.tasks.length || state.projects.length || state.referencing.some(agent => !state.ids.agentIds.includes(agent.id))) return false
    const grouped = state.ids.agentIds.length && this.options.database.db.prepare(`SELECT 1 FROM task_groups WHERE agent_id IN (${state.ids.agentIds.map(() => '?').join(',')}) LIMIT 1`).get(...state.ids.agentIds)
    if (grouped) return false
    const defaults = this.options.database.db.prepare('SELECT value FROM settings WHERE key IN (?,?)').all('default_agent_id', 'chat_agent_id') as Array<{ value: string }>
    return !defaults.some(setting => state.ids.agentIds.includes(setting.value))
  }
}

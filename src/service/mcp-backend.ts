import type { DatabaseManager } from '../main/database/manager'
import type { SyncManager } from '../main/sync-manager'
import type { AgentManager } from '../main/agent-manager-core'
import type { CreateMcpServerData, UpdateMcpServerData, McpServerRecord } from '../main/database/types'
import type { OAuthManager } from '../main/oauth/oauth-manager-core'
import { McpProbeService, type McpServerProbeInput } from '../main/agent-manager/mcp-probe-service'
import { AUTHENTICATED_SECRET_STORAGE_FORMAT, getSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { MCP_CODECS, MCP_OPERATIONS, MCP_LIMITS, MCP_SECRET_SET_MARKER, isMcpDictionary, isMcpData, type McpCodec, type McpOperation } from '../shared/mcp-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
export type McpOAuthOwner = { kind: 'unavailable' | 'available'; manager: OAuthManager }
export interface McpOwners { database: DatabaseManager; manager: AgentManager; sync: SyncManager; probes: McpProbeService; secretStorage: SecretStorage; oauth: McpOAuthOwner }
export interface McpBackendOptions extends McpOwners {
  engineEpoch: string
  configuredMcp: 'enabled' | 'disabled'
  assertAvailable(): void
  assertMcpOwners(owners: McpOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageConfiguration(caller: DesktopCallerContext, access: Access): boolean
  canAccessServer(id: string, caller: DesktopCallerContext, access: Access | 'delete'): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
  /** Exact executable/argv or network endpoint authority, established by native host. */
  canUseTransport(input: McpServerProbeInput, caller: DesktopCallerContext): boolean
  canUseEnvironmentName(name: string, caller: DesktopCallerContext): boolean
  emit(operation: 'tasks:refresh', payload: JsonValue): void
  onFatalEvent(error: ServiceProtocolError): void
}
const reservedEnvironment = /^(?:PATH|HOME|SHELL|BASH_ENV|ENV|IFS|CDPATH|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|ELECTRON_.*|TASK_API_.*|TASK_MCP_.*|21X_.*|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|CODEX_HOME|CODEX_CONFIG_HOME|PI_CODING_AGENT_DIR|CLAUDE_CONFIG_DIR)$/i
const reservedName = (name: string): boolean => ['task-management', 'browser', 'browser-tools', 'browser-automation'].includes(name.trim().toLowerCase())

/** Finite MCP effects on the actual DB/lifecycle/probe owners. Storage authority
 * never enables configured transports or supplies a browser/callback substitute. */
export class McpBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private failed = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly serverSources = new Map<string, Set<Promise<void>>>()
  private readonly mutatingServers = new Set<string>()
  constructor(private readonly options: McpBackendOptions) {
    this.available()
    if (!(options.probes instanceof McpProbeService) || typeof options.manager.runMcpConfigurationMutation !== 'function' || typeof options.manager.getMcpConfigurationAffectedAgents !== 'function' || typeof options.oauth.manager.getMcpServerOAuthStatus !== 'function' || typeof options.sync.runSourceMutation !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.registry.bindEvent('tasks:refresh', { validatePayload: value => isJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0, encodePayload: () => ({}) })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  get pendingProbeCount(): number { return this.options.probes.pendingCount }
  shutdown(): void { this.closing = true; this.options.probes.shutdown() }
  /** A failed drain retains DB/credential/raw process ownership. Root must close
   * a borrowed available OAuth manager concurrently to cancel callback waits. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid MCP backend shutdown deadline')
    this.shutdown()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([Promise.all([this.options.probes.close(timeoutMs), Promise.allSettled([...this.flights, ...[...this.serverSources.values()].flatMap(sources => [...sources])])]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })])
    } catch { throw new ServiceProtocolError('TIMEOUT') }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(MCP_OPERATIONS.map(operation => [operation, {
      validatePayload: (payload: unknown) => { try { return isJsonValue(payload) && MCP_CODECS[operation].validateArguments(MCP_CODECS[operation].decodeArguments(payload)) } catch { return false } },
      validateResult: MCP_CODECS[operation].validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, payload, caller, signal)
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || this.failed) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertMcpOwners(this.options)
    const storage = this.options.secretStorage
    if (storage !== getSecretStorage() || storage.formatId !== AUTHENTICATED_SECRET_STORAGE_FORMAT || !storage.isEncryptionAvailable()) throw new ServiceProtocolError('DISCONNECTED')
  }
  private retain<T>(flight: Promise<T>): Promise<T> { this.flights.add(flight); void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight)); return flight }
  private global(caller: DesktopCallerContext, access: Access): boolean {
    return !!caller.webviewId && !!caller.origin && this.options.canManageConfiguration(caller, 'read') && this.options.canManageConfiguration(caller, access)
  }
  /** Inspect SQL lengths before legacy getters materialize JSON/credentials. */
  private preflight(id?: string): void {
    const stats = this.options.database.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(MAX(MAX(length(CAST(id AS BLOB)),length(CAST(name AS BLOB)),length(CAST(type AS BLOB)),length(CAST(command AS BLOB)),COALESCE(length(CAST(url AS BLOB)),0),length(CAST(source AS BLOB)),length(CAST(created_at AS BLOB)),length(CAST(updated_at AS BLOB)))),0) AS field,
      COALESCE(MAX(MAX(length(CAST(args AS BLOB)),length(CAST(headers AS BLOB)),length(CAST(environment AS BLOB)),length(CAST(oauth_metadata AS BLOB)),length(CAST(tools AS BLOB)))),0) AS json,
      COALESCE(SUM(length(CAST(args AS BLOB))+length(CAST(headers AS BLOB))+length(CAST(environment AS BLOB))+length(CAST(oauth_metadata AS BLOB))+length(CAST(tools AS BLOB))),0) AS bytes
      FROM mcp_servers${id === undefined ? '' : ' WHERE id=?'}`).get(...(id === undefined ? [] : [id])) as { count: number; field: number; json: number; bytes: number }
    if (stats.count > MCP_LIMITS.servers || stats.field > 4096 || stats.json > 256 * 1024 || stats.bytes > 1024 * 1024) throw new ServiceProtocolError('FRAME_TOO_LARGE')
  }
  private get(id: string): McpServerRecord | undefined { this.preflight(id); return this.options.database.getMcpServer(id) }
  private preflightOAuth(id: string): void {
    const invalid = this.options.database.db.prepare(`SELECT 1 FROM oauth_tokens WHERE mcp_server_id=? AND
      (length(access_token)>65536 OR COALESCE(length(refresh_token),0)>65536 OR length(CAST(expires_at AS BLOB))>32) LIMIT 1`).get(id)
    if (invalid) throw new ServiceProtocolError('FRAME_TOO_LARGE')
  }
  private affectedAllowed(id: string, caller: DesktopCallerContext): boolean {
    const agents = this.options.manager.getMcpConfigurationAffectedAgents(id)
    if (agents.length > 128 || new Set(agents).size !== agents.length) return false
    return agents.every(agentId => {
      if (!this.options.canAccessAgent(agentId, caller, 'write')) return false
      return this.options.manager.getAgentConfigurationProjectIds(agentId).every(id => this.options.canAccessProject(id, caller, 'write'))
    })
  }
  private sourceSnapshot(id: string, caller: DesktopCallerContext): string {
    const sources = this.options.database.db.prepare('SELECT CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id, CASE WHEN length(CAST(project_id AS BLOB))<=128 THEN project_id ELSE NULL END AS project_id FROM task_sources WHERE mcp_server_id=? ORDER BY id LIMIT 129').all(id) as Array<{ id: string | null; project_id: string | null }>
    const tasks = this.options.database.db.prepare('SELECT CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id, CASE WHEN length(CAST(project_id AS BLOB))<=128 THEN project_id ELSE NULL END AS project_id, CASE WHEN length(CAST(source_id AS BLOB))<=128 THEN source_id ELSE NULL END AS source_id FROM tasks WHERE source_id IN (SELECT id FROM task_sources WHERE mcp_server_id=?) ORDER BY id LIMIT 513').all(id) as Array<{ id: string | null; project_id: string | null; source_id: string | null }>
    if (sources.length > 128 || tasks.length > 512 || sources.some(source => !source.id || !source.project_id || !this.options.canAccessSource(source.id, caller, 'write') || !this.options.canAccessProject(source.project_id, caller, 'write')) ||
      tasks.some(task => !task.id || !task.project_id || !task.source_id || !this.options.canAccessTask(task.id, caller, 'write') || !this.options.canAccessProject(task.project_id, caller, 'write'))) throw new ServiceProtocolError('INVALID_REQUEST')
    return JSON.stringify({ sources, tasks })
  }
  private async sourceLease<T>(id: string, caller: DesktopCallerContext, signal: AbortSignal, effect: () => T | Promise<T>): Promise<T> {
    const expected = this.sourceSnapshot(id, caller)
    const sources = (JSON.parse(expected) as { sources: Array<{ id: string }> }).sources
    const run = (index: number): Promise<T> => {
      this.available(signal)
      if (this.sourceSnapshot(id, caller) !== expected) throw new ServiceProtocolError('INVALID_REQUEST')
      return index === sources.length ? Promise.resolve().then(() => {
        this.available(signal)
        if (this.sourceSnapshot(id, caller) !== expected) throw new ServiceProtocolError('INVALID_REQUEST')
        return effect()
      })
        : this.options.sync.runSourceMutation(sources[index].id, () => run(index + 1))
    }
    return run(0)
  }
  private trackServerSource(id: string, raw: Promise<void>): void {
    const sources = this.serverSources.get(id) ?? new Set<Promise<void>>()
    this.serverSources.set(id, sources); sources.add(raw)
    void raw.then(() => { sources.delete(raw); if (!sources.size) this.serverSources.delete(id) })
  }
  private serverAllowed(id: string, caller: DesktopCallerContext, access: Access | 'delete'): boolean {
    if (!this.global(caller, access === 'read' ? 'read' : 'write') || !this.options.canAccessServer(id, caller, 'read') || !this.options.canAccessServer(id, caller, access)) return false
    const server = this.get(id)
    if (access !== 'read') {
      this.sourceSnapshot(id, caller)
      if (access === 'delete' && this.options.database.db.prepare('SELECT 1 FROM task_sources WHERE mcp_server_id=? LIMIT 1').get(id)) return false
    }
    return access === 'read' || (!server || server.source === 'user' && !reservedName(server.name)) && this.affectedAllowed(id, caller)
  }
  private dictionaries(data: object, previous: McpServerRecord | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = { ...data }
    for (const field of ['headers', 'environment'] as const) {
      const dictionary = out[field]
      if (dictionary === undefined) continue
      if (!isMcpDictionary(dictionary, field === 'environment')) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      out[field] = Object.fromEntries(Object.entries(dictionary).map(([key, value]) => {
        if (value !== MCP_SECRET_SET_MARKER) return [key, value]
        const saved = previous?.[field][key]
        if (!saved || saved === MCP_SECRET_SET_MARKER) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        return [key, saved]
      }))
    }
    return out
  }
  private dataAllowed(data: { name?: unknown; environment?: unknown }, caller: DesktopCallerContext, previous?: McpServerRecord): boolean {
    if (reservedName(String(data.name ?? previous?.name ?? ''))) return false
    const environment = data.environment
    return environment === undefined || isMcpDictionary(environment, true) && Object.keys(environment).every(name => !reservedEnvironment.test(name) && this.options.canUseEnvironmentName(name, caller))
  }
  private transport(data: Record<string, unknown>, caller: DesktopCallerContext): McpServerProbeInput {
    const previous = typeof data.id === 'string' ? this.get(data.id) : undefined
    if (typeof data.id === 'string' && (!previous || !this.serverAllowed(data.id, caller, 'write'))) throw new ServiceProtocolError('INVALID_REQUEST')
    const resolved = this.dictionaries(data, previous)
    delete resolved.id
    if (!isMcpData(resolved, true) || !this.dataAllowed(resolved, caller, previous)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const input = resolved as unknown as McpServerProbeInput
    if (this.options.configuredMcp !== 'enabled' || reservedName(input.name) || !this.options.canUseTransport(input, caller)) throw new ServiceProtocolError('DISCONNECTED')
    return input
  }
  private oauth(): OAuthManager {
    if (this.options.configuredMcp !== 'enabled' || this.options.oauth.kind !== 'available') throw new ServiceProtocolError('DISCONNECTED')
    return this.options.oauth.manager
  }
  private committed(): void {
    try { this.options.emit('tasks:refresh', this.registry.encodeEvent('tasks:refresh', {}, { principal: 'service', engineEpoch: this.options.engineEpoch })) }
    catch { this.failed = true; this.options.onFatalEvent(new ServiceProtocolError('DISCONNECTED')); throw new ServiceProtocolError('DISCONNECTED') }
  }
  private bind<K extends McpOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>, read = false): void {
    const codec = MCP_CODECS[operation] as McpCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) },
      invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        let result: unknown
        try { result = await effect(args, caller, signal) }
        catch (error) { if (signal.aborted) throw new ServiceProtocolError('CANCELLED'); throw error }
        this.available(signal)
        if (read && !authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const projected = codec.encodeResult(result)
        return codec.decodeResult(projected.defined ? projected.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private async mutation<T>(id: string, caller: DesktopCallerContext, signal: AbortSignal, effect: () => T | Promise<T>): Promise<T> {
    if (this.mutatingServers.has(id)) throw new ServiceProtocolError('BACKPRESSURE')
    this.mutatingServers.add(id)
    let accepted = false
    try {
      // Join only this server's accepted raw sources. Public cancellation or
      // timeout never releases credentials/process ownership early.
      await Promise.all([...(this.serverSources.get(id) ?? [])])
      this.available(signal)
      return await this.sourceLease(id, caller, signal, () => {
        const expected = this.sourceSnapshot(id, caller)
        return this.options.manager.runMcpConfigurationMutation(id, () => {
          this.available(signal)
          if (this.sourceSnapshot(id, caller) !== expected || !this.serverAllowed(id, caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST')
          const result = effect(); accepted = true; return result
        })
      })
    } finally { this.mutatingServers.delete(id); if (accepted) this.committed() }
  }
  private bindCommands(): void {
    const { database: db, probes } = this.options
    this.bind('mcp:getAll', (_args, caller) => this.global(caller, 'read'), (_args, caller) => { this.preflight(); return db.getMcpServers().filter(server => this.serverAllowed(server.id, caller, 'read')) }, true)
    this.bind('mcp:create', ([data], caller) => this.global(caller, 'write') && this.dataAllowed(data, caller), ([data], caller, signal) => {
      this.preflight()
      const result = db.db.transaction(() => {
        this.available(signal)
        const resolved = this.dictionaries(data, undefined)
        if (!this.dataAllowed(resolved, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const count = db.db.prepare('SELECT COUNT(*) AS count FROM mcp_servers').get() as { count: number }
        if (count.count >= MCP_LIMITS.servers) throw new ServiceProtocolError('FRAME_TOO_LARGE')
        const created = db.createMcpServer(resolved as unknown as CreateMcpServerData)
        MCP_CODECS['mcp:create'].encodeResult(created)
        return created
      })()
      this.committed(); return result
    })
    this.bind('mcp:update', ([id, data], caller) => this.serverAllowed(id, caller, 'write') && this.dataAllowed(data, caller, this.get(id)), ([id, data], caller, signal) => this.mutation(id, caller, signal, () => db.db.transaction(() => {
      const resolved = this.dictionaries(data, this.get(id))
      if (!this.dataAllowed(resolved, caller, this.get(id))) throw new ServiceProtocolError('INVALID_REQUEST')
      const result = db.updateMcpServer(id, resolved as UpdateMcpServerData)
      MCP_CODECS['mcp:update'].encodeResult(result); return result
    })()))
    this.bind('mcp:delete', ([id], caller) => this.serverAllowed(id, caller, 'delete'), ([id], caller, signal) => this.mutation(id, caller, signal, () => {
      if (!this.serverAllowed(id, caller, 'delete')) throw new ServiceProtocolError('INVALID_REQUEST')
      return db.db.transaction(() => {
        const deleted = db.deleteMcpServer(id)
        if (deleted) {
          db.deleteOAuthTokenByMcpServer(id)
          for (const agent of db.getAgents()) if (agent.config.mcp_servers?.some(entry => (typeof entry === 'string' ? entry : entry.serverId) === id)) db.updateAgent(agent.id, { config: { ...agent.config, mcp_servers: agent.config.mcp_servers.filter(entry => (typeof entry === 'string' ? entry : entry.serverId) !== id) } })
        }
        return deleted
      })()
    }))
    this.bind('mcp:testConnection', ([data], caller) => this.global(caller, 'write') && (data.id === undefined || this.serverAllowed(data.id, caller, 'write')), async ([data], caller, signal) => {
      if (data.id && this.mutatingServers.has(data.id)) throw new ServiceProtocolError('BACKPRESSURE')
      const input = this.transport(data as unknown as Record<string, unknown>, caller)
      const expectedSources = data.id ? this.sourceSnapshot(data.id, caller) : undefined
      const current = (): void => {
        this.available(signal)
        if (!this.global(caller, 'write') || data.id && (!this.serverAllowed(data.id, caller, 'write') || this.sourceSnapshot(data.id, caller) !== expectedSources) ||
          !this.dataAllowed(input, caller) || this.options.configuredMcp !== 'enabled' || !this.options.canUseTransport(input, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      }
      let started!: (receipt: ReturnType<McpProbeService['probeOwned']>) => void
      const admitted = new Promise<ReturnType<McpProbeService['probeOwned']>>(resolve => { started = resolve })
      const launch = (): Promise<void> => {
        this.available(signal)
        const receipt = probes.probeOwned(input, signal, { beforeEffect: current })
        started(receipt)
        return receipt.closed
      }
      const sourceWork = data.id ? this.sourceLease(data.id, caller, signal, launch) : launch()
      // Admission covers source-sync joins as well as the eventual raw probe.
      const closed = sourceWork.then(() => undefined, () => undefined)
      if (data.id) this.trackServerSource(data.id, closed)
      const receipt = await Promise.race([admitted, sourceWork.then(() => { throw new ServiceProtocolError('DISCONNECTED') })])
      const answer = await receipt.result
      this.available(signal)
      if (!this.options.canUseTransport(input, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const result = answer.status === 'failed' ? { status: 'failed', error: 'MCP probe failed' } : { status: 'connected', ...(answer.tools === undefined ? {} : { toolCount: answer.tools.length, tools: answer.tools }), ...(answer.tools === undefined && answer.toolCount !== undefined ? { toolCount: answer.toolCount } : {}) }
      MCP_CODECS['mcp:testConnection'].encodeResult(result)
      if (data.id && answer.status === 'connected' && answer.tools) {
        await sourceWork
        await this.mutation(data.id, caller, signal, () => {
          // A concurrent edit never receives a stale probe's tool discovery.
          const current = this.get(data.id!)
          if (!current || JSON.stringify([current.type, current.command, current.args, current.url, current.headers, current.environment]) !== JSON.stringify([input.type ?? 'local', input.command ?? '', input.args ?? [], input.url ?? '', input.headers ?? {}, input.environment ?? {}])) throw new ServiceProtocolError('INVALID_REQUEST')
          db.updateMcpServerTools(data.id!, answer.tools!)
        })
      }
      return result
    })
    this.bind('mcp:getOAuthStatus', ([id], caller) => this.serverAllowed(id, caller, 'read'), ([id]) => { this.preflightOAuth(id); return this.options.oauth.manager.getMcpServerOAuthStatus(id) }, true)
    this.bind('mcp:startOAuthFlow', ([id], caller) => this.serverAllowed(id, caller, 'write'), ([id], caller, signal) => {
      const oauth = this.oauth(), server = this.get(id)
      this.preflightOAuth(id)
      if (!server || server.type !== 'remote' || !this.options.canUseTransport(server, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      return this.mutation(id, caller, signal, () => oauth.startMcpServerOAuthFlow(id))
    })
    this.bind('mcp:submitManualClientId', ([id], caller) => this.serverAllowed(id, caller, 'write'), ([id, clientId], caller, signal) => {
      const oauth = this.oauth(), server = this.get(id)
      this.preflightOAuth(id)
      if (!server || server.type !== 'remote' || !this.options.canUseTransport(server, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      return this.mutation(id, caller, signal, () => oauth.completeManualRegistration(id, clientId))
    })
    this.bind('mcp:revokeOAuthToken', ([id], caller) => this.serverAllowed(id, caller, 'write'), ([id], caller, signal) => {
      const oauth = this.options.oauth.manager
      this.preflightOAuth(id)
      return this.mutation(id, caller, signal, () => oauth.revokeMcpServerToken(id))
    })
    this.bind('mcp:probeForAuth', (_args, caller) => this.global(caller, 'read'), async ([url], caller, signal) => {
      if (this.options.configuredMcp !== 'enabled' || !this.options.canUseTransport({ name: 'auth-probe', type: 'remote', url }, caller)) throw new ServiceProtocolError('DISCONNECTED')
      const answer = await probes.probeForAuth(url, signal, { beforeEffect: () => {
        this.available(signal)
        if (!this.global(caller, 'read') || this.options.configuredMcp !== 'enabled' || !this.options.canUseTransport({ name: 'auth-probe', type: 'remote', url }, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      } })
      this.available(signal)
      if (!this.options.canUseTransport({ name: 'auth-probe', type: 'remote', url }, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      return answer
    })
  }
}

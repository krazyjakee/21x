import { TaskGroupRequestScopeError } from '../main/agent-manager/task-group-request-scope'
import type { DatabaseManager } from '../main/database/manager'
import type { CreateAgentData, UpdateAgentData, AgentConfigRecord } from '../main/database/types'
import type { AgentManager } from '../main/agent-manager-core'
import { DEFAULT_SERVER_URL } from '../main/adapters/opencode-server'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { getSecretStorage } from '../main/platform/secret-storage'
import { flattenProviderModels, rememberBackendModels } from '../main/agent-manager/skill-model'
import { AGENT_CONFIGURATION_CODECS, AGENT_CONFIGURATION_OPERATIONS, AGENT_CONFIGURATION_EVENT_CODECS,
  isAgentConfigurationBackendType, isAgentConfigurationServerUrl, AGENT_API_KEY_SET_MARKER, type AgentConfigurationCodec, type AgentConfigurationOperation, type AgentConfigurationBackendType } from '../shared/agent-configuration-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
export interface AgentConfigurationBackendOptions {
  database: DatabaseManager
  manager: AgentManager
  /** Captured actual protected provider; omitted hosts cannot accept keys. */
  credentialStorage?: AuthenticatedSecretStorage
  engineEpoch: string
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessAgent(agentId: string, caller: DesktopCallerContext, access: Access | 'delete'): boolean
  canManageGlobalConfiguration(caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(projectId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessMcpServer(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSecret(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessGlobalSkills(caller: DesktopCallerContext, access: Access): boolean
  canQueryBackend(backend: AgentConfigurationBackendType, serverUrl: string | undefined, caller: DesktopCallerContext): boolean
  emit(operation: 'tasks:refresh', payload: JsonValue): void
  onFatalEvent(error: ServiceProtocolError): void
}

/** Agent content/configuration binds to the actual lifecycle owner. No fixture
 * agent allowlist, alternate DB writer, secret store or callback simulator. */
export class AgentConfigurationBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private failed = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: AgentConfigurationBackendOptions) {
    options.assertAvailable()
    if (typeof options.manager.runAgentConfigurationMutation !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.registry.bindEvent('tasks:refresh', { validatePayload: AGENT_CONFIGURATION_EVENT_CODECS['tasks:refresh'].validatePayload,
      encodePayload: () => ({}) })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  /** Admission closes immediately; the host must retain DB/lock/providers
   * until this join succeeds. Cancellation never releases a raw model flight. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid agent configuration shutdown deadline')
    this.closing = true
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(AGENT_CONFIGURATION_OPERATIONS.map(operation => [operation, {
      validatePayload: (payload: unknown) => {
        try { return isJsonValue(payload) && AGENT_CONFIGURATION_CODECS[operation].validateArguments(AGENT_CONFIGURATION_CODECS[operation].decodeArguments(payload)) } catch { return false }
      }, validateResult: AGENT_CONFIGURATION_CODECS[operation].validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, payload, caller, signal)
    }]))
  }
  private available(): void { if (this.closing || this.failed) throw new ServiceProtocolError('DISCONNECTED'); this.options.assertAvailable() }
  private retain<T>(flight: Promise<T>): Promise<T> {
    this.flights.add(flight)
    void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight))
    return flight
  }
  private referencedProjects(agentId: string): string[] {
    return this.options.manager.getAgentConfigurationProjectIds(agentId)
  }
  private agentAllowed(id: string, caller: DesktopCallerContext, access: Access | 'delete'): boolean {
    return this.options.canManageGlobalConfiguration(caller, 'read') && this.options.canManageGlobalConfiguration(caller, access === 'read' ? 'read' : 'write') &&
      this.options.canAccessAgent(id, caller, 'read') && this.options.canAccessAgent(id, caller, access) &&
      this.referencedProjects(id).every(project => this.options.canAccessProject(project, caller, access === 'read' ? 'read' : 'write'))
  }
  private configAllowed(config: AgentConfigRecord | undefined, caller: DesktopCallerContext, id?: string): boolean {
    if (!config) return true
    const db = this.options.database
    if (config.api_keys !== undefined) {
      try {
        if (!(this.options.credentialStorage instanceof AuthenticatedSecretStorage) || getSecretStorage() !== this.options.credentialStorage || !this.options.credentialStorage.isEncryptionAvailable()) return false
      } catch { return false }
      const saved = id ? db.getAgent(id)?.config.api_keys : undefined
      if (Object.entries(config.api_keys).some(([vendor, value]) => value === AGENT_API_KEY_SET_MARKER && !saved?.[vendor as keyof typeof saved])) return false
    }
    if ((config.fallback_agent_ids ?? []).some(fallback => fallback === id || !db.getAgent(fallback) || !this.agentAllowed(fallback, caller, 'read'))) return false
    if ((config.skill_ids ?? []).some(skillId => {
      const skill = db.getSkill(skillId)
      return !skill || (skill.project_id === null ? !this.options.canAccessGlobalSkills(caller, 'read') : !this.options.canAccessProject(skill.project_id, caller, 'read'))
    })) return false
    if ((config.mcp_servers ?? []).some(entry => {
      const serverId = typeof entry === 'string' ? entry : entry.serverId
      return !this.options.canAccessMcpServer(serverId, caller, 'read') || !db.getMcpServer(serverId)
    })) return false
    if ((config.secret_ids ?? []).some(secretId => !this.options.canAccessSecret(secretId, caller, 'read') || !db.getSecrets().some(secret => secret.id === secretId))) return false
    return true
  }
  private resolveConfig(config: AgentConfigRecord | undefined, saved?: AgentConfigRecord): AgentConfigRecord | undefined {
    if (!config) return undefined
    const keys = { ...saved?.api_keys }
    for (const [vendor, value] of Object.entries(config.api_keys ?? {})) {
      if (value !== AGENT_API_KEY_SET_MARKER) keys[vendor as keyof typeof keys] = value
    }
    const publicConfig = { ...config }; delete publicConfig.api_keys
    return { ...publicConfig, ...(Object.keys(keys).length || saved?.api_keys !== undefined ? { api_keys: keys } : {}) }
  }
  private endpointAllowed(data: CreateAgentData | UpdateAgentData, caller: DesktopCallerContext, id?: string): boolean {
    const previous = id === undefined ? undefined : this.options.database.getAgent(id)
    const backend = data.config?.coding_agent ?? (data.config ? 'opencode' : previous?.config.coding_agent ?? 'opencode')
    const url = data.server_url ?? previous?.server_url ?? DEFAULT_SERVER_URL
    return isAgentConfigurationBackendType(backend) && isAgentConfigurationServerUrl(url) && this.options.canQueryBackend(backend, url, caller)
  }
  private deletionAllowed(id: string, caller: DesktopCallerContext): boolean {
    const db = this.options.database
    if (!this.agentAllowed(id, caller, 'delete')) return false
    if (db.db.prepare("SELECT 1 FROM task_groups WHERE agent_id=? AND state='active' LIMIT 1").get(id)) return false
    return db.getAgents().filter(agent => agent.config.fallback_agent_ids?.includes(id)).every(agent => this.agentAllowed(agent.id, caller, 'write'))
  }
  private backendTarget(serverUrl: string | undefined, backend: string | undefined, caller: DesktopCallerContext): { backend: AgentConfigurationBackendType; url: string } | null {
    if (!this.options.canManageGlobalConfiguration(caller, 'read')) return null
    const defaults = this.options.database.getAgents()
    const selected = defaults.find(agent => agent.is_default) ?? defaults[0]
    const resolved = backend ?? selected?.config.coding_agent ?? 'opencode'
    const url = serverUrl ?? selected?.server_url ?? DEFAULT_SERVER_URL
    return isAgentConfigurationBackendType(resolved) && isAgentConfigurationServerUrl(url) &&
      this.options.canQueryBackend(resolved, url, caller) ? { backend: resolved, url } : null
  }
  private backendRequest(serverUrl: string | undefined, backend: string | undefined, caller: DesktopCallerContext): AgentConfigurationBackendType | null {
    return this.backendTarget(serverUrl, backend, caller)?.backend ?? null
  }
  private committed(): void {
    const payload = this.registry.encodeEvent('tasks:refresh', {}, { principal: 'service', engineEpoch: this.options.engineEpoch })
    try { this.options.emit('tasks:refresh', payload) }
    catch { this.failed = true; this.options.onFatalEvent(new ServiceProtocolError('DISCONNECTED')); throw new ServiceProtocolError('DISCONNECTED') }
  }
  private bind<K extends AgentConfigurationOperation>(operation: K,
    authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>): void {
    const codec = AGENT_CONFIGURATION_CODECS[operation] as AgentConfigurationCodec<K>
    this.registry.bindCommand(operation, {
      decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) },
      invoke: (args, caller, signal) => this.retain((async () => {
        this.available()
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const query = operation === 'agentConfig:getProviders' ? this.backendTarget(args[0] as string | undefined, args[1] as string | undefined, caller)
          : operation === 'agentConfig:listModels' ? this.backendTarget(undefined, args[0] as string, caller) : null
        const projects = operation === 'agent:update' || operation === 'agent:delete' ? this.referencedProjects(args[0] as string) : []
        const current = (): void => {
          this.available()
          if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
          if (!authorize(args, caller) || projects.some(id => !this.options.canAccessProject(id, caller, 'write'))) throw new ServiceProtocolError('INVALID_REQUEST')
          if (query) {
            const now = this.backendTarget(operation === 'agentConfig:getProviders' ? args[0] as string | undefined : undefined,
              operation === 'agentConfig:getProviders' ? args[1] as string | undefined : args[0] as string, caller)
            if (!now || now.backend !== query.backend || now.url !== query.url) throw new ServiceProtocolError('INVALID_REQUEST')
          }
        }
        const result = await this.options.manager.withTaskGroupRequestGuard(async () => effect(args, caller, signal), current, signal).catch(error => {
          if (error instanceof TaskGroupRequestScopeError) throw new ServiceProtocolError(error.code)
          throw error
        })
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        this.available()
        if ((operation.startsWith('agentConfig:') || operation === 'agent:getAll') && !authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        if ((operation === 'agent:create' || operation === 'agent:update') && !this.options.canManageGlobalConfiguration(caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
        if (operation === 'agent:update' && !this.agentAllowed(args[0] as string, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
        const encoded = codec.encodeResult(result)
        return codec.decodeResult(encoded.defined ? encoded.value : undefined)
      })()),
      validateResult: codec.validateResult, encodeResult: codec.encodeResult
    })
  }
  private bindCommands(): void {
    const { database: db, manager } = this.options
    this.bind('agent:getAll', (_args, caller) => this.options.canManageGlobalConfiguration(caller, 'read'), (_args, caller) => db.getAgents().filter(agent => this.agentAllowed(agent.id, caller, 'read')))
    this.bind('agent:create', ([data], caller) => this.options.canManageGlobalConfiguration(caller, 'read') && this.options.canManageGlobalConfiguration(caller, 'write') && this.configAllowed(data.config, caller) && this.endpointAllowed(data, caller), ([data], caller, signal) => {
      const result = db.db.transaction(() => {
        this.available()
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        if (!this.options.canManageGlobalConfiguration(caller, 'read') || !this.options.canManageGlobalConfiguration(caller, 'write') || !this.configAllowed(data.config, caller) || !this.endpointAllowed(data, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const created = db.createAgent({ ...data, ...(data.config ? { config: this.resolveConfig(data.config) } : {}) } as CreateAgentData)
        const projected = AGENT_CONFIGURATION_CODECS['agent:create'].encodeResult(created)
        return AGENT_CONFIGURATION_CODECS['agent:create'].decodeResult(projected.defined ? projected.value : undefined)
      })()
      manager.drainStartQueue(); this.committed()
      return result
    })
    this.bind('agent:update', ([id, data], caller) => this.agentAllowed(id, caller, 'write') && this.configAllowed(data.config, caller, id) && this.endpointAllowed(data, caller, id), async ([id, data], caller, signal) => {
      const original = db.getAgent(id)
      if (!original) return undefined
      const changes = { ...data } as UpdateAgentData
      if (changes.config) changes.config = this.resolveConfig(changes.config, original.config)
      let accepted = false
      try {
        return await manager.runAgentConfigurationMutation(id, 'update', () => {
          const result = db.db.transaction(() => {
            this.available()
            if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
            if (!this.agentAllowed(id, caller, 'write') || !this.configAllowed(data.config, caller, id) || !this.endpointAllowed(data, caller, id)) throw new ServiceProtocolError('INVALID_REQUEST')
            const previous = db.getAgent(id)
            if (!previous) return undefined
            const update = { ...data } as UpdateAgentData
            if (update.config) update.config = this.resolveConfig(update.config, previous.config)
            const updated = db.updateAgent(id, update)
            const projected = AGENT_CONFIGURATION_CODECS['agent:update'].encodeResult(updated)
            return AGENT_CONFIGURATION_CODECS['agent:update'].decodeResult(projected.defined ? projected.value : undefined)
          })()
          accepted = result !== undefined
          return result
        }, changes)
      } finally { if (accepted) this.committed() }
    })
    this.bind('agent:delete', ([id], caller) => this.deletionAllowed(id, caller), async ([id], caller, signal) => {
      if (!db.getAgent(id)) return false
      let accepted = false
      try {
        return await manager.runAgentConfigurationMutation(id, 'delete', () => {
          const result = db.db.transaction(() => {
            this.available()
            if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
            if (!this.deletionAllowed(id, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
            const deleted = db.deleteAgent(id)
            if (deleted) {
              for (const agent of db.getAgents()) if (agent.config.fallback_agent_ids?.includes(id)) db.updateAgent(agent.id, { config: {
                ...agent.config, fallback_agent_ids: agent.config.fallback_agent_ids.filter(fallback => fallback !== id) } })
              if (db.getSetting('default_agent_id') === id) db.setSetting('default_agent_id', '')
            }
            return deleted
          })()
          accepted = result
          return result
        })
      } finally { if (accepted) this.committed() }
    })
    this.bind('agentConfig:getProviders', ([url, type], caller) => this.backendRequest(url, type, caller) !== null, async ([url, type], caller, signal) => {
      const target = this.backendTarget(url, type, caller)
      if (!target) throw new ServiceProtocolError('INVALID_REQUEST')
      const raw = await manager.getProviders(target.url, undefined, target.backend)
      const projected = AGENT_CONFIGURATION_CODECS['agentConfig:getProviders'].encodeResult(raw)
      const result = AGENT_CONFIGURATION_CODECS['agentConfig:getProviders'].decodeResult(projected.defined ? projected.value : undefined)
      const current = this.backendTarget(url, type, caller)
      if (!this.closing && !signal.aborted && current?.backend === target.backend && current.url === target.url) rememberBackendModels(target.backend, flattenProviderModels(result))
      return result
    })
    this.bind('agentConfig:listModels', ([type], caller) => this.backendRequest(undefined, type, caller) !== null, async ([type]) => manager.listModels(type))
  }
}

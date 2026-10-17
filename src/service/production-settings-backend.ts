import { TaskGroupRequestScopeError } from '../main/agent-manager/task-group-request-scope'
import type { DatabaseManager } from '../main/database/manager'
import type { AgentRecord, CreateSecretData, UpdateSecretData, SecretRecord } from '../main/database/types'
import type { AgentManager } from '../main/agent-manager-core'
import type { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import type { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import type { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import type { ScheduledCoordination } from '../main/scheduled-coordination-core'
import type { WorkspaceCleanupSchedulerCore } from '../main/workspace-cleanup-scheduler-core'
import { assertTaskLifecycleOwners } from '../main/task-updates'
import { AUTHENTICATED_SECRET_STORAGE_FORMAT, getSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { CHAT_SETTING_KEYS } from '../shared/chat'
import type { ProductionCredentialMutation } from '../shared/production-credential-mutation'
import { PRODUCTION_SETTINGS_CODECS, PRODUCTION_SETTINGS_OPERATIONS, PRODUCTION_API_KEY_SET_MARKER, isProductionCredentialKey,
  isProductionSettingKey, isProductionSettingWrite, requiresNativeSettingsOwner, settingProjectId, projectProductionSetting, projectProductionSecret,
  type ProductionSettingsCodec, type ProductionSettingsOperation, type ProductionEnvKey } from '../shared/production-settings-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export type { ProductionCredentialMutation } from '../shared/production-credential-mutation'
export interface SettingsOwners {
  database: DatabaseManager
  manager: AgentManager
  recurrence: RecurrenceSchedulerCore
  heartbeat: HeartbeatSchedulerCore
  automation: TaskAutomationScheduler
  coordination: ScheduledCoordination
  cleanup: WorkspaceCleanupSchedulerCore
  secretStorage: SecretStorage
}
export interface ProductionSettingsBackendOptions extends SettingsOwners {
  engineEpoch: string
  assertAvailable(): void
  /** Root validates every borrowed object against the actual singleton. */
  assertSettingsOwners(owners: SettingsOwners): void
  /** Bound actual owner composes Chat/Commander provider-turn and AgentManager
   * fences. It retains raw work, never retries or substitutes a notification. */
  runCredentialMutation<T>(input: ProductionCredentialMutation, mutation: () => T | Promise<T>): Promise<T>
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canReadSetting(key: string, caller: DesktopCallerContext): boolean
  canWriteSetting(key: string, caller: DesktopCallerContext): boolean
  canManageGlobalConfiguration(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessSecret(id: string, caller: DesktopCallerContext, access: 'read' | 'write' | 'delete'): boolean
  canCreateSecret(caller: DesktopCallerContext): boolean
  canUseSecretEnvironment(name: string, caller: DesktopCallerContext): boolean
  canReadEnvironment(key: ProductionEnvKey, caller: DesktopCallerContext): boolean
  /** Host's actual environment, never supplied by renderer arguments. */
  environment: Readonly<Partial<Record<ProductionEnvKey, string>>>
  emit(operation: 'tasks:refresh', payload: JsonValue): void
  onFatalEvent(error: ServiceProtocolError): void
}
const reservedEnvironment = /^(?:PATH|HOME|SHELL|BASH_ENV|ENV|IFS|CDPATH|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|ELECTRON_.*|TASK_API_.*|TASK_MCP_.*|21X_.*|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|CODEX_HOME|CODEX_CONFIG_HOME|PI_CODING_AGENT_DIR|CLAUDE_CONFIG_DIR)$/i
const chatProviderCredential = (key: string): boolean => key === 'openai_api_key' || key === 'anthropic_api_key'

/** Reviewed settings and encrypted secret effects for an actual production
 * owner. Dynamic auth/session bookkeeping is never exported as UI settings. */
export class ProductionSettingsBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private failed = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: ProductionSettingsBackendOptions) {
    options.assertAvailable(); this.ownersReady()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.registry.bindEvent('tasks:refresh', { validatePayload: value => isJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0,
      encodePayload: () => ({}) })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid production settings shutdown deadline')
    this.closing = true
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(PRODUCTION_SETTINGS_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && PRODUCTION_SETTINGS_CODECS[operation].validateArguments(PRODUCTION_SETTINGS_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: PRODUCTION_SETTINGS_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  private ownersReady(): void {
    this.options.assertSettingsOwners(this.options)
    assertTaskLifecycleOwners(this.options.recurrence, this.options.heartbeat, this.options.automation)
    if (getSecretStorage() !== this.options.secretStorage || this.options.secretStorage.formatId !== AUTHENTICATED_SECRET_STORAGE_FORMAT || !this.options.secretStorage.isEncryptionAvailable())
      throw new ServiceProtocolError('DISCONNECTED')
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || this.failed) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.ownersReady()
  }
  private retain<T>(flight: Promise<T>): Promise<T> {
    this.flights.add(flight); void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight)); return flight
  }
  private settingAllowed(key: string, caller: DesktopCallerContext, write: boolean, value?: string): boolean {
    if (!isProductionSettingKey(key) || !(write ? this.options.canWriteSetting(key, caller) : this.options.canReadSetting(key, caller))) return false
    const project = settingProjectId(key)
    if (project && (!this.options.database.getProject(project) || !this.options.canAccessProject(project, caller, write ? 'write' : 'read'))) return false
    if (!project && !this.options.canManageGlobalConfiguration(caller, write ? 'write' : 'read')) return false
    if (!write) {
      const saved = ['current_project_id', 'default_agent_id', CHAT_SETTING_KEYS.agentId].includes(key) ? this.options.database.getSetting(key) : undefined
      if (key === 'current_project_id' && saved && (!this.options.database.getProject(saved) || !this.options.canAccessProject(saved, caller, 'read'))) return false
      if ((key === 'default_agent_id' || key === CHAT_SETTING_KEYS.agentId) && saved && (!this.options.database.getAgent(saved) || !this.options.canAccessAgent(saved, caller, 'read'))) return false
      return true
    }
    if (value === undefined || !isProductionSettingWrite(key, value) || requiresNativeSettingsOwner(key)) return false
    const db = this.options.database
    if (key === 'current_project_id' && value && (!db.getProject(value) || !this.options.canAccessProject(value, caller, 'read'))) return false
    if ((key === 'default_agent_id' || key === CHAT_SETTING_KEYS.agentId) && value && (!db.getAgent(value) || !this.options.canAccessAgent(value, caller, 'read'))) return false
    if (['default_agent_id', 'max_concurrent_agent_sessions', 'all_projects_paused'].includes(key) &&
      db.getProjects({ includeArchived: true }).some(project => !this.options.canAccessProject(project.id, caller, 'write'))) return false
    if (chatProviderCredential(key)) {
      const selected = db.getSetting(CHAT_SETTING_KEYS.agentId)
      if (selected && (!db.getAgent(selected) || !this.options.canAccessAgent(selected, caller, 'read'))) return false
    }
    return true
  }
  private referencedAgents(secretId: string): AgentRecord[] { return this.options.database.getAgents().filter(agent => agent.config.secret_ids?.includes(secretId)) }
  private sameSecretReferences(id: string, ids: string[]): boolean {
    const agents = this.referencedAgents(id)
    return agents.length === ids.length && agents.every(agent => ids.includes(agent.id))
  }
  private credentialScopeAllowed(input: ProductionCredentialMutation, caller: DesktopCallerContext): boolean {
    const ids = this.options.manager.getProductionCredentialAffectedAgents(input)
    if (!Array.isArray(ids) || ids.length > 128 || new Set(ids).size !== ids.length) return false
    return ids.every(id => { const agent = this.options.database.getAgent(id); return !!agent && this.agentAllowed(agent, caller) })
  }
  private agentAllowed(agent: AgentRecord, caller: DesktopCallerContext): boolean {
    if (!this.options.canAccessAgent(agent.id, caller, 'write')) return false
    return this.options.manager.getAgentConfigurationProjectIds(agent.id).every(id =>
      !!this.options.database.getProject(id) && this.options.canAccessProject(id, caller, 'write'))
  }
  private secretAllowed(id: string, caller: DesktopCallerContext, access: 'read' | 'write' | 'delete', data?: UpdateSecretData): boolean {
    if (!this.options.canManageGlobalConfiguration(caller, access === 'read' ? 'read' : 'write') || !this.options.canAccessSecret(id, caller, access)) return false
    if (access === 'read') return true
    const secret = this.options.database.getSecret(id)
    const environment = data?.env_var_name ?? secret?.env_var_name
    return (!environment || !reservedEnvironment.test(environment) && this.options.canUseSecretEnvironment(environment, caller)) &&
      this.referencedAgents(id).every(agent => this.agentAllowed(agent, caller)) && this.credentialScopeAllowed({ kind: 'secret', secretId: id }, caller)
  }
  private committed(): void {
    try { this.options.emit('tasks:refresh', this.registry.encodeEvent('tasks:refresh', {}, { principal: 'service', engineEpoch: this.options.engineEpoch })) }
    catch { this.failed = true; try { this.options.onFatalEvent(new ServiceProtocolError('DISCONNECTED')) } finally { throw new ServiceProtocolError('DISCONNECTED') } }
  }
  private bind<K extends ProductionSettingsOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>, read = false): void {
    const codec = PRODUCTION_SETTINGS_CODECS[operation] as ProductionSettingsCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: codec.decodeArguments, validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) }, invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const affected = operation === 'secrets:update' || operation === 'secrets:delete'
          ? this.options.manager.getProductionCredentialAffectedAgents({ kind: 'secret', secretId: args[0] as string }) : []
        const projects = [...new Set(affected.flatMap(id => this.options.manager.getAgentConfigurationProjectIds(id)))]
        const current = (): void => {
          this.available(signal)
          if (!authorize(args, caller) || projects.some(id => !this.options.canAccessProject(id, caller, 'write')) ||
            affected.some(id => !this.options.canAccessAgent(id, caller, 'write'))) throw new ServiceProtocolError('INVALID_REQUEST')
        }
        const result = await this.options.manager.withTaskGroupRequestGuard(async () => effect(args, caller, signal), current, signal).catch(error => {
          if (error instanceof TaskGroupRequestScopeError) throw new ServiceProtocolError(error.code)
          throw error
        })
        this.available(signal)
        if (read && !authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const value = codec.encodeResult(result)
        return codec.decodeResult(value.defined ? value.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private bindCommands(): void {
    const { database: db, manager } = this.options
    this.bind('settings:get', ([key], caller) => this.settingAllowed(key, caller, false), ([key]) => {
      const value = db.getSetting(key)
      return value === undefined ? null : projectProductionSetting(key, value)
    }, true)
    this.bind('settings:getAll', (_args, caller) => this.options.canManageGlobalConfiguration(caller, 'read'), (_args, caller) => {
      const result: Record<string, string> = {}
      // Read keys only: never decrypt unrelated stored auth/session rows.
      for (const { key } of db.db.prepare('SELECT key FROM settings ORDER BY key').iterate() as Iterable<{ key: string }>) {
        if (!this.settingAllowed(key, caller, false)) continue
        if (Object.keys(result).length === 512) throw new ServiceProtocolError('INVALID_RESULT')
        const value = db.getSetting(key)
        if (value !== undefined) result[key] = projectProductionSetting(key, value)
      }
      return result
    }, true)
    this.bind('settings:set', ([key, value], caller) => this.settingAllowed(key, caller, true, value), async ([key, value], caller, signal) => {
      if (isProductionCredentialKey(key) && value === PRODUCTION_API_KEY_SET_MARKER) return undefined
      let accepted = false
      const mutation = (): void => {
        this.available(signal)
        if (!this.settingAllowed(key, caller, true, value)) throw new ServiceProtocolError('INVALID_REQUEST')
        if (key === 'all_projects_paused') manager.pauseAllProjects(value === '1')
        else db.setSetting(key, value)
        accepted = true
      }
      try {
        if (chatProviderCredential(key)) await this.options.runCredentialMutation({ kind: 'provider-key', key }, mutation)
        else if (key === 'default_agent_id') await this.options.runCredentialMutation({ kind: 'default-agent' }, mutation)
        else mutation()
        if (key === 'max_concurrent_agent_sessions') manager.drainStartQueue()
      } finally { if (accepted) this.committed() }
      return undefined
    })
    this.bind('env:get', ([key], caller) => this.options.canReadEnvironment(key as ProductionEnvKey, caller), ([key]) => {
      const value = this.options.environment[key as ProductionEnvKey]
      if (value !== undefined && typeof value !== 'string') throw new ServiceProtocolError('INVALID_RESULT')
      return value === undefined ? null : value === '' ? '' : PRODUCTION_API_KEY_SET_MARKER
    }, true)
    this.bind('secrets:getAll', (_args, caller) => this.options.canManageGlobalConfiguration(caller, 'read'), (_args, caller) => {
      const result: SecretRecord[] = []
      for (const secret of db.db.prepare('SELECT id,name,description,env_var_name,created_at,updated_at FROM secrets ORDER BY name,id').iterate() as Iterable<SecretRecord>) {
        if (!this.secretAllowed(secret.id, caller, 'read')) continue
        if (result.length === 128) throw new ServiceProtocolError('INVALID_RESULT')
        result.push(secret)
      }
      return result
    }, true)
    this.bind('secrets:create', ([data], caller) => this.options.canManageGlobalConfiguration(caller, 'write') && this.options.canCreateSecret(caller) && !reservedEnvironment.test(data.env_var_name) && this.options.canUseSecretEnvironment(data.env_var_name, caller), ([data], caller, signal) => {
      this.available(signal)
      if (!this.options.canCreateSecret(caller) || !this.options.canManageGlobalConfiguration(caller, 'write') || reservedEnvironment.test(data.env_var_name) || !this.options.canUseSecretEnvironment(data.env_var_name, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const result = db.db.transaction(() => {
        const secret = db.createSecret(data as CreateSecretData)
        if (!secret) throw new ServiceProtocolError('INVALID_RESULT')
        projectProductionSecret(secret)
        return secret
      })()
      this.committed(); return result
    })
    this.bind('secrets:update', ([id, data], caller) => this.secretAllowed(id, caller, 'write', data), async ([id, data], caller, signal) => {
      if (!db.getSecret(id)) return undefined
      const references = this.referencedAgents(id).map(agent => agent.id)
      const affected = this.options.manager.getProductionCredentialAffectedAgents({ kind: 'secret', secretId: id })
      let accepted = false
      try { return await this.options.runCredentialMutation({ kind: 'secret', secretId: id }, () => {
        this.available(signal)
        if (!this.secretAllowed(id, caller, 'write', data) || !this.sameSecretReferences(id, references) ||
          this.options.manager.getProductionCredentialAffectedAgents({ kind: 'secret', secretId: id }).some(agent => !affected.includes(agent))) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = db.db.transaction(() => {
          const secret = db.updateSecret(id, data)
          if (secret) projectProductionSecret(secret)
          return secret
        })()
        accepted = !!result
        return result
      }) } finally { if (accepted) this.committed() }
    })
    this.bind('secrets:delete', ([id], caller) => this.secretAllowed(id, caller, 'delete'), async ([id], caller, signal) => {
      if (!db.getSecret(id)) return false
      const references = this.referencedAgents(id).map(agent => agent.id)
      const affected = this.options.manager.getProductionCredentialAffectedAgents({ kind: 'secret', secretId: id })
      let accepted = false
      try { return await this.options.runCredentialMutation({ kind: 'secret', secretId: id }, () => {
        this.available(signal)
        if (!this.secretAllowed(id, caller, 'delete') || !this.sameSecretReferences(id, references) ||
          this.options.manager.getProductionCredentialAffectedAgents({ kind: 'secret', secretId: id }).some(agent => !affected.includes(agent))) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = db.db.transaction(() => {
          for (const agent of this.referencedAgents(id)) db.updateAgent(agent.id, { config: { ...agent.config, secret_ids: agent.config.secret_ids!.filter(secret => secret !== id) } })
          return db.deleteSecret(id)
        })()
        accepted = result
        return result
      }) } finally { if (accepted) this.committed() }
    })
  }
}

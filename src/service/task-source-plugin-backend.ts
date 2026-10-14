import type { DatabaseManager } from '../main/database/manager'
import type { TaskSourceRecord } from '../main/database/types'
import type { PluginRegistry } from '../main/plugins/registry'
import type { TaskSourcePlugin } from '../main/plugins/types'
import type { SyncManager } from '../main/sync-manager'
import type { OAuthManager } from '../main/oauth/oauth-manager-core'
import { AUTHENTICATED_SECRET_STORAGE_FORMAT, getSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { TASK_SOURCE_CONFIG_FIELDS, TASK_SOURCE_KEY_SET_MARKER, TASK_SOURCE_PLUGIN_IDS, isTaskSourceConfigInput, isTaskSourcePluginId, projectTaskSourceConfig, type TaskSourcePluginId } from '../shared/task-source-codecs'
import { TASK_SOURCE_PLUGIN_CODECS, TASK_SOURCE_PLUGIN_OPERATIONS, TASK_SOURCE_RESOLVER_KEYS, TASK_SOURCE_PLUGIN_LIMITS, isTaskSourceResolverOptions,
  type TaskSourcePluginCodec, type TaskSourcePluginOperation } from '../shared/task-source-plugin-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
type ResolverArgs = DesktopCommandMap['plugin:resolveOptions']['apiArguments']
export interface TaskSourcePluginOwners {
  database: DatabaseManager
  sync: SyncManager
  plugins: PluginRegistry
  oauth: OAuthManager
  secretStorage: SecretStorage
}
export interface TaskSourcePluginBackendOptions extends TaskSourcePluginOwners {
  engineEpoch: string
  assertAvailable(): void
  assertOwners(owners: TaskSourcePluginOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageConfiguration(caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessMcpServer(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessConnector(id: string, caller: DesktopCallerContext, access: Access): boolean
  canUseSourcePlugin(id: string, caller: DesktopCallerContext, operation: TaskSourcePluginOperation): boolean
  /** Saved source read access alone is not permission to use its credentials. */
  canBorrowSourceCredentials(sourceId: string, pluginId: string, caller: DesktopCallerContext): boolean
  canResolveUnsavedConfig(pluginId: string, caller: DesktopCallerContext): boolean
}
interface ResolverBinding { plugin: TaskSourcePlugin; source?: TaskSourceRecord; pluginId: TaskSourcePluginId; projectId?: string }

/** Read-only form controls borrow actual owners. Actions remain with the
 * existing TaskLifecycleBackend, which owns Stop/source completion writes. */
export class TaskSourcePluginBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: TaskSourcePluginBackendOptions) {
    options.assertAvailable(); this.ownersReady()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(TASK_SOURCE_PLUGIN_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && TASK_SOURCE_PLUGIN_CODECS[operation].validateArguments(TASK_SOURCE_PLUGIN_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: TASK_SOURCE_PLUGIN_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid plugin form shutdown deadline')
    this.closing = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  private ownersReady(): void {
    this.options.assertOwners(this.options)
    this.options.sync.assertOwners(this.options.database, this.options.plugins, this.options.oauth)
    if (getSecretStorage() !== this.options.secretStorage || this.options.secretStorage.formatId !== AUTHENTICATED_SECRET_STORAGE_FORMAT || !this.options.secretStorage.isEncryptionAvailable()) throw new ServiceProtocolError('DISCONNECTED')
    const bridge = this.options.plugins.get('connector-bridge') as { assertSourceLifecycle?(owner: SyncManager): void } | undefined
    if (bridge) {
      if (typeof bridge.assertSourceLifecycle !== 'function') throw new ServiceProtocolError('DISCONNECTED')
      bridge.assertSourceLifecycle(this.options.sync)
    }
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.ownersReady()
  }
  private retain<T>(flight: Promise<T>): Promise<T> {
    this.flights.add(flight); void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight)); return flight
  }
  private rowBytes(table: 'task_sources' | 'oauth_tokens' | 'connector_instances', column: 'id' | 'source_id', id: string): void {
    const columns = this.options.database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    const sum = columns.map(item => `COALESCE(length(CAST("${item.name.replaceAll('"', '""')}" AS BLOB)),0)`).join('+')
    const rows = this.options.database.db.prepare(`SELECT ${sum} AS bytes FROM ${table} WHERE ${column}=? LIMIT 2`).all(id) as Array<{ bytes: number }>
    if (rows.length > 1 || rows.some(row => !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > TASK_SOURCE_PLUGIN_LIMITS.frameBytes)) throw new ServiceProtocolError('INVALID_RESULT')
  }
  private source(id: string, pluginId: TaskSourcePluginId, caller: DesktopCallerContext): TaskSourceRecord {
    if (!this.options.canAccessSource(id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
    const raw = this.options.database.db.prepare('SELECT project_id,mcp_server_id,plugin_id FROM task_sources WHERE id=?').get(id) as { project_id: string | null; mcp_server_id: string | null; plugin_id: string } | undefined
    const project = raw?.project_id ?? DEFAULT_PROJECT_ID
    if (!raw || raw.plugin_id !== pluginId || !this.options.canBorrowSourceCredentials(id, pluginId, caller) || !this.options.database.getProject(project) || !this.options.canAccessProject(project, caller, 'read') || raw.mcp_server_id && !this.options.canAccessMcpServer(raw.mcp_server_id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
    this.rowBytes('task_sources', 'id', id)
    const source = this.options.database.getTaskSource(id)
    if (!source) throw new ServiceProtocolError('INVALID_REQUEST')
    return source
  }
  private resolverDeclared(plugin: TaskSourcePlugin, pluginId: TaskSourcePluginId, resolver: string): boolean {
    const schema = plugin.getConfigSchema()
    if (!Array.isArray(schema) || schema.length > 64 || !schema.every(field => field && typeof field.key === 'string' && field.key.length <= 128 && typeof field.type === 'string')) return false
    if (!TASK_SOURCE_RESOLVER_KEYS[pluginId].includes(resolver)) return false
    if (schema.some(field => field.type === 'dynamic-select' && field.optionsResolver === resolver)) return true
    // The retained custom Notion widget requests filter property metadata;
    // the bridge's select gets its allowlisted piece options from this method.
    return pluginId === 'notion' && resolver === 'data_source_properties' && schema.some(field => field.key === 'filters') ||
      pluginId === 'connector-bridge' && resolver === 'pieces' && schema.some(field => field.key === 'piece_name' && field.type === 'select')
  }
  private connectorAllowed(config: Record<string, unknown>, caller: DesktopCallerContext): boolean {
    const id = config.connector_instance_id
    if (!id) return true
    if (typeof id !== 'string' || !this.options.canAccessConnector(id, caller, 'read')) return false
    this.rowBytes('connector_instances', 'id', id)
    const row = this.options.database.db.prepare('SELECT piece_name FROM connector_instances WHERE id=?').get(id) as { piece_name: string } | undefined
    return !!row && row.piece_name === config.piece_name
  }
  private binding(args: ResolverArgs, caller: DesktopCallerContext): ResolverBinding {
    const [pluginId, resolver, config, mcpId, sourceId] = args
    if (!isTaskSourcePluginId(pluginId) || !isTaskSourceConfigInput(pluginId, config)) throw new ServiceProtocolError('INVALID_REQUEST')
    const plugin = this.options.plugins.get(pluginId)
    if (!plugin || !this.options.canUseSourcePlugin(pluginId, caller, 'plugin:resolveOptions') || !this.resolverDeclared(plugin, pluginId, resolver)) throw new ServiceProtocolError('INVALID_REQUEST')
    if (mcpId && (!this.options.canAccessMcpServer(mcpId, caller, 'read') || !this.options.database.db.prepare('SELECT 1 FROM mcp_servers WHERE id=?').get(mcpId))) throw new ServiceProtocolError('INVALID_REQUEST')
    if (sourceId) {
      const source = this.source(sourceId, pluginId, caller)
      if (source.plugin_id !== pluginId || !this.options.canBorrowSourceCredentials(sourceId, pluginId, caller) || mcpId && source.mcp_server_id !== mcpId) throw new ServiceProtocolError('INVALID_REQUEST')
      if (pluginId === 'connector-bridge' && (!this.connectorAllowed(source.config, caller) || !this.connectorAllowed({ ...source.config, ...config }, caller))) throw new ServiceProtocolError('INVALID_REQUEST')
      const secretKeys = TASK_SOURCE_CONFIG_FIELDS[pluginId].secret
      if (secretKeys.some(key => config[key] === TASK_SOURCE_KEY_SET_MARKER && (typeof source.config[key] !== 'string' || !source.config[key] || source.config[key] === TASK_SOURCE_KEY_SET_MARKER))) throw new ServiceProtocolError('INVALID_REQUEST')
      return { plugin, source, pluginId, projectId: source.project_id }
    }
    if (!this.options.canResolveUnsavedConfig(pluginId, caller) || TASK_SOURCE_CONFIG_FIELDS[pluginId].secret.some(key => config[key] === TASK_SOURCE_KEY_SET_MARKER) || pluginId === 'connector-bridge' && !this.connectorAllowed(config, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
    return { plugin, pluginId }
  }
  private borrowedConfig(binding: ResolverBinding, requested: Record<string, unknown>): Record<string, unknown> {
    const config: Record<string, unknown> = binding.source ? { ...projectTaskSourceConfig(binding.pluginId, binding.source.config) } : {}
    for (const key of TASK_SOURCE_CONFIG_FIELDS[binding.pluginId].secret) if (binding.source?.config[key] !== undefined) config[key] = binding.source.config[key]
    for (const [key, value] of Object.entries(requested)) {
      if (TASK_SOURCE_CONFIG_FIELDS[binding.pluginId].secret.includes(key) && value === TASK_SOURCE_KEY_SET_MARKER) continue
      config[key] = value
    }
    if (!isTaskSourceConfigInput(binding.pluginId, config) || TASK_SOURCE_CONFIG_FIELDS[binding.pluginId].secret.some(key => config[key] === TASK_SOURCE_KEY_SET_MARKER)) throw new ServiceProtocolError('INVALID_REQUEST')
    return config
  }
  private snapshot(binding: ResolverBinding): string {
    if (!binding.source) return ''
    const source = binding.source, config = this.borrowedConfig(binding, {})
    let connector: unknown = null
    if (binding.pluginId === 'connector-bridge' && typeof config.connector_instance_id === 'string' && config.connector_instance_id) {
      connector = this.options.database.db.prepare('SELECT id,piece_name,piece_version,enabled FROM connector_instances WHERE id=?').get(config.connector_instance_id) ?? null
    }
    // Normal polling/refresh timestamps are not context changes. Meaningful
    // source config, enabled state, plugin/project/MCP/connector identity are.
    return JSON.stringify({ project: source.project_id, plugin: source.plugin_id, mcp: source.mcp_server_id, enabled: source.enabled, config, connector })
  }
  private stillBound(args: ResolverArgs, caller: DesktopCallerContext, captured: ResolverBinding, snapshot: string): ResolverBinding {
    const current = this.binding(args, caller)
    if (current.plugin !== captured.plugin || this.snapshot(current) !== snapshot) throw new ServiceProtocolError('INVALID_REQUEST')
    return current
  }
  private secrets(pluginId: TaskSourcePluginId, config: Record<string, unknown>, sourceId?: string): string[] {
    const values = TASK_SOURCE_CONFIG_FIELDS[pluginId].secret.map(key => config[key]).filter((value): value is string => typeof value === 'string' && !!value)
    if (sourceId && ['linear', 'hubspot'].includes(pluginId)) {
      this.rowBytes('oauth_tokens', 'source_id', sourceId)
      const token = this.options.database.getOAuthTokenBySource(sourceId)
      if (token) {
        if (token.provider !== pluginId) throw new ServiceProtocolError('INVALID_REQUEST')
        for (const value of [token.access_token, token.refresh_token]) if (typeof value === 'string' && value) values.push(value)
      }
    }
    return [...new Set(values.flatMap(value => [value, encodeURIComponent(value), new URLSearchParams({ value }).toString().slice(6), JSON.stringify(value).slice(1, -1), Buffer.from(value, 'utf8').toString('base64')]))].filter(Boolean).sort((a, b) => b.length - a.length)
  }
  private result(value: unknown, secrets: string[]): unknown {
    if (!isTaskSourceResolverOptions(value)) throw new ServiceProtocolError('INVALID_RESULT')
    return (value as Array<{ value: string; label: string }>).map(option => {
      // A redacted option identifier would be fabricated. Refuse it; a label
      // can safely retain its real identifier while concealing reflected keys.
      if (secrets.some(secret => option.value.includes(secret))) throw new ServiceProtocolError('INVALID_RESULT')
      let label = option.label
      for (const secret of secrets) label = label.split(secret).join('[REDACTED]')
      return { value: option.value, label }
    })
  }
  private bind<K extends TaskSourcePluginOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>): void {
    const codec = TASK_SOURCE_PLUGIN_CODECS[operation] as TaskSourcePluginCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) }, invoke: (args, caller, signal) => this.retain((async () => {
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = await effect(args, caller, signal)
        this.available(signal)
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const wire = codec.encodeResult(result)
        return codec.decodeResult(wire.defined ? wire.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private bindCommands(): void {
    this.bind('plugin:list', (_args, caller) => this.options.canManageConfiguration(caller, 'read'), (_args, caller) => {
      const rows = this.options.plugins.list().filter(plugin => (TASK_SOURCE_PLUGIN_IDS as readonly string[]).includes(plugin.id) && this.options.canUseSourcePlugin(plugin.id, caller, 'plugin:list'))
      if (rows.length > TASK_SOURCE_PLUGIN_LIMITS.plugins) throw new ServiceProtocolError('INVALID_RESULT')
      return rows
    })
    this.bind('plugin:getDocumentation', ([id], caller) => this.options.canManageConfiguration(caller, 'read') && this.options.canUseSourcePlugin(id, caller, 'plugin:getDocumentation'), ([id]) => this.options.plugins.getDocumentation(id))
    this.bind('plugin:resolveOptions', (args, caller) => { this.binding(args, caller); return true }, async (args, caller, signal) => {
      const captured = this.binding(args, caller), sourceId = args[4]
      const snapshot = this.snapshot(captured)
      // Unsaved forms use a stable bounded lane in the actual sync owner, not
      // a fabricated database source. No cursor/checkpoint writer is involved.
      const result = await this.options.sync.runSourceWork(sourceId ?? `plugin-options:${captured.pluginId}:unsaved`, async () => {
        this.available(signal)
        const current = this.stillBound(args, caller, captured, snapshot)
        const config = this.borrowedConfig(current, args[2])
        const before = this.secrets(current.pluginId, config, sourceId)
        const options = await current.plugin.resolveOptions(args[1], config, { db: this.options.database, oauthManager: this.options.oauth, ...(sourceId ? { sourceId } : {}) })
        this.available(signal)
        this.stillBound(args, caller, captured, snapshot)
        // A refresh can rotate tokens while the accepted resolver is pending.
        // Redact both versions while the source/storage owner is still held.
        const after = this.secrets(current.pluginId, config, sourceId)
        return this.result(options, [...new Set([...before, ...after])])
      })
      this.available(signal)
      this.stillBound(args, caller, captured, snapshot)
      return result
    })
  }
}

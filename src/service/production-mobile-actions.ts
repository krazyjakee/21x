import { AsyncLocalStorage } from 'node:async_hooks'
import type { MobileTaskActions } from '../main/mobile-api-server'
import type { CreateTaskData, UpdateTaskData, CreateTaskSourceData, UpdateTaskSourceData } from '../main/database/types'
import { TaskSourceBackend } from './task-source-backend'
import { TaskSourcePluginBackend } from './task-source-plugin-backend'
import type { OAuthManager } from '../main/oauth/oauth-manager-core'
import type { SecretStorage } from '../main/platform/secret-storage'
import { TASK_SOURCE_CODECS, type TaskSourceOperation } from '../shared/task-source-codecs'
import { TASK_SOURCE_PLUGIN_CODECS } from '../shared/task-source-plugin-codecs'
import { TaskLifecycleBackend, type TaskLifecycleBackendOptions } from './task-lifecycle-backend'
import { TASK_LIFECYCLE_CODECS, type TaskLifecycleOperation } from '../shared/task-lifecycle-codecs'
import { getTaskCompletionAction } from '../shared/task-completion'
import { ServiceProtocolError } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'

/** Private HTTP adapter, never a desktop grant or a second domain owner.
 * The server captures paired authentication; every delegated reference/effect
 * rechecks that exact request. Only these finite route methods are exposed. */
export class ProductionMobileActions implements MobileTaskActions {
  private readonly context = new AsyncLocalStorage<() => void>()
  private readonly backend: TaskLifecycleBackend
  private readonly sources: TaskSourceBackend
  private readonly plugins: TaskSourcePluginBackend
  private closing = false
  private readonly caller: DesktopCallerContext
  constructor(private readonly options: Pick<TaskLifecycleBackendOptions,
    'database' | 'manager' | 'sync' | 'registry' | 'recurrence' | 'heartbeat' | 'automation' | 'engineEpoch' | 'emit' | 'assertAvailable' | 'onFatalEvent'> & { oauth: OAuthManager; secretStorage: SecretStorage }) {
    this.caller = Object.freeze({ principal: 'trusted-desktop-main', engineEpoch: options.engineEpoch })
    const available = (): void => { options.assertAvailable(); if (this.closing) throw new ServiceProtocolError('DISCONNECTED'); if (this.context.getStore()) this.current() }
    const check = (): boolean => { this.current(); return true }
    this.backend = new TaskLifecycleBackend({ ...options,
      assertAvailable: available,
      isTrustedDesktop: caller => caller === this.caller && check(),
      canAccessTask: check, canAccessProject: check, canAccessAgent: check, canAccessSource: check,
      canUseSourcePlugin: check, canAccessMcpServer: check, canAccessConnector: check })
    const owners = { database: options.database, manager: options.manager, sync: options.sync, plugins: options.registry, oauth: options.oauth, secretStorage: options.secretStorage }
    const shared = { ...owners, engineEpoch: options.engineEpoch, assertAvailable: available,
      assertOwners: (actual: { database: unknown; sync: unknown; plugins: unknown; oauth: unknown; secretStorage: unknown }) => {
        available()
        if (actual.database !== owners.database || actual.sync !== owners.sync || actual.plugins !== owners.plugins || actual.oauth !== owners.oauth || actual.secretStorage !== owners.secretStorage) throw new ServiceProtocolError('DISCONNECTED')
      },
      isTrustedDesktop: (caller: DesktopCallerContext) => caller === this.caller && check(),
      canAccessProject: check, canAccessTask: check, canAccessSource: check, canAccessMcpServer: check, canAccessConnector: check,
      canUseSourcePlugin: (id: string) => check() && !!options.registry.get(id) }
    this.sources = new TaskSourceBackend({ ...shared, recurrence: options.recurrence, heartbeat: options.heartbeat, automation: options.automation, emit: options.emit, onFatalEvent: options.onFatalEvent })
    this.plugins = new TaskSourcePluginBackend({ ...shared, canManageConfiguration: check, canBorrowSourceCredentials: check, canResolveUnsavedConfig: check })
  }
  shutdown(): void { this.closing = true; this.backend.shutdown() }
  async close(): Promise<void> { this.shutdown(); await Promise.all([this.backend.close(), this.sources.close(), this.plugins.close()]) }
  private current(): void {
    const guard = this.context.getStore()
    if (this.closing || !guard) throw new ServiceProtocolError('INVALID_REQUEST')
    guard()
  }
  private run(operation: TaskLifecycleOperation, args: unknown[], guard: () => void): Promise<unknown> {
    return this.context.run(guard, async () => {
      guard()
      const codec = TASK_LIFECYCLE_CODECS[operation]
      const result = await this.backend.registry.invoke(operation, codec.encodeArguments(args as never), this.caller, new AbortController().signal)
      if (!codec.validateWireResult(result)) throw new ServiceProtocolError('INVALID_RESULT')
      const value = result as { defined: boolean; value?: import('../shared/service-protocol').JsonValue }
      return codec.decodeResult(value.defined ? value.value : undefined)
    })
  }
  private source(operation: TaskSourceOperation, args: unknown[], guard: () => void): Promise<unknown> {
    return this.context.run(guard, async () => {
      guard()
      const codec = TASK_SOURCE_CODECS[operation]
      const result = await this.sources.registry.invoke(operation, codec.encodeArguments(args as never), this.caller, new AbortController().signal)
      if (!codec.validateWireResult(result)) throw new ServiceProtocolError('INVALID_RESULT')
      const value = result as { defined: boolean; value?: import('../shared/service-protocol').JsonValue }
      return codec.decodeResult(value.defined ? value.value : undefined)
    })
  }
  syncSource(id: string, guard: () => void): Promise<unknown> { return this.source('taskSource:sync', [id], guard) }
  createSource(data: CreateTaskSourceData, guard: () => void): Promise<unknown> { return this.source('taskSource:create', [data], guard) }
  updateSource(id: string, data: UpdateTaskSourceData, guard: () => void): Promise<unknown> { return this.source('taskSource:update', [id, data], guard) }
  resolveOptions(id: string, resolver: string, config: Record<string, unknown>, guard: () => void): Promise<unknown> {
    return this.context.run(guard, async () => {
      guard()
      const codec = TASK_SOURCE_PLUGIN_CODECS['plugin:resolveOptions']
      const result = await this.plugins.registry.invoke('plugin:resolveOptions', codec.encodeArguments([id, resolver, config] as never), this.caller, new AbortController().signal)
      if (!codec.validateWireResult(result)) throw new ServiceProtocolError('INVALID_RESULT')
      const value = result as { defined: boolean; value?: import('../shared/service-protocol').JsonValue }
      return codec.decodeResult(value.defined ? value.value : undefined)
    })
  }
  create(data: CreateTaskData, guard: () => void): Promise<unknown> { return this.run('db:createTask', [data], guard) }
  update(id: string, data: UpdateTaskData, guard: () => void): Promise<unknown> { return this.run('db:updateTask', [id, data], guard) }
  async reorder(id: string, ids: string[], guard: () => void): Promise<unknown> {
    await this.run('db:reorderSubtasks', [id, ids], guard)
    return { success: true }
  }
  async complete(id: string, atSource: boolean, guard: () => void): Promise<unknown> {
    guard()
    const task = this.options.database.getTask(id)
    if (!task) throw new ServiceProtocolError('INVALID_REQUEST')
    if (task.source_id && atSource) {
      const result = await this.run('plugin:executeAction', [getTaskCompletionAction(task.output_fields), id, task.source_id], guard) as { success: boolean }
      return { completed: result.success, status: this.options.database.getTask(id)?.status }
    }
    await this.update(id, { status: 'completed', ...(task.source_id ? { complete_at_source: false } : {}) }, guard)
    return { completed: true, status: this.options.database.getTask(id)?.status }
  }
}

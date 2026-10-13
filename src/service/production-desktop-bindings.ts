import { TaskLifecycleBackend } from './task-lifecycle-backend'
import { ProductionAgentBackend } from './production-agent-backend'
import { CommanderBackend } from './commander-backend'
import { encodeDurableTranscriptEvent } from './transcript-events'
import { DatabaseBackend } from './database-backend'
import { ConfigurationBackend } from './configuration-backend'
import { AgentConfigurationBackend, type AgentConfigurationBackendOptions } from './agent-configuration-backend'
import type { ProductionOwner } from './production-owner'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'
import { TASK_LIFECYCLE_CODECS, TASK_LIFECYCLE_EVENT_CODECS } from '../shared/task-lifecycle-codecs'
import { PRODUCTION_AGENT_CODECS } from '../shared/production-agent-codecs'
import { PRODUCTION_AGENT_EVENT_CODECS } from '../shared/production-agent-events'
import { COMMANDER_COMMAND_CODECS, COMMANDER_EVENT_CODECS } from '../shared/commander-desktop-codecs'
import { AGENT_CONFIGURATION_EVENT_CODECS } from '../shared/agent-configuration-codecs'
import { DATABASE_COMMAND_CODECS, DATABASE_EVENT_CODECS } from '../shared/database-desktop-codecs'
import { CONFIGURATION_CONTENT_OPERATIONS, CONFIGURATION_COMMAND_CODECS, CONFIGURATION_EVENT_CODECS } from '../shared/configuration-desktop-codecs'
import { AGENT_CONFIGURATION_CODECS } from '../shared/agent-configuration-codecs'
import { ServiceProtocolError, isRecord, isJsonValue, type JsonValue } from '../shared/service-protocol'

type Authority = Pick<AgentConfigurationBackendOptions, 'isTrustedDesktop' | 'canAccessAgent' | 'canManageGlobalConfiguration' | 'canAccessProject' | 'canQueryBackend'> & {
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessSource(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessSession(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessGlobalCommander(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canCreateProject(caller: DesktopCallerContext): boolean
  canEditSettings(caller: DesktopCallerContext): boolean
  canAccessGlobalSkills(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canChangeSkillScope(caller: DesktopCallerContext): boolean
  canReorderProjects(caller: DesktopCallerContext): boolean
}
export interface ProductionDesktopBindingOptions {
  authority: Authority
  emit(operation: string, payload: JsonValue, recipient?: DesktopCallerContext): void
  fatal(error: ServiceProtocolError): void
}

/** Source codecs are separate from native grants; each domain has actual scope. */
export const PRODUCTION_COMMAND_CODECS = { ...DATABASE_COMMAND_CODECS,
  ...Object.fromEntries(CONFIGURATION_CONTENT_OPERATIONS.map(name => [name, CONFIGURATION_COMMAND_CODECS[name]])),
  ...AGENT_CONFIGURATION_CODECS, ...TASK_LIFECYCLE_CODECS, ...PRODUCTION_AGENT_CODECS, ...COMMANDER_COMMAND_CODECS }
export const PRODUCTION_EVENT_CODECS = { ...DATABASE_EVENT_CODECS, ...CONFIGURATION_EVENT_CODECS,
  ...PRODUCTION_AGENT_EVENT_CODECS, ...TASK_LIFECYCLE_EVENT_CODECS, ...COMMANDER_EVENT_CODECS, ...AGENT_CONFIGURATION_EVENT_CODECS }

/** Validate actual wire payload, including explicit binary envelopes. */
export function validateProductionEventWire(operation: string, payload: unknown): boolean {
  if (!Object.hasOwn(PRODUCTION_EVENT_CODECS, operation)) return false
  const codec = PRODUCTION_EVENT_CODECS[operation as keyof typeof PRODUCTION_EVENT_CODECS]
  try {
    if (operation === 'tasks:refresh') return codec.validatePayload(payload)
    const decoded = codec.decodePayload(payload as JsonValue)
    return codec.validatePayload(decoded)
  } catch { return false }
}

/** Attach reviewed domain bindings to the existing production singleton.
 * Settings remain content-scoped; task/session/Commander effects use their
 * actual lifecycle owners and exact domain codecs. */
export class ProductionDesktopBindings {
  private closed = false
  private readonly database: DatabaseBackend
  private readonly content: ConfigurationBackend
  private readonly agents: AgentConfigurationBackend
  private readonly tasks: TaskLifecycleBackend
  private readonly lifecycle: ProductionAgentBackend
  private readonly commander: CommanderBackend
  private readonly epoch: string
  private constructor(private readonly owner: ProductionOwner, private readonly services: Awaited<ReturnType<ProductionOwner['start']>>, private readonly options: ProductionDesktopBindingOptions) {
    const lease = owner.getDatabaseBindingLease()
    this.epoch = owner.snapshot().epoch
    const available = (): void => {
      if (this.closed || owner.snapshot().phase !== 'ready') throw new ServiceProtocolError('DISCONNECTED')
      lease.lock.assertHeld()
    }
    const { authority } = options
    // Scope can be withdrawn while raw authorization/effects are in flight.
    // Keep every check tied to the current trusted policy, never a cached grant.
    const dynamicAuthority = Object.fromEntries(Object.keys(authority).map(key => [key, (...args: unknown[]) => {
      const check = Reflect.get(authority, key)
      return typeof check === 'function' && Reflect.apply(check, authority, args)
    }])) as Authority
    this.database = new DatabaseBackend({ engineEpoch: this.epoch, ...lease, database: services.db,
      assertOwnerAvailable: available, isTrustedDesktop: dynamicAuthority.isTrustedDesktop,
      canAccessProject: (id, caller, access = 'read') => authority.canAccessProject(id, caller, access),
      canCreateProject: dynamicAuthority.canCreateProject, canEditSettings: dynamicAuthority.canEditSettings,
      canDeleteTask: (id, caller) => {
        const task = services.db.getTask(id)
        return (!task || authority.canAccessProject(task.project_id, caller, 'write')) && !services.agents.hasTaskStartOwnership(id)
      },
      emit: options.emit })
    this.content = new ConfigurationBackend({ database: services.db, engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: dynamicAuthority.isTrustedDesktop, canAccessProject: dynamicAuthority.canAccessProject,
      canAccessGlobalSkills: dynamicAuthority.canAccessGlobalSkills, canChangeSkillScope: dynamicAuthority.canChangeSkillScope,
      canReorderProjects: dynamicAuthority.canReorderProjects, emit: options.emit })
    this.agents = new AgentConfigurationBackend({ database: services.db, manager: services.agents, engineEpoch: this.epoch,
      assertAvailable: available, ...dynamicAuthority, emit: options.emit, onFatalEvent: options.fatal })
    this.tasks = new TaskLifecycleBackend({ database: services.db, manager: services.agents, registry: services.registry,
      sync: services.sync, recurrence: services.recurrence, heartbeat: services.heartbeat, automation: services.automation,
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority, emit: options.emit, onFatalEvent: options.fatal })
    this.lifecycle = new ProductionAgentBackend({ database: services.db, manager: services.agents,
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority })
    this.commander = new CommanderBackend({ database: services.db, store: services.commanderStore, commander: services.commander,
      chat: services.chat, agents: services.agents, createChatProvider: services.createChatProvider,
      engineEpoch: this.epoch, assertAvailable: available, ...dynamicAuthority, emit: options.emit, onFatalEvent: options.fatal })
    owner.retainCleanup('desktop-bindings', () => {
      this.closed = true; this.database.close(); this.lifecycle.shutdown(); this.commander.shutdown()
      void Promise.all([this.agents.close(), this.tasks.close()]).catch(() => { /* Registered drain retains raw work. */ })
    }, () => Promise.all([this.agents.close(), this.tasks.close(), this.lifecycle.close(), this.commander.close()]).then(() => undefined))
  }

  static async attach(owner: ProductionOwner, options: ProductionDesktopBindingOptions): Promise<ProductionDesktopBindings> {
    return owner.run(services => new ProductionDesktopBindings(owner, services, options))
  }

  hasOwnerEvent(operation: string): boolean { return Object.hasOwn(PRODUCTION_EVENT_CODECS, operation) }
  /** Raw owner events never bypass exact codecs or durable transcript projection. */
  encodeOwnerEvent(operation: string, payload: unknown): JsonValue {
    if (this.closed) throw new ServiceProtocolError('DISCONNECTED')
    if (!this.hasOwnerEvent(operation)) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    try {
      if (operation === 'transcript:changed') payload = encodeDurableTranscriptEvent(this.services.db, payload)
      if (operation === 'tasks:refresh' && payload === undefined) payload = {}
      const codec = PRODUCTION_EVENT_CODECS[operation as keyof typeof PRODUCTION_EVENT_CODECS]
      if ('encodePayload' in codec) return codec.encodePayload(payload as never)
      if (!codec.validatePayload(payload) || !isJsonValue(payload)) throw new ServiceProtocolError('INVALID_RESULT')
      return payload
    } catch {
      this.closed = true
      const error = new ServiceProtocolError('INVALID_RESULT')
      this.options.fatal(error)
      throw error
    }
  }

  /** Event delivery is a read grant separate from command permission. */
  projectOwnerEvent(operation: string, payload: JsonValue, caller: DesktopCallerContext): JsonValue | undefined {
    if (this.closed || caller.engineEpoch !== this.epoch || caller.principal !== 'trusted-desktop-main' || !this.options.authority.isTrustedDesktop(caller)) return undefined
    if (!validateProductionEventWire(operation, payload)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const authority = this.options.authority
    const taskAllowed = (id: unknown): boolean => {
      if (typeof id !== 'string' || !authority.canAccessTask(id, caller, 'read')) return false
      const task = this.services.db.getTask(id)
      return !task || authority.canAccessProject(task.project_id, caller, 'read')
    }
    if (operation === 'commander:event' || operation === 'chat:event') {
      const codec = COMMANDER_EVENT_CODECS[operation]
      const decoded = codec.decodePayload(payload)
      return this.commander.canReadEvent(operation, decoded, caller) ? payload : undefined
    }
    if (!isRecord(payload)) return undefined
    if (operation === 'agent:startQueueChanged') {
      const queue = (payload.queue as JsonValue[]).filter(row => isRecord(row) && taskAllowed(row.taskId) && typeof row.agentId === 'string' &&
        authority.canAccessAgent(row.agentId, caller, 'read') && typeof row.projectId === 'string' && authority.canAccessProject(row.projectId, caller, 'read'))
      return { queue, ...(isRecord(payload.failed) && taskAllowed(payload.failed.taskId) ? { failed: payload.failed as JsonValue } : {}) }
    }
    if (operation === 'tasks:refresh') return this.services.db.getProjects().some(project => authority.canAccessProject(project.id, caller, 'read')) ? payload : undefined
    if (operation === 'skills:changed' && !Object.hasOwn(payload, 'projectId'))
      return authority.canAccessGlobalSkills(caller, 'read') ? payload : undefined
    if (operation === 'task:created') return isRecord(payload.task) && taskAllowed(payload.task.id) ? payload : undefined
    if (typeof payload.taskId === 'string') {
      if (!taskAllowed(payload.taskId)) return undefined
      if (typeof payload.agentId === 'string' && !authority.canAccessAgent(payload.agentId, caller, 'read')) return undefined
      return payload
    }
    if (typeof payload.parentId === 'string') return taskAllowed(payload.parentId) ? payload : undefined
    if (typeof payload.projectId === 'string') return authority.canAccessProject(payload.projectId, caller, 'read') ? payload : undefined
    return undefined
  }

  /** Caller context is selected by trusted native ingress, never payload fields. */
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    const schemas = { ...this.database.operationSchemas(caller), ...this.content.operationSchemas(caller), ...this.agents.operationSchemas(caller),
      ...this.tasks.operationSchemas(caller), ...this.lifecycle.operationSchemas(caller), ...this.commander.operationSchemas(caller) }
    return Object.fromEntries(Object.entries(schemas).map(([operation, schema]) => [operation, {
      ...schema, handle: (payload: JsonValue, signal: AbortSignal) => this.invoke(operation, payload, caller, signal)
    }]))
  }

  async invoke(operation: string, payload: JsonValue, caller: DesktopCallerContext, signal: AbortSignal): Promise<JsonValue> {
    if (this.closed) throw new ServiceProtocolError('DISCONNECTED')
    if (caller.engineEpoch !== this.epoch) throw new ServiceProtocolError('STALE_EPOCH')
    return this.owner.run(async (_services, ownerSignal) => {
      const combined = new AbortController()
      const abort = (): void => combined.abort()
      signal.addEventListener('abort', abort, { once: true }); ownerSignal.addEventListener('abort', abort, { once: true })
      if (signal.aborted || ownerSignal.aborted) abort()
      try {
        if (Object.hasOwn(TASK_LIFECYCLE_CODECS, operation)) return await this.tasks.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(PRODUCTION_AGENT_CODECS, operation)) return await this.lifecycle.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(COMMANDER_COMMAND_CODECS, operation)) return await this.commander.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(DATABASE_COMMAND_CODECS, operation)) return await this.database.registry.invoke(operation, payload, caller, combined.signal)
        if ((CONFIGURATION_CONTENT_OPERATIONS as readonly string[]).includes(operation) && Object.hasOwn(CONFIGURATION_COMMAND_CODECS, operation))
          return await this.content.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(AGENT_CONFIGURATION_CODECS, operation)) return await this.agents.registry.invoke(operation, payload, caller, combined.signal)
        throw new ServiceProtocolError('UNKNOWN_OPERATION')
      } finally { signal.removeEventListener('abort', abort); ownerSignal.removeEventListener('abort', abort) }
    })
  }
}

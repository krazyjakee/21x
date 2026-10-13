import { DatabaseBackend } from './database-backend'
import { ConfigurationBackend } from './configuration-backend'
import { AgentConfigurationBackend, type AgentConfigurationBackendOptions } from './agent-configuration-backend'
import type { ProductionOwner } from './production-owner'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'
import { DATABASE_COMMAND_CODECS } from '../shared/database-desktop-codecs'
import { CONFIGURATION_CONTENT_OPERATIONS, CONFIGURATION_COMMAND_CODECS } from '../shared/configuration-desktop-codecs'
import { AGENT_CONFIGURATION_CODECS } from '../shared/agent-configuration-codecs'
import { ServiceProtocolError, type JsonValue } from '../shared/service-protocol'

type Authority = Pick<AgentConfigurationBackendOptions, 'isTrustedDesktop' | 'canAccessAgent' | 'canManageGlobalConfiguration' | 'canAccessProject' | 'canQueryBackend'> & {
  canCreateProject(caller: DesktopCallerContext): boolean
  canEditSettings(caller: DesktopCallerContext): boolean
  canAccessGlobalSkills(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canChangeSkillScope(caller: DesktopCallerContext): boolean
  canReorderProjects(caller: DesktopCallerContext): boolean
}
export interface ProductionDesktopBindingOptions {
  authority: Authority
  emit(operation: string, payload: JsonValue): void
  fatal(error: ServiceProtocolError): void
}

/** Attach reviewed domain bindings to the existing production singleton.
 * Synthetic-profile settings/task write restrictions remain intentionally
 * narrow until their complete lifecycle codecs are implemented. */
export class ProductionDesktopBindings {
  private closed = false
  private readonly database: DatabaseBackend
  private readonly content: ConfigurationBackend
  private readonly agents: AgentConfigurationBackend
  private readonly epoch: string
  private constructor(private readonly owner: ProductionOwner, services: Awaited<ReturnType<ProductionOwner['start']>>, options: ProductionDesktopBindingOptions) {
    const lease = owner.getDatabaseBindingLease()
    this.epoch = owner.snapshot().epoch
    const available = (): void => {
      if (this.closed || owner.snapshot().phase !== 'ready') throw new ServiceProtocolError('DISCONNECTED')
      lease.lock.assertHeld()
    }
    const { authority } = options
    this.database = new DatabaseBackend({ engineEpoch: this.epoch, ...lease, database: services.db,
      assertOwnerAvailable: available, isTrustedDesktop: authority.isTrustedDesktop,
      canAccessProject: (id, caller, access = 'read') => authority.canAccessProject(id, caller, access),
      canCreateProject: authority.canCreateProject, canEditSettings: authority.canEditSettings,
      canDeleteTask: (id, caller) => {
        const task = services.db.getTask(id)
        return (!task || authority.canAccessProject(task.project_id, caller, 'write')) && !services.agents.hasTaskStartOwnership(id)
      },
      emit: options.emit })
    this.content = new ConfigurationBackend({ database: services.db, engineEpoch: this.epoch, assertAvailable: available,
      isTrustedDesktop: authority.isTrustedDesktop, canAccessProject: authority.canAccessProject,
      canAccessGlobalSkills: authority.canAccessGlobalSkills, canChangeSkillScope: authority.canChangeSkillScope,
      canReorderProjects: authority.canReorderProjects, emit: options.emit })
    this.agents = new AgentConfigurationBackend({ database: services.db, manager: services.agents, engineEpoch: this.epoch,
      assertAvailable: available, ...authority, emit: options.emit, onFatalEvent: options.fatal })
    owner.retainCleanup('desktop-bindings', () => {
      this.closed = true; this.database.close()
      void this.agents.close().catch(() => { /* The registered drain retains raw operations. */ })
    }, () => this.agents.close())
  }

  static async attach(owner: ProductionOwner, options: ProductionDesktopBindingOptions): Promise<ProductionDesktopBindings> {
    return owner.run(services => new ProductionDesktopBindings(owner, services, options))
  }

  /** Caller context is selected by trusted native ingress, never payload fields. */
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    const schemas = { ...this.database.operationSchemas(caller), ...this.content.operationSchemas(caller), ...this.agents.operationSchemas(caller) }
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
        if (Object.hasOwn(DATABASE_COMMAND_CODECS, operation)) return await this.database.registry.invoke(operation, payload, caller, combined.signal)
        if ((CONFIGURATION_CONTENT_OPERATIONS as readonly string[]).includes(operation) && Object.hasOwn(CONFIGURATION_COMMAND_CODECS, operation))
          return await this.content.registry.invoke(operation, payload, caller, combined.signal)
        if (Object.hasOwn(AGENT_CONFIGURATION_CODECS, operation)) return await this.agents.registry.invoke(operation, payload, caller, combined.signal)
        throw new ServiceProtocolError('UNKNOWN_OPERATION')
      } finally { signal.removeEventListener('abort', abort); ownerSignal.removeEventListener('abort', abort) }
    })
  }
}

import type { DatabaseManager } from '../main/database/manager'
import { SkillVersionConflictError } from '../main/database/types'
import type { CreateSkillData, UpdateSkillData } from '../main/database/types'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import {
  CONFIGURATION_COMMAND_CODECS, CONFIGURATION_DESKTOP_EVENTS, CONFIGURATION_CONTENT_OPERATIONS,
  CONFIGURATION_EVENT_CODECS, projectPublicProject,
  type ConfigurationDesktopEvent
} from '../shared/configuration-desktop-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export const CONFIGURATION_BOUND_OPERATIONS = CONFIGURATION_CONTENT_OPERATIONS
type Operation = typeof CONFIGURATION_BOUND_OPERATIONS[number]
type Access = 'read' | 'write'
type Notify = (operation: ConfigurationDesktopEvent, payload: JsonValue, skillScopes?: readonly (string | null)[]) => void

export interface ConfigurationBackendOptions {
  database: DatabaseManager
  engineEpoch: string
  /** Must assert the shared lifetime lock, database openness and owner liveness. */
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  /** Caller identity and scope originate from the host, never command payloads. */
  canAccessProject(projectId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessGlobalSkills(caller: DesktopCallerContext, access: Access): boolean
  canChangeSkillScope(caller: DesktopCallerContext): boolean
  canReorderProjects(caller: DesktopCallerContext): boolean
  /** Trusted desktop invalidation sink; the service transport supplies sequence/epoch. */
  emit(operation: ConfigurationDesktopEvent, payload: JsonValue): void
  /** Source-private scope receipts; never added to the retained event DTO. */
  emitSkillInvalidation?(payload: JsonValue, scopes: readonly (string | null)[]): void
}

/** Content-only bindings sharing the actual database; no alternate state writer. */
export class ConfigurationBackend {
  readonly registry: DesktopOperationRegistry
  constructor(private readonly options: ConfigurationBackendOptions) {
    options.assertAvailable()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of CONFIGURATION_DESKTOP_EVENTS) this.registry.bindEvent(operation, {
      validatePayload: CONFIGURATION_EVENT_CODECS[operation].validatePayload,
      encodePayload: value => {
        if (!CONFIGURATION_EVENT_CODECS[operation].validatePayload(value) || !isJsonValue(value)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        return value
      }
    })
    this.bindCommands()
  }

  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(CONFIGURATION_BOUND_OPERATIONS.map(operation => [operation, {
      validatePayload: (payload: unknown) => {
        try { return isJsonValue(payload) && CONFIGURATION_COMMAND_CODECS[operation].validateArguments(CONFIGURATION_COMMAND_CODECS[operation].decodeArguments(payload)) }
        catch { return false }
      },
      validateResult: CONFIGURATION_COMMAND_CODECS[operation].validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, payload, caller, signal)
    }]))
  }

  private projectAllowed(id: string, caller: DesktopCallerContext, access: Access): boolean {
    return !!this.options.database.getProject(id) && this.options.canAccessProject(id, caller, access)
  }

  private skillScopeAllowed(projectId: string | null, caller: DesktopCallerContext, access: Access): boolean {
    return projectId === null ? this.options.canAccessGlobalSkills(caller, access) : this.projectAllowed(projectId, caller, access)
  }

  private skillAllowed(id: string, caller: DesktopCallerContext): boolean {
    const skill = this.options.database.getSkill(id)
    // Legacy missing updates/deletes retain undefined/false; foreign rows deny.
    return !skill || this.skillScopeAllowed(skill.project_id, caller, 'write')
  }

  private childAllowed(kind: 'repo' | 'resource', id: string, caller: DesktopCallerContext): boolean {
    const db = this.options.database
    const child = kind === 'repo' ? db.getProjectRepo(id) : db.getProjectResource(id)
    return !child || this.projectAllowed(child.project_id, caller, 'write')
  }

  private completeOrder(actual: readonly { id: string }[], ordered: readonly string[]): boolean {
    const ids = new Set(ordered)
    return actual.length === ordered.length && ids.size === ordered.length && actual.every(row => ids.has(row.id))
  }

  private bind<K extends Operation>(operation: K,
    authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, notify: Notify) => unknown): void {
    const codec = CONFIGURATION_COMMAND_CODECS[operation]
    this.registry.bindCommand(operation, {
      decodeRequest: codec.decodeArguments, validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.options.assertAvailable(); return authorize(args, caller) },
      invoke: (args, caller, signal) => {
        this.options.assertAvailable()
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        const notifications: Array<{ operation: ConfigurationDesktopEvent; payload: JsonValue; skillScopes?: readonly (string | null)[] }> = []
        let result: DesktopCommandMap[K]['result']
        try {
          result = this.options.database.db.transaction(() => {
            // Registry authorization yields at an await boundary. Recheck scope,
            // associations and the complete reorder set in the write transaction.
            this.options.assertAvailable()
            if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
            if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
            const encoded = codec.encodeResult(effect(args, caller, (event, payload, skillScopes) => {
              const validated = this.registry.encodeEvent(event, payload, { principal: 'service', engineEpoch: this.options.engineEpoch })
              notifications.push({ operation: event, payload: validated, skillScopes })
            }))
            // Projection/result failures roll back the mutation before any event.
            return codec.decodeResult(encoded.defined ? encoded.value : undefined)
          })()
        } catch (error) {
          if (error instanceof SkillVersionConflictError) throw new ServiceProtocolError('SKILL_VERSION_CONFLICT')
          throw error
        }
        for (const event of notifications) {
          if (event.operation === 'skills:changed' && event.skillScopes && this.options.emitSkillInvalidation) this.options.emitSkillInvalidation(event.payload, event.skillScopes)
          else this.options.emit(event.operation, event.payload)
        }
        return result
      },
      validateResult: codec.validateResult, encodeResult: codec.encodeResult
    })
  }

  private bindCommands(): void {
    const db = this.options.database
    const skillChanged = (notify: Notify, id: string, kind: string, scopes: readonly (string | null)[]): void => notify('skills:changed', { skillId: id, kind }, scopes)
    const projectChanged = (notify: Notify, id: string, kind: string): void => notify('project:changed', { projectId: id, kind })
    this.bind('skills:getAll', () => true, (_args, caller) => db.getSkills().filter(skill => this.skillScopeAllowed(skill.project_id, caller, 'read')))
    this.bind('skills:create', ([data], caller) => this.skillScopeAllowed((data.project_id as string | null | undefined) ?? null, caller, 'write'), ([data], _caller, notify) => {
      if (db.getSkillByName(data.name as string)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      const skill = db.createSkill(data as unknown as CreateSkillData)
      if (!skill) throw new ServiceProtocolError('INTERNAL_ERROR')
      skillChanged(notify, skill.id, 'created', [skill.project_id])
      return skill
    })
    this.bind('skills:update', ([id], caller) => this.skillAllowed(id, caller), ([id, data], _caller, notify) => {
      const existing = db.getSkill(id)
      if (!existing) return undefined
      const collision = data.name === undefined ? undefined : db.getSkillByName(data.name as string)
      if (collision && collision.id !== id) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      const skill = db.updateSkill(id, data as unknown as UpdateSkillData)
      if (skill && (skill.version !== existing.version || skill.uses !== existing.uses || skill.last_used !== existing.last_used)) skillChanged(notify, id, 'updated', [existing.project_id])
      return skill
    })
    this.bind('skills:delete', ([id], caller) => this.skillAllowed(id, caller), ([id], _caller, notify) => {
      const scope = db.getSkill(id)?.project_id
      const deleted = db.deleteSkill(id)
      if (deleted && scope !== undefined) skillChanged(notify, id, 'removed', [scope])
      return deleted
    })
    this.bind('skills:setProject', ([id, destination], caller) => this.options.canChangeSkillScope(caller) && this.skillAllowed(id, caller) && this.skillScopeAllowed(destination, caller, 'write'), ([id, destination], _caller, notify) => {
      const existing = db.getSkill(id)
      if (!existing || existing.project_id === destination) return existing
      if (destination !== null && (db.getTasksUsingSkill(id).some(task => task.project_id !== destination) || db.getAgents().some(agent => agent.config.skill_ids?.includes(id)))) {
        throw new ServiceProtocolError('INVALID_REQUEST')
      }
      const skill = db.setSkillProject(id, destination)
      if (skill) skillChanged(notify, id, 'scope', [existing.project_id, destination])
      return skill
    })
    // These DTOs cannot replace settings/default-agent/Captain fields. The codec
    // rejects private fields in existing settings before any content mutation.
    this.bind('project:update', ([id], caller) => this.projectAllowed(id, caller, 'write'), ([id, data], _caller, notify) => {
      projectPublicProject(db.getProject(id))
      const project = db.updateProject(id, data)
      if (project) projectChanged(notify, id, 'updated')
      return project
    })
    this.bind('project:archive', ([id], caller) => this.projectAllowed(id, caller, 'write'), ([id, archived = true], _caller, notify) => {
      if (id === DEFAULT_PROJECT_ID && archived) throw new ServiceProtocolError('INVALID_REQUEST')
      projectPublicProject(db.getProject(id))
      const project = db.archiveProject(id, archived)
      if (project) projectChanged(notify, id, archived ? 'archived' : 'restored')
      return project
    })
    this.bind('project:reorder', ([ids], caller) => this.options.canReorderProjects(caller) &&
      this.completeOrder(db.getProjects({ includeArchived: true }), ids) && ids.every(id => this.projectAllowed(id, caller, 'write')), ([ids], _caller, notify) => {
      db.reorderProjects(ids)
      for (const id of ids) projectChanged(notify, id, 'updated')
    })
    this.bind('projectRepo:list', ([id], caller) => this.projectAllowed(id, caller, 'read'), ([id]) => db.getProjectRepos(id))
    this.bind('projectRepo:add', ([id], caller) => this.projectAllowed(id, caller, 'write'), ([id, data], _caller, notify) => {
      const repo = db.addProjectRepo(id, data)
      if (repo) projectChanged(notify, id, 'repos')
      return repo
    })
    this.bind('projectRepo:update', ([id], caller) => this.childAllowed('repo', id, caller), ([id, data], _caller, notify) => {
      const repo = db.updateProjectRepo(id, data)
      if (repo) projectChanged(notify, repo.project_id, 'repos')
      return repo
    })
    this.bind('projectRepo:remove', ([id], caller) => this.childAllowed('repo', id, caller), ([id], _caller, notify) => {
      const existing = db.getProjectRepo(id)
      const deleted = db.removeProjectRepo(id)
      if (deleted && existing) projectChanged(notify, existing.project_id, 'repos')
      return deleted
    })
    this.bind('projectRepo:reorder', ([id, ids], caller) => this.projectAllowed(id, caller, 'write') && this.completeOrder(db.getProjectRepos(id), ids), ([id, ids], _caller, notify) => {
      db.reorderProjectRepos(id, ids)
      projectChanged(notify, id, 'repos')
    })
    this.bind('projectResource:list', ([id], caller) => this.projectAllowed(id, caller, 'read'), ([id]) => db.getProjectResources(id))
    this.bind('projectResource:add', ([id], caller) => this.projectAllowed(id, caller, 'write'), ([id, data], _caller, notify) => {
      const resource = db.addProjectResource(id, data)
      if (resource) projectChanged(notify, id, 'resources')
      return resource
    })
    this.bind('projectResource:update', ([id], caller) => this.childAllowed('resource', id, caller), ([id, data], _caller, notify) => {
      const resource = db.updateProjectResource(id, data)
      if (resource) projectChanged(notify, resource.project_id, 'resources')
      return resource
    })
    this.bind('projectResource:remove', ([id], caller) => this.childAllowed('resource', id, caller), ([id], _caller, notify) => {
      const existing = db.getProjectResource(id)
      const deleted = db.removeProjectResource(id)
      if (deleted && existing) projectChanged(notify, existing.project_id, 'resources')
      return deleted
    })
    this.bind('projectResource:reorder', ([id, ids], caller) => this.projectAllowed(id, caller, 'write') && this.completeOrder(db.getProjectResources(id), ids), ([id, ids], _caller, notify) => {
      db.reorderProjectResources(id, ids)
      projectChanged(notify, id, 'resources')
    })
  }
}

import { AgentManager } from '../main/agent-manager-core'
import type { DatabaseManager } from '../main/database/manager'
import { resolveCaptainAgentId } from '../main/captain-waker'
import type { CreateProjectData, UpdateProjectData, ProjectRecord } from '../shared/projects'
import { CONFIGURATION_EVENT_CODECS } from '../shared/configuration-desktop-codecs'
import { PROJECT_CONFIGURATION_CODECS, PROJECT_CONFIGURATION_OPERATIONS, isProjectConfigurationSettings, type ProjectConfigurationOperation } from '../shared/project-configuration-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
export interface ProjectConfigurationBackendOptions {
  database: DatabaseManager
  manager: AgentManager
  engineEpoch: string
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canCreateProject(caller: DesktopCallerContext): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessSession(id: string, caller: DesktopCallerContext, access: Access): boolean
  emit(operation: 'project:changed', payload: JsonValue): void
  onFatalEvent(error: ServiceProtocolError): void
}

/** The same SQLite project owner and actual AgentManager as task starts.
 * Accepted raw Captain retirement stays owned through cancellation/shutdown. */
export class ProjectConfigurationBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private failed = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly options: ProjectConfigurationBackendOptions) {
    if (!(options.manager instanceof AgentManager)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of PROJECT_CONFIGURATION_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid project configuration shutdown deadline')
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(PROJECT_CONFIGURATION_OPERATIONS.map(operation => [operation, {
      validatePayload: (v: unknown) => { try { return isJsonValue(v) && PROJECT_CONFIGURATION_CODECS[operation].validateArguments(PROJECT_CONFIGURATION_CODECS[operation].decodeArguments(v)) } catch { return false } },
      validateResult: PROJECT_CONFIGURATION_CODECS[operation].validateWireResult,
      handle: (v: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, v, caller, signal)
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || this.failed || !this.options.database.db.open) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable()
  }
  private authorized(caller: DesktopCallerContext, signal: AbortSignal): void {
    this.available(signal)
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !caller.webviewId || !caller.origin || !this.options.isTrustedDesktop(caller)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private committed(id: string, kind: 'created' | 'updated'): void {
    const payload = { projectId: id, kind }
    if (!CONFIGURATION_EVENT_CODECS['project:changed'].validatePayload(payload)) throw new ServiceProtocolError('INVALID_RESULT')
    try { this.options.emit('project:changed', payload) }
    catch { this.failed = true; this.options.onFatalEvent(new ServiceProtocolError('DISCONNECTED')); throw new ServiceProtocolError('DISCONNECTED') }
  }
  private async execute(operation: ProjectConfigurationOperation, args: unknown[], caller: DesktopCallerContext, signal: AbortSignal): Promise<ProjectRecord> {
    const { database: db, manager } = this.options
    const create = operation === 'project:create', id = create ? undefined : args[0] as string
    const input = args[create ? 0 : 1] as CreateProjectData | UpdateProjectData
    const check = (): void => {
      this.authorized(caller, signal)
      if (create ? !this.options.canCreateProject(caller) : !id || !this.options.canAccessProject(id, caller, 'read') || !this.options.canAccessProject(id, caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST')
      for (const value of [input.default_agent_id, input.captain_agent_id]) if (value && (!this.options.canAccessAgent(value, caller, 'read') || !db.db.prepare('SELECT 1 FROM agents WHERE id=?').get(value))) throw new ServiceProtocolError('INVALID_REQUEST')
    }
    check()
    const readProject = (): ProjectRecord | undefined => {
      const size = db.db.prepare(`SELECT length(CAST(settings AS BLOB)) AS settings_bytes,
        length(CAST(name AS BLOB)) AS name_bytes,length(CAST(description AS BLOB)) AS description_bytes,
        length(CAST(default_agent_id AS BLOB)) AS default_bytes,length(CAST(captain_agent_id AS BLOB)) AS captain_bytes,
        length(CAST(git_provider AS BLOB)) AS provider_bytes,length(CAST(git_org AS BLOB)) AS org_bytes
        FROM projects WHERE id=?`).get(id) as Record<string, number | null> | undefined
      if (size && Object.entries(size).some(([key, value]) => value !== null && (!Number.isSafeInteger(value) || value < 0 || value >
        (key === 'settings_bytes' ? 65_536 : key === 'description_bytes' ? 262_144 : key === 'name_bytes' || key === 'org_bytes' ? 2048 : 128)))) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      const project = id ? db.getProject(id) : undefined
      if (project && !isProjectConfigurationSettings(project.settings)) throw new ServiceProtocolError('INVALID_REQUEST')
      return project
    }
    const original = id ? readProject() : undefined
    let expectedProject = original
    if (!create && !original) throw new ServiceProtocolError('INVALID_REQUEST')
    // Capture only public project and agent identities; never materialize
    // encrypted agent configs to resolve the Captain's fallback selection.
    const agentRows = () => {
      const bounds = db.db.prepare("SELECT COUNT(*) AS count,COALESCE(MAX(length(CAST(id AS BLOB))),0) AS bytes,COALESCE(SUM(CASE WHEN typeof(id)!='text' OR is_default NOT IN (0,1) THEN 1 ELSE 0 END),0) AS invalid FROM agents").get() as { count: number; bytes: number; invalid: number }
      if (bounds.count > 128 || bounds.bytes > 128 || bounds.invalid) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      return db.db.prepare('SELECT id,is_default FROM agents ORDER BY created_at ASC LIMIT 129').all() as Array<{ id: string; is_default: number }>
    }
    const identities = agentRows()
    if (identities.length > 128) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const agents = identities.map(row => ({ id: row.id, is_default: !!row.is_default }))
    const resolve = (project: Pick<ProjectRecord, 'captain_agent_id' | 'default_agent_id'>) => resolveCaptainAgentId({ getAgents: () => agents as ReturnType<DatabaseManager['getAgents']> }, project)
    const next = { ...original, ...input }
    const nextCaptain = resolve(next as ProjectRecord)
    const currentCaptain = original && resolve(original)
    const captain = id ? db.getCoordinatorTask(id) : undefined
    if (!create && !captain) throw new ServiceProtocolError('INVALID_REQUEST')
    let retirement: { taskId: string; agentId: string | null; sessionId?: string } | undefined
    const retained = (): void => {
      check()
      if (JSON.stringify(agentRows()) !== JSON.stringify(identities) || id && JSON.stringify(readProject()) !== JSON.stringify(expectedProject)) throw new ServiceProtocolError('INVALID_REQUEST')
      for (const value of [original?.default_agent_id, original?.captain_agent_id, currentCaptain, nextCaptain]) if (value && !this.options.canAccessAgent(value, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
      if (retirement && (!this.options.canAccessTask(retirement.taskId, caller, 'write') || retirement.agentId && !this.options.canAccessAgent(retirement.agentId, caller, 'write') ||
        retirement.sessionId && !this.options.canAccessSession(retirement.sessionId, caller, 'write'))) throw new ServiceProtocolError('INVALID_REQUEST')
    }
    retained()
    const commit = (): ProjectRecord => {
      const updated = db.db.transaction(() => {
      retained()
      const data = structuredClone(input)
      if (data.settings !== undefined) {
        const settings = { ...data.settings }
        if (original?.settings.concurrency !== undefined) settings.concurrency = original.settings.concurrency
        else delete settings.concurrency
        if (!isProjectConfigurationSettings(settings)) throw new ServiceProtocolError('FRAME_TOO_LARGE')
        data.settings = settings
      }
      const updated = create ? db.createProject(data as CreateProjectData) : db.updateProject(id!, data)
      const result = PROJECT_CONFIGURATION_CODECS[operation].encodeResult(updated)
      const projected = PROJECT_CONFIGURATION_CODECS[operation].decodeResult(result.value)
      if (!projected) throw new ServiceProtocolError('INVALID_RESULT')
      return projected
      })()
      expectedProject = updated
      manager.recheckStartQueue()
      this.committed(updated.id, create ? 'created' : 'updated')
      return updated
    }
    let updated: ProjectRecord
    if (create) updated = commit()
    else updated = await manager.withTaskGroupRequestGuard(() => manager.runProjectConfigurationMutation(id!, async () => {
      retained()
      // Stop the exact old owner BEFORE publishing a different selection. A
      // refused raw stop leaves the persisted project unchanged and retryable.
      const live = manager.findSessionByTaskId(captain!.id)
      const selectionChanged = nextCaptain !== currentCaptain
      if (selectionChanged && manager.hasTaskStartOwnership(captain!.id) || live && live.session.agentId !== nextCaptain) {
        retirement = { taskId: captain!.id, agentId: live?.session.agentId ?? currentCaptain ?? null, ...(live ? { sessionId: live.sessionId } : {}) }
        const stopGuard = (): void => {
          retained()
          if (!this.options.canAccessTask(captain!.id, caller, 'write') ||
            live && (!this.options.canAccessSession(live.sessionId, caller, 'write') || !this.options.canAccessAgent(live.session.agentId, caller, 'write'))) throw new ServiceProtocolError('INVALID_REQUEST')
        }
        stopGuard()
        await manager.stopByTaskId(captain!.id)
        stopGuard()
      }
      retained()
      return commit()
    }), retained, signal)
    return updated
  }
  private bind<K extends ProjectConfigurationOperation>(operation: K): void {
    const codec = PROJECT_CONFIGURATION_CODECS[operation]
    this.registry.bindCommand(operation, {
      decodeRequest: payload => codec.decodeArguments(structuredClone(payload)), validateArguments: codec.validateArguments,
      authorize: (_args, caller) => { this.available(); return this.options.isTrustedDesktop(caller) },
      invoke: (args, caller, signal) => {
        const controller = new AbortController()
        const cancel = () => controller.abort()
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) controller.abort()
        this.controllers.add(controller)
        // Admit the raw flight before callbacks or manager work can reenter.
        const flight = Promise.resolve().then(() => this.execute(operation, args, caller, controller.signal)).finally(() => {
          this.controllers.delete(controller); signal.removeEventListener('abort', cancel)
        })
        this.flights.add(flight)
        void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight))
        return flight
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult
    })
  }
}

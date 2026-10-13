import type { AgentManager } from '../main/agent-manager-core'
import type { DatabaseManager } from '../main/database/manager'
import { DeterministicAgentAdapter } from './fixtures/deterministic-agent-adapter'
import {
  AGENT_COMMAND_CODECS, AGENT_DESKTOP_EVENTS, AGENT_DESKTOP_OPERATIONS, AGENT_EVENT_CODECS, AGENT_QUEUE_FIELDS, AGENT_RECOVERY_ERROR,
  type AgentDesktopEvent, type AgentDesktopOperation
} from '../shared/agent-desktop-codecs'
import { DATABASE_COMMAND_CODECS } from '../shared/database-desktop-codecs'
import { encodeDurableTranscriptEvent } from './transcript-events'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface AgentBackendOptions {
  fixtureMode: 'synthetic-only'
  database: DatabaseManager
  manager: AgentManager
  fixtureAdapter: DeterministicAgentAdapter
  fixtureAgentId: string
  fixtureTaskId: string
  engineEpoch: string
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessProject(projectId: string, caller: DesktopCallerContext): boolean
  emit(operation: AgentDesktopEvent, payload: JsonValue): void
  /** Must disconnect the transport; actual manager catches listener exceptions. */
  onFatalEvent(error: ServiceProtocolError, operation: AgentDesktopEvent | 'unreviewed'): void
}

/** Synthetic-only bridge to the actual lifecycle owner; no session simulator. */
export class AgentBackend {
  readonly registry: DesktopOperationRegistry
  private disposed = false
  private failed = false
  private readonly approvalsInFlight = new Set<string>()
  private readonly listener = (operation: string, payload: unknown): void => this.acceptOwnerEvent(operation, payload)

  /** Internal owner ingress; never registered as a renderer/service operation. */
  acceptOwnerEvent(operation: string, payload: unknown): void {
    if (this.disposed || this.failed) return
    try { this.forwardOwnerEvent(operation, payload) }
    catch {
      this.failed = true
      this.options.onFatalEvent(new ServiceProtocolError('INVALID_FRAME'), Object.hasOwn(AGENT_EVENT_CODECS, operation) ? operation as AgentDesktopEvent : 'unreviewed')
    }
  }

  constructor(private readonly options: AgentBackendOptions) {
    if (options.fixtureMode !== 'synthetic-only' || !(options.fixtureAdapter instanceof DeterministicAgentAdapter)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    options.assertAvailable()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of AGENT_DESKTOP_EVENTS) this.registry.bindEvent(operation, {
      validatePayload: AGENT_EVENT_CODECS[operation].validatePayload,
      encodePayload: value => {
        if (!AGENT_EVENT_CODECS[operation].validatePayload(value) || !isJsonValue(value)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        return value
      }
    })
    this.bindCommands()
    options.manager.addExternalListener(this.listener)
  }

  /** Dispose after the owner stops and its projection events have drained. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.options.manager.removeExternalListener(this.listener)
  }

  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(AGENT_DESKTOP_OPERATIONS.map(operation => [operation, {
      validatePayload: (payload: unknown) => {
        try { return isJsonValue(payload) && AGENT_COMMAND_CODECS[operation].validateArguments(AGENT_COMMAND_CODECS[operation].decodeArguments(payload)) }
        catch { return false }
      },
      validateResult: AGENT_COMMAND_CODECS[operation].validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, payload, caller, signal)
    }]))
  }

  private available(): void {
    if (this.disposed || this.failed) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable()
  }

  private fixtureAgent(): boolean {
    const agent = this.options.database.getAgent(this.options.fixtureAgentId)
    const config = agent?.config
    return !!config && config.coding_agent === 'opencode' && config.permission_mode === 'ask' &&
      !config.mcp_servers?.length && !config.secret_ids?.length && !config.skill_ids?.length && !config.fallback_agent_ids?.length &&
      !Object.values(config.api_keys ?? {}).some(Boolean)
  }

  private taskAllowed(id: string, caller?: DesktopCallerContext, allowUnassigned = false): boolean {
    const task = this.options.database.getTask(id)
    return id === this.options.fixtureTaskId && !!task && !!this.options.database.getProject(task.project_id) && this.fixtureAgent() &&
      task.role === 'task' && task.source === 'local' && task.source_id === null && task.parent_task_id === null &&
      !task.auto_start_agent && !task.auto_complete_without_review && !task.is_recurring && !task.heartbeat_enabled &&
      (task.agent_id === this.options.fixtureAgentId || allowUnassigned && task.agent_id === null) &&
      (!caller || this.options.canAccessProject(task.project_id, caller))
  }

  private sessionAllowed(id: string, caller: DesktopCallerContext): boolean {
    const session = this.options.manager.getSession(id) // Exact key: never follow owner redirects at this boundary.
    const task = session && this.options.database.getTask(session.taskId)
    return !!session && !!task && task.session_id === id && session.agentId === this.options.fixtureAgentId &&
      session.adapter === this.options.fixtureAdapter && this.taskAllowed(session.taskId, caller)
  }

  private bind<K extends AgentDesktopOperation>(operation: K,
    authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>): void {
    const codec = AGENT_COMMAND_CODECS[operation]
    this.registry.bindCommand(operation, {
      decodeRequest: codec.decodeArguments, validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.available(); return authorize(args, caller) },
      invoke: async (args, caller, signal) => {
        this.available()
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = await effect(args, caller, signal)
        this.available()
        const encoded = codec.encodeResult(result)
        return codec.decodeResult(encoded.defined ? encoded.value : undefined)
      },
      validateResult: codec.validateResult, encodeResult: codec.encodeResult
    })
  }

  private bindCommands(): void {
    const { database: db, manager, fixtureAgentId, fixtureAdapter } = this.options
    this.bind('agent:getAll', (_args, caller) => this.taskAllowed(this.options.fixtureTaskId, caller, true), () => {
      const agent = db.getAgent(fixtureAgentId)
      return agent ? [agent] : [] // Codec selects public fields; no raw Agent spread.
    })
    this.bind('agentSession:start', ([agentId, taskId, workspace, skip], caller) => agentId === fixtureAgentId && workspace === undefined && skip !== true &&
      this.taskAllowed(taskId, caller, true) && db.getTask(taskId)?.status !== 'completed', async ([agentId, taskId, _workspace, skip], caller, signal) => {
      if (db.getTask(taskId)?.agent_id === null) {
        db.updateTask(taskId, { agent_id: fixtureAgentId })
        this.listener('task:updated', { taskId, updates: {} })
        this.available()
      }
      // The actual UI assignment remains if startup fails. No fabricated rollback
      // or retry can erase a real manager/adapter effect with uncertain outcome.
      const outcome = await manager.requestSession(agentId, taskId, undefined, skip)
      if (outcome.status === 'queued') return { sessionId: '', queued: true, queuePosition: outcome.position, queueReason: outcome.reason }
      if (!this.sessionAllowed(outcome.sessionId, caller)) throw new ServiceProtocolError('INVALID_RESULT')
      if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
      return { sessionId: outcome.sessionId }
    })
    this.bind('agentSession:resume', ([agentId, taskId, sessionId], caller) => agentId === fixtureAgentId && this.taskAllowed(taskId, caller) &&
      db.getTask(taskId)?.session_id === sessionId && (!manager.getSession(sessionId) || this.sessionAllowed(sessionId, caller)), async ([agentId, taskId, sessionId], caller) => {
      const resumed = await manager.resumeSession(agentId, taskId, sessionId)
      if (!resumed) return { sessionId: '', ended: true }
      if (resumed !== sessionId || !this.sessionAllowed(resumed, caller)) throw new ServiceProtocolError('INVALID_RESULT')
      const current = manager.getSessionStatus(resumed)
      if (!current) throw new ServiceProtocolError('INVALID_RESULT')
      // Live-owner resume can return without a transition. Publish its actual
      // current state for renderer reload without manager transition side effects
      // or fabricated activity/backend-health stamps.
      this.listener('agent:status', { sessionId: resumed, ...current })
      this.available()
      return { sessionId: resumed }
    })
    this.bind('agentSession:approve', ([sessionId, _approved, _message, responseType], caller) => responseType !== 'question' && this.sessionAllowed(sessionId, caller),
      async ([sessionId, approved, message, responseType, requestId], caller) => {
        if (this.approvalsInFlight.has(sessionId)) throw new ServiceProtocolError('INVALID_REQUEST')
        // The legacy owner returns void. Claim before its first await so two
        // callers cannot confirm the same newly recorded adapter decision.
        this.approvalsInFlight.add(sessionId)
        try {
          const session = manager.getSession(sessionId)
          const pending = fixtureAdapter.getPendingApprovalIdentity(sessionId)
          const taskId = session?.taskId
          if (!taskId || !requestId || !pending || pending.requestId !== requestId || pending.taskId !== taskId || pending.agentId !== fixtureAgentId ||
            session?.status !== 'waiting_approval' || !this.sessionAllowed(sessionId, caller) ||
            !db.hasTranscriptPermission(taskId, `question-${requestId}`, requestId)) {
            throw new ServiceProtocolError('INVALID_REQUEST')
          }
          const before = fixtureAdapter.decisions().length
          await manager.respondToPermission(sessionId, approved, message, undefined, responseType ?? 'permission', requestId)
          const decisions = fixtureAdapter.decisions()
          const decision = decisions[before]
          if (decisions.length !== before + 1 || !decision || decision.requestId !== requestId || decision.approved !== approved || fixtureAdapter.getPendingApprovalIdentity(sessionId)?.requestId === requestId) {
            throw new ServiceProtocolError('INVALID_REQUEST')
          }
          return { success: true }
        } finally { this.approvalsInFlight.delete(sessionId) }
      })
    this.bind('agentSession:stop', ([sessionId], caller) => this.sessionAllowed(sessionId, caller), async ([sessionId]) => {
      const destroyed = fixtureAdapter.destroyed
      await manager.stopSession(sessionId, true, true) // Require actual adapter teardown acknowledgement.
      if (manager.getSession(sessionId) || fixtureAdapter.destroyed <= destroyed || fixtureAdapter.getPendingApprovalIdentity(sessionId)) throw new ServiceProtocolError('INVALID_RESULT')
      return { success: true }
    })
  }

  private forwardOwnerEvent(operation: string, source: unknown): void {
    this.available()
    if (!Object.hasOwn(AGENT_EVENT_CODECS, operation) || !isRecord(source)) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    const event = operation as AgentDesktopEvent
    let payload: unknown = source
    if (Object.hasOwn(source, 'taskId') && (typeof source.taskId !== 'string' || !this.taskAllowed(source.taskId))) throw new ServiceProtocolError('INVALID_REQUEST')
    if (Object.hasOwn(source, 'projectId') && source.projectId !== this.options.database.getTask(this.options.fixtureTaskId)?.project_id) throw new ServiceProtocolError('INVALID_REQUEST')
    if (event === 'agent:status') {
      if (source.agentId !== this.options.fixtureAgentId || source.sessionId !== this.options.database.getTask(this.options.fixtureTaskId)?.session_id) throw new ServiceProtocolError('INVALID_REQUEST')
    } else if (event === 'task:updated') {
      if (!hasExactKeys(source, ['taskId', 'updates']) || !isRecord(source.updates) || source.updates.id !== undefined && source.updates.id !== source.taskId) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      const task = DATABASE_COMMAND_CODECS['db:getTask'].encodeResult(this.options.database.getTask(source.taskId as string))
      if (!task.defined) throw new ServiceProtocolError('INVALID_RESULT')
      payload = { taskId: source.taskId as string, updates: task.value }
    } else if (event === 'transcript:changed') {
      payload = encodeDurableTranscriptEvent(this.options.database, source)
    } else if (event === 'agent:startQueueChanged') {
      if (!hasExactKeys(source, ['queue'], ['failed']) || !Array.isArray(source.queue) || source.queue.length > 1) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      const queue = source.queue.map(row => {
        if (!isRecord(row) || !hasExactKeys(row, [...AGENT_QUEUE_FIELDS]) || row.lastError !== null && typeof row.lastError !== 'string' ||
          row.taskId !== this.options.fixtureTaskId || !this.taskAllowed(row.taskId) ||
          row.agentId !== this.options.fixtureAgentId || row.projectId !== this.options.database.getTask(row.taskId)?.project_id) throw new ServiceProtocolError('INVALID_REQUEST')
        return Object.fromEntries(AGENT_QUEUE_FIELDS.map(key => [key, key === 'lastError' ? row.lastError === null ? null : AGENT_RECOVERY_ERROR : row[key]]))
      })
      if (source.failed !== undefined && (!isRecord(source.failed) || !hasExactKeys(source.failed, ['taskId', 'error']) || typeof source.failed.error !== 'string' || source.failed.taskId !== this.options.fixtureTaskId)) throw new ServiceProtocolError('INVALID_REQUEST')
      payload = { queue, ...(source.failed === undefined ? {} : { failed: { taskId: this.options.fixtureTaskId, error: AGENT_RECOVERY_ERROR } }) }
    } else if (event === 'agent:recoveryStateChanged') {
      if (!hasExactKeys(source, ['taskId', 'cause', 'action', 'result', 'error']) || source.error !== null && typeof source.error !== 'string') throw new ServiceProtocolError('INVALID_ARGUMENTS')
      payload = { ...source, error: source.error === null ? null : AGENT_RECOVERY_ERROR }
    }
    const encoded = this.registry.encodeEvent(event, payload, { principal: 'service', engineEpoch: this.options.engineEpoch })
    this.options.emit(event, encoded)
  }
}

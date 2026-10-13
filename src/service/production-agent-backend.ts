import { createHash, randomUUID } from 'node:crypto'
import type { AgentManager } from '../main/agent-manager-core'
import type { DatabaseManager } from '../main/database/manager'
import type { TaskRecord } from '../main/database/types'
import { resolveCaptainAgentId } from '../main/captain-waker'
import { isCoordinatorTask } from '../shared/task-roles'
import { DeliveryStore } from '../main/sessions/delivery-store'
import { PRODUCTION_AGENT_CODECS, PRODUCTION_AGENT_OPERATIONS, type ProductionAgentCodec, type ProductionAgentOperation } from '../shared/production-agent-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
type Attachments = DesktopCommandMap['agentSession:sendByTaskId']['apiArguments'][2]
export interface ProductionAgentBackendOptions {
  database: DatabaseManager
  manager: AgentManager
  engineEpoch: string
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTask(taskId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessProject(projectId: string, caller: DesktopCallerContext, access: Access): boolean
  canAccessAgent(agentId: string, caller: DesktopCallerContext, access: Access): boolean
}

/** Production session commands bind to one actual manager/database. The
 * transport owns request IDs; this owner retains raw effects after disconnect. */
export class ProductionAgentBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly decisions = new Set<string>()
  private readonly deliveries: DeliveryStore

  constructor(private readonly options: ProductionAgentBackendOptions) {
    options.assertAvailable()
    this.deliveries = new DeliveryStore(options.database)
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid agent lifecycle shutdown deadline')
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const drain = async (): Promise<void> => { while (this.flights.size) await Promise.allSettled([...this.flights]) }
      await Promise.race([drain(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(PRODUCTION_AGENT_OPERATIONS.map(operation => [operation, {
      validatePayload: (payload: unknown) => {
        try { const codec = PRODUCTION_AGENT_CODECS[operation]; return codec.validateArguments(codec.decodeArguments(payload as JsonValue)) } catch { return false }
      },
      validateResult: PRODUCTION_AGENT_CODECS[operation].validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, payload, caller, signal)
    }]))
  }
  private available(): void { if (this.closing) throw new ServiceProtocolError('DISCONNECTED'); this.options.assertAvailable() }
  private retain<T>(raw: Promise<T>): Promise<T> {
    this.flights.add(raw)
    void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw))
    return raw
  }
  private agentAllowed(id: string | null | undefined, caller: DesktopCallerContext, access: Access): boolean {
    if (!id) return false
    const seen = new Set<string>(), remaining = [id]
    while (remaining.length) {
      const candidate = remaining.pop()!
      if (seen.has(candidate)) continue
      if (seen.size >= 64) return false
      seen.add(candidate)
      const agent = this.options.database.getAgent(candidate)
      if (!agent || !this.options.canAccessAgent(candidate, caller, access)) return false
      remaining.push(...(agent.config.fallback_agent_ids ?? []))
    }
    return true
  }
  private taskAllowed(id: string, caller: DesktopCallerContext, access: Access): TaskRecord | null {
    const db = this.options.database, task = db.getTask(id)
    if (!task || !db.getProject(task.project_id) || !this.options.canAccessProject(task.project_id, caller, access) || !this.options.canAccessTask(id, caller, access)) return null
    const execution = db.getTaskGroupExecution(id) ?? task
    if (execution.project_id !== task.project_id || !this.options.canAccessTask(execution.id, caller, access)) return null
    const group = db.getTaskGroupByTask(execution.id)
    if (group && (group.execution_task_id !== execution.id || db.getTaskGroupMembers(group.id).some(member => member.project_id !== task.project_id || !this.options.canAccessTask(member.id, caller, access)))) return null
    return execution
  }
  private selectedAgent(task: TaskRecord): string | null {
    const db = this.options.database
    const live = this.options.manager.findSessionByTaskId(task.id)
    if (live) return live.session.agentId
    if (isCoordinatorTask(task)) {
      const project = db.getProject(task.project_id)
      return project ? resolveCaptainAgentId(db, project) : null
    }
    return task.agent_id ?? db.getAgents().find(agent => agent.is_default)?.id ?? db.getAgents()[0]?.id ?? null
  }
  private exactSession(id: string, caller: DesktopCallerContext, access: Access) {
    const session = this.options.manager.getSession(id)
    if (!session?.adapter) return null
    const task = this.taskAllowed(session.taskId, caller, access)
    if (!task || task.id !== session.taskId || task.session_id !== id || !this.agentAllowed(session.agentId, caller, access)) return null
    return { session, task }
  }
  private startAllowed(taskId: string, agentId: string, caller: DesktopCallerContext): boolean {
    const task = this.taskAllowed(taskId, caller, 'write')
    if (!task || task.status === 'completed' || !this.agentAllowed(agentId, caller, 'write')) return false
    const actual = this.selectedAgent(task)
    // Assignment is a separate content command. A session request cannot use an
    // arbitrary agent to override a group's or Captain's configured owner.
    return actual === agentId || task.agent_id === null && !isCoordinatorTask(task) && task.role !== 'task_group' && !this.options.manager.findSessionByTaskId(task.id)
  }
  private taskStartAllowed(taskId: string, caller: DesktopCallerContext): boolean {
    const task = this.taskAllowed(taskId, caller, 'write')
    if (!task || task.status === 'completed' || isCoordinatorTask(task)) return false
    const candidates = [task, ...this.options.database.getSubtasks(task.id)]
    return candidates.every(candidate => !!this.taskAllowed(candidate.id, caller, 'write') && (this.selectedAgent(candidate) === null || this.agentAllowed(this.selectedAgent(candidate), caller, 'write')))
  }
  private attachmentsAllowed(inputTaskId: string, task: TaskRecord, attachments: Attachments): boolean {
    if (!attachments?.length) return true
    if (inputTaskId !== task.id) return false
    return attachments.every(item => task.attachments.some(saved => saved.id === item.id && saved.filename === item.filename && saved.size === item.size && saved.mime_type === item.mime_type))
  }
  private sendAllowed(sessionId: string, taskId: string | undefined, agentId: string | undefined, attachments: Attachments, caller: DesktopCallerContext): boolean {
    const exact = sessionId ? this.exactSession(sessionId, caller, 'write') : null
    if (sessionId && !exact) return false
    const inputTask = taskId ?? exact?.task.id
    if (!inputTask) return false
    const task = this.taskAllowed(inputTask, caller, 'write')
    if (!task || task.status === 'completed' || exact && exact.task.id !== task.id || !this.attachmentsAllowed(inputTask, task, attachments)) return false
    const selected = exact?.session.agentId ?? this.selectedAgent(task)
    return this.agentAllowed(selected, caller, 'write') && (agentId === undefined || agentId === selected)
  }
  private captainAllowed(projectId: string, caller: DesktopCallerContext, access: Access): boolean {
    const db = this.options.database, project = db.getProject(projectId), task = db.getCoordinatorTask(projectId)
    if (!project || !task || !isCoordinatorTask(task) || !this.taskAllowed(task.id, caller, access)) return false
    if (!this.agentAllowed(resolveCaptainAgentId(db, project), caller, access)) return false
    const runtime = this.options.manager.getCaptainRuntime(projectId)
    return !runtime || [runtime.agentId, runtime.candidateAgentId, runtime.lastGoodAgentId].every(id => id === null || this.agentAllowed(id, caller, access))
  }
  private verifyResultSession(id: string, inputTaskId: string, caller: DesktopCallerContext): void {
    const task = this.taskAllowed(inputTaskId, caller, 'write')
    const exact = this.exactSession(id, caller, 'write')
    if (!task || !exact || exact.task.id !== task.id) throw new ServiceProtocolError('INVALID_RESULT')
  }
  private deliveryId(taskId: string, message: string, attachments: Attachments, clientId: string | undefined, caller: DesktopCallerContext): string {
    if (!clientId) return `desktop-agent:${randomUUID()}`
    const task = this.options.database.getTaskGroupExecution(taskId) ?? this.options.database.getTask(taskId)!
    // Stable across engine restarts. Same-profile durable outbox, trusted caller
    // and task scope prevent a nonce from acquiring someone else's delivery.
    const key = `desktop-agent:${createHash('sha256').update(JSON.stringify([caller.principal, caller.webviewId ?? '', caller.origin ?? '', task.id, clientId])).digest('hex')}`
    const previous = this.deliveries.getByKey(key)
    if (previous) {
      let payload: unknown
      try { payload = JSON.parse(previous.payload) } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
      if (!isRecord(payload)) throw new ServiceProtocolError('INVALID_REQUEST')
      const scopedMessage = task.id === taskId ? message : `For group member ${this.options.database.getTask(taskId)?.title ?? taskId} (id: ${taskId}):\n${message}`
      if (previous.kind !== 'agent_message' || previous.taskId !== task.id || payload.taskId !== task.id || payload.message !== scopedMessage ||
          JSON.stringify(payload.attachments) !== JSON.stringify(attachments ?? []) || previous.agentId && !this.agentAllowed(previous.agentId, caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST')
    }
    return key
  }
  private verifySendResult(result: { newSessionId?: string }, taskId: string, key: string, caller: DesktopCallerContext): void {
    const task = this.taskAllowed(taskId, caller, 'write')
    if (!task) throw new ServiceProtocolError('INVALID_RESULT')
    if (!result.newSessionId) return
    const live = this.exactSession(result.newSessionId, caller, 'write')
    if (live?.task.id === task.id) return
    // A replay returns the original accepted native identity. It may have been
    // retired, but its durable destination must still prove this exact task.
    const record = this.deliveries.getByKey(key)
    if (!record || record.taskId !== task.id || record.destinationId !== result.newSessionId || !['accepted', 'acknowledged'].includes(record.state)) {
      throw new ServiceProtocolError('INVALID_RESULT')
    }
  }
  private bind<K extends ProductionAgentOperation>(operation: K,
    authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean | Promise<boolean>,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) => unknown | Promise<unknown>): void {
    const codec = PRODUCTION_AGENT_CODECS[operation] as ProductionAgentCodec<K>
    this.registry.bindCommand(operation, {
      decodeRequest: codec.decodeArguments, validateArguments: codec.validateArguments,
      authorize: (args, caller) => this.retain(Promise.resolve().then(async () => { this.available(); const allowed = await authorize(args, caller); this.available(); return allowed })),
      invoke: (args, caller, signal) => this.retain((async () => {
        this.available()
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        if (!await authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        this.available()
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        const result = await effect(args, caller, signal)
        // This only suppresses a late reply. The raw accepted effect is retained
        // and durable; disconnect never rolls it back or resends it.
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        this.available()
        if (['agent:getStartRecoveryState', 'agentSession:getRawTranscript', 'captainRuntime:get'].includes(operation) && !await authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        this.available()
        const encoded = codec.encodeResult(result)
        return codec.decodeResult(encoded.defined ? encoded.value : undefined)
      })()),
      validateResult: codec.validateResult, encodeResult: codec.encodeResult
    })
  }
  private bindCommands(): void {
    const { manager, database: db } = this.options
    this.bind('agentSession:start', ([agentId, taskId], caller) => this.startAllowed(taskId, agentId, caller), async ([agentId, taskId, _workspace, skip], caller) => {
      if (!this.startAllowed(taskId, agentId, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const outcome = await manager.requestSession(agentId, taskId, undefined, skip)
      if (outcome.status === 'queued') return { sessionId: '', queued: true, queuePosition: outcome.position, queueReason: outcome.reason }
      this.verifyResultSession(outcome.sessionId, taskId, caller)
      return { sessionId: outcome.sessionId }
    })
    this.bind('agentSession:startTask', ([taskId], caller) => this.taskStartAllowed(taskId, caller), async ([taskId], caller) => {
      if (!this.taskStartAllowed(taskId, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const result = await manager.startTask(taskId, { resumeManualStop: true, explicitUserStart: true })
      const root = this.taskAllowed(taskId, caller, 'write')
      const selected = result.startedTaskId && db.getTask(result.startedTaskId)
      if (!root || selected && selected.id !== root.id && selected.parent_task_id !== root.id || result.agentId && !this.agentAllowed(result.agentId, caller, 'write')) throw new ServiceProtocolError('INVALID_RESULT')
      if (result.sessionId && result.startedTaskId) this.verifyResultSession(result.sessionId, result.startedTaskId, caller)
      return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined))
    })
    this.bind('agentSession:resume', ([agentId, taskId, id], caller) => {
      const task = this.taskAllowed(taskId, caller, 'write')
      return !!task && task.session_id === id && this.selectedAgent(task) === agentId && this.agentAllowed(agentId, caller, 'write') && (!manager.getSession(id) || !!this.exactSession(id, caller, 'write'))
    }, async ([agentId, taskId, id], caller) => {
      const resumed = await manager.resumeSession(agentId, taskId, id)
      if (!resumed) return { sessionId: '', ended: true }
      this.verifyResultSession(resumed, taskId, caller)
      return { sessionId: resumed }
    })
    this.bind('agentSession:send', ([id, _message, taskId, agentId, attachments], caller) => this.sendAllowed(id, taskId, agentId, attachments, caller),
      async ([id, message, taskId, agentId, attachments, nonce], caller) => {
        const inputTask = taskId ?? manager.getSession(id)?.taskId
        if (!inputTask || !this.sendAllowed(id, taskId, agentId, attachments, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const key = this.deliveryId(inputTask, message, attachments, nonce, caller)
        const result = await manager.sendMessage(id, message, taskId, agentId, attachments, key)
        this.verifySendResult(result, inputTask, key, caller)
        return { success: true, ...result }
      })
    this.bind('agentSession:sendByTaskId', ([taskId, _message, attachments], caller) => this.sendAllowed('', taskId, undefined, attachments, caller), async ([taskId, message, attachments, nonce], caller) => {
      if (!this.sendAllowed('', taskId, undefined, attachments, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      const key = this.deliveryId(taskId, message, attachments, nonce, caller)
      const result = await manager.sendByTaskId(taskId, message, attachments, key)
      this.verifySendResult(result, taskId, key, caller)
      return { success: true, ...result }
    })
    this.bind('agentSession:abort', ([id], caller) => !!this.exactSession(id, caller, 'write'), async ([id]) => {
      await manager.abortSession(id, { requireAcknowledgement: true })
      return { success: true }
    })
    this.bind('agentSession:stop', ([id], caller) => !!this.exactSession(id, caller, 'write'), async ([id]) => {
      await manager.stopSession(id, true, true)
      if (manager.getSession(id)) throw new ServiceProtocolError('INVALID_RESULT')
      return { success: true }
    })
    this.bind('agentSession:stopByTaskId', ([taskId], caller) => {
      const task = this.taskAllowed(taskId, caller, 'write')
      return !!task && (this.selectedAgent(task) === null || this.agentAllowed(this.selectedAgent(task), caller, 'write')) &&
        (!manager.getStartRecoveryState(task.id) || this.agentAllowed(manager.getStartRecoveryState(task.id)!.agentId, caller, 'write'))
    }, async ([taskId]) => ({ success: true, ...await manager.stopByTaskId(taskId) }))
    this.bind('agentSession:switchAgent', ([taskId, agentId], caller) => !!this.taskAllowed(taskId, caller, 'write') && this.agentAllowed(agentId, caller, 'write') &&
      this.agentAllowed(this.selectedAgent(this.taskAllowed(taskId, caller, 'write')!), caller, 'write'), async ([taskId, agentId], caller) => {
      const sessionId = await manager.switchAgent(taskId, agentId)
      this.verifyResultSession(sessionId, taskId, caller)
      return { sessionId }
    })
    this.bind('agentSession:approve', async ([id, _approved, _message, type, requestId], caller) => {
      const exact = this.exactSession(id, caller, 'write')
      if (!exact || !requestId) return false
      const pending = await manager.getSessionRequestScope(id, requestId, type ?? 'permission')
      return !!pending && pending.sessionId === id && pending.taskId === exact.task.id && pending.agentId === exact.session.agentId && pending.requestId === requestId && pending.responseType === (type ?? 'permission')
    }, async ([id, approved, message, type, requestId], caller) => {
      const exact = this.exactSession(id, caller, 'write')
      if (!exact || !requestId) throw new ServiceProtocolError('INVALID_REQUEST')
      const key = JSON.stringify([id, requestId, type ?? 'permission'])
      if (this.decisions.has(key)) throw new ServiceProtocolError('INVALID_REQUEST')
      this.decisions.add(key)
      try {
        const result = await manager.respondToScopedPermission({ sessionId: id, taskId: exact.task.id, agentId: exact.session.agentId,
          requestId, responseType: type ?? 'permission', approved, ...(message === undefined ? {} : { message }) })
        if (!result.handled) throw new ServiceProtocolError('INVALID_REQUEST')
        return { success: true }
      } finally { this.decisions.delete(key) }
    })
    this.bind('agent:getStartQueue', () => true, (_args, caller) => manager.getStartQueue().filter(row => !!this.taskAllowed(row.taskId, caller, 'read') && this.agentAllowed(row.agentId, caller, 'read')))
    this.bind('agent:getStartRecoveryState', ([taskId], caller) => !!this.taskAllowed(taskId, caller, 'read'), ([taskId], caller) => {
      const task = this.taskAllowed(taskId, caller, 'read')!
      const result = manager.getStartRecoveryState(task.id)
      if (result && !this.agentAllowed(result.agentId, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
      return result
    })
    this.bind('agentSession:getRawTranscript', ([taskId], caller) => !!this.taskAllowed(taskId, caller, 'read') && this.agentAllowed(this.selectedAgent(this.taskAllowed(taskId, caller, 'read')!), caller, 'read'), async ([taskId]) =>
      manager.getRawTranscriptForDebug((db.getTaskGroupExecution(taskId) ?? db.getTask(taskId)!).id, { requireAvailable: true }))
    this.bind('captainRuntime:get', ([projectId], caller) => this.captainAllowed(projectId, caller, 'read'), ([projectId]) => manager.getCaptainRuntime(projectId))
    this.bind('captainRuntime:switch', ([projectId, agentId], caller) => this.captainAllowed(projectId, caller, 'write') && this.agentAllowed(agentId, caller, 'write'), ([projectId, agentId]) => manager.switchCaptainAgent(projectId, agentId))
    this.bind('captainRuntime:retry', ([projectId], caller) => this.captainAllowed(projectId, caller, 'write'), ([projectId]) => manager.retryCaptainSwitch(projectId))
    this.bind('captainRuntime:rollback', ([projectId], caller) => this.captainAllowed(projectId, caller, 'write'), ([projectId]) => manager.rollbackCaptainSwitch(projectId))
  }
}

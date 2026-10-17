import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ProductionOwner } from './production-owner'
import { TaskLifecycleBackend, type TaskLifecycleBackendOptions } from './task-lifecycle-backend'
import { ProductionAgentBackend } from './production-agent-backend'
import { VoiceActionService } from '../main/voice/voice-action-service'
import { interpretTranscript } from '../shared/voice-intent-parser'
import { isNativeVoiceEvent, isNativeVoiceIntent, NATIVE_VOICE_ERROR, type NativeVoiceEvent } from '../shared/voice-native-callbacks'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { isAgentRequestId } from '../shared/agent-desktop-codecs'
import { TASK_LIFECYCLE_CODECS } from '../shared/task-lifecycle-codecs'
import { PRODUCTION_AGENT_CODECS } from '../shared/production-agent-codecs'
import type { TaskRecord } from '../main/database/types'
import type {
  VoiceActionOutcome,
  VoiceIntent,
  VoiceIntentProposal,
  VoiceTurnMode,
  VoiceUiContext
} from '../shared/voice'
import { ServiceProtocolError, hasExactKeys, isRecord, type JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'

export type VoiceActionAuthority = Pick<
  TaskLifecycleBackendOptions,
  'isTrustedDesktop' | 'canAccessTask' | 'canAccessProject' | 'canAccessAgent' | 'canAccessSource'
>
type Pair = { turnId: string; turnEpoch: string }
type Choice = { taskId?: string; agentName?: string }
export interface VoiceTranscriptInput {
  caller: DesktopCallerContext
  projectId: string
  selectedTaskId?: string
  visibleTaskIds?: string[]
  mode: VoiceTurnMode
  /** Captured document/selection/intent authority; not recognition text. */
  beforeEffect(): void
  /** Recheck beforePublish immediately before any deferred recipient effect. */
  publish(event: NativeVoiceEvent, beforePublish: () => void): void | Promise<void>
  /** One captured focused control; its implementation must recheck before write. */
  dictation?: { assertCurrent(): void; write(text: string, beforeWrite: () => void): void | Promise<void> }
  approval?: { taskId: string; sessionId: string; requestId: string; responseType: 'permission' | 'question' }
  ttlMs?: number
}
export interface VoiceTranscriptLease extends Pair {
  finalTranscript(text: string): Promise<VoiceActionOutcome>
  confirm(pair: Pair, choice?: Choice): Promise<{ success: boolean; outcome: VoiceActionOutcome }>
  dismiss(pair: Pair): Promise<{ success: boolean }>
  close(): Promise<void>
}
interface Entry {
  pair: Pair
  input: VoiceTranscriptInput
  context: VoiceUiContext
  controller: AbortController
  expires: number
  timer: ReturnType<typeof setTimeout> | undefined
  state: 'open' | 'running' | 'pending' | 'done' | 'cancelled'
  pending?: {
    proposal: VoiceIntentProposal
    candidates: Map<string, string>
    taskSnapshots: Map<string, string>
    agentSnapshots: Map<string, string>
    needsChoice: boolean
  }
  tasks: Map<string, string>
  raw: Set<Promise<unknown>>
}
const stableTask = (task: TaskRecord): string =>
  JSON.stringify([
    task.id,
    task.project_id,
    task.role,
    task.group_id,
    task.parent_task_id,
    task.source_id,
    task.external_id
  ])
const textAllowed = (value: unknown): value is string =>
  typeof value === 'string' && Buffer.byteLength(value) <= 65536 && !value.includes('\0')
const stale = (pair: Pair): VoiceActionOutcome => ({
  ...pair,
  status: 'rejected',
  reason: 'stale_turn',
  message: 'That request is no longer active.'
})

/** Final-transcript entry for trusted Source owners only. It is deliberately
 * absent from every production command registry and native capability. */
export class ProductionVoiceActionOwner {
  private closing = false
  private admitted = 0
  private readonly entries = new Set<Entry>()
  private readonly context = new AsyncLocalStorage<Entry>()
  private readonly tasks: TaskLifecycleBackend
  private readonly agents: ProductionAgentBackend
  private readonly resolver: VoiceActionService
  constructor(
    private readonly lease: ReturnType<ProductionOwner['getVoiceActionBindingLease']>,
    private readonly authority: VoiceActionAuthority,
    private readonly epoch: string,
    private readonly now = () => performance.now()
  ) {
    lease.assertOwners()
    const available = (): void => {
      lease.assertOwners()
      const entry = this.context.getStore()
      if (entry) this.guard(entry)
    }
    const scoped = {
      isTrustedDesktop: (caller: DesktopCallerContext) => {
        available()
        return caller.engineEpoch === epoch && authority.isTrustedDesktop(caller)
      },
      canAccessProject: (id: string, caller: DesktopCallerContext, access: 'read' | 'write') => {
        available()
        return id === this.current().input.projectId && authority.canAccessProject(id, caller, access)
      },
      canAccessTask: (id: string, caller: DesktopCallerContext, access: 'read' | 'write') => {
        available()
        const row = lease.database.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(id) as
          | { project_id: string }
          | undefined
        return row?.project_id === this.current().input.projectId && authority.canAccessTask(id, caller, access)
      },
      canAccessAgent: (id: string, caller: DesktopCallerContext, access: 'read' | 'write') => {
        available()
        return authority.canAccessAgent(id, caller, access)
      },
      canAccessSource: (id: string, caller: DesktopCallerContext, access: 'read' | 'write') => {
        available()
        return authority.canAccessSource(id, caller, access)
      }
    }
    this.tasks = new TaskLifecycleBackend({ ...lease, ...scoped, engineEpoch: epoch, assertAvailable: available })
    this.agents = new ProductionAgentBackend({
      database: lease.database,
      manager: lease.manager,
      ...scoped,
      engineEpoch: epoch,
      assertAvailable: available
    })
    const db = lease.database,
      manager = lease.manager
    this.resolver = new VoiceActionService({
      db: {
        getTasks: () => this.visibleTasks(),
        getTask: (id) => this.readTask(id),
        getAgents: () =>
          db.getAgents().filter((agent) => authority.canAccessAgent(agent.id, this.current().input.caller, 'read')),
        getSetting: (key) => {
          this.guard(this.current())
          return db.getSetting(key)
        },
        getTranscriptParts: (id) => {
          if (!this.readTask(id)) throw new Error('Unavailable task')
          return db.getTranscriptParts(id)
        },
        createTask: () => {
          throw new Error('Use the task lifecycle owner')
        },
        updateTask: () => {
          throw new Error('Use the task lifecycle owner')
        }
      },
      agents: manager,
      notify: () => {
        throw new Error('Use the captured Source recipient')
      },
      execute: (id, intent, context, task) => this.execute(id, intent, context, task)
    })
  }
  get inflightCount(): number {
    return this.entries.size + this.tasks.inflightCount + this.agents.inflightCount
  }
  begin(input: VoiceTranscriptInput): VoiceTranscriptLease {
    this.lease.assertOwners()
    if (this.closing || this.entries.size >= 16 || this.admitted >= 4096) throw new ServiceProtocolError('BACKPRESSURE')
    const ttl = input.ttlMs ?? 30000
    if (
      !isDatabaseId(input.projectId) ||
      !['command', 'dictation', 'conversation'].includes(input.mode) ||
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      ttl > 120000 ||
      (input.selectedTaskId !== undefined && !isDatabaseId(input.selectedTaskId)) ||
      (input.visibleTaskIds &&
        (input.visibleTaskIds.length > 128 || input.visibleTaskIds.some((id) => !isDatabaseId(id)))) ||
      (input.approval &&
        (!isDatabaseId(input.approval.taskId) ||
          !isDatabaseId(input.approval.sessionId) ||
          !isAgentRequestId(input.approval.requestId) ||
          !['permission', 'question'].includes(input.approval.responseType)))
    )
      throw new ServiceProtocolError('INVALID_ARGUMENTS')
    input.beforeEffect()
    const captured: VoiceTranscriptInput = Object.freeze({
      ...input,
      caller: Object.freeze({ ...input.caller }),
      visibleTaskIds: input.visibleTaskIds ? [...input.visibleTaskIds] : undefined,
      approval: input.approval ? Object.freeze({ ...input.approval }) : undefined,
      beforeEffect: input.beforeEffect.bind(input),
      publish: input.publish.bind(input),
      dictation: input.dictation
        ? Object.freeze({
            assertCurrent: input.dictation.assertCurrent.bind(input.dictation),
            write: input.dictation.write.bind(input.dictation)
          })
        : undefined
    })
    const pair = Object.freeze({ turnId: randomUUID(), turnEpoch: randomUUID() })
    const entry: Entry = {
      pair,
      input: captured,
      context: {
        selectedTaskId: input.selectedTaskId,
        visibleTaskIds: captured.visibleTaskIds,
        pendingApproval: captured.approval
          ? { taskId: captured.approval.taskId, sessionId: captured.approval.sessionId }
          : null
      },
      controller: new AbortController(),
      expires: this.now() + ttl,
      state: 'open',
      tasks: new Map(),
      raw: new Set(),
      timer: undefined
    }
    this.guard(entry)
    if (input.selectedTaskId && !this.context.run(entry, () => this.readTask(input.selectedTaskId!))) {
      clearTimeout(entry.timer)
      throw new ServiceProtocolError('INVALID_REQUEST')
    }
    entry.timer = setTimeout(() => this.cancel(entry), ttl)
    this.entries.add(entry)
    this.admitted++
    return Object.freeze({
      ...pair,
      finalTranscript: (text) => this.final(entry, text),
      confirm: (requested, choice) => this.confirm(entry, requested, choice),
      dismiss: (requested) => this.dismiss(entry, requested),
      close: () => {
        this.cancel(entry)
        return this.join(entry)
      }
    })
  }
  shutdown(): void {
    this.closing = true
    for (const entry of this.entries) this.cancel(entry)
    this.tasks.shutdown()
    this.agents.shutdown()
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000)
      throw new RangeError('Invalid voice action drain deadline')
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([...this.entries].map((entry) => this.join(entry))).then(() =>
          Promise.all([this.tasks.close(), this.agents.close()])
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('VOICE_ACTION_DRAIN_BLOCKED')), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  private current(): Entry {
    const entry = this.context.getStore()
    if (!entry) throw new ServiceProtocolError('INVALID_REQUEST')
    return entry
  }
  private guard(entry: Entry): void {
    this.lease.assertOwners()
    entry.input.beforeEffect()
    const { caller, projectId } = entry.input
    if (
      this.closing ||
      entry.controller.signal.aborted ||
      entry.state === 'done' ||
      entry.state === 'cancelled' ||
      this.now() >= entry.expires ||
      caller.engineEpoch !== this.epoch ||
      caller.principal !== 'trusted-desktop-main' ||
      !this.authority.isTrustedDesktop(caller) ||
      !this.lease.database.getProject(projectId) ||
      !this.authority.canAccessProject(projectId, caller, 'read')
    )
      throw new ServiceProtocolError('CANCELLED')
    for (const [id, binding] of entry.tasks) {
      const task = this.lease.database.getTask(id)
      if (!task || stableTask(task) !== binding || !this.authority.canAccessTask(id, caller, 'read'))
        throw new ServiceProtocolError('INVALID_REQUEST')
    }
  }
  private readTask(id: string): TaskRecord | undefined {
    const entry = this.current()
    this.guard(entry)
    if (!this.authority.canAccessTask(id, entry.input.caller, 'read')) return undefined
    const scope = this.lease.database.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(id) as
      | { project_id: string }
      | undefined
    if (scope?.project_id !== entry.input.projectId) return undefined
    const task = this.lease.database.getTask(id)
    if (task) entry.tasks.set(id, stableTask(task))
    return task
  }
  private visibleTasks(): TaskRecord[] {
    const entry = this.current()
    this.guard(entry)
    const rows = this.lease.database.db
      .prepare("SELECT id FROM tasks WHERE project_id=? AND role!='captain' ORDER BY created_at DESC LIMIT 501")
      .all(entry.input.projectId) as { id: string }[]
    if (rows.length > 500) throw new ServiceProtocolError('BACKPRESSURE')
    return rows.map((row) => this.readTask(row.id)).filter((task): task is TaskRecord => !!task)
  }
  private async execute(
    turnId: string,
    intent: VoiceIntent,
    _context: VoiceUiContext,
    task: TaskRecord | null
  ): Promise<VoiceActionOutcome> {
    const entry = this.current()
    this.guard(entry)
    if (!isNativeVoiceIntent(intent)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    let message = 'Done.',
      taskId = task?.id
    if (intent.type === 'create_task') {
      const result = await this.invokeTask(
        'db:createTask',
        {
          data: {
            title: intent.title,
            description: intent.description ?? '',
            project_id: entry.input.projectId,
            ...(intent.priority ? { priority: intent.priority } : {})
          }
        },
        entry
      )
      taskId = (result as { id: string }).id
      message = 'Task created.'
    } else if (intent.type === 'assign_agent' && task) {
      const selected = this.resolver.resolveAgent(intent.agentName)
      if (!selected.ok) {
        if (selected.reason !== 'ambiguous') throw new ServiceProtocolError('INVALID_REQUEST')
        return {
          turnId, status: 'needs_confirmation', reason: 'ambiguous_agent', candidates: selected.candidates,
          proposal: { intent: { ...intent, taskRef: { kind: 'id', id: task.id } }, confidence: 1,
            transcript: '', source: 'deterministic', summary: 'Choose an agent for the selected task.' }
        }
      }
      if (selected.match !== 'exact') throw new ServiceProtocolError('INVALID_REQUEST')
      await this.invokeTask('db:updateTask', { id: task.id, data: { agent_id: selected.value.id } }, entry)
      message = 'Agent assigned.'
    } else if (intent.type === 'start_task' && task) {
      const result = (await this.invokeAgent('agentSession:startTask', { taskId: task.id }, entry)) as {
        action: string
      }
      if (result.action === 'no_action') throw new ServiceProtocolError('INVALID_REQUEST')
      message =
        result.action === 'queued'
          ? 'Task queued through admission.'
          : result.action === 'already_running'
            ? 'Task is already running.'
            : 'Task started.'
    } else if (intent.type === 'reply_to_agent' && task) {
      await this.invokeAgent(
        'agentSession:sendByTaskId',
        { taskId: task.id, message: intent.message, deliveryId: `voice:${entry.pair.turnEpoch}` },
        entry
      )
      message = 'Message sent.'
    } else if ((intent.type === 'approve_checkpoint' || intent.type === 'reject_checkpoint') && task) {
      const approval = entry.input.approval
      if (
        !approval ||
        approval.taskId !== task.id ||
        this.lease.database.getTask(task.id)?.session_id !== approval.sessionId
      )
        throw new ServiceProtocolError('INVALID_REQUEST')
      await this.invokeAgent(
        'agentSession:approve',
        {
          sessionId: approval.sessionId,
          approved: intent.type === 'approve_checkpoint',
          responseType: approval.responseType,
          requestId: approval.requestId,
          ...(intent.message ? { message: intent.message } : {})
        },
        entry
      )
      message = intent.type === 'approve_checkpoint' ? 'Checkpoint approved.' : 'Checkpoint rejected.'
    } else if (intent.type === 'navigate') {
      await this.publish(entry, {
        type: 'navigate',
        ...entry.pair,
        destination: intent.destination,
        taskId: task?.id ?? entry.input.selectedTaskId ?? null
      })
      message = 'View opened.'
    } else if (intent.type === 'read_last_answer' && task) {
      message = this.resolver.lastAnswerFor(task.id) ?? ''
      if (!message) throw new ServiceProtocolError('INVALID_REQUEST')
      message = message.slice(0, 16384)
    } else if (intent.type === 'cancel') return { status: 'cancelled', turnId }
    else throw new ServiceProtocolError('INVALID_REQUEST')
    return { status: 'executed', turnId, intent: intent.type, message, ...(taskId ? { taskId } : {}) }
  }
  private invokeTask(operation: 'db:createTask' | 'db:updateTask', payload: JsonValue, entry: Entry): Promise<unknown> {
    return this.lease.manager.withTaskGroupRequestGuard(
      async () => {
        this.guard(entry)
        const wire = await this.tasks.registry.invoke(operation, payload, entry.input.caller, entry.controller.signal)
        return TASK_LIFECYCLE_CODECS[operation].decodeResult(
          (wire as { defined: boolean; value?: JsonValue }).value as never
        )
      },
      () => this.guard(entry),
      entry.controller.signal
    )
  }
  private invokeAgent(
    operation: 'agentSession:startTask' | 'agentSession:sendByTaskId' | 'agentSession:approve',
    payload: JsonValue,
    entry: Entry
  ): Promise<unknown> {
    return this.lease.manager.withTaskGroupRequestGuard(
      async () => {
        this.guard(entry)
        const wire = await this.agents.registry.invoke(operation, payload, entry.input.caller, entry.controller.signal)
        return PRODUCTION_AGENT_CODECS[operation].decodeResult(
          (wire as { defined: boolean; value?: JsonValue }).value as never
        )
      },
      () => this.guard(entry),
      entry.controller.signal
    )
  }
  private publish(entry: Entry, event: NativeVoiceEvent): Promise<void> {
    this.guard(entry)
    if (!isNativeVoiceEvent(event) || Buffer.byteLength(JSON.stringify(event)) > 256 * 1024)
      throw new ServiceProtocolError('INVALID_RESULT')
    return Promise.resolve(entry.input.publish(structuredClone(event), () => this.guard(entry))).then(() => this.guard(entry))
  }
  private own<T>(entry: Entry, effect: () => Promise<T>): Promise<T> {
    // Admit the raw promise before any captured callback can synchronously
    // revoke/close its turn. Callbacks must never outrun cleanup ownership.
    const raw = Promise.resolve().then(() => this.context.run(entry, async () => {
      try {
        return await effect()
      } finally {
        if (entry.state === 'done' || entry.state === 'cancelled') clearTimeout(entry.timer)
      }
    }))
    entry.raw.add(raw)
    void raw.then(
      () => this.release(entry, raw),
      () => this.release(entry, raw)
    )
    return raw
  }
  private release(entry: Entry, raw: Promise<unknown>): void {
    entry.raw.delete(raw)
    if (!entry.raw.size && (entry.state === 'done' || entry.state === 'cancelled')) this.entries.delete(entry)
  }
  private async final(entry: Entry, text: string): Promise<VoiceActionOutcome> {
    if (entry.state !== 'open') return stale(entry.pair)
    entry.state = 'running'
    return this.own(entry, async () => {
      try {
        this.guard(entry)
        if (!textAllowed(text)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        const interpretation = interpretTranscript(text, entry.input.mode)
        if (interpretation.kind === 'dictation') {
          if (!entry.input.dictation) throw new ServiceProtocolError('INVALID_REQUEST')
          entry.input.dictation.assertCurrent()
          await entry.input.dictation.write(interpretation.text, () => {
            this.guard(entry)
            entry.input.dictation!.assertCurrent()
          })
          this.guard(entry)
          const outcome: VoiceActionOutcome = { ...entry.pair, status: 'dictation', text: interpretation.text }
          await this.finish(entry, outcome)
          return outcome
        }
        if (interpretation.kind === 'unrecognized') {
          const outcome: VoiceActionOutcome = {
            ...entry.pair,
            status: 'rejected',
            reason: 'unrecognized',
            message: 'That command is not supported.'
          }
          await this.finish(entry, outcome)
          return outcome
        }
        return await this.apply(entry, interpretation.proposal, false)
      } catch {
        return this.failed(entry)
      }
    })
  }
  private async apply(entry: Entry, proposal: VoiceIntentProposal, confirmed: boolean): Promise<VoiceActionOutcome> {
    this.guard(entry)
    if (!isNativeVoiceIntent(proposal.intent)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    if (proposal.intent.type === 'approve_checkpoint' || proposal.intent.type === 'reject_checkpoint') {
      const approval = entry.input.approval
      const pending =
        approval &&
        (await this.lease.manager.getSessionRequestScope(approval.sessionId, approval.requestId, approval.responseType))
      this.guard(entry)
      if (
        !approval ||
        !pending ||
        pending.taskId !== approval.taskId ||
        pending.sessionId !== approval.sessionId ||
        pending.requestId !== approval.requestId ||
        pending.responseType !== approval.responseType ||
        entry.input.selectedTaskId !== approval.taskId
      ) {
        const result: VoiceActionOutcome = {
          ...entry.pair,
          status: 'rejected',
          reason: 'no_pending_approval',
          message: 'There is no checkpoint waiting for an answer.'
        }
        await this.finish(entry, result)
        return result
      }
    }
    const result = await this.resolver.apply(entry.pair.turnId, proposal, entry.context, confirmed)
    const outcome = {
      ...result,
      ...entry.pair,
      ...(result.status === 'rejected' && result.reason === 'failed' ? { message: NATIVE_VOICE_ERROR } : {})
    }
    this.guard(entry)
    if (outcome.status === 'needs_confirmation') {
      const pinned = structuredClone(proposal),
        candidates = new Map<string, string>(),
        taskSnapshots = new Map<string, string>(),
        agentSnapshots = new Map<string, string>()
      for (const item of outcome.candidates ?? []) {
        candidates.set(item.id, item.kind)
        if (item.kind === 'task') {
          const task = this.readTask(item.id)
          if (task) taskSnapshots.set(item.id, JSON.stringify(task))
        } else {
          const agent = this.lease.database.getAgent(item.id)
          if (agent) agentSnapshots.set(item.id, JSON.stringify(agent))
        }
      }
      if ('taskRef' in pinned.intent && pinned.intent.taskRef) {
        const resolved = this.resolver.resolveTask(pinned.intent.taskRef, entry.context)
        if (resolved.ok) {
          pinned.intent.taskRef = { kind: 'id', id: resolved.value.id }
          taskSnapshots.set(resolved.value.id, JSON.stringify(resolved.value))
        }
      }
      if (
        pinned.intent.type === 'assign_agent' &&
        (!('taskRef' in pinned.intent) || pinned.intent.taskRef.kind === 'id')
      ) {
        const resolved = this.resolver.resolveAgent(pinned.intent.agentName)
        if (resolved.ok) {
          pinned.intent.agentName = resolved.value.name
          agentSnapshots.set(resolved.value.id, JSON.stringify(this.lease.database.getAgent(resolved.value.id)))
        } else if (resolved.reason === 'ambiguous')
          for (const candidate of resolved.candidates) {
            candidates.set(candidate.id, 'agent')
            agentSnapshots.set(candidate.id, JSON.stringify(this.lease.database.getAgent(candidate.id)))
          }
      }
      entry.pending = { proposal: pinned, candidates, taskSnapshots, agentSnapshots, needsChoice: candidates.size > 1 }
      entry.state = 'pending'
      const visual = {
        ...outcome,
        proposal: pinned,
        ...(candidates.size
          ? {
              candidates: [...candidates].map(([id, kind]) => ({
                id,
                kind: kind as 'task' | 'agent',
                label: kind === 'task' ? this.lease.database.getTask(id)!.title : this.lease.database.getAgent(id)!.name
              }))
            }
          : {})
      }
      await this.publish(entry, { type: 'outcome', ...entry.pair, outcome: visual })
      return visual
    }
    await this.finish(entry, outcome)
    return outcome
  }
  private confirm(
    entry: Entry,
    pair: Pair,
    choice?: Choice
  ): Promise<{ success: boolean; outcome: VoiceActionOutcome }> {
    if (!this.samePair(entry, pair) || entry.state !== 'pending' || !entry.pending)
      return Promise.resolve({ success: false, outcome: stale(entry.pair) })
    const pending = entry.pending
    entry.pending = undefined
    entry.state = 'running'
    return this.own(entry, async () => {
      try {
        this.guard(entry)
        if (choice && (!isRecord(choice) || !hasExactKeys(choice, [], ['taskId', 'agentName'])))
          throw new ServiceProtocolError('INVALID_ARGUMENTS')
        for (const [id, value] of pending.taskSnapshots)
          if (JSON.stringify(this.readTask(id)) !== value) throw new ServiceProtocolError('INVALID_REQUEST')
        for (const [id, value] of pending.agentSnapshots)
          if (
            JSON.stringify(this.lease.database.getAgent(id)) !== value ||
            !this.authority.canAccessAgent(id, entry.input.caller, 'read')
          )
            throw new ServiceProtocolError('INVALID_REQUEST')
        const proposal = structuredClone(pending.proposal)
        if (choice?.taskId) {
          if (pending.candidates.get(choice.taskId) !== 'task' || !('taskRef' in proposal.intent))
            throw new ServiceProtocolError('INVALID_REQUEST')
          proposal.intent.taskRef = { kind: 'id', id: choice.taskId }
        }
        if (choice?.agentName) {
          if (
            proposal.intent.type !== 'assign_agent' ||
            ![...pending.candidates].some(
              ([id, kind]) => kind === 'agent' && this.lease.database.getAgent(id)?.name === choice.agentName
            )
          )
            throw new ServiceProtocolError('INVALID_REQUEST')
          proposal.intent.agentName = choice.agentName
        }
        if (pending.needsChoice && !choice?.taskId && !choice?.agentName)
          throw new ServiceProtocolError('INVALID_REQUEST')
        const outcome = await this.apply(entry, proposal, true)
        return { success: outcome.status === 'executed', outcome }
      } catch {
        const outcome = this.failed(entry)
        return { success: false, outcome }
      }
    })
  }
  private async dismiss(entry: Entry, pair: Pair): Promise<{ success: boolean }> {
    if (!this.samePair(entry, pair) || entry.state !== 'pending') return { success: false }
    entry.pending = undefined
    entry.state = 'running'
    return this.own(entry, async () => {
      try {
        await this.finish(entry, { ...entry.pair, status: 'cancelled' })
        return { success: true }
      } catch {
        this.cancel(entry)
        return { success: false }
      }
    })
  }
  private samePair(entry: Entry, pair: Pair): boolean {
    return (
      isRecord(pair) &&
      hasExactKeys(pair, ['turnId', 'turnEpoch']) &&
      pair.turnId === entry.pair.turnId &&
      pair.turnEpoch === entry.pair.turnEpoch
    )
  }
  private async finish(entry: Entry, outcome: VoiceActionOutcome): Promise<void> {
    await this.publish(entry, { type: 'outcome', ...entry.pair, outcome })
    entry.state = 'done'
    clearTimeout(entry.timer)
  }
  private failed(entry: Entry): VoiceActionOutcome {
    this.cancel(entry)
    return { ...entry.pair, status: 'rejected', reason: 'failed', message: NATIVE_VOICE_ERROR }
  }
  private cancel(entry: Entry): void {
    entry.state = 'cancelled'
    entry.pending = undefined
    entry.controller.abort()
    clearTimeout(entry.timer)
    if (!entry.raw.size) this.entries.delete(entry)
  }
  private async join(entry: Entry): Promise<void> {
    while (entry.raw.size) await Promise.allSettled([...entry.raw])
    this.entries.delete(entry)
  }
}

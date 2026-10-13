import { DatabaseManager, type DatabaseRuntimeOptions, type TranscriptPartInput } from '../main/database/manager'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import {
  DATABASE_COMMAND_CODECS, DATABASE_DESKTOP_EVENTS, DATABASE_DESKTOP_OPERATIONS, DATABASE_EVENT_CODECS,
  isDatabaseId, isSyntheticSettingKey,
  type DatabaseDesktopEvent, type DatabaseDesktopOperation
} from '../shared/database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'
import { encodeDurableTranscriptEvent } from './transcript-events'

/** Structural interface supplied by the shared writer-process lifetime lock. */
export interface DatabaseProfileLock {
  readonly profileRoot: string
  assertHeld(): void
}
export interface DatabaseBackendOptions {
  engineEpoch: string
  lock: DatabaseProfileLock
  runtime: DatabaseRuntimeOptions
  isTrustedDesktop: (caller: DesktopCallerContext) => boolean
  canAccessProject: (projectId: string, caller: DesktopCallerContext) => boolean
  canCreateProject: (caller: DesktopCallerContext) => boolean
  canEditSettings: (caller: DesktopCallerContext) => boolean
  /** Attached service closing state, checked again after authorization yields. */
  assertOwnerAvailable?: () => void
  /** An attached lifecycle owner must deny deletion while it still owns work. */
  canDeleteTask?: (taskId: string, caller: DesktopCallerContext) => boolean
  emit: (operation: DatabaseDesktopEvent, payload: JsonValue) => void
}

/** Real database bindings; the current bootstrap restricts them to synthetic profiles. */
export class DatabaseBackend {
  readonly database: DatabaseManager
  readonly registry: DesktopOperationRegistry
  private closed = false

  constructor(private readonly options: DatabaseBackendOptions) {
    options.lock.assertHeld()
    if (options.runtime.paths.profileRoot !== options.lock.profileRoot) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.database = new DatabaseManager(options.runtime)
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    try {
      this.database.initialize()
      for (const operation of DATABASE_DESKTOP_EVENTS) this.registry.bindEvent(operation, {
        validatePayload: DATABASE_EVENT_CODECS[operation].validatePayload,
        encodePayload: payload => {
          if (!DATABASE_EVENT_CODECS[operation].validatePayload(payload) || !isJsonValue(payload)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
          return payload
        }
      })
      this.bindCommands()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    // Leave the lifetime guard held until the caller disposes its provider.
    let lost = false
    try { this.options.lock.assertHeld() } catch { lost = true }
    this.database.close()
    this.closed = true
    if (lost) throw new ServiceProtocolError('DISCONNECTED')
  }

  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(DATABASE_DESKTOP_OPERATIONS.map(operation => [operation, {
      validatePayload: (payload: unknown) => {
        try { return isJsonValue(payload) && DATABASE_COMMAND_CODECS[operation].validateArguments(DATABASE_COMMAND_CODECS[operation].decodeArguments(payload)) }
        catch { return false }
      },
      validateResult: DATABASE_COMMAND_CODECS[operation].validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, payload, caller, signal)
    }]))
  }

  /** Internal test ingress for real projections, never a renderer command/agent simulator. */
  fixtureTranscriptUpsert(payload: JsonValue, caller: DesktopCallerContext, signal: AbortSignal): JsonValue {
    this.assertAvailable()
    if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
    if (!this.options.isTrustedDesktop(caller) || caller.engineEpoch !== this.options.engineEpoch ||
      caller.principal !== 'trusted-desktop-main' || !isFixtureTranscriptInput(payload)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const input = payload
    if (!this.database.getTask(input.taskId) || !this.canUseTask(input.taskId, caller, true)) throw new ServiceProtocolError('INVALID_REQUEST')
    const result = this.database.upsertTranscriptParts(input.taskId, input.parts, 'live')
    if (result.changedPartIds.length) {
      const changed = result.changedPartIds.map(partId => ({ taskId: input.taskId, partId, rev: this.database.getTranscriptEventPart(input.taskId, partId)!.rev }))
      this.emit('transcript:changed', encodeDurableTranscriptEvent(this.database, { taskId: input.taskId, parts: changed, maxRev: result.maxRev }))
      const task = this.database.getTask(input.taskId)
      if (task) this.emit('task:updated', { taskId: task.id, updates: this.taskDto(task) })
    }
    return { maxRev: result.maxRev, changedPartIds: result.changedPartIds }
  }

  private assertAvailable(): void {
    if (this.closed) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertOwnerAvailable?.()
    try { this.options.lock.assertHeld() } catch { throw new ServiceProtocolError('DISCONNECTED') }
  }

  private canUseTask(id: string, caller: DesktopCallerContext, mutation = false): boolean {
    const task = this.database.getTask(id)
    if (!task) return true // Missing reads/updates are undefined; missing deletes return false without filesystem effects.
    return this.options.canAccessProject(task.project_id, caller) && (!mutation ||
      task.role === 'task' && task.source === 'local' && task.source_id === null && task.status === 'not_started' && task.agent_id === null && task.session_id === null &&
      !task.auto_start_agent && !task.auto_complete_without_review && !task.is_recurring && !task.heartbeat_enabled)
  }

  private bind<K extends DatabaseDesktopOperation>(operation: K, authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean, invoke: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => unknown): void {
    const codec = DATABASE_COMMAND_CODECS[operation]
    this.registry.bindCommand(operation, {
      decodeRequest: codec.decodeArguments,
      validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.assertAvailable(); return authorize(args, caller) },
      invoke: (args, caller, signal) => {
        this.assertAvailable()
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        // The registry yields while authorizing. Recheck immediately before a
        // synchronous effect, including an attached lifecycle owner's guard.
        if (!authorize(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const encoded = codec.encodeResult(invoke(args, caller))
        return codec.decodeResult(encoded.defined ? encoded.value : undefined)
      },
      validateResult: codec.validateResult,
      encodeResult: codec.encodeResult
    })
  }

  private taskDto(task: unknown): JsonValue {
    const encoded = DATABASE_COMMAND_CODECS['db:getTask'].encodeResult(task)
    if (!encoded.defined) throw new ServiceProtocolError('INVALID_RESULT')
    return encoded.value
  }

  private emit(operation: DatabaseDesktopEvent, payload: JsonValue): void {
    const encoded = this.registry.encodeEvent(operation, payload, { principal: 'service', engineEpoch: this.options.engineEpoch })
    this.options.emit(operation, encoded)
  }

  private bindCommands(): void {
    const db = this.database
    this.bind('db:getTasks', ([projectId], caller) => !projectId || this.options.canAccessProject(projectId, caller), ([projectId], caller) =>
      db.getTasks(projectId ? { projectId } : undefined).filter(task => this.options.canAccessProject(task.project_id, caller)))
    this.bind('db:getTask', ([id], caller) => this.canUseTask(id, caller), ([id]) => db.getTask(id))
    this.bind('db:createTask', ([data], caller) => this.options.canAccessProject(data.project_id ?? DEFAULT_PROJECT_ID, caller) && !!db.getProject(data.project_id ?? DEFAULT_PROJECT_ID), ([data]) => {
      const task = db.createTask(data)
      if (task) this.emit('task:created', { task: this.taskDto(task) })
      return task
    })
    this.bind('db:updateTask', ([id], caller) => this.canUseTask(id, caller, true), ([id, data]) => {
      const task = db.updateTask(id, data)
      if (task) this.emit('task:updated', { taskId: id, updates: this.taskDto(task) })
      return task
    })
    this.bind('db:deleteTask', ([id], caller) => {
      if (!this.canUseTask(id, caller, true)) return false
      if (this.options.canDeleteTask) return this.options.canDeleteTask(id, caller)
      const task = db.getTask(id)
      return !task || !task.session_id && !['agent_working', 'triaging', 'agent_learning'].includes(task.status)
    }, ([id]) => {
      if (!db.getTask(id)) return false
      const deleted = db.deleteTask(id)
      if (deleted) this.emit('task:deleted', { taskId: id })
      return deleted
    })
    this.bind('project:getAll', () => true, ([opts], caller) => db.getProjects(opts).filter(project => this.options.canAccessProject(project.id, caller)))
    this.bind('project:get', ([id], caller) => this.options.canAccessProject(id, caller), ([id]) => db.getProject(id))
    this.bind('project:getDefault', (_args, caller) => this.options.canAccessProject(DEFAULT_PROJECT_ID, caller), () => db.getDefaultProject())
    this.bind('project:create', (_args, caller) => this.options.canCreateProject(caller), ([data]) => {
      const project = db.createProject(data)
      if (project) this.emit('project:changed', { projectId: project.id, kind: 'created' })
      return project
    })
    this.bind('settings:get', () => true, ([key]) => db.getSetting(key) ?? null)
    this.bind('settings:set', (_args, caller) => this.options.canEditSettings(caller), ([key, value]) => { db.setSetting(key, value) })
    this.bind('settings:getAll', () => true, () => Object.fromEntries(Object.entries(db.getAllSettings()).filter(([key]) => isSyntheticSettingKey(key))))
    this.bind('agentSession:getTranscriptSnapshot', ([taskId], caller) => this.canUseTask(taskId, caller), ([taskId, sinceSeq]) => db.getTranscriptParts(taskId, sinceSeq))
    this.bind('agentSession:getTranscriptDelta', ([taskId], caller) => this.canUseTask(taskId, caller), ([taskId, sinceRev]) => db.getTranscriptDelta(taskId, sinceRev))
    this.bind('agentSession:getTranscriptPage', ([taskId], caller) => !!db.getTask(taskId) && this.canUseTask(taskId, caller), ([taskId, page]) => db.getTranscriptPage(taskId, page))
  }
}

export function isFixtureTranscriptInput(value: unknown): value is { taskId: string; parts: TranscriptPartInput[] } {
  return isRecord(value) && hasExactKeys(value, ['taskId', 'parts']) && isDatabaseId(value.taskId) && Array.isArray(value.parts) && value.parts.length <= 32 &&
    new Set(value.parts.map(part => isRecord(part) ? part.id : undefined)).size === value.parts.length &&
    value.parts.every(part => isRecord(part) && hasExactKeys(part, ['id', 'role', 'content'], ['partType', 'tool', 'payload', 'receivedAt']) &&
      typeof part.id === 'string' && part.id.length > 0 && part.id.length <= 512 && !part.id.includes('\0') &&
      ['user', 'assistant', 'system'].includes(part.role as string) && typeof part.content === 'string' && part.content.length <= 16_384 &&
      (part.partType === undefined || typeof part.partType === 'string' && part.partType.length <= 128) &&
      (part.tool === undefined || isJsonValue(part.tool)) && (part.payload === undefined || isJsonValue(part.payload)) &&
      (part.receivedAt === undefined || Number.isSafeInteger(part.receivedAt) && (part.receivedAt as number) >= 0))
}

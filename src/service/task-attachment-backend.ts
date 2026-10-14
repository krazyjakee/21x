import { AgentManager } from '../main/agent-manager-core'
import type { DatabaseManager } from '../main/database/manager'
import type { FileAttachmentRecord } from '../main/database/types'
import { TaskAttachmentFileOwner, TaskAttachmentFileError } from '../main/task-attachment-file-owner'
import { saveImagesAsTaskAttachments, type TaskImageStore } from '../main/chat/task-image-attachments'
import { TaskWorkspaceScopeReader } from './task-workspace-scope'
import { TASK_ATTACHMENT_CODECS, TASK_ATTACHMENT_OPERATIONS, TASK_ATTACHMENT_LIMITS, taskAttachmentRecords, type TaskAttachmentCodec, type TaskAttachmentOperation } from '../shared/task-attachment-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { isUiLeaseId } from '../shared/ui-desktop-codecs'
import { isAttachmentPathReceipt, type AttachmentPathReceipt } from '../shared/attachment-native-callbacks'
import { ServiceProtocolError, isJsonValue, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface TaskAttachmentOwners { database: DatabaseManager; manager: AgentManager; files: TaskAttachmentFileOwner; attachmentRoot: string }
export interface TaskAttachmentBackendOptions extends TaskAttachmentOwners {
  engineEpoch: string
  assertAvailable(): void
  assertTaskAttachmentOwners(owners: TaskAttachmentOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessAgent(id: string, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  runAttachmentMutation?<T>(taskIds: string[], effect: () => Promise<T>): Promise<T>
  onTaskUpdated(taskId: string, attachments: FileAttachmentRecord[]): void
  openAttachment?(receipt: AttachmentPathReceipt, caller: DesktopCallerContext, signal: AbortSignal): Promise<void>
  downloadAttachment?(receipt: AttachmentPathReceipt, caller: DesktopCallerContext, signal: AbortSignal, beforeEffect: () => void): Promise<void>
}
/** Exact saved attachment effects. Opening and downloading each require a
 * captured real native callback; public arguments grant no destination/path. */
export class TaskAttachmentBackend {
  readonly registry: DesktopOperationRegistry
  private readonly owners: TaskAttachmentOwners
  private readonly flights = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private closing = false
  private mutationBusy = false
  private readonly openAttachment: TaskAttachmentBackendOptions['openAttachment']
  private readonly downloadAttachment: TaskAttachmentBackendOptions['downloadAttachment']
  constructor(private readonly options: TaskAttachmentBackendOptions) {
    this.owners = Object.freeze({ database: options.database, manager: options.manager, files: options.files, attachmentRoot: options.attachmentRoot })
    this.openAttachment = options.openAttachment
    this.downloadAttachment = options.downloadAttachment
    if (!(options.manager instanceof AgentManager) || !(options.files instanceof TaskAttachmentFileOwner) || typeof options.onTaskUpdated !== 'function' || this.openAttachment !== undefined && typeof this.openAttachment !== 'function' || this.downloadAttachment !== undefined && typeof this.downloadAttachment !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available(); this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of this.operations()) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  private operations(): readonly TaskAttachmentOperation[] { return TASK_ATTACHMENT_OPERATIONS.filter(operation => operation === 'attachments:open' ? !!this.openAttachment : operation === 'attachments:download' ? !!this.downloadAttachment : true) }
  shutdown(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid attachment backend close deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) } finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(this.operations().map(operation => [operation, { validatePayload: (value: unknown) => { try { return isJsonValue(value) && TASK_ATTACHMENT_CODECS[operation].validateArguments(TASK_ATTACHMENT_CODECS[operation].decodeArguments(value)) } catch { return false } }, validateResult: TASK_ATTACHMENT_CODECS[operation].validateWireResult, handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal) }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || !this.owners.database.db.open) throw new ServiceProtocolError('DISCONNECTED')
    try { this.options.assertAvailable(); this.options.assertTaskAttachmentOwners(this.owners); this.owners.files.assertOwners(this.owners.attachmentRoot) } catch (error) { if (error instanceof ServiceProtocolError) throw error; throw new ServiceProtocolError('DISCONNECTED') }
  }
  private authorize(caller: DesktopCallerContext, signal?: AbortSignal): void {
    this.available(signal)
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !caller.webviewId || !caller.origin || !this.options.isTrustedDesktop(caller)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private async execute<K extends TaskAttachmentOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal): Promise<DesktopCommandMap[K]['result']> {
    const { database, manager, files } = this.owners, db = database.db, taskId = args[0] as string
    const mutation = operation === 'chatImages:saveToTask' || operation === 'attachments:remove'
    const nativeCallback = operation === 'attachments:download' ? this.downloadAttachment : this.openAttachment
    let active = true
    const current = (): void => {
      if (!active) throw new ServiceProtocolError('CANCELLED')
      this.authorize(caller, signal)
      if (!mutation) {
        if (!isUiLeaseId(caller.uiLeaseId)) throw new ServiceProtocolError('INVALID_REQUEST')
        const configured = operation === 'attachments:download' ? this.options.downloadAttachment : this.options.openAttachment
        if (!nativeCallback || configured !== nativeCallback) throw new ServiceProtocolError('DISCONNECTED')
      }
    }
    const readIds = new Set<string>(), projects = new Set<string>(), agents = new Set<string>()
    let selectedProject: string | undefined
    const taskGrant = (id: string, write = false): boolean => { current(); if (!isDatabaseId(id) || !this.options.canAccessTask(id, caller, 'read') || write && !this.options.canAccessTask(id, caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST'); readIds.add(id); return true }
    const projectGrant = (id: string): boolean => { current(); if (!isDatabaseId(id)) throw new ServiceProtocolError('INVALID_REQUEST'); selectedProject ??= id; if (!this.options.canAccessProject(id, caller, 'read') || mutation && id === selectedProject && !this.options.canAccessProject(id, caller, 'write')) throw new ServiceProtocolError('INVALID_REQUEST'); projects.add(id); return true }
    const scopeReader = new TaskWorkspaceScopeReader({ database, assertAvailable: current, canAccessTask: id => taskGrant(id), canAccessProject: id => projectGrant(id) })
    // Bound group scalar materialization before the shared scope reader parses
    // repositories. No unrelated task/agent credential getter is used here.
    const relevantSql = `SELECT id,project_id,role,group_id,repos,agent_id,session_id FROM tasks WHERE id=? OR id IN
      (SELECT execution_task_id FROM task_groups WHERE execution_task_id=? OR id=(SELECT group_id FROM tasks WHERE id=?)) OR id IN
      (SELECT task_id FROM task_group_memberships WHERE group_id IN (SELECT id FROM task_groups WHERE execution_task_id=? OR id=(SELECT group_id FROM tasks WHERE id=?)))`
    const relevantParams = [taskId,taskId,taskId,taskId,taskId]
    const scalarBounds = { id: 128, project_id: 128, role: 32, group_id: 128, repos: 65536, agent_id: 128, session_id: 512 }
    const preflight = (): void => {
      current(); const sizes = Object.entries(scalarBounds).map(([field, max]) => ({ bytes: `COALESCE(length(CAST(${field} AS BLOB)),0)`, max }))
      const stats = db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(${sizes.map(value => `(${value.bytes}>${value.max})`).join(' OR ')}),0) AS oversized,COALESCE(SUM(${sizes.map(value => value.bytes).join('+')}),0) AS bytes FROM (${relevantSql})`).get(...relevantParams) as { count: number; oversized: number; bytes: number }
      if (stats.count > 129 || stats.oversized || stats.bytes >= TASK_ATTACHMENT_LIMITS.wireBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    }
    const metadata = (): { raw: string; records: FileAttachmentRecord[] } => {
      current(); const size = db.prepare('SELECT typeof(attachments) AS type,length(CAST(attachments AS BLOB)) AS bytes FROM tasks WHERE id=?').get(taskId) as { type: string; bytes: number } | undefined
      if (!size) throw new ServiceProtocolError('INVALID_REQUEST')
      if (size.type !== 'text' || size.bytes > TASK_ATTACHMENT_LIMITS.metadataBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      const { attachments: raw } = db.prepare('SELECT attachments FROM tasks WHERE id=?').get(taskId) as { attachments: string }
      let records: unknown; try { records = JSON.parse(raw) } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
      if (!taskAttachmentRecords(records)) throw new ServiceProtocolError('INVALID_REQUEST')
      return { raw, records: records as FileAttachmentRecord[] }
    }
    try {
      current(); taskGrant(taskId, mutation); preflight(); const initialScope = scopeReader.capture(taskId, caller), scopeText = JSON.stringify(initialScope), initial = metadata(); let expectedMetadata = initial.raw
      if (Buffer.byteLength(scopeText) + Buffer.byteLength(initial.raw) >= TASK_ATTACHMENT_LIMITS.wireBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      const relevant = db.prepare(relevantSql).all(...relevantParams) as Array<{ id: string; project_id: string; agent_id: string | null }>
      for (const task of relevant) { taskGrant(task.id); projectGrant(task.project_id); if (task.agent_id) { if (!isDatabaseId(task.agent_id) || !this.options.canAccessAgent(task.agent_id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST'); agents.add(task.agent_id) } }
      const relevantText = JSON.stringify(relevant)
      // A group may retain an assigned agent independently of its task rows.
      // Capture only the bounded ownership scalar; do not load its credentials.
      const groupAgent = (): string | null => {
        if (mutation || initialScope.group === null) return null
        const id = (initialScope.group as { id: string }).id
        const row = db.prepare('SELECT CASE WHEN agent_id IS NULL THEN 1 WHEN typeof(agent_id)=\'text\' AND length(CAST(agent_id AS BLOB))<=128 THEN 1 ELSE 0 END AS valid FROM task_groups WHERE id=?').get(id) as { valid: number } | undefined
        if (!row || row.valid !== 1) throw new ServiceProtocolError('INVALID_REQUEST')
        const agent = (db.prepare('SELECT agent_id FROM task_groups WHERE id=?').get(id) as { agent_id: string | null }).agent_id
        if (agent !== null && (!isDatabaseId(agent) || !this.options.canAccessAgent(agent, caller, 'read'))) throw new ServiceProtocolError('INVALID_REQUEST')
        return agent
      }
      const initialGroupAgent = groupAgent()
      let preflightRows = (): void => {}
      const beforeEffect = (): void => {
        current(); taskGrant(taskId, mutation); for (const id of readIds) taskGrant(id); for (const id of projects) projectGrant(id); for (const id of agents) if (!this.options.canAccessAgent(id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
        preflight(); preflightRows(); if (JSON.stringify(scopeReader.capture(taskId, caller)) !== scopeText || JSON.stringify(db.prepare(relevantSql).all(...relevantParams)) !== relevantText || metadata().raw !== expectedMetadata || groupAgent() !== initialGroupAgent) throw new ServiceProtocolError('INVALID_REQUEST')
      }
      if (readIds.size > 128) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      if (!mutation) {
        const selected = initial.records.find(record => record.id === args[1])
        if (!selected || !nativeCallback) throw new ServiceProtocolError('INVALID_REQUEST')
        if (Buffer.byteLength(scopeText) + Buffer.byteLength(initial.raw) + Buffer.byteLength(relevantText) >= TASK_ATTACHMENT_LIMITS.wireBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
        beforeEffect()
        await files.open(taskId, selected, { beforeEffect, signal }, async receipt => {
          beforeEffect()
          if (!isAttachmentPathReceipt(receipt) || receipt.taskId !== taskId || receipt.attachmentId !== selected.id || receipt.filename !== selected.filename || receipt.target.size !== String(selected.size) || receipt.attachmentRoot !== this.owners.attachmentRoot) throw new ServiceProtocolError('INVALID_RESULT')
          // A native Save dialog can wait while task grants/bindings change.
          // This captured call scope remains active through the raw callback;
          // native copy must recheck it before each accepted write boundary.
          if (operation === 'attachments:download') await this.downloadAttachment!(receipt, caller, signal, beforeEffect)
          else await this.openAttachment!(receipt, caller, signal)
          beforeEffect()
        })
        beforeEffect()
        return undefined as DesktopCommandMap[K]['result']
      }
      // Bound every actual schema column before a legacy full task getter can
      // materialize it. Schema metadata is iterated with a finite column cap.
      const columns: string[] = []
      for (const row of db.prepare('PRAGMA table_info(tasks)').iterate() as Iterable<{ name: string }>) {
        if (columns.length >= 256 || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name)) throw new ServiceProtocolError('INVALID_REQUEST')
        columns.push(`COALESCE(length(CAST("${row.name}" AS BLOB)),0)`)
      }
      const agentColumns: string[] = []
      for (const row of db.prepare('PRAGMA table_info(agents)').iterate() as Iterable<{ name: string }>) {
        if (agentColumns.length >= 256 || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name)) throw new ServiceProtocolError('INVALID_REQUEST')
        agentColumns.push(`COALESCE(length(CAST("${row.name}" AS BLOB)),0)`)
      }
      preflightRows = (): void => { for (const id of readIds) {
        const tooLarge = db.prepare(`SELECT 1 FROM tasks WHERE id=? AND (${columns.map(bytes => `${bytes}>131072`).join(' OR ')} OR ${columns.join('+')}>=890000)`).get(id)
        if (tooLarge) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      } for (const id of agents) {
        if (db.prepare(`SELECT 1 FROM agents WHERE id=? AND (${agentColumns.map(bytes => `${bytes}>131072`).join(' OR ')} OR ${agentColumns.join('+')}>=890000)`).get(id)) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      } }
      preflightRows()
      if (operation === 'chatImages:saveToTask' && initial.records.length + (args[1] as unknown[]).length > TASK_ATTACHMENT_LIMITS.records) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      const effect = async (): Promise<unknown> => {
        beforeEffect()
        if (operation === 'attachments:remove') {
          const selected = initial.records.find(record => record.id === args[1])
          if (!selected) throw new ServiceProtocolError('INVALID_REQUEST')
          await files.remove(taskId, selected, { beforeEffect, signal }); beforeEffect(); return undefined
        }
        const store: TaskImageStore = {
          getTask(id) { if (id !== taskId) throw new ServiceProtocolError('INVALID_REQUEST'); beforeEffect(); return { attachments: metadata().records } },
          getAttachmentsDir() { throw new ServiceProtocolError('UNKNOWN_OPERATION') },
          updateTask: (id, update) => {
            if (id !== taskId || !taskAttachmentRecords(update.attachments)) throw new ServiceProtocolError('INVALID_REQUEST')
            beforeEffect(); const expected = JSON.stringify(update.attachments)
            const changed = db.transaction(() => {
              const result = database.updateTask(id, { attachments: update.attachments }); if (!result) throw new ServiceProtocolError('INVALID_REQUEST')
              current()
              const actual = db.prepare('SELECT attachments FROM tasks WHERE id=?').get(id) as { attachments: string } | undefined
              if (actual?.attachments !== expected) throw new ServiceProtocolError('INVALID_RESULT')
              return result
            })()
            // No fallible guard between accepted commit and file bookkeeping.
            // A later caller loss must preserve this exact durable append.
            expectedMetadata = expected
            return changed
          }
        }
        const saved = await saveImagesAsTaskAttachments(store, taskId, args[1], { beforeEffect, write: (id, record, bytes) => files.write(id, record, bytes, { beforeEffect, signal }), rollback: receipt => files.rollback(receipt), commit: receipt => files.commit(receipt) })
        beforeEffect(); if (saved.saved.length) this.options.onTaskUpdated(taskId, saved.attachments); return saved.saved
      }
      const ids = [...readIds], result = this.options.runAttachmentMutation ? await this.options.runAttachmentMutation(ids, effect) : await manager.runTaskLifecycleMutation(ids, effect)
      beforeEffect(); const codec = TASK_ATTACHMENT_CODECS[operation] as TaskAttachmentCodec<K>, encoded = codec.encodeResult(result); return codec.decodeResult(encoded.defined ? encoded.value : undefined)
    } catch (error) {
      current(); if (error instanceof ServiceProtocolError) throw error
      if (error instanceof TaskAttachmentFileError) {
        const codes = { ATTACHMENT_CAPACITY: 'FRAME_TOO_LARGE', ATTACHMENT_PATH_CHANGED: 'INVALID_REQUEST', ATTACHMENT_PATH_REFUSED: 'INVALID_REQUEST', ATTACHMENT_INVALID_ARGUMENTS: 'INVALID_ARGUMENTS', ATTACHMENT_CANCELLED: 'CANCELLED', ATTACHMENT_CLOSED: 'DISCONNECTED', ATTACHMENT_BUSY: 'BACKPRESSURE', ATTACHMENT_CLOSE_FAILED: 'INTERNAL_ERROR', ATTACHMENT_DRAIN_INCOMPLETE: 'TIMEOUT', ATTACHMENT_IO_FAILED: 'INTERNAL_ERROR' } as const
        throw new ServiceProtocolError(codes[error.code])
      }
      throw new ServiceProtocolError('INTERNAL_ERROR')
    } finally { active = false }
  }
  private bind<K extends TaskAttachmentOperation>(operation: K): void {
    const codec = TASK_ATTACHMENT_CODECS[operation] as TaskAttachmentCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments, authorize: (_args, caller) => { this.authorize(caller); return true }, invoke: (args, caller, signal) => {
      const mutation = operation === 'chatImages:saveToTask' || operation === 'attachments:remove'
      if (this.mutationBusy || this.flights.size >= TASK_ATTACHMENT_LIMITS.requests || mutation && this.flights.size > 0) throw new ServiceProtocolError('BACKPRESSURE')
      if (mutation) this.mutationBusy = true; const controller = new AbortController(), abort = (): void => controller.abort(); this.controllers.add(controller); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      const raw = this.execute(operation, args, Object.freeze({ ...caller }), controller.signal).finally(() => { if (mutation) this.mutationBusy = false; this.controllers.delete(controller); signal.removeEventListener('abort', abort) })
      this.flights.add(raw); void raw.then(() => this.flights.delete(raw), () => this.flights.delete(raw)); return raw
    }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}

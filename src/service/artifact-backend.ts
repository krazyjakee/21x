import { lstat, realpath } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { WorkspaceFileOwner, WorkspaceFileError, type WorkspacePathReceipt } from '../main/workspace-file-owner'
import type { ArtifactCopyFileResult } from '../shared/artifacts'
import { isWorkspacePathReceipt } from '../shared/workspace-native-callbacks'
import { isUiLeaseId } from '../shared/ui-desktop-codecs'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import type { DatabaseManager } from '../main/database/manager'
import { ArtifactReadLimitError, listTaskArtifactEntries, readTaskArtifact, type ArtifactReadControls } from '../main/artifacts'
import { ARTIFACT_CODECS, ARTIFACT_OPERATIONS, ARTIFACT_LIMITS, type ArtifactCodec, type ArtifactOperation } from '../shared/artifact-codecs'
import { TaskWorkspaceScopeReader, type TaskWorkspaceScope } from './task-workspace-scope'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface ArtifactBackendOptions {
  database: DatabaseManager
  /** Exact host-selected database workspace root; never an RPC argument. */
  workspaceRoot: string
  engineEpoch: string
  assertAvailable(): void
  assertArtifactOwners(database: DatabaseManager, workspaceRoot: string, files?: WorkspaceFileOwner): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  files?: WorkspaceFileOwner
  canAccessAgent?(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  copyArtifact?(receipt: WorkspacePathReceipt, caller: DesktopCallerContext, signal: AbortSignal, beforeEffect: () => void): Promise<ArtifactCopyFileResult>
}
interface FileIdentity { dev: number; ino: number }

/** Read-only retained artifact controls. Literal requested-task workspaces are
 * preserved; group reads never silently migrate/alias a member to its anchor.
 * Read content stays inert. Optional copying grants an exact native file
 * reference callback only; it cannot create or open an embedded viewer. */
export class ArtifactBackend {
  readonly registry: DesktopOperationRegistry
  private readonly root: string
  private readonly scopeReader: TaskWorkspaceScopeReader
  private readonly rootIdentity: FileIdentity
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private readonly files: WorkspaceFileOwner | undefined
  private readonly copyArtifact: ArtifactBackendOptions['copyArtifact']
  constructor(private readonly options: ArtifactBackendOptions) {
    this.files = options.files; this.copyArtifact = options.copyArtifact
    if (this.files !== undefined && !(this.files instanceof WorkspaceFileOwner) || this.copyArtifact !== undefined && (typeof this.copyArtifact !== 'function' || !this.files || typeof options.canAccessAgent !== 'function')) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available()
    this.scopeReader = new TaskWorkspaceScopeReader({ database: options.database, assertAvailable: () => this.available(), canAccessTask: (...args) => options.canAccessTask(...args), canAccessProject: (...args) => options.canAccessProject(...args) })
    try {
      this.root = resolve(options.workspaceRoot)
      const info = lstatSync(this.root)
      if (!isAbsolute(options.workspaceRoot) || this.root !== options.workspaceRoot || realpathSync(this.root) !== this.root || !info.isDirectory() || info.isSymbolicLink()) throw new Error()
      this.rootIdentity = { dev: info.dev, ino: info.ino }
    } catch { throw new ServiceProtocolError('INVALID_ARGUMENTS') }
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true; for (const controller of this.controllers) controller.abort() }
  /** Raw directory/file handles remain owned through their actual close even
   * after a public request abort or this bounded shutdown deadline. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid artifact shutdown deadline')
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(ARTIFACT_OPERATIONS.map(operation => [operation, {
      validatePayload: (v: unknown) => { try { return isJsonValue(v) && ARTIFACT_CODECS[operation].validateArguments(ARTIFACT_CODECS[operation].decodeArguments(v)) } catch { return false } },
      validateResult: ARTIFACT_CODECS[operation].validateWireResult,
      handle: (v: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, v, caller, signal)
    }]))
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertArtifactOwners(this.options.database, this.options.workspaceRoot, this.files)
  }
  private scope(id: string, caller: DesktopCallerContext): TaskWorkspaceScope {
    return this.scopeReader.capture(id, caller)
  }
  private async physical(workspace: string): Promise<FileIdentity | null> {
    const root = await lstat(this.root)
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino || await realpath(this.root) !== this.root) throw new ServiceProtocolError('DISCONNECTED')
    let info
    try { info = await lstat(workspace) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ServiceProtocolError('INVALID_REQUEST') }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(workspace) !== workspace) throw new ServiceProtocolError('INVALID_REQUEST')
    return { dev: info.dev, ino: info.ino }
  }
  private async read<K extends ArtifactOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal): Promise<DesktopCommandMap[K]['result']> {
    this.available(signal)
    const [id] = args, expected = JSON.stringify(this.scope(id, caller)), workspace = join(this.root, id), identity = await this.physical(workspace)
    const recheck = (): void => { this.available(signal); if (JSON.stringify(this.scope(id, caller)) !== expected) throw new ServiceProtocolError('INVALID_REQUEST') }
    recheck()
    const controls: ArtifactReadControls = { strict: true, taskId: id, signal, maxTextBytes: ARTIFACT_LIMITS.textBytes, maxImageBytes: ARTIFACT_LIMITS.imageBytes, beforeRead: recheck }
    let result: unknown
    try { result = identity ? operation === 'artifacts:scan' ? await listTaskArtifactEntries(workspace, id, controls) : await readTaskArtifact(workspace, args[1] as string, controls) : operation === 'artifacts:scan' ? [] : null }
    catch (error) { recheck(); if (error instanceof ArtifactReadLimitError) throw new ServiceProtocolError('FRAME_TOO_LARGE'); throw error }
    const final = await this.physical(workspace)
    if (JSON.stringify(final) !== JSON.stringify(identity)) throw new ServiceProtocolError('INVALID_REQUEST')
    recheck()
    const codec = ARTIFACT_CODECS[operation] as ArtifactCodec<K>, encoded = codec.encodeResult(result)
    return codec.decodeResult(encoded.defined ? encoded.value : undefined)
  }
  private async copy(args: DesktopCommandMap['artifacts:copyFile']['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal): Promise<ArtifactCopyFileResult> {
    const [taskId, relativePath] = args, callback = this.copyArtifact, files = this.files
    let active = true
    const current = (): void => {
      if (!active) throw new ServiceProtocolError('CANCELLED')
      this.available(signal)
      if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !caller.origin || !caller.webviewId || !this.options.isTrustedDesktop(caller)) throw new ServiceProtocolError('INVALID_REQUEST')
      if (callback && (this.options.copyArtifact !== callback || this.options.files !== files)) throw new ServiceProtocolError('DISCONNECTED')
      if (callback && !isUiLeaseId(caller.uiLeaseId)) throw new ServiceProtocolError('INVALID_REQUEST')
    }
    const binding = (): string => {
      current()
      const scope = this.scope(taskId, caller), db = this.options.database.db
      let groupAgent: string | null = null
      if (scope.group !== null) {
        const row = db.prepare("SELECT CASE WHEN agent_id IS NULL THEN NULL WHEN typeof(agent_id)='text' AND length(CAST(agent_id AS BLOB))<=128 THEN agent_id ELSE '' END AS agent_id FROM task_groups WHERE id=?").get((scope.group as { id: string }).id) as { agent_id: string | null } | undefined
        if (!row) throw new ServiceProtocolError('INVALID_REQUEST')
        groupAgent = row.agent_id
        if (groupAgent !== null && !isDatabaseId(groupAgent)) throw new ServiceProtocolError('INVALID_REQUEST')
      }
      const agents = new Set([...scope.tasks.flatMap(task => task.agent_id ? [task.agent_id] : []), ...(groupAgent ? [groupAgent] : [])])
      for (const id of agents) {
        if (!isDatabaseId(id) || !db.prepare('SELECT 1 FROM agents WHERE id=?').get(id) || this.options.canAccessAgent !== undefined && !this.options.canAccessAgent(id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
      }
      const frozen = JSON.stringify({ scope, groupAgent })
      if (Buffer.byteLength(frozen) >= ARTIFACT_LIMITS.resultBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      return frozen
    }
    try {
      const initial = binding()
      const beforeEffect = (): void => { current(); if (binding() !== initial) throw new ServiceProtocolError('INVALID_REQUEST') }
      beforeEffect()
      if (!callback || !files) return ARTIFACT_CODECS['artifacts:copyFile'].decodeResult({ mode: 'unavailable' })
      files.assertOwners(this.root)
      const path = join(this.root, taskId, relativePath)
      const result = await files.withCapturedFile(taskId, path, { beforeEffect, signal }, async receipt => {
        beforeEffect()
        if (!isWorkspacePathReceipt(receipt) || receipt.taskId !== taskId || receipt.path !== path || receipt.workspaceRoot !== this.root || receipt.target.kind !== 'file' || receipt.target.nlink !== '1' || BigInt(receipt.target.size) > BigInt(ARTIFACT_LIMITS.copyFileBytes)) throw new ServiceProtocolError('INVALID_RESULT')
        const copied = await callback(receipt, caller, signal, beforeEffect)
        beforeEffect()
        // This portable scope advertises native file references only. Legacy
        // public image/path modes remain valid DTOs for their existing owners.
        if (!ARTIFACT_CODECS['artifacts:copyFile'].validateResult(copied) || !['file', 'unavailable'].includes(copied.mode)) throw new ServiceProtocolError('INVALID_RESULT')
        return Object.freeze({ mode: copied.mode })
      })
      beforeEffect()
      return ARTIFACT_CODECS['artifacts:copyFile'].decodeResult(result ?? { mode: 'unavailable' })
    } catch (error) {
      current()
      if (error instanceof ServiceProtocolError) throw error
      if (error instanceof WorkspaceFileError) {
        const codes = { WORKSPACE_INVALID_ARGUMENTS: 'INVALID_ARGUMENTS', WORKSPACE_PATH_REFUSED: 'INVALID_REQUEST', WORKSPACE_PATH_CHANGED: 'INVALID_REQUEST', WORKSPACE_CANCELLED: 'CANCELLED', WORKSPACE_CLOSED: 'DISCONNECTED', WORKSPACE_BUSY: 'BACKPRESSURE', WORKSPACE_IO_FAILED: 'INTERNAL_ERROR', WORKSPACE_CLOSE_FAILED: 'INTERNAL_ERROR', WORKSPACE_DRAIN_INCOMPLETE: 'TIMEOUT', WORKSPACE_NATIVE_UNAVAILABLE: 'INVALID_REQUEST' } as const
        throw new ServiceProtocolError(codes[error.code])
      }
      throw new ServiceProtocolError('INTERNAL_ERROR')
    } finally { active = false }
  }
  private bindCommands(): void {
    for (const operation of ARTIFACT_OPERATIONS) this.bind(operation)
  }
  private bind<K extends ArtifactOperation>(operation: K): void {
    const codec = ARTIFACT_CODECS[operation] as ArtifactCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments,
      authorize: ([id], caller) => { this.scope(id, caller); return true },
      invoke: (args, caller, signal) => {
        if (this.flights.size >= 16) throw new ServiceProtocolError('BACKPRESSURE')
        const controller = new AbortController(), abort = (): void => controller.abort()
        this.controllers.add(controller); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
        const captured = Object.freeze({ ...caller })
        const work = (operation === 'artifacts:copyFile' ? this.copy(args as DesktopCommandMap['artifacts:copyFile']['apiArguments'], captured, controller.signal) : this.read(operation, args, captured, controller.signal)).finally(() => { this.controllers.delete(controller); signal.removeEventListener('abort', abort) })
        this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work as Promise<DesktopCommandMap[K]['result']>
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}

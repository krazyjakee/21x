import { isAbsolute, normalize, relative, sep } from 'node:path'
import type { DatabaseManager } from '../main/database/manager'
import { WorkspaceFileOwner, WorkspaceFileError } from '../main/workspace-file-owner'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { WORKSPACE_FILE_CODECS, WORKSPACE_FILE_OPERATIONS, WORKSPACE_FILE_LIMITS, type WorkspaceFileCodec, type WorkspaceFileOperation } from '../shared/workspace-file-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { TaskWorkspaceScopeReader, type TaskWorkspaceScope } from './task-workspace-scope'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface WorkspaceFileBackendOptions {
  database: DatabaseManager
  files: WorkspaceFileOwner
  workspaceRoot: string
  engineEpoch: string
  assertAvailable(): void
  assertWorkspaceFileOwners(database: DatabaseManager, files: WorkspaceFileOwner, workspaceRoot: string): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read'): boolean
}

/** Four existing workspace controls. A path identifies a literal task beneath
 * the captured root; it cannot supply a task ID, root, or permission override. */
export class WorkspaceFileBackend {
  readonly registry: DesktopOperationRegistry
  private readonly scopeReader: TaskWorkspaceScopeReader
  private readonly files: WorkspaceFileOwner
  private readonly database: DatabaseManager
  private readonly root: string
  private readonly operations: readonly WorkspaceFileOperation[]
  private readonly flights = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private closing = false
  constructor(private readonly options: WorkspaceFileBackendOptions) {
    this.files = options.files; this.database = options.database; this.root = options.workspaceRoot
    if (!(this.files instanceof WorkspaceFileOwner) || !isAbsolute(this.root) || normalize(this.root) !== this.root) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.available()
    this.scopeReader = new TaskWorkspaceScopeReader({ database: this.database, assertAvailable: () => this.available(), canAccessTask: (...args) => options.canAccessTask(...args), canAccessProject: (...args) => options.canAccessProject(...args) })
    this.operations = Object.freeze(WORKSPACE_FILE_OPERATIONS.filter(operation => this.supported(operation)))
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of this.operations) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size + this.files.inflightCount }
  shutdown(): void { this.closing = true; for (const controller of this.controllers) controller.abort(); this.files.shutdown() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid workspace shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.all([Promise.allSettled([...this.flights]), this.files.close(timeoutMs)]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    catch { throw new ServiceProtocolError('TIMEOUT') }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(this.operations.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && WORKSPACE_FILE_CODECS[operation].validateArguments(WORKSPACE_FILE_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: WORKSPACE_FILE_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  private supported(operation: WorkspaceFileOperation): boolean { return operation === 'shell:openPath' ? this.files.canOpenPath : operation === 'shell:showItemInFolder' ? this.files.canShowItemInFolder : true }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing || !this.database.db.open) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertWorkspaceFileOwners(this.database, this.files, this.root); this.files.assertOwners(this.root)
  }
  private authorized(caller: DesktopCallerContext, signal?: AbortSignal): void {
    this.available(signal)
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !caller.origin || !caller.webviewId || !this.options.isTrustedDesktop(caller)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  private taskId(operation: WorkspaceFileOperation, argument: string): string {
    if (operation === 'tasks:getWorkspaceDir') { if (!isDatabaseId(argument)) throw new ServiceProtocolError('INVALID_ARGUMENTS'); return argument }
    if (!isAbsolute(argument) || normalize(argument) !== argument) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const part = relative(this.root, argument)
    if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new ServiceProtocolError('INVALID_REQUEST')
    const id = part.split(sep)[0]
    if (!isDatabaseId(id)) throw new ServiceProtocolError('INVALID_REQUEST')
    return id
  }
  private scope(operation: WorkspaceFileOperation, argument: string, caller: DesktopCallerContext): TaskWorkspaceScope {
    if (!this.supported(operation)) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    this.authorized(caller)
    return this.scopeReader.capture(this.taskId(operation, argument), caller)
  }
  private async execute<K extends WorkspaceFileOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal): Promise<DesktopCommandMap[K]['result']> {
    this.authorized(caller, signal)
    const argument = args[0], id = this.taskId(operation, argument), expected = JSON.stringify(this.scope(operation, argument, caller))
    const recheck = (): void => { this.authorized(caller, signal); if (JSON.stringify(this.scope(operation, argument, caller)) !== expected) throw new ServiceProtocolError('INVALID_REQUEST') }
    const controls = { beforeEffect: recheck, signal }
    try {
      let result: unknown
      switch (operation) {
        case 'tasks:getWorkspaceDir': result = await this.files.getWorkspaceDir(id, controls); break
        case 'shell:readTextFile': result = await this.files.readTextFile(id, argument, controls); break
        case 'shell:openPath': result = await this.files.openPath(id, argument, controls); break
        case 'shell:showItemInFolder': result = await this.files.showItemInFolder(id, argument, controls); break
      }
      recheck()
      const codec = WORKSPACE_FILE_CODECS[operation] as WorkspaceFileCodec<K>, encoded = codec.encodeResult(result)
      return codec.decodeResult(encoded.defined ? encoded.value : undefined)
    } catch (error) {
      recheck()
      if (error instanceof ServiceProtocolError) throw error
      if (error instanceof WorkspaceFileError) {
        const codes = { WORKSPACE_INVALID_ARGUMENTS: 'INVALID_ARGUMENTS', WORKSPACE_PATH_REFUSED: 'INVALID_REQUEST', WORKSPACE_PATH_CHANGED: 'INVALID_REQUEST', WORKSPACE_CANCELLED: 'CANCELLED', WORKSPACE_CLOSED: 'DISCONNECTED', WORKSPACE_BUSY: 'BACKPRESSURE', WORKSPACE_NATIVE_UNAVAILABLE: 'UNKNOWN_OPERATION' } as const
        if (Object.hasOwn(codes, error.code)) throw new ServiceProtocolError(codes[error.code as keyof typeof codes])
      }
      throw new ServiceProtocolError('INTERNAL_ERROR')
    }
  }
  private bind<K extends WorkspaceFileOperation>(operation: K): void {
    const codec = WORKSPACE_FILE_CODECS[operation] as WorkspaceFileCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments,
      authorize: ([argument], caller) => { this.scope(operation, argument, caller); return true },
      invoke: (args, caller, signal) => {
        if (!this.supported(operation)) throw new ServiceProtocolError('UNKNOWN_OPERATION')
        if (this.flights.size >= WORKSPACE_FILE_LIMITS.requests) throw new ServiceProtocolError('BACKPRESSURE')
        const controller = new AbortController(), abort = (): void => controller.abort()
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort(); this.controllers.add(controller)
        const work = this.execute(operation, args, Object.freeze({ ...caller }), controller.signal).finally(() => { this.controllers.delete(controller); signal.removeEventListener('abort', abort) })
        this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}

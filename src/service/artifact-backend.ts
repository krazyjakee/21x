import { lstat, realpath } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
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
  assertArtifactOwners(database: DatabaseManager, workspaceRoot: string): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read'): boolean
}
interface FileIdentity { dev: number; ino: number }

/** Read-only retained artifact controls. Literal requested-task workspaces are
 * preserved; group reads never silently migrate/alias a member to its anchor.
 * Content has no native/WebView capability and cannot create or open a viewer. */
export class ArtifactBackend {
  readonly registry: DesktopOperationRegistry
  private readonly root: string
  private readonly scopeReader: TaskWorkspaceScopeReader
  private readonly rootIdentity: FileIdentity
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: ArtifactBackendOptions) {
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
  shutdown(): void { this.closing = true }
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
    this.options.assertAvailable(); this.options.assertArtifactOwners(this.options.database, this.options.workspaceRoot)
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
  private bindCommands(): void {
    for (const operation of ARTIFACT_OPERATIONS) this.bind(operation)
  }
  private bind<K extends ArtifactOperation>(operation: K): void {
    const codec = ARTIFACT_CODECS[operation] as ArtifactCodec<K>
    this.registry.bindCommand(operation, { decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments,
      authorize: ([id], caller) => { this.scope(id, caller); return true },
      invoke: (args, caller, signal) => {
        if (this.flights.size >= 16) throw new ServiceProtocolError('BACKPRESSURE')
        const work = this.read(operation, args, caller, signal); this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work
      }, validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
}

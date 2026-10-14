import { lstat, realpath } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { DatabaseManager } from '../main/database/manager'
import { ArtifactReadLimitError, listTaskArtifactEntries, readTaskArtifact, type ArtifactReadControls } from '../main/artifacts'
import { ARTIFACT_CODECS, ARTIFACT_OPERATIONS, ARTIFACT_LIMITS, type ArtifactCodec, type ArtifactOperation } from '../shared/artifact-codecs'
import { isDatabaseId } from '../shared/database-desktop-codecs'
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
interface TaskBinding { id: string; project_id: string; role: string; group_id: string | null; repos: string; agent_id: string | null; session_id: string | null }
interface Scope { task: TaskBinding; tasks: TaskBinding[]; project: { id: string; archived: number }; repositories: unknown[]; group: unknown; memberships: unknown[] }

/** Read-only retained artifact controls. Literal requested-task workspaces are
 * preserved; group reads never silently migrate/alias a member to its anchor.
 * Content has no native/WebView capability and cannot create or open a viewer. */
export class ArtifactBackend {
  readonly registry: DesktopOperationRegistry
  private readonly root: string
  private readonly rootIdentity: FileIdentity
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: ArtifactBackendOptions) {
    this.available()
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
  private task(id: string, caller: DesktopCallerContext): TaskBinding {
    if (!this.options.canAccessTask(id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
    const db = this.options.database.db
    // Only these scalar bindings and repos are needed. Avoid DatabaseManager's
    // unrelated attachment/output/settings JSON deserializers entirely.
    const oversized = db.prepare(`SELECT 1 FROM tasks WHERE id=? AND
      (length(CAST(id AS BLOB))>128 OR length(CAST(project_id AS BLOB))>128 OR length(CAST(role AS BLOB))>32 OR
       COALESCE(length(CAST(group_id AS BLOB)),0)>128 OR COALESCE(length(CAST(agent_id AS BLOB)),0)>128 OR
       COALESCE(length(CAST(session_id AS BLOB)),0)>512 OR length(CAST(repos AS BLOB))>65536) LIMIT 1`).get(id)
    if (oversized) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const row = db.prepare('SELECT id,project_id,role,group_id,repos,agent_id,session_id FROM tasks WHERE id=?').get(id) as TaskBinding | undefined
    if (!row || !isDatabaseId(row.id) || !isDatabaseId(row.project_id) || !['task', 'captain', 'task_group'].includes(row.role) || row.group_id !== null && !isDatabaseId(row.group_id) || row.agent_id !== null && !isDatabaseId(row.agent_id) || !this.options.canAccessProject(row.project_id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
    let repos: unknown
    try { repos = JSON.parse(row.repos) } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
    if (!Array.isArray(repos) || repos.length > 128 || repos.some(repo => typeof repo !== 'string' || !repo || Buffer.byteLength(repo) > 512 || /[\u0000-\u001f\u007f]/.test(repo))) throw new ServiceProtocolError('INVALID_REQUEST')
    return row
  }
  private scope(id: string, caller: DesktopCallerContext): Scope {
    this.available()
    if (!caller.webviewId || !caller.origin) throw new ServiceProtocolError('INVALID_REQUEST')
    const db = this.options.database.db, task = this.task(id, caller)
    const project = db.prepare("SELECT id,CASE WHEN typeof(archived)='integer' AND archived IN (0,1) THEN archived ELSE NULL END AS archived FROM projects WHERE id=?").get(task.project_id) as Scope['project'] | undefined
    if (!project || !isDatabaseId(project.id) || ![0, 1].includes(project.archived)) throw new ServiceProtocolError('INVALID_REQUEST')
    const repoStats = db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(MAX(length(CAST(id AS BLOB)),length(CAST(provider AS BLOB)),length(CAST(org AS BLOB)),length(CAST(name AS BLOB)),COALESCE(length(CAST(default_branch AS BLOB)),0))),0) AS bytes FROM project_repos WHERE project_id=?`).get(project.id) as { count: number; bytes: number }
    if (repoStats.count > 128 || repoStats.bytes > 512) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const repositories = db.prepare('SELECT id,project_id,provider,org,name,default_branch FROM project_repos WHERE project_id=? ORDER BY id').all(project.id)
    const groups = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id,
      CASE WHEN length(CAST(project_id AS BLOB))<=128 THEN project_id ELSE NULL END AS project_id,
      CASE WHEN length(CAST(execution_task_id AS BLOB))<=128 THEN execution_task_id ELSE NULL END AS execution_task_id,
      CASE WHEN length(CAST(state AS BLOB))<=32 THEN state ELSE NULL END AS state
      FROM task_groups WHERE execution_task_id=? OR id=? LIMIT 2`).all(task.id, task.group_id) as Array<{ id: string; project_id: string; execution_task_id: string; state: string }>
    if (groups.length > 1 || task.role === 'task_group' && !groups.length || task.group_id && !groups.length) throw new ServiceProtocolError('INVALID_REQUEST')
    const group = groups[0] ?? null, tasks = [task]
    let memberships: Scope['memberships'] = []
    if (group) {
      if (!isDatabaseId(group.id) || !isDatabaseId(group.execution_task_id) || group.project_id !== project.id || !['active', 'dissolved'].includes(group.state) || task.role === 'captain') throw new ServiceProtocolError('INVALID_REQUEST')
      const rows = db.prepare(`SELECT CASE WHEN length(CAST(task_id AS BLOB))<=128 THEN task_id ELSE NULL END AS task_id,
        CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id,
        CASE WHEN typeof(position)='integer' AND position>=0 AND position<=9007199254740991 THEN position ELSE NULL END AS position,
        CASE WHEN length(CAST(joined_at AS BLOB))<=32 THEN joined_at ELSE NULL END AS joined_at,
        CASE WHEN left_at IS NULL OR length(CAST(left_at AS BLOB))<=32 THEN left_at ELSE '' END AS left_at
        FROM task_group_memberships WHERE group_id=? ORDER BY position,joined_at,id LIMIT 129`).all(group.id) as Array<{ id: string; task_id: string; position: number; joined_at: string; left_at: string | null }>
      if (rows.length > ARTIFACT_LIMITS.members) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      if (rows.some(row => !isDatabaseId(row.id) || !isDatabaseId(row.task_id) || !Number.isSafeInteger(row.position) || row.position < 0 || typeof row.joined_at !== 'string' || !row.joined_at || row.left_at !== null && (typeof row.left_at !== 'string' || !row.left_at))) throw new ServiceProtocolError('INVALID_REQUEST')
      if (task.id !== group.execution_task_id && !rows.some(row => row.task_id === task.id && row.left_at === null) || task.role === 'task_group' && task.id !== group.execution_task_id) throw new ServiceProtocolError('INVALID_REQUEST')
      const ids = new Set([group.execution_task_id, ...rows.filter(row => task.id === group.execution_task_id || row.left_at === null).map(row => row.task_id)])
      for (const member of ids) {
        const owned = this.task(member, caller)
        if (owned.project_id !== project.id || member === group.execution_task_id && owned.role !== 'task_group' || rows.some(row => row.task_id === member && row.left_at === null) && owned.group_id !== group.id) throw new ServiceProtocolError('INVALID_REQUEST')
        if (member !== task.id) tasks.push(owned)
      }
      memberships = rows
    }
    return { task, tasks, project, repositories, group, memberships }
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

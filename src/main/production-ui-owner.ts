import type { DatabaseManager } from './database/manager'
import type { AgentManager } from './agent-manager'
import type { UiCommand, UiStateSnapshot } from '../shared/ui-commands'
import { isUiCommand, isUiStateSnapshot, isUiLeaseId, uiText, UI_DESKTOP_LIMITS } from '../shared/ui-desktop-codecs'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { hasExactKeys, isRecord, ServiceProtocolError } from '../shared/service-protocol'
import { DEFAULT_PROJECT_ID } from '../shared/projects'

export interface UiRequestControls { beforeEffect(): void; signal: AbortSignal }
export type NativeUiSnapshot = { available: false } | { available: true; leaseId: string }
export type NativeUiAcknowledgement = { ok: true; leaseId: string } | { ok: false; detail: string }
export interface ProductionUiNativeHost {
  snapshot(): Promise<NativeUiSnapshot>
  send(command: UiCommand, leaseId: string, signal: AbortSignal): Promise<NativeUiAcknowledgement>
}
export interface UiReferenceGrants {
  canAccessProject(id: string): boolean
  canAccessTask(id: string): boolean
  canAccessAgent(id: string): boolean
}
export type PublishedUiState = { available: false } | (UiStateSnapshot & { available: true; updatedAt: number })
export interface ProductionUiOwners { database: DatabaseManager; manager: AgentManager }
export interface ProductionUiOwnerOptions extends ProductionUiOwners {
  native: ProductionUiNativeHost
  assertCurrent(): void
  beforeState(state: UiStateSnapshot): void
  beforeCommand(command: UiCommand): void
}
/** Bounded scalar scope only. No task/agent getter parses private configs or
 * large descriptions. Panel IDs are opaque UI IDs, never agent aliases. */
export function assertUiStateReferences(database: DatabaseManager, state: UiStateSnapshot, grants: UiReferenceGrants): void {
  if (!isUiStateSnapshot(state)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  let bytes = 0
  const project = (id: string, captain: boolean): void => {
    if (!isDatabaseId(id) || !grants.canAccessProject(id)) throw new ServiceProtocolError('INVALID_REQUEST')
    const size = database.db.prepare('SELECT length(CAST(id AS BLOB))+COALESCE(length(CAST(captain_agent_id AS BLOB)),0) AS bytes FROM projects WHERE id=?').get(id) as { bytes: number } | undefined
    if (!size || size.bytes > 256) throw new ServiceProtocolError('INVALID_REQUEST')
    bytes += size.bytes
    if (bytes > UI_DESKTOP_LIMITS.storedScopeBytes) throw new ServiceProtocolError('INVALID_REQUEST')
    if (captain) {
      const row = database.db.prepare('SELECT captain_agent_id FROM projects WHERE id=?').get(id) as { captain_agent_id: string | null }
      if (row.captain_agent_id && (!isDatabaseId(row.captain_agent_id) || !grants.canAccessAgent(row.captain_agent_id) || !database.db.prepare('SELECT 1 FROM agents WHERE id=?').get(row.captain_agent_id))) throw new ServiceProtocolError('INVALID_REQUEST')
    }
  }
  project(state.projectId, state.captainOpen)
  const local = new Set([...state.visibleTaskIds, ...state.canvas.panels.flatMap(panel => panel.taskId ? [panel.taskId] : [])])
  const tasks = new Set([...local, ...[state.selectedTaskId, state.dashboardPreviewTaskId].filter((id): id is string => id !== null)])
  for (const id of tasks) {
    if (!grants.canAccessTask(id)) throw new ServiceProtocolError('INVALID_REQUEST')
    const size = database.db.prepare(`SELECT COALESCE(length(CAST(project_id AS BLOB)),0)+COALESCE(length(CAST(agent_id AS BLOB)),0)
      +COALESCE(length(CAST(role AS BLOB)),0)+COALESCE(length(CAST(group_id AS BLOB)),0) AS bytes FROM tasks WHERE id=?`).get(id) as { bytes: number } | undefined
    if (!size || size.bytes > 512) throw new ServiceProtocolError('INVALID_REQUEST')
    bytes += size.bytes
    if (bytes > UI_DESKTOP_LIMITS.storedScopeBytes) throw new ServiceProtocolError('INVALID_REQUEST')
    const task = database.db.prepare('SELECT project_id,agent_id,role,group_id FROM tasks WHERE id=?').get(id) as { project_id: string | null; agent_id: string | null; role: string; group_id: string | null }
    const projectId = task.project_id ?? DEFAULT_PROJECT_ID
    if (local.has(id) && projectId !== state.projectId) throw new ServiceProtocolError('INVALID_REQUEST')
    project(projectId, false)
    if (task.agent_id !== null && (!isDatabaseId(task.agent_id) || !grants.canAccessAgent(task.agent_id) || !database.db.prepare('SELECT 1 FROM agents WHERE id=?').get(task.agent_id))) throw new ServiceProtocolError('INVALID_REQUEST')
    if (task.group_id !== null && !isDatabaseId(task.group_id) || !['task','captain','task_group'].includes(task.role)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
}

/** Registration of open_artifact is an async workspace-registry check owned
 * by its sending route. This helper proves only its literal task/scalar scope. */
export function assertUiCommandReferences(database: DatabaseManager, command: UiCommand, grants: UiReferenceGrants): void {
  if (!isUiCommand(command)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  if (command.kind === 'navigate' || command.kind === 'set_canvas_view') return
  let projectId: string, taskId: string | null = null
  if (command.kind === 'switch_project') projectId = command.projectId
  else {
    taskId = command.taskId
    const size = database.db.prepare('SELECT COALESCE(length(CAST(project_id AS BLOB)),0) AS bytes FROM tasks WHERE id=?').get(taskId) as { bytes: number } | undefined
    if (!size || size.bytes > 128) throw new ServiceProtocolError('INVALID_REQUEST')
    const row = database.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as { project_id: string | null }
    projectId = row.project_id ?? DEFAULT_PROJECT_ID
    if (command.kind === 'open_artifact' && !/^artifact_[a-z0-9][a-z0-9_-]{5,80}$/.test(command.artifactId)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  }
  assertUiStateReferences(database, { view: 'tasks', projectId, modal: null, selectedTaskId: taskId, selectedTaskTitle: null, dashboardPreviewTaskId: null, captainOpen: false, settingsTab: null, waitingForYou: false, visibleTaskIds: [], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [] } }, grants)
}

/** Owns the real native acknowledgement. Window absence does not stop the
 * application services, and accepting intent never claims renderer application. */
export class ProductionUiOwner {
  private readonly native: ProductionUiNativeHost
  private readonly requests = new Set<AbortController>()
  private readonly work = new Set<Promise<unknown>>()
  private closing = false
  private revision = 0
  private leaseId: string | null = null
  private cache: PublishedUiState = { available: false }
  constructor(private readonly options: ProductionUiOwnerOptions) {
    this.native = Object.freeze({ snapshot: options.native.snapshot.bind(options.native), send: options.native.send.bind(options.native) })
    this.current()
  }
  get inflightCount(): number { return this.work.size }
  /** Trusted call-site receipt only; never part of published renderer state. */
  get observedLeaseId(): string | null { return this.leaseId }
  assertCommand(command: UiCommand): void {
    this.current()
    const clean = Object.fromEntries(Object.entries(command).filter(([, value]) => value !== undefined))
    if (!isUiCommand(clean)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.options.beforeCommand(clean)
  }
  assertOwners(owners: ProductionUiOwners): void {
    if (owners.database !== this.options.database || owners.manager !== this.options.manager || this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertCurrent()
  }
  shutdown(): void { this.closing = true; this.cache = { available: false }; this.leaseId = null; this.revision++; for (const request of this.requests) request.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid UI shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { while (this.work.size) await Promise.allSettled([...this.work]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private current(controls?: UiRequestControls): void {
    if (controls?.signal.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertCurrent(); controls?.beforeEffect()
  }
  private run<T>(controls: UiRequestControls | undefined, effect: (controls: UiRequestControls) => Promise<T>): Promise<T> {
    this.current(controls)
    if (this.work.size >= 64) throw new ServiceProtocolError('BACKPRESSURE')
    const request = new AbortController(), cancel = () => request.abort()
    controls?.signal.addEventListener('abort', cancel, { once: true }); if (controls?.signal.aborted) cancel()
    this.requests.add(request)
    let active = true
    const owned = { signal: request.signal, beforeEffect: () => { if (!active) throw new ServiceProtocolError('INVALID_REQUEST'); controls?.beforeEffect() } }
    const raw = (async () => { try { return await effect(owned) } catch (error) { throw error instanceof ServiceProtocolError ? error : new ServiceProtocolError('INTERNAL_ERROR') } })()
    this.work.add(raw)
    void raw.finally(() => { active = false; this.work.delete(raw); this.requests.delete(request); controls?.signal.removeEventListener('abort', cancel) }).catch(() => {})
    return raw
  }
  private async refresh(controls: UiRequestControls): Promise<NativeUiSnapshot> {
    this.current(controls); const revision = ++this.revision
    const native = await this.native.snapshot(); this.current(controls)
    if (revision !== this.revision) throw new ServiceProtocolError('DISCONNECTED')
    if (!isRecord(native) || !(native.available === false ? hasExactKeys(native,['available']) : native.available === true && hasExactKeys(native,['available','leaseId']) && isUiLeaseId(native.leaseId))) {
      this.cache = { available: false }; this.leaseId = null; throw new ServiceProtocolError('INVALID_RESULT')
    }
    const lease = native.available ? native.leaseId : null
    if (this.leaseId !== lease || !native.available) this.cache = { available: false }
    this.leaseId = lease
    return native
  }
  publish(state: UiStateSnapshot, uiLeaseId: string, controls: UiRequestControls): Promise<void> {
    if (!isUiStateSnapshot(state) || !isUiLeaseId(uiLeaseId)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const frozen = structuredClone(state)
    return this.run(controls, async current => {
      const native = await this.refresh(current); this.current(current)
      if (!native.available || native.leaseId !== uiLeaseId) throw new ServiceProtocolError('INVALID_REQUEST')
      this.options.beforeState(frozen); this.current(current)
      this.cache = { ...frozen, available: true, updatedAt: Date.now() }
    })
  }
  snapshot(controls?: UiRequestControls): Promise<PublishedUiState> {
    return this.run(controls, async current => {
      await this.refresh(current); this.current(current)
      if (this.cache.available) {
        const { available: _available, updatedAt: _updatedAt, ...state } = this.cache
        void _available; void _updatedAt
        try { this.options.beforeState(state); this.current(current) } catch (error) { this.cache = { available: false }; throw error }
      }
      return structuredClone(this.cache)
    })
  }
  send(command: UiCommand, controls?: UiRequestControls, expectedLeaseId?: string): Promise<{ success: true; command: string; accepted: true } | { error: string }> {
    if (expectedLeaseId !== undefined && !isUiLeaseId(expectedLeaseId)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const clean = Object.fromEntries(Object.entries(command).filter(([, value]) => value !== undefined))
    if (!isUiCommand(clean)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const frozen = structuredClone(clean)
    return this.run(controls, async current => {
      this.current(current); this.options.beforeCommand(frozen)
      const native = await this.refresh(current); this.current(current); this.options.beforeCommand(frozen)
      if (!native.available) return { error: 'No 21x window is open' }
      if (expectedLeaseId !== undefined && native.leaseId !== expectedLeaseId) return { error: 'The window changed before the command could be sent' }
      const acknowledgement = await this.native.send(frozen, native.leaseId, current.signal)
      this.current(current); this.options.beforeCommand(frozen)
      const latest = await this.refresh(current); this.current(current); this.options.beforeCommand(frozen)
      if (!latest.available || latest.leaseId !== native.leaseId) return { error: 'The window changed before the command was acknowledged' }
      if (!isRecord(acknowledgement) || !(acknowledgement.ok === true ? hasExactKeys(acknowledgement,['ok','leaseId']) && acknowledgement.leaseId === native.leaseId : acknowledgement.ok === false && hasExactKeys(acknowledgement,['ok','detail']) && uiText(acknowledgement.detail,256))) throw new ServiceProtocolError('INVALID_RESULT')
      return acknowledgement.ok ? { success: true, command: frozen.kind, accepted: true } : { error: 'The window could not accept the command' }
    })
  }
}

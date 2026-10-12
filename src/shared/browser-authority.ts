import { isJsonValue, isRecord, hasExactKeys, type JsonValue } from './service-protocol'
import { BROWSER_POLICY_LIMITS, BrowserPolicyError, BrowserNavigationPolicy, isBrowserIdentifier } from './browser-policy'

export const BROWSER_OPERATIONS = [
  'navigate', 'history', 'reload', 'snapshot', 'interact', 'get', 'wait', 'screenshot',
  'console', 'network', 'recording-start', 'recording-stop'
] as const
export type BrowserOperation = typeof BROWSER_OPERATIONS[number]
export interface BrowserSession {
  readonly taskId: string
  readonly sessionId: string
  readonly engineEpoch: string
}
/** Opaque, process-local capability. Never serialize it into a remote WebView. */
export interface BrowserOperationTicket {
  readonly panelId: string
  readonly nativeViewId: string
  readonly operation: BrowserOperation
  readonly request: JsonValue
  readonly signal: AbortSignal
}
interface PanelState { nativeViewId: string; taskIds: Set<string>; generation: number }
interface SessionState { allowed: Set<BrowserOperation>; permissionMode: 'ask' | 'allow' }
interface OperationState {
  session: BrowserSession
  generation: number
  status: 'awaiting-approval' | 'authorized' | 'running' | 'revoked-running'
  controller: AbortController
}
export interface BrowserAuthorityOptions {
  engineEpoch: string
  navigation: BrowserNavigationPolicy
  /** Every adapter operation needs argument validation; absence fails closed. */
  requestSchemas: Partial<Record<BrowserOperation, (value: unknown) => boolean>>
  /** Main/trusted views must never enter the browser registry. */
  protectedViewIds?: readonly string[]
}

function operationName(value: unknown): value is BrowserOperation {
  return typeof value === 'string' && (BROWSER_OPERATIONS as readonly string[]).includes(value)
}
function deepFreeze(value: JsonValue): JsonValue {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Task/session authorization state for a future broker. It performs no native operations. */
export class BrowserAuthority {
  private readonly panels = new Map<string, PanelState>()
  private readonly sessions = new Map<BrowserSession, SessionState>()
  private readonly tickets = new Map<BrowserOperationTicket, OperationState>()
  private readonly protectedViews: Set<string>
  private generation = 0
  private disposed = false

  constructor(private readonly options: BrowserAuthorityOptions) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.engineEpoch)) throw new BrowserPolicyError('INVALID_ARGUMENTS')
    this.protectedViews = new Set(['main', ...(options.protectedViewIds ?? [])])
  }

  get pendingOperationCount(): number { return this.tickets.size }

  registerPanel(panelId: string, nativeViewId: string, taskIds: readonly string[]): void {
    this.assertAvailable()
    const tasks = this.tasks(taskIds)
    if (!isBrowserIdentifier(panelId) || !isBrowserIdentifier(nativeViewId) || this.protectedViews.has(nativeViewId) ||
      this.panels.has(panelId) || [...this.panels.values()].some(panel => panel.nativeViewId === nativeViewId)) {
      throw new BrowserPolicyError('INVALID_ARGUMENTS')
    }
    if (this.panels.size >= BROWSER_POLICY_LIMITS.panels) throw new BrowserPolicyError('CAPACITY_REACHED')
    this.panels.set(panelId, { nativeViewId, taskIds: tasks, generation: ++this.generation })
  }

  setPanelTasks(panelId: string, taskIds: readonly string[]): void {
    this.assertAvailable()
    const panel = this.panels.get(panelId)
    if (!panel) throw new BrowserPolicyError('PANEL_UNAVAILABLE')
    const tasks = this.tasks(taskIds)
    this.invalidate(ticket => ticket.panelId === panelId)
    panel.taskIds = tasks
    panel.generation = ++this.generation
  }

  disposePanel(panelId: string): void {
    this.panels.delete(panelId)
    this.invalidate(ticket => ticket.panelId === panelId)
  }

  /** Called only by the authenticated service/session owner, with grants from its policy. */
  createSession(taskId: string, sessionId: string, grants: {
    operations: readonly BrowserOperation[]
    permissionMode?: 'ask' | 'allow'
  }): BrowserSession {
    this.assertAvailable()
    if (!isBrowserIdentifier(taskId) || !isBrowserIdentifier(sessionId) || !Array.isArray(grants.operations) ||
      grants.operations.length > BROWSER_OPERATIONS.length || !grants.operations.every(operationName) ||
      (grants.permissionMode !== undefined && !['ask', 'allow'].includes(grants.permissionMode)) ||
      [...this.sessions.keys()].some(session => session.sessionId === sessionId)) {
      throw new BrowserPolicyError('INVALID_ARGUMENTS')
    }
    if (this.sessions.size >= BROWSER_POLICY_LIMITS.sessions) throw new BrowserPolicyError('CAPACITY_REACHED')
    const session = Object.freeze({ taskId, sessionId, engineEpoch: this.options.engineEpoch })
    this.sessions.set(session, { allowed: new Set(grants.operations), permissionMode: grants.permissionMode ?? 'ask' })
    return session
  }

  revokeSession(session: BrowserSession): void {
    this.sessions.delete(session)
    this.invalidate((_ticket, state) => state.session === session)
  }

  listPanels(session: BrowserSession): string[] {
    this.session(session)
    return [...this.panels].filter(([, panel]) => panel.taskIds.has(session.taskId)).map(([id]) => id)
  }

  issueOperation(session: BrowserSession, operation: BrowserOperation, request: JsonValue, panelId?: string): BrowserOperationTicket {
    const grant = this.session(session)
    if (!grant.allowed.has(operation)) throw new BrowserPolicyError('NOT_AUTHORIZED')
    const validator = Object.hasOwn(this.options.requestSchemas, operation) ? this.options.requestSchemas[operation] : undefined
    if (!validator) throw new BrowserPolicyError('UNSUPPORTED_OPERATION')
    const resolved = this.resolvePanel(session, panelId)
    if (this.tickets.size >= BROWSER_POLICY_LIMITS.operations) throw new BrowserPolicyError('CAPACITY_REACHED')
    let frozen: JsonValue
    try {
      if (!isJsonValue(request)) throw new BrowserPolicyError('INVALID_ARGUMENTS')
      const serialized = JSON.stringify(request)
      if (new TextEncoder().encode(serialized).length > BROWSER_POLICY_LIMITS.requestBytes) throw new BrowserPolicyError('INVALID_ARGUMENTS')
      const copy = JSON.parse(serialized) as JsonValue
      if (operation === 'navigate') {
        if (!isRecord(copy) || !hasExactKeys(copy, ['url'])) throw new BrowserPolicyError('INVALID_ARGUMENTS')
        copy.url = this.options.navigation.normalize(copy.url)
      }
      if (!validator(copy)) throw new BrowserPolicyError('INVALID_ARGUMENTS')
      frozen = deepFreeze(copy)
    } catch (error) {
      throw error instanceof BrowserPolicyError ? error : new BrowserPolicyError('INVALID_ARGUMENTS')
    }
    const controller = new AbortController()
    const ticket = Object.freeze({ panelId: resolved.id, nativeViewId: resolved.panel.nativeViewId,
      operation, request: frozen, signal: controller.signal })
    this.tickets.set(ticket, { session, generation: resolved.panel.generation, controller,
      status: grant.permissionMode === 'allow' ? 'authorized' : 'awaiting-approval' })
    return ticket
  }

  /** The service supplies the correlated HITL result; remote pages cannot approve tickets. */
  approveOperation(ticket: BrowserOperationTicket, approved: boolean): void {
    const state = this.current(ticket)
    if (state.status !== 'awaiting-approval' || typeof approved !== 'boolean') throw new BrowserPolicyError('NOT_AUTHORIZED')
    if (!approved) { state.controller.abort(); this.tickets.delete(ticket); return }
    state.status = 'authorized'
  }

  /** Call immediately before native dispatch; a ticket starts at most once. */
  startOperation(ticket: BrowserOperationTicket): void {
    const state = this.current(ticket)
    if (state.status === 'awaiting-approval') throw new BrowserPolicyError('APPROVAL_REQUIRED')
    if (state.status !== 'authorized') throw new BrowserPolicyError('NOT_AUTHORIZED')
    state.status = 'running'
  }

  assertOperationCurrent(ticket: BrowserOperationTicket): void {
    if (this.current(ticket).status !== 'running') throw new BrowserPolicyError('NOT_AUTHORIZED')
  }

  /** Call on success or failure. False means a late native result must be discarded. */
  finishOperation(ticket: BrowserOperationTicket): boolean {
    const state = this.tickets.get(ticket)
    if (!state || !['running', 'revoked-running'].includes(state.status)) throw new BrowserPolicyError('NOT_AUTHORIZED')
    let usable = false
    try { this.current(ticket); usable = state.status === 'running' } catch { /* Revocation is expected. */ }
    this.tickets.delete(ticket)
    return usable
  }

  cancelOperation(ticket: BrowserOperationTicket): void { this.invalidate(candidate => candidate === ticket) }

  /** Baseline for the isolated spike. Native adapters must enforce denial on every permission callback. */
  remotePermissionDecision(_nativeViewId: string, _permission: unknown): 'deny' { return 'deny' }

  dispose(): void {
    this.disposed = true
    this.panels.clear()
    this.sessions.clear()
    this.invalidate(() => true)
  }

  private assertAvailable(): void {
    if (this.disposed) throw new BrowserPolicyError('NOT_AUTHORIZED')
  }

  private session(session: BrowserSession): SessionState {
    this.assertAvailable()
    const state = this.sessions.get(session)
    if (!state || session.engineEpoch !== this.options.engineEpoch) throw new BrowserPolicyError('NOT_AUTHORIZED')
    return state
  }

  private resolvePanel(session: BrowserSession, panelId?: string): { id: string; panel: PanelState } {
    if (panelId !== undefined) {
      if (!isBrowserIdentifier(panelId)) throw new BrowserPolicyError('INVALID_ARGUMENTS')
      const panel = this.panels.get(panelId)
      if (!panel || !panel.taskIds.has(session.taskId)) throw new BrowserPolicyError('PANEL_UNAVAILABLE')
      return { id: panelId, panel }
    }
    const linked = [...this.panels].filter(([, panel]) => panel.taskIds.has(session.taskId))
    if (linked.length === 0) throw new BrowserPolicyError('PANEL_UNAVAILABLE')
    if (linked.length > 1) throw new BrowserPolicyError('AMBIGUOUS_PANEL')
    return { id: linked[0][0], panel: linked[0][1] }
  }

  private current(ticket: BrowserOperationTicket): OperationState {
    const state = this.tickets.get(ticket)
    if (!state || state.controller.signal.aborted) throw new BrowserPolicyError('NOT_AUTHORIZED')
    this.session(state.session)
    const panel = this.panels.get(ticket.panelId)
    if (!panel || panel.generation !== state.generation || !panel.taskIds.has(state.session.taskId) ||
      panel.nativeViewId !== ticket.nativeViewId) throw new BrowserPolicyError('PANEL_UNAVAILABLE')
    return state
  }

  private invalidate(predicate: (ticket: BrowserOperationTicket, state: OperationState) => boolean): void {
    for (const [ticket, state] of this.tickets) {
      if (!predicate(ticket, state)) continue
      state.controller.abort()
      if (state.status === 'running' || state.status === 'revoked-running') state.status = 'revoked-running'
      else this.tickets.delete(ticket)
    }
  }

  private tasks(values: readonly string[]): Set<string> {
    if (!Array.isArray(values) || values.length > BROWSER_POLICY_LIMITS.tasksPerPanel || !values.every(isBrowserIdentifier)) {
      throw new BrowserPolicyError('INVALID_ARGUMENTS')
    }
    return new Set(values)
  }
}

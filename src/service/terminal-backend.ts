import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { TerminalEventHost, TerminalServiceCore } from '../main/terminal-service-core'
import type { DesktopCommandMap, DesktopEventMap } from '../shared/desktop-operations'
import { ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { TERMINAL_COMMAND_CODECS, TERMINAL_EVENT_CODECS, TERMINAL_DESKTOP_OPERATIONS, TERMINAL_DESKTOP_LIMITS, type TerminalCommandCodec, type TerminalDesktopOperation, type TerminalDesktopEvent } from '../shared/terminal-desktop-codecs'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

type Access = 'read' | 'write'
type Identity = NonNullable<ReturnType<TerminalServiceCore['identity']>>
interface Lease {
  id: string
  owner: DesktopCallerContext
  cwd: string
  root: string
  identity: Identity | null
  phase: 'starting' | 'live' | 'retiring' | 'exited'
  exitEmitted: boolean
  usedPids: Set<number>
}
export interface TerminalDirectoryAuthority { cwd: string; root: string }
export interface TerminalBackendOptions {
  terminals: TerminalServiceCore
  engineEpoch: string
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canAccessTerminal(id: string, caller: DesktopCallerContext, access: Access): boolean
  /** Server policy chooses both paths from an actual project/workspace grant. */
  resolveDirectory(id: string, caller: DesktopCallerContext): TerminalDirectoryAuthority | null
  emit(operation: TerminalDesktopEvent, payload: JsonValue, recipient: DesktopCallerContext): void
  onFatalEvent(error: ServiceProtocolError): void
}

/** Borrows the single real PTY owner. No process factory, shell, PID or
 * filesystem root can be supplied through a terminal request. */
export class TerminalBackend {
  readonly registry: DesktopOperationRegistry
  private readonly leases = new Map<string, Lease>()
  private readonly flights = new Set<Promise<unknown>>()
  private closing = false
  private failed = false
  constructor(private readonly options: TerminalBackendOptions) {
    options.assertAvailable()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    this.registry.bindEvent('terminal:data', TERMINAL_EVENT_CODECS['terminal:data'])
    this.registry.bindEvent('terminal:exit', TERMINAL_EVENT_CODECS['terminal:exit'])
    this.bindCommands()
  }
  get inflightCount(): number { return this.flights.size }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(TERMINAL_DESKTOP_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return TERMINAL_COMMAND_CODECS[operation].validateArguments(TERMINAL_COMMAND_CODECS[operation].decodeArguments(value as JsonValue)) } catch { return false } },
      validateResult: TERMINAL_COMMAND_CODECS[operation].validateWireResult,
      handle: (payload: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, payload, caller, signal)
    }]))
  }
  canReadEvent(operation: TerminalDesktopEvent, payload: DesktopEventMap[TerminalDesktopEvent], caller: DesktopCallerContext): boolean {
    if (!TERMINAL_EVENT_CODECS[operation].validatePayload(payload)) return false
    const lease = this.leases.get(payload.id)
    return !!lease && this.owned(lease, caller, 'read')
  }
  /** Window/navigation changes do not kill an application-owned terminal. */
  shutdown(): void {
    if (this.closing) return
    this.closing = true
    this.stopOwned()
  }
  /** ProductionOwner also joins TerminalServiceCore before releasing its DB/lock. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid terminal backend shutdown deadline')
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.drain(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private async drain(): Promise<void> { while (this.flights.size) await Promise.allSettled([...this.flights]) }
  private retain<T>(work: Promise<T>): Promise<T> {
    this.flights.add(work)
    void work.then(() => this.flights.delete(work), () => this.flights.delete(work))
    return work
  }
  private available(): void { if (this.closing || this.failed) throw new ServiceProtocolError('DISCONNECTED'); this.options.assertAvailable() }
  private trusted(caller: DesktopCallerContext): boolean {
    try { return caller.principal === 'trusted-desktop-main' && caller.engineEpoch === this.options.engineEpoch && typeof caller.webviewId === 'string' && !!caller.webviewId && typeof caller.origin === 'string' && !!caller.origin && this.options.isTrustedDesktop(caller) }
    catch { return false }
  }
  private sameCaller(one: DesktopCallerContext, two: DesktopCallerContext): boolean { return one.engineEpoch === two.engineEpoch && one.webviewId === two.webviewId && one.origin === two.origin }
  private owned(lease: Lease, caller: DesktopCallerContext, access: Access): boolean {
    return this.trusted(caller) && this.sameCaller(lease.owner, caller) && this.options.canAccessTerminal(lease.id, caller, access) && this.options.canAccessTerminal(lease.id, caller, 'read')
  }
  private identityMatches(one: Identity | null, two: Identity | null): boolean { return !!one && !!two && one.pid === two.pid && one.generation === two.generation }
  private contained(root: string, cwd: string): boolean { const child = relative(root, cwd); return child === '' || !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`) }
  private directory(id: string, caller: DesktopCallerContext, requested?: string): TerminalDirectoryAuthority {
    const selected = this.options.resolveDirectory(id, caller)
    if (!selected || ![selected.cwd, selected.root].every(value => typeof value === 'string' && !!value && value.length <= TERMINAL_DESKTOP_LIMITS.pathBytes && !value.includes('\0') && isAbsolute(value))) throw new ServiceProtocolError('INVALID_REQUEST')
    try {
      const root = realpathSync(selected.root), cwd = realpathSync(selected.cwd)
      if (!statSync(root).isDirectory() || !statSync(cwd).isDirectory() || !this.contained(root, cwd) || requested !== undefined && (!isAbsolute(requested) || realpathSync(requested) !== cwd)) throw new Error()
      if (!TERMINAL_COMMAND_CODECS['terminal:getCwd'].validateResult({ cwd }) || !TERMINAL_COMMAND_CODECS['terminal:getCwd'].validateResult({ cwd: root })) throw new Error()
      return { root, cwd }
    } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
  }
  private fatal(code: 'DISCONNECTED' | 'FRAME_TOO_LARGE' = 'DISCONNECTED'): void {
    if (this.failed) return
    this.failed = true
    this.stopOwned()
    this.options.onFatalEvent(new ServiceProtocolError(code))
  }
  private stopOwned(): void {
    for (const lease of this.leases.values()) {
      if (!lease.identity || lease.phase === 'exited') continue
      let identity: Identity | null
      try { identity = this.options.terminals.ownedIdentity(lease.id) } catch { continue /* The actual core has already fenced admission and owns its drain. */ }
      if (!this.identityMatches(identity, lease.identity)) continue
      lease.phase = 'retiring'
      this.retain(this.options.terminals.killAcknowledged(lease.id, lease.identity.pid, lease.identity.generation)).then(result => { if (result.killed) lease.phase = 'exited' }, () => {})
    }
  }
  private emit<K extends TerminalDesktopEvent>(operation: K, payload: DesktopEventMap[K], lease: Lease): void {
    if (this.closing || this.failed) return
    try {
      if (!this.owned(lease, lease.owner, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
      const encoded = this.registry.encodeEvent(operation, payload, { principal: 'service', engineEpoch: this.options.engineEpoch })
      this.options.emit(operation, encoded, lease.owner)
    } catch { this.fatal(); throw new ServiceProtocolError('DISCONNECTED') }
  }
  private events(lease: Lease): TerminalEventHost {
    return {
      data: (id, raw) => {
        if (this.leases.get(id) !== lease || lease.phase === 'retiring' || lease.phase === 'exited' || this.closing || this.failed) return
        if (lease.identity && !this.identityMatches(this.options.terminals.identity(id), lease.identity)) { this.fatal(); return }
        if (typeof raw !== 'string' || raw.length > TERMINAL_DESKTOP_LIMITS.sourceBytes || new TextEncoder().encode(raw).length > TERMINAL_DESKTOP_LIMITS.sourceBytes) { this.fatal('FRAME_TOO_LARGE'); return }
        let chunk = '', count = 0
        for (const character of raw) {
          const point = character.codePointAt(0)!
          const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
          if (count + width > TERMINAL_DESKTOP_LIMITS.eventBytes) { this.emit('terminal:data', { id, data: chunk }, lease); chunk = ''; count = 0 }
          chunk += character; count += width
        }
        if (chunk) this.emit('terminal:data', { id, data: chunk }, lease)
      },
      exit: id => {
        if (this.leases.get(id) !== lease || lease.exitEmitted) return
        lease.phase = 'exited'; lease.exitEmitted = true
        this.emit('terminal:exit', { id }, lease)
      }
    }
  }
  private lease(id: string, caller: DesktopCallerContext, access: Access): Lease {
    const lease = this.leases.get(id)
    if (!lease || !this.owned(lease, caller, access)) throw new ServiceProtocolError('INVALID_REQUEST')
    return lease
  }
  private current(lease: Lease): Identity | null {
    const identity = this.options.terminals.identity(lease.id)
    if (identity && !this.identityMatches(identity, lease.identity)) throw new ServiceProtocolError('INVALID_REQUEST')
    return identity
  }
  private bind<K extends TerminalDesktopOperation>(operation: K, access: Access,
    effect: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => unknown | Promise<unknown>): void {
    const codec = TERMINAL_COMMAND_CODECS[operation] as TerminalCommandCodec<K>
    const authorized = (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext): boolean => {
      this.available()
      return this.trusted(caller) && this.options.canAccessTerminal(args[0], caller, access) && this.options.canAccessTerminal(args[0], caller, 'read') &&
        (operation === 'terminal:create' ? !this.leases.has(args[0]) || this.sameCaller(this.leases.get(args[0])!.owner, caller) : !!this.leases.get(args[0]) && this.sameCaller(this.leases.get(args[0])!.owner, caller))
    }
    this.registry.bindCommand(operation, {
      decodeRequest: codec.decodeArguments, validateArguments: codec.validateArguments, authorize: authorized,
      invoke: (args, caller, signal) => this.retain((async () => {
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        if (!authorized(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        const result = await effect(args, caller)
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        if (!authorized(args, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
        return codec.decodeResult(codec.encodeResult(result).defined ? result as JsonValue : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult
    })
  }
  private bindCommands(): void {
    const core = this.options.terminals
    this.bind('terminal:create', 'write', ([id, cols, rows, requested], caller) => {
      const selected = this.directory(id, caller, requested)
      let lease = this.leases.get(id)
      if (lease && this.current(lease)) {
        if (lease.phase !== 'live' || lease.root !== selected.root || lease.cwd !== selected.cwd) throw new ServiceProtocolError('INVALID_REQUEST')
        const attached = core.attachIdentity(id, this.events(lease))
        if (!this.identityMatches(attached, lease.identity)) throw new ServiceProtocolError('INVALID_REQUEST')
        if (!core.resizeAcknowledged(id, cols, rows, attached!).alive) throw new ServiceProtocolError('DISCONNECTED')
        return { pid: attached!.pid }
      }
      if (core.ownedIdentity(id) || lease?.phase === 'starting' || lease?.phase === 'retiring') throw new ServiceProtocolError('INVALID_REQUEST')
      if (!lease && this.leases.size >= 256 || lease && lease.usedPids.size >= 256) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      lease = { id, owner: { ...caller }, ...selected, identity: null, phase: 'starting', exitEmitted: false, usedPids: lease?.usedPids ?? new Set<number>() }
      this.leases.set(id, lease)
      const createdLease = lease
      try {
        const result = core.create({ id, cols, rows, cwd: selected.cwd }, this.events(createdLease))
        const identity = core.identity(id)
        if (!identity || identity.pid !== result.pid) throw new ServiceProtocolError('DISCONNECTED')
        createdLease.identity = identity
        if (this.failed || this.closing) throw new ServiceProtocolError('DISCONNECTED')
        if (!TERMINAL_COMMAND_CODECS['terminal:create'].validateResult(result)) { this.fatal(); throw new ServiceProtocolError('INVALID_RESULT') }
        if (createdLease.usedPids.has(identity.pid)) { this.fatal(); throw new ServiceProtocolError('INVALID_REQUEST') }
        createdLease.usedPids.add(identity.pid); createdLease.phase = 'live'
        const confirmed = this.directory(id, caller, requested)
        if (confirmed.root !== selected.root || confirmed.cwd !== selected.cwd) { this.fatal(); throw new ServiceProtocolError('INVALID_REQUEST') }
        return result
      } catch (error) {
        if (!createdLease.identity) createdLease.phase = 'exited'
        else {
          createdLease.phase = 'retiring'
          this.retain(core.killAcknowledged(id, createdLease.identity.pid, createdLease.identity.generation)).then(result => { if (result.killed) createdLease.phase = 'exited' }, () => {})
        }
        throw error
      }
    })
    this.bind('terminal:write', 'write', ([id, data], caller) => {
      const lease = this.lease(id, caller, 'write')
      if (lease.phase !== 'live' || !this.current(lease) || !core.write(id, data).alive) throw new ServiceProtocolError('DISCONNECTED')
    })
    this.bind('terminal:resize', 'write', ([id, cols, rows], caller) => {
      const lease = this.lease(id, caller, 'write')
      const identity = this.current(lease)
      if (lease.phase !== 'live' || !identity || !core.resizeAcknowledged(id, cols, rows, identity).alive) throw new ServiceProtocolError('DISCONNECTED')
    })
    this.bind('terminal:getBuffer', 'read', ([id, lines], caller) => {
      const lease = this.lease(id, caller, 'read'); this.current(lease)
      // The retained codec conservatively counts one extra delimiter byte.
      const result = core.getBuffer(id, lines, TERMINAL_DESKTOP_LIMITS.bufferBytes - 1)
      if (!TERMINAL_COMMAND_CODECS['terminal:getBuffer'].validateResult(result)) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      return result
    })
    this.bind('terminal:getCwd', 'read', async ([id, expectedPid], caller) => {
      const lease = this.lease(id, caller, 'read'), identity = this.current(lease)
      if (!identity || lease.phase !== 'live' || expectedPid !== undefined && expectedPid !== identity.pid) return { cwd: null }
      const result = await core.getCwd(id, identity.pid)
      if (this.closing || this.failed) return { cwd: null }
      if (!this.identityMatches(core.identity(id), identity) || !TERMINAL_COMMAND_CODECS['terminal:getCwd'].validateResult(result) || result.cwd === null) return { cwd: null }
      try { const cwd = realpathSync(result.cwd); return { cwd: statSync(cwd).isDirectory() && this.contained(lease.root, cwd) ? cwd : null } } catch { return { cwd: null } }
    })
    this.bind('terminal:kill', 'write', async ([id, expectedPid], caller) => {
      const lease = this.lease(id, caller, 'write'), identity = lease.phase === 'retiring' ? core.ownedIdentity(id) : this.current(lease)
      if (identity && !this.identityMatches(identity, lease.identity)) throw new ServiceProtocolError('INVALID_REQUEST')
      if (!identity || expectedPid !== undefined && identity.pid !== expectedPid) return
      lease.phase = 'retiring'
      const receipt = await this.retain(core.killAcknowledged(id, identity.pid, identity.generation))
      if (!receipt.killed) throw new ServiceProtocolError('INVALID_REQUEST')
      if (this.leases.get(id) === lease && !lease.exitEmitted) { lease.phase = 'exited'; lease.exitEmitted = true; this.emit('terminal:exit', { id }, lease) }
    })
  }
}

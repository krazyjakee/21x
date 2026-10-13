import { getDesktopHost, type DesktopHost } from './desktop-api'
import type { NativeDesktopHost } from './native-desktop-host'
import { subscribe } from './shared-ipc-listeners'

interface Receipt { pid: number; epoch: string }
interface Registry {
  receipts: Map<string, Receipt>
  /** Historical receipts identify seen IDs; they grant no command authority. */
  remembered: Map<string, { epoch: string; pid: number | null }>
  attempts: Map<string, symbol>
  offExit: (() => void) | null
}
const registries = new WeakMap<DesktopHost, Registry>()
function registry(host: DesktopHost): Registry {
  let entry = registries.get(host)
  if (entry) return entry
  entry = { receipts: new Map(), remembered: new Map(), attempts: new Map(), offExit: null }
  const owner = entry
  registries.set(host, owner)
  host.subscribeConnection(() => {
    if (host.connection.status === 'ready') return
    owner.receipts.clear(); owner.attempts.clear(); owner.offExit?.(); owner.offExit = null
  })
  return owner
}
function forget(host: DesktopHost, id: string): void {
  const owner = registries.get(host)
  owner?.receipts.delete(id)
  if (owner && !owner.receipts.size) { owner.offExit?.(); owner.offExit = null }
}
function record(host: DesktopHost, id: string, receipt: Receipt, attempt: symbol): boolean {
  const owner = registry(host)
  if (owner.attempts.get(id) !== attempt || host.connection.status !== 'ready' || host.connection.engineEpoch !== receipt.epoch) return false
  owner.receipts.set(id, receipt)
  owner.remembered.set(id, receipt)
  if (!owner.offExit) owner.offExit = subscribe<{ id: string }>('terminal:exit', callback => host.api.terminal.onExit(callback), event => forget(host, event.id))
  return true
}
/** Explicit canvas close only. Discard the receipt before one request; never
 * infer a PID from persisted panels or retry it against a later service. */
export async function closeNativeTerminalPanel(id: string): Promise<void> {
  const host = getDesktopHost()
  if (host.kind !== 'tauri') return
  const owner = registries.get(host), receipt = owner?.receipts.get(id)
  owner?.attempts.delete(id); forget(host, id)
  if (!receipt || host.connection.status !== 'ready' || host.connection.engineEpoch !== receipt.epoch) return
  await host.api.terminal.kill(id, receipt.pid)
}
export interface TerminalSessionOptions {
  host: DesktopHost
  id: string
  cols: number
  rows: number
  cwd?: string
  onData(data: string): void
  onExit(): void
  onRecentText(lines: string[]): void
  onReady(ready: boolean, initial: boolean): void
  onError(message: string | null): void
  onCwd(cwd: string): void
}
export interface TerminalViewSession {
  start(): Promise<void>
  restart(): Promise<void>
  write(data: string): void
  resize(cols: number, rows: number): void
  captureCwd(): Promise<void>
  dispose(): void
}

/** One view lease, not a second PTY owner. Native navigation preserves the
 * process; reconnect never replays input or automatically spawns a new epoch. */
export function createTerminalViewSession(options: TerminalSessionOptions): TerminalViewSession {
  const { host, id } = options, api = host.api.terminal, native = host.kind === 'tauri'
  const previous = native ? registry(host).remembered.get(id) : undefined
  let disposed = false, ready = false, started = !!previous, exited = false, prepared = false
  let closeVersion = 0
  let pid: number | null = previous?.pid ?? null, epoch: string | null = previous?.epoch ?? null, generation = 0
  let cols = options.cols, rows = options.rows
  let flight: Promise<void> | null = null
  const hydrated = () => !native || (host as NativeDesktopHost).hydrationPending === false
  const live = () => !disposed && ready && !exited && (!native || host.connection.status === 'ready' && hydrated() && host.connection.engineEpoch === epoch)
  const sameEpoch = (captured: string | null) => !native || host.connection.status === 'ready' && host.connection.engineEpoch === captured
  const error = (value: unknown) => options.onError(value instanceof Error ? value.message : 'The terminal could not be restored.')
  const offData = subscribe<{ id: string; data: string }>('terminal:data', callback => api.onData?.(callback), event => {
    if (event.id === id && !disposed && !exited && sameEpoch(epoch)) options.onData(event.data)
  })
  const offExit = subscribe<{ id: string }>('terminal:exit', callback => api.onExit?.(callback), event => {
    if (event.id !== id || disposed || !sameEpoch(epoch)) return
    exited = true; ready = false; closeVersion++
    if (native) forget(host, id)
    options.onReady(false, false); options.onExit()
  })
  const captureCwd = async (): Promise<void> => {
    const capturedPid = pid, capturedEpoch = epoch
    if (capturedPid === null || exited || !sameEpoch(capturedEpoch) || native && registries.get(host)?.receipts.get(id)?.pid !== capturedPid) return
    try {
      const result = await api.getCwd(id, capturedPid)
      if (result.cwd && sameEpoch(capturedEpoch) && (!native || registries.get(host)?.receipts.get(id)?.pid === capturedPid)) options.onCwd(result.cwd)
    } catch { /* A stale/unavailable cwd is never persisted or retried. */ }
  }
  const run = (recover: boolean): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (flight) return flight
    if (native && (host.connection.status !== 'ready' || !hydrated())) return Promise.resolve()
    const capturedEpoch = host.connection.engineEpoch, initial = !prepared
    if (native && recover && epoch !== capturedEpoch) { options.onReady(false, initial); options.onError('The previous terminal belongs to an earlier connection. Restore it explicitly or open a new terminal to start a shell.'); return Promise.resolve() }
    const mine = ++generation, observedClose = closeVersion
    let attempt: symbol | undefined
    if (native) {
      const owner = registry(host)
      if (!owner.remembered.has(id) && owner.remembered.size >= 256) { options.onError('Too many terminal identities. Close and reopen the app before opening another terminal.'); return Promise.resolve() }
      if (!owner.remembered.has(id)) owner.remembered.set(id, { epoch: capturedEpoch!, pid: null })
      attempt = Symbol(id); owner.attempts.set(id, attempt)
    }
    ready = false; options.onReady(false, initial); options.onError(null)
    // Early output is already subscribed. Data retains its real event order;
    // the separately labeled history snapshot has no live-event watermark.
    epoch = capturedEpoch
    const work = (async () => {
      let accepted: { pid: number }
      if (native && recover) {
        if (pid === null || !started || exited) throw new Error('The previous terminal could not be verified. Open a new terminal to start a shell.')
        const verifiedPid = pid, result = await api.getCwd(id, verifiedPid)
        if (!result.cwd) throw new Error('The previous terminal could not be verified. Open a new terminal to start a shell.')
        accepted = { pid: verifiedPid }
      } else {
        if (disposed || mine !== generation || !sameEpoch(capturedEpoch)) return
        accepted = native ? await api.create(id, cols, rows) : await api.create(id, cols, rows, options.cwd)
      }
      if (!sameEpoch(capturedEpoch)) return
      if (observedClose !== closeVersion) { pid = accepted.pid; started = true; return }
      if (native && attempt && !record(host, id, { epoch: capturedEpoch!, pid: accepted.pid }, attempt)) return
      if (disposed || mine !== generation) {
        if (!native) await api.kill(id, accepted.pid).catch(() => {})
        return
      }
      pid = accepted.pid; started = true; exited = false
      if (native) {
        const recent = await api.getBuffer(id, 200)
        if (disposed || mine !== generation || !sameEpoch(capturedEpoch) || exited) return
        if (recent.lines.length) options.onRecentText(recent.lines)
      }
      if (disposed || mine !== generation || !sameEpoch(capturedEpoch) || exited) return
      ready = true; prepared = true; options.onReady(true, initial)
    })().catch(value => {
      if (!disposed && mine === generation && sameEpoch(capturedEpoch)) { ready = false; error(value) }
    })
    flight = work
    void work.finally(() => { if (flight === work) flight = null })
    return work
  }
  const offConnection = native ? host.subscribeConnection(() => {
    if (disposed) return
    if (host.connection.status !== 'ready' || !hydrated()) {
      generation++; flight = null; ready = false; options.onReady(false, false)
      if (started && host.connection.status !== 'ready') options.onError('Terminal connection lost. Reconnect the desktop to restore recent text.')
      return
    }
    if (epoch && epoch !== host.connection.engineEpoch) { ready = false; options.onReady(false, false); options.onError('The previous terminal belongs to an earlier connection. Restore it explicitly or open a new terminal to start a shell.'); return }
    if (!ready && !exited) void run(started || registry(host).remembered.has(id))
  }) : () => {}
  return {
    start: () => run(native && !!registry(host).remembered.get(id)), restart: () => run(false), captureCwd,
    write(data) { if (live()) void api.write(id, data).catch(value => { if (live()) error(value) }) },
    resize(nextCols, nextRows) {
      cols = nextCols; rows = nextRows
      if (!live()) return
      const captured = generation, capturedEpoch = epoch
      void api.resize(id, cols, rows).catch(() => { if (native && captured === generation && sameEpoch(capturedEpoch) && live()) options.onError('The terminal resize was not confirmed.') })
    },
    dispose() {
      if (disposed) return
      disposed = true; generation++; ready = false
      offData(); offExit(); offConnection()
      if (native) { void captureCwd(); return }
      const capturedPid = pid
      if (capturedPid !== null) void captureCwd().finally(() => { void api.kill(id, capturedPid).catch(() => {}) })
    }
  }
}

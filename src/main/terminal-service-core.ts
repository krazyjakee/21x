import { TerminalTextBuffer } from './terminal-text-buffer'

export interface TerminalHandle {
  write(data: string): void | boolean
  resize?(cols: number, rows: number): void
  kill(): void
  pid: number
}
export interface PtyOptions {
  shellPath: string
  cols: number
  rows: number
  cwd?: string
  onData(data: string): void
  /** Must mean actual native close, not a cancellation or kill request. */
  onExit(pid: number, code: unknown, signal: unknown): void
}
export interface TerminalProcessHost {
  resolveShell(): string
  create(options: PtyOptions): TerminalHandle
  getCwd(pid: number, isCurrent: () => boolean): Promise<string | null>
}
export interface TerminalEventHost {
  data(id: string, data: string): void
  exit(id: string): void
}
interface Entry {
  id: string
  generation: number
  handle?: TerminalHandle
  events: TerminalEventHost
  buffer: TerminalTextBuffer
  closed: Promise<void>
  finish(): void
  exited: boolean
  killRequested: boolean
}
const MAX_LINES = 500
const MAX_CHARS = 1_000_000

/** Owns active and retiring PTYs plus raw cwd probes, independently of a window. */
export class TerminalServiceCore {
  private current = new Map<string, Entry>()
  private owned = new Set<Entry>()
  private probes = new Set<Promise<unknown>>()
  private closing = false
  private nextGeneration = 0

  constructor(private readonly host: TerminalProcessHost) {}

  create(input: { id: string; cols: number; rows: number; cwd?: string }, events: TerminalEventHost): { pid: number } {
    this.assertOpen()
    if (typeof input.id !== 'string' || !input.id || input.id.length > 256) throw new Error('Invalid terminal ID')
    this.validateSize(input.cols, input.rows)
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.includes('\0'))) throw new Error('Invalid terminal cwd')
    // Retired processes still consume a slot until actual native close.
    if (this.owned.size >= 64) throw new Error('TERMINAL_CAPACITY_EXCEEDED')
    if (this.nextGeneration === Number.MAX_SAFE_INTEGER) throw new Error('TERMINAL_IDENTITY_EXHAUSTED')
    const existing = this.current.get(input.id)
    if (existing) this.retire(existing)
    let finish!: () => void
    const entry: Entry = {
      id: input.id, generation: ++this.nextGeneration, events, buffer: new TerminalTextBuffer(MAX_LINES, MAX_CHARS), exited: false, killRequested: false,
      closed: new Promise<void>(resolve => { finish = resolve }), finish: () => finish()
    }
    this.current.set(input.id, entry)
    this.owned.add(entry)
    try {
      entry.handle = this.host.create({
        ...input, shellPath: this.host.resolveShell(),
        onData: data => {
          if (!this.isCurrent(entry)) return
          entry.buffer.append(data)
          try { entry.events.data(entry.id, data) } catch { /* window may disappear */ }
        },
        onExit: () => {
          if (entry.exited) return
          const wasCurrent = this.current.get(entry.id) === entry
          entry.exited = true
          this.owned.delete(entry)
          if (wasCurrent) this.current.delete(entry.id)
          entry.finish()
          if (wasCurrent && !this.closing) {
            try { entry.events.exit(entry.id) } catch { /* window may disappear */ }
          }
        }
      })
      return { pid: entry.handle.pid }
    } catch (error) {
      this.owned.delete(entry)
      if (this.current.get(entry.id) === entry) this.current.delete(entry.id)
      entry.finish()
      throw error
    }
  }

  /** Reconnect a trusted renderer host without respawning the terminal. */
  attach(id: string, events: TerminalEventHost): { pid: number; lines: string[] } | null {
    this.assertOpen()
    const entry = this.current.get(id)
    if (!entry?.handle) return null
    entry.events = events
    return { pid: entry.handle.pid, lines: entry.buffer.snapshot(MAX_LINES) }
  }

  /** Current native identity; generation distinguishes same-PID replacements. */
  identity(id: string): { pid: number; generation: number } | null {
    this.assertOpen()
    const entry = this.current.get(id)
    return entry?.handle && this.isCurrent(entry) ? { pid: entry.handle.pid, generation: entry.generation } : null
  }

  /** A retiring process still owns its ID until the actual onExit receipt. */
  ownedIdentity(id: string): { pid: number; generation: number } | null {
    this.assertOpen()
    const entry = this.current.get(id) ?? [...this.owned].filter(row => row.id === id && !row.exited).sort((a, b) => b.generation - a.generation)[0]
    return entry?.handle && !entry.exited ? { pid: entry.handle.pid, generation: entry.generation } : null
  }

  /** Reconnect event delivery without copying the potentially large buffer. */
  attachIdentity(id: string, events: TerminalEventHost): { pid: number; generation: number } | null {
    this.assertOpen()
    const entry = this.current.get(id)
    if (!entry?.handle || !this.isCurrent(entry)) return null
    entry.events = events
    return { pid: entry.handle.pid, generation: entry.generation }
  }

  write(id: string, data: string): { alive: boolean } {
    this.assertOpen()
    if (typeof data !== 'string' || data.length > MAX_CHARS) throw new Error('Invalid terminal input')
    const entry = this.current.get(id)
    if (!entry?.handle) return { alive: false }
    try { return { alive: entry.handle.write(data) !== false } } catch { return { alive: false } }
  }

  resize(id: string, cols: number, rows: number): void {
    this.assertOpen()
    this.validateSize(cols, rows)
    try { this.current.get(id)?.handle?.resize?.(cols, rows) } catch { /* terminal already exited */ }
  }

  /** Production acknowledgement must reflect the actual captured native call. */
  resizeAcknowledged(id: string, cols: number, rows: number, expected: { pid: number; generation: number }): { alive: boolean } {
    this.assertOpen(); this.validateSize(cols, rows)
    const entry = this.current.get(id)
    if (!entry?.handle?.resize || !this.isCurrent(entry) || entry.handle.pid !== expected.pid || entry.generation !== expected.generation) return { alive: false }
    try { entry.handle.resize(cols, rows); return { alive: this.isCurrent(entry) } } catch { return { alive: false } }
  }

  getBuffer(id: string, lines = 200, maxJsonBytes?: number): { lines: string[] } {
    this.assertOpen()
    if (!Number.isSafeInteger(lines) || lines < 1) throw new Error('Invalid terminal line count')
    return { lines: this.current.get(id)?.buffer.snapshot(lines, maxJsonBytes) ?? [] }
  }

  kill(id: string, expectedPid?: number): void {
    this.assertOpen()
    const entry = this.current.get(id)
    if (!entry || (expectedPid !== undefined && entry.handle?.pid !== expectedPid)) return
    this.retire(entry)
  }

  /** Retain this exact native process through close, including a prior failed
   * kill or a timeout at the caller. Never redirect a delayed kill to a new PID. */
  async killAcknowledged(id: string, expectedPid?: number, expectedGeneration?: number): Promise<{ killed: boolean }> {
    this.assertOpen()
    const candidates = [...this.owned].filter(entry => entry.id === id && !entry.exited && entry.handle &&
      (expectedPid === undefined || entry.handle.pid === expectedPid) && (expectedGeneration === undefined || entry.generation === expectedGeneration))
    const entry = expectedGeneration === undefined ? this.current.get(id) ?? candidates.sort((a, b) => b.generation - a.generation)[0] : candidates[0]
    if (!entry?.handle || (expectedPid !== undefined && entry.handle.pid !== expectedPid) || (expectedGeneration !== undefined && entry.generation !== expectedGeneration)) return { killed: false }
    this.retire(entry)
    await entry.closed
    return { killed: true }
  }

  async getCwd(id: string, expectedPid?: number): Promise<{ cwd: string | null }> {
    this.assertOpen()
    const entry = this.current.get(id)
    if (!entry?.handle || (expectedPid !== undefined && entry.handle.pid !== expectedPid)) return { cwd: null }
    const work = Promise.resolve().then(async () => {
      if (!this.isCurrent(entry)) return { cwd: null }
      const cwd = await this.host.getCwd(entry.handle!.pid, () => this.isCurrent(entry))
      return { cwd: this.isCurrent(entry) ? cwd : null }
    })
    this.probes.add(work)
    try { return await work } finally { this.probes.delete(work) }
  }

  shutdown(): void {
    this.closing = true
    for (const entry of this.owned) this.retire(entry)
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Terminal shutdown deadline must be an integer from 1 to 3000 ms')
    this.shutdown()
    const drain = Promise.allSettled([...this.owned].map(entry => entry.closed).concat([...this.probes].map(probe => probe.then(() => {}, () => {}))))
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('TERMINAL_SHUTDOWN_INCOMPLETE')), timeoutMs)
    })
    try { await Promise.race([drain, expired]) }
    finally { if (timer) clearTimeout(timer) }
  }

  private retire(entry: Entry): void {
    if (this.current.get(entry.id) === entry) this.current.delete(entry.id)
    if (entry.exited || entry.killRequested || !entry.handle) return
    try { entry.handle.kill(); entry.killRequested = true } catch { /* close can retry this owned handle */ }
  }

  private isCurrent(entry: Entry): boolean {
    return !this.closing && !entry.exited && this.current.get(entry.id) === entry
  }

  private validateSize(cols: number, rows: number): void {
    if (![cols, rows].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 4096)) throw new Error('Invalid terminal size')
  }
  private assertOpen(): void {
    if (this.closing) throw new Error('TERMINAL_SERVICE_CLOSED')
  }
}

import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export interface TunnelHost {
  /** Host-selected staged binary and private profile root, never renderer paths. */
  binary: string
  privateRoot: string
  environment: NodeJS.ProcessEnv
  spawn(binary: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams
  connectTimeoutMs?: number
}
interface Flight {
  port: number
  child: ChildProcessWithoutNullStreams
  directory: string
  startup: Promise<string>
  reject(error: Error): void
  closed: Promise<void>
  stopping: boolean
  exited: boolean
  timer: ReturnType<typeof setTimeout> | null
  url: string | null
  ready: boolean
}

/** Real child ownership: public connection/close deadlines never release raw
 * stdout/stderr/process receipts, permit replacement, or remove its config. */
export class TunnelManagerCore {
  private flight: Flight | null = null
  private closing = false
  constructor(private readonly host: TunnelHost) {
    if (!isAbsolute(host.binary) || !isAbsolute(host.privateRoot) || !Number.isSafeInteger(host.connectTimeoutMs ?? 120_000) || (host.connectTimeoutMs ?? 120_000) < 1 || (host.connectTimeoutMs ?? 120_000) > 120_000) throw new Error('TUNNEL_HOST_INVALID')
  }
  get url(): string | null { return this.flight?.ready && !this.flight.stopping && !this.flight.exited ? this.flight.url : null }
  get active(): boolean { return this.url !== null }
  get inflightCount(): number { return this.flight ? 1 : 0 }
  start(port: number): Promise<string> {
    if (this.closing) return Promise.reject(new Error('TUNNEL_CLOSED'))
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error('TUNNEL_PORT_INVALID'))
    if (this.flight) return this.flight.port === port && !this.flight.stopping && !this.flight.exited ? this.flight.startup : Promise.reject(new Error('TUNNEL_BUSY'))
    let directory = ''; let child: ChildProcessWithoutNullStreams
    try {
      if (realpathSync(this.host.privateRoot) !== resolve(this.host.privateRoot) || !statSync(this.host.privateRoot).isDirectory() || !statSync(this.host.binary).isFile()) throw new Error()
      directory = mkdtempSync(join(this.host.privateRoot, 'mobile-tunnel-'))
      const config = join(directory, 'config.yml')
      writeFileSync(config, '', { flag: 'wx', mode: 0o600 })
      child = this.host.spawn(this.host.binary, ['tunnel', '--config', config, '--edge-ip-version', '4', '--url', `http://127.0.0.1:${port}`], { env: { ...this.host.environment }, cwd: directory, windowsHide: true, shell: false, stdio: 'pipe' })
    } catch { if (directory) rmSync(directory, { recursive: true, force: true }); return Promise.reject(new Error('TUNNEL_UNAVAILABLE')) }
    let finish!: () => void, resolveStart!: (url: string) => void, rejectStart!: (error: Error) => void
    const closed = new Promise<void>(done => { finish = done })
    const startup = new Promise<string>((done, reject) => { resolveStart = done; rejectStart = reject })
    void startup.catch(() => {})
    const flight: Flight = { port, directory, child, startup, reject: rejectStart, closed, stopping: false, exited: false, timer: null, url: null, ready: false }
    this.flight = flight
    const fail = (reason: string): void => { flight.reject(new Error(reason)); this.stopFlight(flight) }
    const observe = (line: string): void => {
      if (flight.stopping || flight.exited || this.flight !== flight) return
      const address = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|"']|$)/i)?.[0]
      if (address) flight.url = address
      if (/Registered tunnel connection/.test(line)) flight.ready = true
      if (flight.ready && flight.url) { if (flight.timer) clearTimeout(flight.timer); flight.timer = null; resolveStart(flight.url) }
    }
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8'); let pending = ''
      stream.on('data', (data: Buffer) => {
        pending += decoder.write(data)
        if (Buffer.byteLength(pending) > 64 * 1024) { pending = ''; fail('TUNNEL_OUTPUT_LIMIT'); return }
        let boundary: number
        while ((boundary = pending.indexOf('\n')) >= 0) { observe(pending.slice(0, boundary)); pending = pending.slice(boundary + 1) }
      })
      stream.on('end', () => { const tail = pending + decoder.end(); if (tail) observe(tail); pending = '' })
      stream.on('error', () => fail('TUNNEL_STREAM_FAILED'))
    }
    child.stdin.on('error', () => fail('TUNNEL_STREAM_FAILED'))
    child.on('error', () => fail('TUNNEL_PROCESS_FAILED'))
    child.once('exit', () => { flight.exited = true; flight.ready = false; flight.reject(new Error('TUNNEL_EXITED')); if (flight.timer) clearTimeout(flight.timer); flight.timer = null })
    child.once('close', () => {
      flight.exited = true; flight.ready = false; flight.reject(new Error('TUNNEL_CLOSED'))
      if (flight.timer) clearTimeout(flight.timer)
      if (this.flight === flight) this.flight = null
      try { rmSync(directory, { recursive: true, force: true }) } catch { /* closed child remains acknowledged; private empty config may be retained */ } finally { finish() }
    })
    flight.timer = setTimeout(() => fail(flight.url ? 'TUNNEL_NEVER_CONNECTED' : 'TUNNEL_START_TIMEOUT'), this.host.connectTimeoutMs ?? 120_000)
    flight.timer.unref()
    return startup
  }
  private stopFlight(flight: Flight): void {
    flight.stopping = true; flight.ready = false; flight.reject(new Error('TUNNEL_CANCELLED'))
    if (flight.timer) clearTimeout(flight.timer)
    flight.timer = null
    if (!flight.exited) { try { flight.child.kill('SIGTERM') } catch { /* retain exact raw receipt for retry */ } }
  }
  stop(): Promise<void> { const flight = this.flight; if (!flight) return Promise.resolve(); this.stopFlight(flight); return flight.closed }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid tunnel shutdown deadline')
    this.closing = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.stop(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TUNNEL_SHUTDOWN_INCOMPLETE')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
}

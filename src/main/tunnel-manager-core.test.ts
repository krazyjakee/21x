import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { TunnelManagerCore, type TunnelHost } from './tunnel-manager-core'
class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  kill = vi.fn(() => true)
  finish(): void { this.emit('exit', 0, null); this.stdout.end(); this.stderr.end(); this.stdin.end(); this.emit('close', 0, null) }
}
let root: string, binary: string, owner: TunnelManagerCore, child: Child, spawn: ReturnType<typeof vi.fn<TunnelHost['spawn']>>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '21x-tunnel-core-')); binary = join(root, 'staged-cloudflared'); writeFileSync(binary, 'synthetic executable boundary')
  spawn = vi.fn<TunnelHost['spawn']>(() => { child = new Child(); return child as unknown as ChildProcessWithoutNullStreams })
  owner = new TunnelManagerCore({ binary, privateRoot: root, environment: { PATH: '/synthetic-bin', HOME: root }, spawn, connectTimeoutMs: 50 })
})
afterEach(async () => { if (child) child.finish(); await owner.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })
const url = 'https://synthetic-words.trycloudflare.com'
function connect() { child.stderr.write(`INF | ${url} |\n`); child.stderr.write('INF Registered tunnel connection connIndex=0\n') }
describe('portable tunnel actual raw-child receipts', () => {
  it('coalesces startup, uses one private config and narrow host environment, and requires actual connection evidence', async () => {
    const start = owner.start(20620); expect(owner.start(20620)).toBe(start)
    const invocation = spawn.mock.calls[0]; if (!invocation) throw new Error('Fixture child was not spawned')
    const [path, args, options] = invocation
    expect(path).toBe(binary); expect(options.shell).toBe(false); expect(options.env).toEqual({ PATH: '/synthetic-bin', HOME: root })
    expect(args).toEqual(['tunnel', '--config', expect.any(String), '--edge-ip-version', '4', '--url', 'http://127.0.0.1:20620'])
    expect(readFileSync(args[2]!, 'utf8')).toBe('')
    child.stderr.write(`INF | ${url} |\n`); await Promise.resolve(); expect(owner.url).toBeNull(); expect(owner.active).toBe(false)
    child.stderr.write('INF Registered tunnel connection connIndex=0\n'); expect(await start).toBe(url); expect(owner.active).toBe(true)
    const directory = options.cwd; if (typeof directory !== 'string') throw new Error('Fixture private directory missing')
    const stopping = owner.stop(); expect(owner.url).toBeNull(); expect(existsSync(directory)).toBe(true)
    let closed = false; void stopping.then(() => { closed = true }); await Promise.resolve(); expect(closed).toBe(false)
    child.emit('exit', 0, null); await Promise.resolve(); expect(closed).toBe(false); expect(owner.inflightCount).toBe(1)
    child.finish(); await stopping; expect(existsSync(directory)).toBe(false); expect(owner.inflightCount).toBe(0)
  })
  it('retains a cancelled pending child after public close deadline, fences late output/replacement and joins retry only on close', async () => {
    const start = owner.start(20620), rejected = expect(start).rejects.toThrow('TUNNEL_CANCELLED')
    await expect(owner.close(5)).rejects.toThrow('TUNNEL_SHUTDOWN_INCOMPLETE'); await rejected
    expect(owner.inflightCount).toBe(1); connect(); expect(owner.url).toBeNull()
    await expect(owner.start(20620)).rejects.toThrow('TUNNEL_CLOSED'); expect(spawn).toHaveBeenCalledOnce()
    let drained = false; const retry = owner.close().then(() => { drained = true }); await Promise.resolve(); expect(drained).toBe(false)
    child.finish(); await retry; expect(drained).toBe(true)
  })
  it('keeps timeout raw ownership and refuses another start until actual stream/process close', async () => {
    vi.useFakeTimers(); const start = owner.start(20620), rejected = expect(start).rejects.toThrow('TUNNEL_NEVER_CONNECTED')
    child.stderr.write(`INF | ${url} |\n`); await vi.advanceTimersByTimeAsync(50); await rejected
    expect(child.kill).toHaveBeenCalled(); expect(owner.inflightCount).toBe(1)
    await expect(owner.start(20620)).rejects.toThrow('TUNNEL_BUSY'); connect(); expect(owner.url).toBeNull()
    child.finish(); const next = owner.start(20620); connect(); expect(await next).toBe(url); expect(spawn).toHaveBeenCalledTimes(2)
  })
  it('invalidates crash URL on exit while retaining undrained streams, and bounds private output without echoing raw errors', async () => {
    const start = owner.start(20620); connect(); await start; child.emit('exit', 1, null)
    expect(owner.url).toBeNull(); await expect(owner.start(20620)).rejects.toThrow('TUNNEL_BUSY'); expect(owner.inflightCount).toBe(1)
    child.finish(); const next = owner.start(20620), rejected = expect(next).rejects.toThrow('TUNNEL_OUTPUT_LIMIT')
    child.stdout.write('private-output'.repeat(6000)); await rejected; expect(owner.inflightCount).toBe(1)
  })
})
